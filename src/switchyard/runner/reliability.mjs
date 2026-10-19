import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PERSISTED_SIGNALS } from "../adapter/exec-error-kinds.mjs";
import { quickCheckSandboxProfile, safeEnv } from "./checks-sandbox.mjs";

const SELF = fileURLToPath(new URL("./checks.mjs", import.meta.url));
const WORKER_GROUP_CLEANUP = new Set(["complete", "unknown"]);
const WORKER_RESULT_KEYS = "exitCode,groupCleanup,signal,timedOut";

function unknownCommandResult(timedOut = false) {
	return {
		exitCode: null,
		signal: null,
		timedOut,
		groupCleanup: "unknown",
	};
}

function closedWorkerResult(value) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(",") !== WORKER_RESULT_KEYS
	)
		return null;
	if (
		(value.exitCode !== null &&
			(!Number.isSafeInteger(value.exitCode) ||
				value.exitCode < 0 ||
				value.exitCode > 255)) ||
		(value.signal !== null && !PERSISTED_SIGNALS.has(value.signal)) ||
		(value.exitCode !== null && value.signal !== null) ||
		typeof value.timedOut !== "boolean" ||
		!WORKER_GROUP_CLEANUP.has(value.groupCleanup)
	)
		return null;
	return {
		exitCode: value.exitCode,
		signal: value.signal,
		timedOut: value.timedOut,
		groupCleanup: value.groupCleanup,
	};
}

export function runCommand(
	cwd,
	env,
	argv,
	timeoutMs,
	{
		sandbox = true,
		spawnSync: runSpawnSync = spawnSync,
		command,
		readOnlyPaths = [],
	} = {},
) {
	if (process.platform !== "darwin" && runSpawnSync === spawnSync)
		return unknownCommandResult();
	let result;
	try {
		result = runSpawnSync(
			process.execPath,
			[
				SELF,
				"--quick-check-worker",
				JSON.stringify({
					cwd,
					argv,
					timeoutMs,
					sandbox,
					// `command` is the owner check's argv; setup never passes one.
					profile: sandbox
						? quickCheckSandboxProfile(cwd, env.HOME, readOnlyPaths, {
								command,
							})
						: null,
				}),
			],
			{
				cwd,
				env,
				encoding: "utf8",
				timeout: timeoutMs + 10_000,
				maxBuffer: 1024,
				stdio: ["ignore", "pipe", "inherit"],
			},
		);
	} catch {
		return unknownCommandResult();
	}
	if (result?.error?.code === "ETIMEDOUT") return unknownCommandResult(true);
	if (result?.error || result?.status !== 0) return unknownCommandResult();
	try {
		const parsed = JSON.parse(result.stdout);
		const closed = closedWorkerResult(parsed);
		if (closed) return closed;
	} catch {
		/* closed unknown receipt */
	}
	return unknownCommandResult();
}

export function settleScopedChecksSync(root, launchedAt) {
	const result = spawnSync(
		process.execPath,
		[SELF, "--quick-check-settle", JSON.stringify({ root, launchedAt })],
		{
			env: safeEnv(root),
			encoding: "utf8",
			timeout: 12_000,
			maxBuffer: 64,
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	return result.status === 0 && result.stdout === "stopped";
}

export function gateCandidate(
	cwd,
	env,
	diff,
	allowedPaths,
	allowSensitiveManifests,
) {
	const result = spawnSync(process.execPath, [SELF, "--quick-check-gate"], {
		cwd,
		env,
		input: JSON.stringify({ diff, allowedPaths, allowSensitiveManifests }),
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 1024,
		stdio: ["pipe", "pipe", "ignore"],
	});
	return result.status === 0 && result.stdout === "passed";
}
