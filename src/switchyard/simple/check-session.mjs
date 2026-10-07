import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { integrationGate } from "../integrate/index.mjs";
import { materializeDirtyOverlay } from "../lifecycle/index.mjs";
import { parseCommand } from "../runner/check-contract.mjs";
import { trustedOfflineNpmEnv } from "../runner/check-dependencies.mjs";
import {
	quickCheckSandboxProfile,
	safeEnv,
} from "../runner/checks-sandbox.mjs";
import {
	MAX_CAPTURE_BYTES,
	requireGit,
	requireWorktreeGit,
	SECRET_PATHS,
	snapshotGitControl,
	verifyGitControl,
} from "./args.mjs";
import { EVIDENCE_TAIL_BYTES, evidenceTail } from "./check-environment.mjs";
import { commandWords, resolveCheckExecution } from "./check-execution.mjs";
import {
	declaredPathDependencies,
	pathDependenciesUnchanged,
	venvPathEntries,
} from "./path-dependencies.mjs";
import { runSimpleWriter } from "./provider-invocation.mjs";

function refused(code, details = null) {
	return Object.assign(new Error(code), { code }, details);
}

/** Longest a sandbox executable-resolution probe may run. */
const RESOLVE_EXECUTABLE_PROBE_CAP_MS = 30_000;
const MAX_EXECUTABLE_PATH_CHARS = 256;

/** One `command -v` answer, only when it is a bounded absolute path. */
function absoluteExecutablePath(value) {
	if (typeof value !== "string") return null;
	const path = value.trim();
	return path.length > 0 &&
		path.length <= MAX_EXECUTABLE_PATH_CHARS &&
		isAbsolute(path) &&
		!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path)
		? path
		: null;
}

// Failed-check tails stay host-side diagnostics: the result carries this path
// and never the bytes themselves.
function writeCheckEvidence(directory, attempt, index, check) {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, `${attempt}-${index}.log`);
	writeFileSync(
		path,
		Buffer.concat([
			evidenceTail(check?.output, EVIDENCE_TAIL_BYTES),
			evidenceTail(check?.stderr, EVIDENCE_TAIL_BYTES),
		]),
		{ mode: 0o600 },
	);
	return path;
}

function checksNeedNodePackages(commands, checkout) {
	const heads = commands.flatMap((command) => commandWords(command) ?? []);
	const nodeTools = new Set([
		"node",
		"nodejs",
		"npm",
		"npx",
		"pnpm",
		"pnpx",
		"yarn",
		"bun",
		"bunx",
	]);
	if (heads.some((head) => nodeTools.has(basename(head)))) return true;
	if (heads.some((head) => head.includes("node_modules/.bin/"))) return true;
	let lock;
	try {
		lock = JSON.parse(
			readFileSync(join(checkout, "package-lock.json"), "utf8"),
		);
	} catch {
		return false;
	}
	const lockedBins = new Set();
	for (const [path, entry] of Object.entries(lock.packages ?? {})) {
		if (!path.startsWith("node_modules/")) continue;
		if (typeof entry?.bin === "string") lockedBins.add(basename(path));
		else if (entry?.bin && typeof entry.bin === "object") {
			for (const name of Object.keys(entry.bin)) lockedBins.add(name);
		}
	}
	return heads.some((head) => lockedBins.has(head));
}

// A project venv is an explicit dependency input: the checker clone links to
// the trusted interpreter instead of copying it, and a venv whose real path
// leaves the project is refused rather than exposed to the sandbox.
function linkPythonVenv(projectPath, clonePath) {
	const venv = join(projectPath, ".venv");
	if (!existsSync(venv)) return [];
	const resolved = realpathSync(venv);
	if (!resolved.startsWith(`${realpathSync(projectPath)}/`))
		throw refused("check_venv_outside_project");
	const linked = join(clonePath, ".venv");
	if (!existsSync(linked)) symlinkSync(resolved, linked);
	return [resolved, ...venvBaseInterpreterPrefix(resolved)];
}

// A venv's bin/python links to its base interpreter (uv, pyenv, Homebrew or
// python.org), which lives outside the project; the sandbox may read and exec
// that one interpreter prefix, named by pyvenv.cfg `home`, and nothing beside it.
function venvBaseInterpreterPrefix(venv) {
	let declared;
	let home;
	try {
		const config = readFileSync(join(venv, "pyvenv.cfg"), "utf8");
		declared = /^home\s*=\s*(.+?)\s*$/mu.exec(config)?.[1];
		if (!declared || !isAbsolute(declared)) return [];
		home = realpathSync(declared);
	} catch {
		return [];
	}
	if (!readdirSync(home).some((name) => /^python3(\.\d+)?$/u.test(name)))
		return [];
	const prefix = dirname(home);
	if (prefix === "/" || prefix === "/usr") return [];
	const alias = dirname(declared);
	return alias === prefix ? [prefix] : [prefix, alias];
}

