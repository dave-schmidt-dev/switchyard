#!/usr/bin/env node
// Native headless Vibe for the simple "vibe-code" lane.
// Vibe authenticates with its own keychain login, so Mistral bills the Vibe Code
// allowance. No BWS secret, broker consumer or proxy is involved: this process
// never reads, receives or prints that credential. Vibe runs under Seatbelt with
// a per-run VIBE_HOME and HOME, no MISTRAL_API_KEY in its environment (an
// inherited key would silently move billing to the API allowance), and only the
// file tools enabled, so the model has no shell or web tool to read the keychain
// item or send anything anywhere.

import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const VIBE = "/Users/dave/.local/share/uv/tools/mistral-vibe/bin/vibe";
const VIBE_RUNTIME = "/Users/dave/.local/share/uv/tools/mistral-vibe";
const UV_PYTHON = "/Users/dave/.local/share/uv/python";
const MAX_PROMPT = 256 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_WAIT_MS = 30 * 60 * 1000;
const ENABLED_TOOLS = Object.freeze([
	"edit",
	"write_file",
	"read_file",
	"grep",
]);
const THINKING = Object.freeze({ "glm-5-3-medium": "high", "glm-5-3": "max" });
// biome-ignore lint/complexity/useRegexLiterals: control-byte grammar is easier to audit as string data.
const TERMINAL_ESCAPE_PATTERN = new RegExp(
	String.raw`\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*(?:\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)`,
	"gu",
);
// biome-ignore lint/complexity/useRegexLiterals: control-byte grammar is easier to audit as string data.
const UNSAFE_CONTROL_PATTERN = new RegExp(
	String.raw`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]`,
	"gu",
);

function fail(reason) {
	throw new Error(`simple-vibe-code-launcher: ${reason}`);
}
const boundedText = (bytes) =>
	bytes
		.toString("utf8")
		.replace(TERMINAL_ESCAPE_PATTERN, "")
		.replace(UNSAFE_CONTROL_PATTERN, "");
