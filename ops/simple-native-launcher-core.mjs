// Provider-neutral core for running native coding assistants under macOS Seatbelt.
// Handles worktree validation, clone detachment, Seatbelt profile generation,
// environment isolation, bounded I/O, process-group lifecycle, and heartbeat logging.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, sep } from "node:path";

/** Fixed restricted PATH for sandboxed processes and child git commands. */
export const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** Maximum prompt size accepted on stdin (256 KB). */
export const MAX_PROMPT = 256 * 1024;

/** Maximum stdout/stderr output captured before terminating (8 MB). */
export const MAX_OUTPUT = 8 * 1024 * 1024;

/** Default process execution timeout (30 minutes). */
export const MAX_WAIT_MS = 30 * 60 * 1000;

// biome-ignore lint/complexity/useRegexLiterals: control-byte grammar is easier to audit as string data.
export const TERMINAL_ESCAPE_PATTERN = new RegExp(
	String.raw`\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*(?:\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)`,
	"gu",
);

// biome-ignore lint/complexity/useRegexLiterals: control-byte grammar is easier to audit as string data.
export const UNSAFE_CONTROL_PATTERN = new RegExp(
	String.raw`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]`,
	"gu",
);

/**
 * Strips ANSI terminal escape sequences and unsafe control bytes from output.
 * @param {Buffer | string} bytes
 * @returns {string}
 */
export const boundedText = (bytes) =>
	bytes
		.toString("utf8")
		.replace(TERMINAL_ESCAPE_PATTERN, "")
		.replace(UNSAFE_CONTROL_PATTERN, "");

/**
 * Creates a fail helper that throws an Error prefixed with the given label.
 * @param {string} label Label prepended to error messages.
 * @returns {(reason: string) => never}
 */
export function createFail(label) {
	return (reason) => {
		throw new Error(`${label}: ${reason}`);
	};
}

/**
 * Validates that a worktree path is an absolute, canonical disposable clone directory.
 * @param {string} path Candidate worktree path.
 * @param {(reason: string) => never} [fail] Fail callback.
 * @returns {string} The validated canonical worktree path.
 */
export function safeWorktree(
	path,
	fail = createFail("simple-native-launcher-core"),
) {
	if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0"))
		fail("worktree must be absolute");
	let isCanonical = false;
	try {
		isCanonical =
			realpathSync(path) === path &&
			!lstatSync(path).isSymbolicLink() &&
			lstatSync(path).isDirectory();
	} catch {}
	if (!isCanonical) fail("worktree must be a canonical directory");
	const parent = dirname(path);
	if (
		!/^switchyard-simple-[0-9a-f-]{36}$/iu.test(parent.split(sep).at(-1)) ||
		path !== join(parent, "worktree")
	)
		fail("worktree is not a simple disposable clone");
	if (
		!existsSync(join(parent, ".switchyard-cleanup-owner.json")) ||
		!existsSync(join(path, ".git"))
	)
		fail("worktree ownership marker is absent");
	return path;
}

/**
 * Detaches git alternates for a shared clone by repacking objects and checking connectivity.
 * @param {string} worktree Canonical worktree path.
 * @param {(reason: string) => never} [fail] Fail callback.
 */