/** Disposable checkers remain inside the enclosing run's durable owned root. */
export function createSimpleCheckSessions({
	taskRoot,
	projectPath,
	baseRevision,
	baseTree,
	dirtyOverlayReceipt,
	files,
	allowManifests = [],
	commands,
	taskId,
	deadlineMs,
	now = Date.now,
	signal,
	onProgress,
	cachePath,
	evidenceDir = null,
}) {
	let active = null;
	let lifecycle = "never_started";
	let evidenceAttempt = 1;
	let evidenceIndex = 0;
	function timeout() {
		if (signal?.aborted) throw refused("cancelled");
		const remaining = deadlineMs - now();
		if (remaining <= 0) throw refused("deadline_expired");
		return remaining;
	}
	function git(path, args) {
		const control = active?.gitControl;
		if (control) verifyGitControl(path, control);
		return requireWorktreeGit(path, args, "check_session_base_unavailable", {
			timeout: timeout(),
		}).trim();
	}
	async function confined(
		command,
		args,
		env,
		reads = [],
		progress = onProgress,
		timeoutMsOverride = null,
		ownerCommand = undefined,
	) {
		const remaining = timeout();
		// A per-call cap can only shorten the run, never extend the deadline.
		const timeoutMs =
			Number.isFinite(timeoutMsOverride) && timeoutMsOverride > 0
				? Math.min(timeoutMsOverride, remaining)
				: remaining;
		if (!pathDependenciesUnchanged(active.pathDependencies, active.pathEntries))
			throw refused("check_dependencies_unverified");
		// Only an owner check's own command can earn command-specific grants
		// (xcodebuild build); probes, readiness and setup never pass one.
		const profile = quickCheckSandboxProfile(
			active.path,
			active.runtime,
			[...reads, ...active.readOnlyPaths],
			{ command: ownerCommand },
		);
		lifecycle = "unavailable";
		const result = await runSimpleWriter(
			"/usr/bin/sandbox-exec",
			["-p", profile, command, ...args],
			{
				cwd: active.path,
				env,
				processScopePath: active.root,
				timeoutMs,
				maxBuffer: MAX_CAPTURE_BYTES,
				onPoll: progress,
				signal,
			},
		);
		lifecycle = result.writerLifecycle;
		return result;
	}
	// The pre-provider dry run compares where the first word of a failed check
	// resolves in the check sandbox and on the host PATH. This read-only probe
	// waits for its own work and never changes the session's lifecycle proof.
	async function resolveCheckExecutables(command) {
		if (!active) return null;
		const words = commandWords(command);
		if (!words || words.length === 0) return null;
		const word = words[0];
		const remaining = deadlineMs - now();
		if (remaining <= 0) return null;
		const env = safeEnv(active.runtime);
		let checkExecutable = null;
		try {
			const profile = quickCheckSandboxProfile(
				active.path,
				active.runtime,
				[...active.readOnlyPaths],
				{},
			);
			const result = await runSimpleWriter(
				"/usr/bin/sandbox-exec",
				[
					"-p",
					profile,
					"/bin/sh",
					"-c",
					'command -v -- "$1"',
					"check-executable",
					word,
				],
				{
					cwd: active.path,
					env,
					processScopePath: active.root,
					timeoutMs: Math.min(RESOLVE_EXECUTABLE_PROBE_CAP_MS, remaining),
					maxBuffer: 64 * 1024,
					signal,
				},
			);
			if (result?.success)
				checkExecutable = absoluteExecutablePath(result.output);
		} catch {
			checkExecutable = null;
		}
		if (checkExecutable === null) return null;
		let hostExecutable = null;
		try {
			const host = spawnSync(
				"/bin/sh",
				["-c", 'command -v -- "$1"', "check-executable", word],
				{ encoding: "utf8", env: { ...process.env }, timeout: 5000 },
			);
			if (host.status === 0)
				hostExecutable = absoluteExecutablePath(host.stdout);
		} catch {
			hostExecutable = null;
		}
		return hostExecutable !== null && hostExecutable !== checkExecutable
			? { checkExecutable, hostExecutable }
			: null;
	}
	function remove() {
		if (!active) return;
		if (!["stopped", "never_started"].includes(lifecycle))
			throw refused("check_group_unconfirmed");
		rmSync(active.root, { recursive: true, force: true });
		if (existsSync(active.root)) throw refused("check_session_cleanup_failed");
		active = null;
	}
	async function prepareSession(diff, attempt, markStep) {
		markStep("remove_session");
		remove();
		markStep("verify_deadline");
		timeout();
		onProgress?.();
		evidenceAttempt = attempt;
		evidenceIndex = 0;
		markStep("allocate_root");
		const root = mkdtempSync(join(taskRoot, "checker-"));
		active = {
			root,
			path: join(root, "checkout"),
			runtime: join(root, "runtime"),
			readOnlyPaths: [],
			pathDependencies: [],
			pathEntries: [],
		};
		lifecycle = "never_started";
		mkdirSync(active.runtime, { mode: 0o700 });
		// The checker clone is created from the trusted project before any check
		// code runs; the hardened helper presupposes an existing checkout.
		markStep("clone_checkout");
		requireGit(
			root,
			[
				"clone",
				"--shared",
				"--no-checkout",
				"--quiet",
				"--",
				projectPath,
				active.path,
			],
			"check_session_base_unavailable",
			{ timeout: timeout() },
		);
		markStep("checkout_base");
		git(active.path, ["checkout", "--detach", "--quiet", baseRevision]);
		if (dirtyOverlayReceipt) {
			markStep("materialize_overlay");
			materializeDirtyOverlay(active.path, dirtyOverlayReceipt, {
				maxFileBytes: MAX_CAPTURE_BYTES,
				secretPaths: SECRET_PATHS,
			});
		}
		markStep("stage_tree");
		git(active.path, ["add", "-A", "--", "."]);
		// A re-check session at an advanced HEAD plus a dirty overlay has no
		// precomputable tree: the checkout and the trusted receipt are the
		// baseline, so `baseTree: null` skips the exact-tree assertion.
		markStep("verify_base_tree");
		if (baseTree !== null && git(active.path, ["write-tree"]) !== baseTree)
			throw refused("check_session_base_mismatch");
		markStep("commit_base");
		git(active.path, [
			"-c",
			"user.name=switchyard",
			"-c",
			"user.email=switchyard@localhost",
			"commit",
			"--allow-empty",
			"-qm",
			"checker-base",
		]);
		markStep("configure_exclude");
		appendFileSync(
			join(active.path, ".git", "info", "exclude"),
			"\n/node_modules/\n/.venv\n",
		);
		markStep("link_python_venv");
		active.readOnlyPaths.push(...linkPythonVenv(projectPath, active.path));
		// Path dependencies come from the trusted project's manifests, never the
		// candidate's, so a diff cannot widen what the sandbox may read.
		markStep("resolve_path_dependencies");
		active.pathDependencies = declaredPathDependencies(projectPath);
		active.pathEntries = venvPathEntries(projectPath, active.pathDependencies);
		active.readOnlyPaths.push(
			...active.pathDependencies,
			...active.pathEntries,
		);
		markStep("snapshot_git_control");
		active.gitControl = snapshotGitControl(active.path);
		markStep("probe_environment");
		const env = safeEnv(active.runtime);
		const probe = await confined("/usr/bin/true", [], env);
		if (!probe.success || lifecycle !== "stopped")
			throw refused("check_environment_unavailable");
		// Node tests may import locked packages even when no package binary is named.
		markStep("inspect_manifests");
		const packagePresent = existsSync(join(active.path, "package.json"));
		const needsNodePackages = checksNeedNodePackages(commands, active.path);
		let provision = false;
		if (packagePresent && needsNodePackages) {
			const manifest = JSON.parse(
				readFileSync(join(active.path, "package.json"), "utf8"),
			);
			provision = [
				"dependencies",
				"devDependencies",
				"optionalDependencies",
			].some((group) => Object.keys(manifest[group] ?? {}).length);
		}
		const manifests = ["package.json", "package-lock.json"].map((name) => ({
			name,
			bytes: existsSync(join(active.path, name))
				? readFileSync(join(active.path, name))
				: null,
		}));
		if (diff) {
			markStep("verify_candidate_manifests");
			verifyGitControl(active.path, active.gitControl);
			const result = integrationGate(diff, active.path, {
				allowedPaths: files,
				allowSensitiveManifests: allowManifests.length > 0,
			});
			if (!result.success) throw refused("check_candidate_rejected");
			for (const { name, bytes } of needsNodePackages ? manifests : []) {
				const candidate = existsSync(join(active.path, name))
					? readFileSync(join(active.path, name))
					: null;
				if (bytes ? !candidate || !bytes.equals(candidate) : candidate !== null)
					throw refused("check_dependencies_unverified", {
						dependencyCheck: "manifest_changed_by_diff",
						manifestName: name,
					});
			}
		}
		if (provision) {
			markStep("provision_dependencies");
			const setupEnv = trustedOfflineNpmEnv(
				projectPath,
				active.path,
				env,
				cachePath,
			);
			if (!setupEnv)
				throw refused("check_dependencies_unverified", {
					dependencyCheck: "offline_npm_unavailable",
				});
			const [tool, ...args] = parseCommand(
				"npm ci --ignore-scripts --offline",
				taskId,
				true,
			);
			const setup = await confined(
				`/opt/homebrew/bin/${tool}`,
				args,
				setupEnv,
				[setupEnv.npm_config_cache],
			);
			if (!setup.success || lifecycle !== "stopped")
				throw refused("check_dependencies_unverified", {
					dependencyCheck: "npm_ci_failed",
				});
		}
		markStep("validate_commands");
		for (const [index, command] of commands.entries()) {
			// Command parseability is checked before resolution so an unparseable
			// command is never mistaken for a rejected package launch.
			const words = commandWords(command);
			if (!words)
				throw refused("check_dependencies_unverified", {
					dependencyCheck: "command_unparsed",
					checkIndex: index + 1,
				});
			const execution = resolveCheckExecution(command, active.path);
			if (execution.kind === "rejected")
				throw refused("check_dependencies_unverified", {
					dependencyCheck: "command_rejected",
					checkIndex: index + 1,
				});
			for (const word of words) {
				if (execution.kind === "local") break;
				const ready = await confined(
					"/bin/sh",
					["-c", 'command -v "$1" >/dev/null', "check-readiness", word],
					env,
				);
				if (!ready.success || lifecycle !== "stopped")
					throw refused("check_environment_unavailable");
			}
		}
		return active.path;
	}
	// A prepare refusal names the closed step it failed in; the step name stays
	// alongside the thrown error so the engine can persist it without ever
	// persisting the error's message text.
	async function prepare(diff = null, attempt = 1) {
		let checkSetupStep = "remove_session";
		try {
			return await prepareSession(diff, attempt, (step) => {
				checkSetupStep = step;
			});
		} catch (error) {
			if (
				error !== null &&
				typeof error === "object" &&
				!("checkSetupStep" in error)
			) {
				try {
					error.checkSetupStep = checkSetupStep;
				} catch {}
			}
			throw error;
		}
	}
	async function run({ command, onProgress: progress, timeoutMs = null }) {
		if (!active) throw refused("check_session_unavailable");
		const execution = resolveCheckExecution(command, active.path);
		if (execution.kind === "rejected")
			throw refused("check_dependencies_unverified", {
				dependencyCheck: "command_rejected",
			});
		const result = await confined(
			execution.kind === "local" ? execution.command : "/bin/sh",
			execution.kind === "local" ? execution.args : ["-c", command],
			safeEnv(active.runtime),
			[],
			progress,
			timeoutMs,
			command,
		);
		// Evidence files are named <attempt>-<check position>; attempt 0 is the
		// baseline run.
		evidenceIndex += 1;
		if (result?.success || !evidenceDir) return result;
		try {
			return {
				...result,
				outputPath: writeCheckEvidence(
					evidenceDir,
					evidenceAttempt,
					evidenceIndex,
					result,
				),
			};
		} catch {
			// Evidence retention must never change the check's gate result.
			return result;
		}
	}
	// Opt-in formatter: run inside the same sandbox that will run the checks so
	// its rewrite lands in the checker clone that already holds the candidate,
	// then capture the clone's base-relative diff for the caller. A nonzero
	// format exit is the caller's advisory signal, never this session's gate.
	async function format({ command, onProgress: progress, timeoutMs = null }) {
		if (!active) throw refused("check_session_unavailable");
		const execution = resolveCheckExecution(command, active.path);
		if (execution.kind === "rejected")
			throw refused("check_dependencies_unverified", {
				dependencyCheck: "command_rejected",
			});
		const result = await confined(
			execution.kind === "local" ? execution.command : "/bin/sh",
			execution.kind === "local" ? execution.args : ["-c", command],
			safeEnv(active.runtime),
			[],
			progress,
			timeoutMs,
			command,
		);
		verifyGitControl(active.path, active.gitControl);
		requireWorktreeGit(
			active.path,
			["add", "-A", "--", "."],
			"diff_stage_failed",
			{ timeout: timeout() },
		);
		const names = requireWorktreeGit(
			active.path,
			["diff", "--cached", "--name-only", "-z", "HEAD"],
			"diff_names_failed",
			{ timeout: timeout() },
		);
		const diff = requireWorktreeGit(
			active.path,
			["diff", "--cached", "--binary", "--full-index", "HEAD"],
			"diff_capture_failed",
			{ maxBuffer: MAX_CAPTURE_BYTES, timeout: timeout() },
		);
		return {
			...result,
			changedFiles: names.split("\0").filter(Boolean),
			diff,
		};
	}
	return {
		prepare,
		remove,
		run,
		format,
		resolveCheckExecutables,
		get path() {
			return active?.path;
		},
		get gitControlSnapshot() {
			return active?.gitControl ?? null;
		},
		get writerLifecycle() {
			return lifecycle;
		},
	};
}