function safePath(path) {
	if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0"))
		fail("worktree must be absolute");
	if (
		realpathSync(path) !== path ||
		lstatSync(path).isSymbolicLink() ||
		!lstatSync(path).isDirectory()
	)
		fail("worktree must be a canonical directory");
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
export function parseLauncherArgs(argv) {
	if (argv.length !== 4) fail("invalid fixed argument set");
	const values = {};
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		if (!["--model", "--worktree"].includes(flag) || flag in values)
			fail("unknown or duplicate argument");
		values[flag] = argv[i + 1];
	}
	const model = values["--model"];
	if (!Object.hasOwn(THINKING, model)) fail("model is not approved");
	return { model, worktree: safePath(values["--worktree"]) };
}
export function renderVibeCodeConfig(model, runtime) {
	const aliases = Object.entries(THINKING)
		.map(
			([alias, thinking]) =>
				`[[models]]\nname = "zai-glm-5-3"\nprovider = "mistral"\nalias = "${alias}"\nthinking = "${thinking}"\n`,
		)
		.join("\n");
	return `active_model = ${JSON.stringify(model)}\nenable_telemetry = false\nenable_otel = false\nenable_update_checks = false\nenable_auto_update = false\n\n[session_logging]\nsave_dir = ${JSON.stringify(join(runtime, "vibe", "logs", "session"))}\n\n[[providers]]\nname = "mistral"\napi_base = "https://api.mistral.ai/v1"\napi_key_env_var = "MISTRAL_API_KEY"\napi_style = "openai"\nbackend = "mistral"\n\n${aliases}`;
}
export function vibeCodeArgs(worktree) {
	return [
		"-p",
		"--agent",
		"accept-edits",
		"--auto-approve",
		"--trust",
		"--workdir",
		worktree,
		"--output",
		"json",
		...ENABLED_TOOLS.flatMap((tool) => ["--enabled-tools", tool]),
	];
}
export function vibeCodeEnvironment(runtime) {
	// Allowlist only: nothing from the launcher's own environment is inherited.
	return {
		PATH: SAFE_PATH,
		HOME: join(runtime, "home"),
		TMPDIR: runtime,
		TMP: runtime,
		TEMP: runtime,
		USER: "dave",
		LOGNAME: "dave",
		LC_ALL: "C",
		NO_COLOR: "1",
		CI: "1",
		VIBE_HOME: join(runtime, "vibe"),
		VIBE_DISABLE_TELEMETRY: "1",
	};
}
const schemePath = (path) => JSON.stringify(path);
export function vibeCodeSeatbeltProfile({ worktree, runtime, keychains }) {
	const reads = [
		"/System",
		"/usr",
		"/bin",
		"/sbin",
		"/dev",
		"/private/etc",
		"/private/var/db",
		"/Library/Keychains",
		"/Library/Preferences",
		"/private/var/run",
		worktree,
		runtime,
		VIBE_RUNTIME,
		UV_PYTHON,
		keychains,
	];
	return [
		"(version 1)",
		"(deny default)",
		"(allow process-exec)",
		"(allow process-fork)",
		"(allow sysctl-read)",
		'(allow file-read* (literal "/"))',
		`(allow file-read* ${reads.map((p) => `(subpath ${schemePath(p)})`).join(" ")})`,
		"(allow file-read-metadata)",
		`(allow file-write* (subpath ${schemePath(worktree)}) (subpath ${schemePath(runtime)}) (literal "/dev/null"))`,
		"(allow mach-lookup)",
		"(allow ipc-posix-shm)",
		'(allow network-outbound (remote tcp "*:443") (literal "/private/var/run/mDNSResponder") (remote udp "*:53"))',
	].join("\n");
}
function verifyVibeSession(runtime, model) {
	const sessions = join(runtime, "vibe", "logs", "session");
	if (!existsSync(sessions)) return false;
	return readdirSync(sessions, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.some((dir) => {
			try {
				return (
					JSON.parse(
						readFileSync(join(sessions, dir.name, "meta.json"), "utf8"),
					)?.config?.active_model === model
				);
			} catch {
				return false;
			}
		});
}
function detachSharedClone(worktree) {
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
function killGroup(child, signal) {
	if (!child?.pid) return;
	try {
		process.kill(-child.pid, signal);
	} catch {}
}
function groupPresent(child) {
	if (!child?.pid) return false;
	try {
		process.kill(-child.pid, 0);
		return true;
	} catch (error) {
		return error?.code !== "ESRCH";
	}
}
async function settleGroup(child) {
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
export async function runVibeCode({
	model,
	worktree,
	prompt,
	cliPath = VIBE,
	timeoutMs = MAX_WAIT_MS,
	verifySession = true,
	keychains = join(homedir(), "Library", "Keychains"),
}) {
	if (!Object.hasOwn(THINKING, model)) fail("model is not approved");
	if (
		typeof prompt !== "string" ||
		!prompt ||
		Buffer.byteLength(prompt) > MAX_PROMPT
	)
		fail("prompt is empty or too large");
	detachSharedClone(worktree);
	const runtime = mkdtempSync(join(dirname(worktree), ".switchyard-vibecode-"));
	let child;
	let interrupted = false;
	try {
		mkdirSync(join(runtime, "vibe"), { mode: 0o700 });
		mkdirSync(join(runtime, "home", "Library"), { recursive: true });
		// `security` resolves the login keychain from HOME; expose only that directory.
		symlinkSync(keychains, join(runtime, "home", "Library", "Keychains"));
		writeFileSync(
			join(runtime, "vibe", "config.toml"),
			renderVibeCodeConfig(model, runtime),
			{ mode: 0o600 },
		);
		const profile = vibeCodeSeatbeltProfile({ worktree, runtime, keychains });
		child = spawn(
			"/usr/bin/sandbox-exec",
			["-p", profile, cliPath, ...vibeCodeArgs(worktree)],
			{
				cwd: worktree,
				env: vibeCodeEnvironment(runtime),
				detached: true,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
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
		const heartbeat = setInterval(
			() => process.stderr.write("switchyard: native vibe still running\n"),
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
		if (verifySession && !verifyVibeSession(runtime, model))
			fail("Vibe session does not prove the requested model alias");
		return result;
	} finally {
		const stopped = await settleGroup(child);
		rmSync(runtime, { recursive: true, force: true });
		if (!stopped) fail("provider process group did not stop");
	}
}
async function readBoundedStdin() {
	const chunks = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size > MAX_PROMPT) fail("prompt too large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}
async function main() {
	const options = parseLauncherArgs(process.argv.slice(2));
	const prompt = await readBoundedStdin();
	const result = await runVibeCode({ ...options, prompt });
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	process.exitCode = result.code;
}
if (process.argv[1] && resolve(process.argv[1]) === SELF)
	main().catch((error) => {
		process.stderr.write(
			`simple-vibe-code-launcher: failed closed (${String(error?.message ?? error).slice(0, 300)})\n`,
		);
		process.exitCode = 76;
	});
