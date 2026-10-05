import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { basename, join } from "node:path";
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
import { commandWords, resolveCheckExecution } from "./check-execution.mjs";
import { runSimpleWriter } from "./provider-invocation.mjs";

function refused(code) {
	return Object.assign(new Error(code), { code });
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
}) {
	let active = null;
	let lifecycle = "never_started";
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
	) {
		const timeoutMs = timeout();
		const profile = quickCheckSandboxProfile(
			active.path,
			active.runtime,
			reads,
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
	function remove() {
		if (!active) return;
		if (!["stopped", "never_started"].includes(lifecycle))
			throw refused("check_group_unconfirmed");
		rmSync(active.root, { recursive: true, force: true });
		if (existsSync(active.root)) throw refused("check_session_cleanup_failed");
		active = null;
	}
	async function prepare(diff = null) {
		remove();
		timeout();
		onProgress?.();
		const root = mkdtempSync(join(taskRoot, "checker-"));
		active = {
			root,
			path: join(root, "checkout"),
			runtime: join(root, "runtime"),
		};
		lifecycle = "never_started";
		mkdirSync(active.runtime, { mode: 0o700 });
		// The checker clone is created from the trusted project before any check
		// code runs; the hardened helper presupposes an existing checkout.
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
		git(active.path, ["checkout", "--detach", "--quiet", baseRevision]);
		if (dirtyOverlayReceipt)
			materializeDirtyOverlay(active.path, dirtyOverlayReceipt, {
				maxFileBytes: MAX_CAPTURE_BYTES,
				secretPaths: SECRET_PATHS,
			});
		git(active.path, ["add", "-A", "--", "."]);
		if (git(active.path, ["write-tree"]) !== baseTree)
			throw refused("check_session_base_mismatch");
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
		appendFileSync(
			join(active.path, ".git", "info", "exclude"),
			"\n/node_modules/\n",
		);
		active.gitControl = snapshotGitControl(active.path);
		const env = safeEnv(active.runtime);
		const probe = await confined("/usr/bin/true", [], env);
		if (!probe.success || lifecycle !== "stopped")
			throw refused("check_environment_unavailable");
		// Node tests may import locked packages even when no package binary is named.
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
					throw refused("check_dependencies_unverified");
			}
		}
		if (provision) {
			const setupEnv = trustedOfflineNpmEnv(
				projectPath,
				active.path,
				env,
				cachePath,
			);
			if (!setupEnv) throw refused("check_dependencies_unverified");
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
				throw refused("check_dependencies_unverified");
		}
		for (const command of commands) {
			const execution = resolveCheckExecution(command, active.path);
			if (execution.kind === "rejected")
				throw refused("check_dependencies_unverified");
			const words = commandWords(command);
			if (!words) throw refused("check_dependencies_unverified");
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
	async function run({ command, onProgress: progress }) {
		if (!active) throw refused("check_session_unavailable");
		const execution = resolveCheckExecution(command, active.path);
		if (execution.kind === "rejected")
			throw refused("check_dependencies_unverified");
		return confined(
			execution.kind === "local" ? execution.command : "/bin/sh",
			execution.kind === "local" ? execution.args : ["-c", command],
			safeEnv(active.runtime),
			[],
			progress,
		);
	}
	return {
		prepare,
		remove,
		run,
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
