// Lifecycle module - working container lifecycle
// INV-3: Working container is wiped at project end
// Manages create, credential-provision, wipe operations

import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { validateIdentifier } from "../adapter/shell-safety.mjs";
import { AGENT_CONTAINER_NAME, AGENT_IMAGE } from "../container/index.mjs";

const WORKING_PREFIX = "switchyard-work-";

// Credential FILES copied from the standing agent container into each fresh
// working container so any of the four authenticated CLIs can actually run
// there (Task 26). Two deliberate properties:
//
//   - CREDENTIAL FILES ONLY, never the whole provider directory. Each
//     provider's dir also holds conversation history / project state (claude
//     `projects/`, `sessions/`, `backups/`; codex `log/`, `goals_*.sqlite`;
//     agy `conversations/`, `brain/`, `knowledge/`), which must NOT bleed into
//     a disposable working container. Copying just the single auth file avoids
//     that cross-project/conversation bleed. (`/root/.claude.json` is a
//     single root-level config file, not a directory, so it carries no
//     subtree.)
//   - `dest` is the file's PARENT DIR, created with `mkdir -p` before the copy:
//     `docker cp SRC -` roots the tar at basename(SRC) and we extract into
//     `dest`, so `/root/.codex/auth.json` must extract into `/root/.codex`
//     (not `/root`) to land at the right path.
//
// Paths were confirmed empirically against a real authenticated agent
// container (2026-07-26), not assumed. cursor's file lives under
// `/root/.config`; the INV-1 gate test no longer forbids that path — it now
// asserts "no host bind mount" directly (see tests/no-host-rights.test.mjs),
// which is INV-1's real intent ("no host rights"), so a legitimately
// provisioned in-container credential no longer trips it.
const PROVIDER_CREDENTIAL_PATHS = [
	{ src: "/root/.claude/.credentials.json", dest: "/root/.claude" },
	{ src: "/root/.claude.json", dest: "/root" },
	{ src: "/root/.codex/auth.json", dest: "/root/.codex" },
	{
		src: "/root/.gemini/antigravity-cli/antigravity-oauth-token",
		dest: "/root/.gemini/antigravity-cli",
	},
	{ src: "/root/.config/cursor/auth.json", dest: "/root/.config/cursor" },
];

/**
 * Generate a unique working container name for a project.
 * @param {string} projectPath Project path
 * @returns {string} Container name
 */
function generateWorkingContainerName(projectPath) {
	const projectName = basename(projectPath);
	return `${WORKING_PREFIX}${projectName}-${randomUUID().slice(0, 8)}`;
}

/**
 * Create a working container for a project, built directly FROM the agent
 * image so it carries its own copy of every provider CLI + git on PATH
 * (Task 14). This replaces the earlier
 * `docker run --volumes-from ${AGENT_CONTAINER_NAME} ... alpine:latest`
 * approach, which shared the agent container's *volumes* but not its image
 * layers — and the CLIs live in the image's `/root/.local/bin`, not in any
 * volume, so they were never actually reachable inside the working container.
 *
 * INV-1: still no host filesystem mount — `/project` is an isolated named
 * Docker volume and nothing binds a host path in. Credentials are NOT baked
 * in here; a fresh working container is unauthenticated until
 * provisionCredentials() copies them in. That is deliberately a
 * separate step so the INV-1/INV-3 gate tests, which pass a credential-less
 * `alpine:latest` image, exercise pure container creation without needing the
 * multi-GB agent image present.
 * @param {string} projectPath Host project path (names the container; not mounted)
 * @param {string} [image] Image to build the working container from. Defaults
 *   to the real AGENT_IMAGE; the gate tests pass "alpine:latest" so they stay
 *   hermetic and don't require the agent image to be built.
 * @returns {string|null} Working container name or null on failure
 */
export function createWorkingContainer(projectPath, image = AGENT_IMAGE) {
	const containerName = generateWorkingContainerName(projectPath);

	try {
		// Defense-in-depth: `image` is an internal constant today, but it is
		// interpolated into the execSync command string below, so validate it
		// against the same safe-identifier pattern the adapters use.
		validateIdentifier(image, "image");

		// Isolated named volume for project code (INV-1: no host FS mount).
		execSync(`docker volume create ${containerName}-vol`, { stdio: "inherit" });

		// Build the working container FROM the agent image so every provider
		// CLI + git is on PATH inside it. No --volumes-from: the CLIs come from
		// the image's own layers, not a shared volume.
		execSync(
			`docker run -d --name ${containerName} ` +
				`-v ${containerName}-vol:/project -w /project ` +
				`${image} sleep infinity`,
			{ stdio: "inherit" },
		);

		return containerName;
	} catch (error) {
		console.error("Failed to create working container:", error.message);
		return null;
	}
}

/**
 * Copy one path from the agent container into the working container via a
 * container→container tar stream, never touching host disk. Best-effort: a
 * source path that doesn't exist (a provider that was never logged in, or a
 * lightweight `alpine` test fixture with no credentials) is skipped without
 * failing.
 *
 * INV-1: this moves bytes container→container through an in-memory tar Buffer
 * — no host filesystem path is mounted or written, so nothing persists to
 * host disk. INV-3: the copy lands in the disposable working container and is
 * destroyed when it is wiped. The credential VALUE is never printed, logged,
 * or placed in argv — it rides the tar Buffer between two `docker cp` argv
 * invocations, which is also why this uses execFileSync (no shell) rather
 * than a piped shell string.
 * @param {string} agentContainerName Source (standing agent container)
 * @param {string} workingContainerName Destination (disposable working container)
 * @param {string} srcPath Absolute file path inside the agent container
 * @param {string} destDir Absolute parent dir inside the working container to
 *   extract the file into (created with `mkdir -p` first). See
 *   PROVIDER_CREDENTIAL_PATHS for why dest is the file's parent dir, not `/root`.
 * @returns {boolean} true if copied, false if the source was absent (skipped)
 */