export function detachSharedClone(
	worktree,
	fail = createFail("simple-native-launcher-core"),
) {
	const alternate = join(worktree, ".git", "objects", "info", "alternates");
	if (!existsSync(alternate)) return;
	const env = {
		PATH: SAFE_PATH,
		HOME: dirname(worktree),
		LC_ALL: "C",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	const run = (args) =>
		spawnSync("/usr/bin/git", ["-C", worktree, ...args], {
			env,
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
			timeout: 120_000,
		});
	if (run(["repack", "-a", "-d"]).status !== 0)
		fail("shared clone could not be detached");
	unlinkSync(alternate);
	if (run(["fsck", "--connectivity-only", "--no-reflogs"]).status !== 0)
		fail("detached clone connectivity check failed");
}

/**
 * Sends a signal to the child's process group.
 * @param {import("node:child_process").ChildProcess} child Child process.
 * @param {NodeJS.Signals | number} signal Signal to send.
 */
export function killGroup(child, signal) {
	if (!child?.pid) return;
	try {
		process.kill(-child.pid, signal);
	} catch {}
}

/**
 * Checks whether any process in the child's process group is still alive.
 * @param {import("node:child_process").ChildProcess} child Child process.
 * @returns {boolean} True if the group is still present.
 */
export function groupPresent(child) {
	if (!child?.pid) return false;
	try {
		process.kill(-child.pid, 0);
		return true;
	} catch (error) {
		return error?.code !== "ESRCH";
	}
}

/**
 * Attempts graceful SIGTERM teardown then forceful SIGKILL on a child's process group.
 * @param {import("node:child_process").ChildProcess} child Child process.
 * @returns {Promise<boolean>} True if the process group stopped completely.
 */
export async function settleGroup(child) {
	if (!groupPresent(child)) return true;
	killGroup(child, "SIGTERM");
	for (let i = 0; i < 10 && groupPresent(child); i += 1)
		await new Promise((done) => setTimeout(done, 100));
	if (!groupPresent(child)) return true;
	killGroup(child, "SIGKILL");
	for (let i = 0; i < 40 && groupPresent(child); i += 1)
		await new Promise((done) => setTimeout(done, 100));
	return !groupPresent(child);
}

/**
 * Reads bounded UTF-8 text from stdin up to MAX_PROMPT bytes.
 * @param {(reason: string) => never} [fail] Fail callback.
 * @returns {Promise<string>} Stdin content as UTF-8 string.
 */
export async function readBoundedStdin(
	fail = createFail("simple-native-launcher-core"),
) {
	const chunks = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size > MAX_PROMPT) fail("prompt too large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * Formats a path as a Seatbelt Scheme string literal.
 * @param {string} path File system path.
 * @returns {string} JSON-quoted Scheme string.
 */
export const schemePath = (path) => JSON.stringify(path);

/**
 * Generates shared Seatbelt profile rules for sandboxed native execution.
 * @param {object} [options] Profile options.
 * @param {string[]} [options.reads] Paths allowed for subpath reading.
 * @param {string[]} [options.writes] Paths allowed for subpath writing.
 * @returns {string} Seatbelt profile rule text.
 */
export function baseSeatbeltRules({ reads = [], writes = [] } = {}) {
	const readRules =
		reads.length > 0
			? [
					`(allow file-read* ${reads.map((p) => `(subpath ${schemePath(p)})`).join(" ")})`,
				]
			: [];
	const writeEntries = [
		...writes.map((p) => `(subpath ${schemePath(p)})`),
		'(literal "/dev/null")',
	];
	return [
		"(version 1)",
		"(deny default)",
		"(allow process-exec)",
		"(allow process-fork)",
		"(allow sysctl-read)",
		'(allow file-read* (literal "/"))',
		...readRules,
		"(allow file-read-metadata)",
		`(allow file-write* ${writeEntries.join(" ")})`,
		"(allow mach-lookup)",
		"(allow ipc-posix-shm)",
		'(allow network-outbound (remote tcp "*:443") (literal "/private/var/run/mDNSResponder") (remote udp "*:53"))',
	].join("\n");
}

/**
 * Spawns and manages a native provider CLI inside a Seatbelt sandbox.
 * @param {object} options Execution options.
 * @param {(reason: string) => never} [options.fail] Fail callback.
 * @param {string} [options.label] Heartbeat provider label.
 * @param {string} options.worktree Canonical worktree path.
 * @param {string} options.prompt Task prompt sent to CLI stdin.
 * @param {string} options.cliPath Executable path for provider CLI.
 * @param {string[]} [options.args] Arguments for provider CLI.
 * @param {Record<string, string>} [options.env] Environment variables.
 * @param {string} options.profile Seatbelt profile text.
 * @param {string} [options.runtime] Runtime directory path.
 * @param {number} [options.timeoutMs] Execution timeout in ms.
 * @param {(result: { code: number, stdout: string, stderr: string }) => void | Promise<void>} [options.verify] Verification hook on exit code 0.
 * @param {string} [options.sandboxExec] Path to sandbox-exec executable.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function runSandboxedNative({
	fail = createFail("simple-native-launcher-core"),
	label = "provider",
	worktree,
	prompt,
	cliPath,
	args = [],
	env = {},
	profile,
	runtime: _runtime,
	timeoutMs = MAX_WAIT_MS,
	verify,
	sandboxExec = "/usr/bin/sandbox-exec",
}) {
	if (typeof profile !== "string" || !profile.trim())
		fail("seatbelt profile is required");
	if (
		typeof prompt !== "string" ||
		!prompt ||
		Buffer.byteLength(prompt) > MAX_PROMPT
	)
		fail("prompt is empty or too large");

	let child;
	let interrupted = false;
	try {
		child = spawn(sandboxExec, ["-p", profile, cliPath, ...args], {
			cwd: worktree,
			env,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdinError = null;
		child.stdin.on("error", (error) => {
			stdinError = error;
			killGroup(child, "SIGTERM");
		});
		child.stdin.end(prompt);
		const output = [];
		const errors = [];
		let outputSize = 0;
		let errorSize = 0;
		child.stdout.on("data", (chunk) => {
			outputSize += chunk.length;
			if (outputSize <= MAX_OUTPUT) output.push(chunk);
			else killGroup(child, "SIGTERM");
		});
		child.stderr.on("data", (chunk) => {
			errorSize += chunk.length;
			if (errorSize <= MAX_OUTPUT) errors.push(chunk);
			else killGroup(child, "SIGTERM");
		});
		const heartbeatLabel = label
			? label.startsWith("native ")
				? label
				: `native ${label}`
			: "native provider";
		const heartbeat = setInterval(
			() =>
				process.stderr.write(`switchyard: ${heartbeatLabel} still running\n`),
			15_000,
		);
		const stop = () => {
			interrupted = true;
			killGroup(child, "SIGTERM");
			setTimeout(() => killGroup(child, "SIGKILL"), 1_000).unref();
		};
		const timer = setTimeout(stop, timeoutMs);
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		let status;
		try {
			status = await new Promise((done) => {
				child.once("error", (error) => done({ error }));
				child.once("close", (code, signal) => done({ code, signal }));
			});
		} finally {
			clearInterval(heartbeat);
			clearTimeout(timer);
			process.removeListener("SIGTERM", stop);
			process.removeListener("SIGINT", stop);
		}
		if (stdinError)
			fail(`prompt pipe failed (${stdinError.code ?? "unknown"})`);
		if (
			interrupted ||
			status.error ||
			status.signal ||
			outputSize > MAX_OUTPUT ||
			errorSize > MAX_OUTPUT
		)
			fail(
				`provider terminated before a verified completion (code ${status.code ?? "none"}, signal ${status.signal ?? "none"}, error ${status.error?.code ?? "none"}; ${boundedText(Buffer.concat(errors)).slice(0, 300)})`,
			);
		const result = {
			code: status.code,
			stdout: boundedText(Buffer.concat(output)),
			stderr: boundedText(Buffer.concat(errors)),
		};
		if (status.code !== 0) return { ...result, code: status.code || 76 };
		if (verify) await verify(result);
		return result;
	} finally {
		const stopped = await settleGroup(child);
		if (!stopped) fail("provider process group did not stop");
	}
}
