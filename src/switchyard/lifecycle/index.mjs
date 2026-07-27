// Lifecycle module - working container lifecycle
// INV-3: Working container is wiped at project end
// Manages create, credential-provision, wipe operations

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { validateIdentifier } from "../adapter/shell-safety.mjs";
import { AGENT_CONTAINER_NAME, AGENT_IMAGE } from "../container/index.mjs";

const WORKING_PREFIX = "switchyard-work-";

const LABEL_MANAGED = "com.zerodelta.switchyard.managed=true";
const LABEL_RUN_ID = "com.zerodelta.switchyard.run_id";
const LABEL_PROJECT = "com.zerodelta.switchyard.project";

function projectHash(projectPath) {
	return createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
}

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
	{
		src: "/root/.config/github-copilot/hosts.json",
		dest: "/root/.config/github-copilot",
	},
	{
		src: "/root/.config/github-copilot/apps.json",
		dest: "/root/.config/github-copilot",
	},
	{ src: "/root/.config/gh/hosts.yml", dest: "/root/.config/gh" },
	{
		src: "/root/.local/share/opencode/auth.json",
		dest: "/root/.local/share/opencode",
	},
	{
		src: "/root/.local/share/opencode/config.json",
		dest: "/root/.local/share/opencode",
	},
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
export function createWorkingContainer(
	projectPath,
	image = AGENT_IMAGE,
	options = {},
) {
	const containerName = generateWorkingContainerName(projectPath);
	const { runId, labels: extraLabels = {} } = options;

	try {
		// Defense-in-depth: `image` is an internal constant today, but it is
		// passed as an execFileSync argv element below, so validate it
		// against the same safe-identifier pattern the adapters use.
		validateIdentifier(image, "image");

		if (runId) {
			const ph = projectHash(projectPath);
			execFileSync(
				"docker",
				[
					"volume",
					"create",
					"--label",
					LABEL_MANAGED,
					"--label",
					`${LABEL_RUN_ID}=${runId}`,
					"--label",
					`${LABEL_PROJECT}=${ph}`,
					`${containerName}-vol`,
				],
				{ stdio: "inherit" },
			);

			try {
				const runArgs = [
					"run",
					"-d",
					"--name",
					containerName,
					"--label",
					LABEL_MANAGED,
					"--label",
					`${LABEL_RUN_ID}=${runId}`,
					"--label",
					`${LABEL_PROJECT}=${ph}`,
				];
				for (const [key, value] of Object.entries(extraLabels)) {
					runArgs.push("--label", `${key}=${value}`);
				}
				runArgs.push(
					"-v",
					`${containerName}-vol:/project`,
					"-w",
					"/project",
					image,
					"sleep",
					"infinity",
				);
				execFileSync("docker", runArgs, { stdio: "inherit" });
			} catch (runError) {
				try {
					execFileSync("docker", ["volume", "rm", `${containerName}-vol`], {
						stdio: "pipe",
					});
				} catch {
					/* best effort */
				}
				throw runError;
			}
		} else {
			// Isolated named volume for project code (INV-1: no host FS mount).
			// containerName is safe-char validated below before any docker call.
			validateIdentifier(containerName, "containerName");
			execFileSync("docker", ["volume", "create", `${containerName}-vol`], {
				stdio: "inherit",
			});

			// Build the working container FROM the agent image so every provider
			// CLI + git is on PATH inside it. No --volumes-from: the CLIs come from
			// the image's own layers, not a shared volume.
			try {
				execFileSync(
					"docker",
					[
						"run",
						"-d",
						"--name",
						containerName,
						"-v",
						`${containerName}-vol:/project`,
						"-w",
						"/project",
						image,
						"sleep",
						"infinity",
					],
					{ stdio: "inherit" },
				);
			} catch (runError) {
				try {
					execFileSync("docker", ["volume", "rm", `${containerName}-vol`], {
						stdio: "pipe",
					});
				} catch {
					/* best effort */
				}
				throw runError;
			}
		}

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
	try {
		execFileSync(
			"docker",
			["exec", workingContainerName, "mkdir", "-p", destDir],
			{ stdio: "pipe" },
		);
	} catch {
		return false;
	}

	// `docker cp SRC -` streams a tar of srcPath (rooted at its basename) to
	// stdout; extracting that tar into destDir of the working container
	// recreates the file there. Two hops through a Node Buffer — no shell, no
	// temp file — so the credential bytes never persist to host disk (INV-1)
	// and no value is ever interpolated into a command string.
	let tar;
	try {
		tar = execFileSync(
			"docker",
			["cp", `${agentContainerName}:${srcPath}`, "-"],
			{ maxBuffer: 256 * 1024 * 1024 },
		);
	} catch {
		return false;
	}
	try {
		execFileSync("docker", ["cp", "-", `${workingContainerName}:${destDir}`], {
			input: tar,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch {
		return false;
	}
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
 * Seed a freshly created working container's /project with the host project's
 * committed tree, so an agent CLI edits real project code and captureDiff()'s
 * `git diff` has a baseline to diff against. Without this, /project is an
 * empty, un-initialized volume and every dispatch dead-ends at
 * "success_no_diff" — the integration gate (INV-2) is never reached.
 *
 * INV-1: the tree crosses host->container as an in-memory tar Buffer piped
 * through `docker cp` — no host path is bind-mounted into the container (same
 * pattern provisionCredentials uses for credentials). Only the committed HEAD
 * tree is sent (`git archive HEAD` excludes .git), so no history, no untracked
 * scratch, and no uncommitted host changes bleed in. INV-3: the seed lives in
 * the disposable working container and is destroyed when it is wiped.
 *
 * The in-container baseline commit gives `git diff` a tree to diff against; its
 * commit hash need not match the host's — the integration gate applies the
 * returned diff with `git apply`, which matches context by CONTENT, not blob
 * hash, so a diff generated against this baseline lands cleanly on the
 * identical-content host tree.
 *
 * @param {string} workingContainerName Destination working container
 * @param {string} projectPath Host project path; must be a git repo with a
 *   committed HEAD (the baseline the agent works from)
 * @throws {Error} if the container name is unsafe, `git archive` fails (e.g. no
 *   commits yet), or the container-side baseline commit fails — a seed failure
 *   must abort the run loudly, never silently yield empty "success_no_diff".
 */
export function seedProject(workingContainerName, projectPath) {
	validateIdentifier(workingContainerName, "workingContainerName");

	// git archive HEAD => tar of the committed tree only (no .git), rooted at
	// the repo top. execFileSync (no shell) returns the tar as a Buffer; the
	// host path is an argv element, never interpolated into a command string.
	const tar = execFileSync("git", ["-C", projectPath, "archive", "HEAD"], {
		maxBuffer: 256 * 1024 * 1024,
	});

	// Extract that tar INTO /project (the container's isolated named volume);
	// /project already exists (createWorkingContainer set it as the workdir).
	execFileSync("docker", ["cp", "-", `${workingContainerName}:/project`], {
		input: tar,
		maxBuffer: 256 * 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
	});

	// Make /project a git repo whose baseline == the seeded tree so the agent's
	// edits surface under `git diff`. `git add -A -f` FORCE-adds every extracted
	// file: `git archive HEAD` faithfully includes files that were force-added
	// on the host despite matching a `.gitignore` pattern (e.g. a committed
	// `build/keep.txt` with `build/` ignored), but a plain `git add -A` would
	// re-honor that `.gitignore` and silently drop them from the baseline —
	// their later edits would then produce no diff and be lost (INV-2). Only the
	// archived tracked files are on disk, so `-f` re-adds exactly them, nothing
	// stray. The script is a constant (no host input interpolated) and runs
	// inside the container's own `sh` — there is no host shell, and the
	// container name was already validated above.
	execFileSync(
		"docker",
		[
			"exec",
			workingContainerName,
			"sh",
			"-c",
			"cd /project && git init -q && " +
				"git config user.email seed@switchyard.local && " +
				"git config user.name switchyard-seed && " +
				"git add -A -f && git commit --allow-empty -q -m baseline",
		],
		{ stdio: "pipe" },
	);
}

/**
 * Commit the working container's current tree so the NEXT task in the queue
 * diffs against it rather than against the original seed.
 *
 * The runner runs a whole task queue through ONE working container. Without
 * advancing the baseline between tasks, task 2's captureDiff (`git add -A` +
 * `git diff --cached`) re-emits task 1's still-uncommitted changes on top of
 * its own, so the host `git apply` rejects task 2 outright (task 1's hunks
 * already landed on the host). Committing task 1 inside the container isolates
 * each task's diff to just that task's work.
 *
 * Idempotent: a task that changed nothing leaves a clean index, so the commit
 * is skipped (`git diff --cached --quiet`) rather than failing on "nothing to
 * commit". INV-1/INV-3: this only ever mutates the disposable container's own
 * git state — no host path, no bind mount — and is destroyed at wipe. The
 * container name is validated before any docker call; the script is a constant.
 *
 * @param {string} workingContainerName
 */
export function commitWorkingTree(workingContainerName) {
	validateIdentifier(workingContainerName, "workingContainerName");
	execFileSync(
		"docker",
		[
			"exec",
			"-w",
			"/project",
			workingContainerName,
			"sh",
			"-c",
			"git add -A && (git diff --cached --quiet || git commit -q -m switchyard-task)",
		],
		{ stdio: "pipe" },
	);
}

/**
 * Reset the working container's /project to the last committed state,
 * discarding all uncommitted changes from a failed task. Uses `git reset --hard`
 * followed by `git clean -fd` to ensure no stray untracked files survive.
 *
 * INV-2: This prevents a rejected task's changes from contaminating the next
 * task's baseline. Without this, a failed task's edits persist in the working
 * tree and reappear in the next task's diff.
 *
 * @param {string} workingContainerName
 */
export function resetWorkingTree(workingContainerName) {
	validateIdentifier(workingContainerName, "workingContainerName");
	execFileSync(
		"docker",
		["exec", "-w", "/project", workingContainerName, "git", "reset", "--hard"],
		{ stdio: "pipe" },
	);
	execFileSync(
		"docker",
		["exec", "-w", "/project", workingContainerName, "git", "clean", "-fd"],
		{ stdio: "pipe" },
	);
}

/**
 * Wipe working container at project end.
 * INV-3: Working container is wiped at project end
 * Idempotent: succeeds when containers/volumes are already absent.
 * @param {string} workingContainerName Working container name
 * @returns {{containerRemoved: boolean, volumeRemoved: boolean, verified: boolean}}
 */
export function wipeWorkingContainer(workingContainerName) {
	const results = {
		containerRemoved: false,
		volumeRemoved: false,
		verified: false,
	};

	// Step 1: Stop container (idempotent — succeeds if stopped or doesn't exist)
	try {
		execFileSync("docker", ["stop", workingContainerName], {
			stdio: "pipe",
			timeout: 15_000,
		});
	} catch {
		/* already stopped or doesn't exist */
	}

	// Step 2: Remove container (idempotent)
	try {
		execFileSync("docker", ["rm", workingContainerName], { stdio: "pipe" });
		results.containerRemoved = true;
	} catch {
		/* doesn't exist */
	}

	// Step 3: Remove volume (idempotent — doesn't fail if already gone)
	try {
		execFileSync("docker", ["volume", "rm", `${workingContainerName}-vol`], {
			stdio: "pipe",
		});
		results.volumeRemoved = true;
	} catch {
		/* doesn't exist */
	}

	// Step 4: Verify absence
	const containerExists = workingContainerExists(workingContainerName);
	let volumeExists = false;
	try {
		const out = execFileSync(
			"docker",
			["volume", "ls", "-q", "--filter", `name=^${workingContainerName}-vol$`],
			{ encoding: "utf8", stdio: "pipe" },
		);
		volumeExists = out.trim().length > 0;
	} catch {
		/* ignore */
	}

	results.verified = !containerExists && !volumeExists;

	return results;
}

/**
 * List all containers with the Switchyard managed label.
 * @returns {Array<{name: string, runId: string, project: string, status: string}>}
 */
export function listManagedContainers() {
	try {
		const out = execFileSync(
			"docker",
			[
				"ps",
				"-a",
				"--filter",
				`label=${LABEL_MANAGED}`,
				"--format",
				`{{.Names}}\t{{.Label "${LABEL_RUN_ID}"}}\t{{.Label "${LABEL_PROJECT}"}}\t{{.State}}`,
			],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return out
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [name, runId, project, status] = line.split("\t");
				return { name, runId, project, status };
			});
	} catch (error) {
		console.error("Failed to list managed containers:", error.message);
		return [];
	}
}

/**
 * List all volumes with the Switchyard managed label.
 * @returns {Array<{name: string, runId: string}>}
 */
export function listManagedVolumes() {
	let names;
	try {
		names = execFileSync(
			"docker",
			["volume", "ls", "-q", "--filter", `label=${LABEL_MANAGED}`],
			{ encoding: "utf8", stdio: "pipe" },
		)
			.trim()
			.split("\n")
			.filter(Boolean);
	} catch (error) {
		console.error("Failed to list managed volumes:", error.message);
		return [];
	}

	if (names.length === 0) return [];

	let json;
	try {
		json = JSON.parse(
			execFileSync("docker", ["volume", "inspect", ...names], {
				encoding: "utf8",
				stdio: "pipe",
			}),
		);
	} catch (parseError) {
		console.error(
			"Failed to parse docker volume inspect output:",
			parseError.message,
		);
		return [];
	}

	return json.map((v) => ({
		name: v.Name,
		runId: v.Labels?.[LABEL_RUN_ID] || "",
	}));
}

/**
 * Recover orphaned Switchyard-managed containers and volumes.
 * Only reclaims objects whose owning run is demonstrably dead.
 * Active runs, standing agent containers, and ambiguous owners are never touched.
 *
 * If `isRunActive` is not provided or is not a function, every managed object
 * is treated as still active and nothing is reclaimed (silent no-op).
 *
 * @param {object} options
 * @param {Function} [options.isRunActive] — (runId: string) => boolean
 *   Called for each managed object's runId. Should return true if the run
 *   is still active (has a live process or unexpired lease).
 *   When absent, defaults to treating every run as active (reclaims nothing).
 * @param {boolean} [options.dryRun] — if true, report but don't delete
 * @param {Function} [options.onStatus] — callback(recoveryEvent) for diagnostics
 * @returns {{containersReclaimed: number, volumesReclaimed: number,
 *   errors: string[]}}
 */
export function recoverManagedObjects(options = {}) {
	const { isRunActive, dryRun = false, onStatus } = options;

	const result = {
		containersReclaimed: 0,
		volumesReclaimed: 0,
		errors: [],
	};

	const emit = (event) => {
		if (onStatus) onStatus(event);
	};

	const checkActive = (runId) => {
		if (typeof isRunActive !== "function") return true;
		return isRunActive(runId);
	};

	const containers = listManagedContainers();
	for (const container of containers) {
		if (container.name === AGENT_CONTAINER_NAME) {
			emit({
				type: "skip",
				object: "container",
				name: container.name,
				reason: "standing-agent",
			});
			continue;
		}

		if (!container.runId || container.runId === "") {
			result.errors.push(
				`Container ${container.name} has empty/missing runId label`,
			);
			emit({
				type: "error",
				object: "container",
				name: container.name,
				reason: "missing-run-id",
			});
			continue;
		}

		if (checkActive(container.runId)) {
			emit({
				type: "skip",
				object: "container",
				name: container.name,
				runId: container.runId,
				reason: "active-run",
			});
			continue;
		}

		if (dryRun) {
			emit({
				type: "would-reclaim",
				object: "container",
				name: container.name,
				runId: container.runId,
			});
			result.containersReclaimed += 1;
			continue;
		}

		try {
			execFileSync("docker", ["stop", container.name], {
				stdio: "pipe",
				timeout: 15_000,
			});
		} catch {
			/* already stopped */
		}

		try {
			execFileSync("docker", ["rm", container.name], { stdio: "pipe" });
			result.containersReclaimed += 1;
			emit({
				type: "reclaimed",
				object: "container",
				name: container.name,
				runId: container.runId,
			});
		} catch (e) {
			result.errors.push(
				`Failed to remove container ${container.name}: ${e.message}`,
			);
			emit({
				type: "error",
				object: "container",
				name: container.name,
				reason: "rm-failed",
				error: e.message,
			});
		}
	}

	const volumes = listManagedVolumes();
	for (const volume of volumes) {
		if (!volume.runId || volume.runId === "") {
			result.errors.push(`Volume ${volume.name} has empty/missing runId label`);
			emit({
				type: "error",
				object: "volume",
				name: volume.name,
				reason: "missing-run-id",
			});
			continue;
		}

		if (checkActive(volume.runId)) {
			emit({
				type: "skip",
				object: "volume",
				name: volume.name,
				runId: volume.runId,
				reason: "active-run",
			});
			continue;
		}

		if (dryRun) {
			emit({
				type: "would-reclaim",
				object: "volume",
				name: volume.name,
				runId: volume.runId,
			});
			result.volumesReclaimed += 1;
			continue;
		}

		try {
			execFileSync("docker", ["volume", "rm", volume.name], { stdio: "pipe" });
			result.volumesReclaimed += 1;
			emit({
				type: "reclaimed",
				object: "volume",
				name: volume.name,
				runId: volume.runId,
			});
		} catch (e) {
			result.errors.push(
				`Failed to remove volume ${volume.name}: ${e.message}`,
			);
			emit({
				type: "error",
				object: "volume",
				name: volume.name,
				reason: "rm-failed",
				error: e.message,
			});
		}
	}

	return result;
}

/**
 * Check if working container exists.
 * @param {string} workingContainerName Working container name
 * @returns {boolean}
 */
export function workingContainerExists(workingContainerName) {
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
		const output = execFileSync(
			"docker",
			[
				"ps",
				"-a",
				"--filter",
				`name=^/${workingContainerName}$`,
				"--format",
				"{{.Names}}",
			],
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
	validateIdentifier(workingContainerName, "workingContainerName");
	const result = execFileSync(
		"docker",
		["exec", workingContainerName, "sh", "-c", command],
		{ encoding: "utf8", stdio: "pipe" },
	);
	return result.trim();
}