function copyPathAgentToWorking(
	agentContainerName,
	workingContainerName,
	srcPath,
	destDir,
) {
	// Best-effort existence probe — a missing source is a skip, not an error.
	try {
		execFileSync(
			"docker",
			["exec", agentContainerName, "test", "-e", srcPath],
			{
				stdio: "pipe",
			},
		);
	} catch {
		return false;
	}

	// `docker cp - container:destDir` extracts INTO destDir, which must already
	// exist — create it first (idempotent). destDir is an internal constant
	// from PROVIDER_CREDENTIAL_PATHS, never user input; the container name was
	// already validated by the caller.
	execFileSync(
		"docker",
		["exec", workingContainerName, "mkdir", "-p", destDir],
		{ stdio: "pipe" },
	);

	// `docker cp SRC -` streams a tar of srcPath (rooted at its basename) to
	// stdout; extracting that tar into destDir of the working container
	// recreates the file there. Two hops through a Node Buffer — no shell, no
	// temp file — so the credential bytes never persist to host disk (INV-1)
	// and no value is ever interpolated into a command string.
	const tar = execFileSync(
		"docker",
		["cp", `${agentContainerName}:${srcPath}`, "-"],
		{ maxBuffer: 256 * 1024 * 1024 },
	);
	execFileSync("docker", ["cp", "-", `${workingContainerName}:${destDir}`], {
		input: tar,
		stdio: ["pipe", "pipe", "pipe"],
	});
	return true;
}

/**
 * Provision all four providers' credentials from the standing agent container
 * into a newly created working container, so `docker exec <working> <cli> ...`
 * runs authenticated for whichever provider a task routes to. Best-effort:
 * returns the count of credential files actually copied and silently skips any
 * that are absent (an `alpine` test fixture, or a provider never logged in) —
 * a fresh working container simply stays unauthenticated for that provider,
 * which the adapter's own is<Provider>Authenticated() check surfaces
 * downstream. Copies credential FILES only, never whole provider dirs, so no
 * conversation/project state bleeds into the disposable container (see
 * PROVIDER_CREDENTIAL_PATHS).
 * @param {string} workingContainerName Destination working container
 * @param {string} [agentContainerName] Source agent container (defaults to the standing one)
 * @returns {number} number of credential files copied (0 if none present)
 */
export function provisionCredentials(
	workingContainerName,
	agentContainerName = AGENT_CONTAINER_NAME,
) {
	validateIdentifier(workingContainerName, "workingContainerName");
	validateIdentifier(agentContainerName, "agentContainerName");

	let copied = 0;
	for (const { src, dest } of PROVIDER_CREDENTIAL_PATHS) {
		if (
			copyPathAgentToWorking(
				agentContainerName,
				workingContainerName,
				src,
				dest,
			)
		) {
			copied += 1;
		}
	}
	return copied;
}

/**
 * Wipe working container at project end.
 * INV-3: Working container is wiped at project end
 * @param {string} workingContainerName Working container name
 * @returns {boolean}
 */
export function wipeWorkingContainer(workingContainerName) {
	try {
		// Stop and remove the working container
		execSync(`docker stop ${workingContainerName}`, { stdio: "inherit" });
		execSync(`docker rm ${workingContainerName}`, { stdio: "inherit" });

		// Remove the associated volume
		execSync(`docker volume rm ${workingContainerName}-vol`, {
			stdio: "inherit",
		});

		return true;
	} catch (error) {
		console.error("Failed to wipe working container:", error.message);
		return false;
	}
}

/**
 * Check if working container exists.
 * @param {string} workingContainerName Working container name
 * @returns {boolean}
 */
export function workingContainerExists(workingContainerName) {
	try {
		// `--filter name=X` is a SUBSTRING match in Docker, not exact — an
		// unanchored filter false-positives/false-negatives against any other
		// container whose name contains workingContainerName as a substring
		// (reproduced concretely: two test fixtures where one name contained
		// the other as a prefix caused this check to see multiple matched
		// names and fail the exact-equality comparison below). `^/X$` anchors
		// to the exact name — Docker stores container names with a leading
		// slash internally.
		const output = execSync(
			`docker ps -a --filter "name=^/${workingContainerName}$" --format '{{.Names}}'`,
			{ stdio: "pipe" },
		)
			.toString()
			.trim();
		return output === workingContainerName;
	} catch {
		return false;
	}
}

/**
 * Execute a command in the working container.
 * @param {string} workingContainerName Working container name
 * @param {string} command Command to execute
 * @returns {string} Command output
 */
export function execInWorkingContainer(workingContainerName, command) {
	const escapedCommand = command.replace(/'/g, "'\\''");
	const result = execSync(
		`docker exec ${workingContainerName} sh -c '${escapedCommand}'`,
		{ encoding: "utf8", stdio: "pipe" },
	);
	return result.trim();
}
