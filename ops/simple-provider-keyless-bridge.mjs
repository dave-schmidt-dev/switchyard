#!/usr/bin/env node
// Fixed BWS consumer for the local Vibe and OpenCode Go simple lanes.
// The broker delivers the key over an anonymous pipe, never in this process's
// environment. The sandboxed CLI receives only a per-run nonce.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
	createReadStream,
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const SAFE_PATH =
	"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const VIBE = "/Users/dave/.local/share/uv/tools/mistral-vibe/bin/vibe";
const OPENCODE = "/opt/homebrew/Cellar/opencode/1.18.30_2/bin/opencode";
const VIBE_RUNTIME = "/Users/dave/.local/share/uv/tools/mistral-vibe";
const UV_PYTHON = "/Users/dave/.local/share/uv/python";
const MAX_PROMPT = 256 * 1024;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_WAIT_MS = 30 * 60 * 1000;
const MODELS = Object.freeze({
	"glm-5-3-medium": {
		target: "vibe",
		upstreamModel: "zai-glm-5-3",
	},
	"glm-5-3": { target: "vibe", upstreamModel: "zai-glm-5-3" },
	"opencode-go/deepseek-v4.1-flash": {
		target: "opencode-go",
		upstreamModel: "deepseek-v4.1-flash",
	},
});
const UPSTREAM = Object.freeze({
	vibe: "https://api.mistral.ai/v1/chat/completions",
	"opencode-go": "https://opencode.ai/zen/go/v1/chat/completions",
});
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
	throw new Error(`simple-provider-keyless-bridge: ${reason}`);
}
function boundedText(bytes, secret) {
	return bytes
		.toString("utf8")
		.split(secret)
		.join("[redacted]")
		.replace(TERMINAL_ESCAPE_PATTERN, "")
		.replace(UNSAFE_CONTROL_PATTERN, "");
}
function safePath(path) {
	if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0"))
		fail("worktree must be absolute");
	const canonical = realpathSync(path);
	if (
		canonical !== path ||
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
export function parseBridgeArgs(argv) {
	if (argv.length % 2 !== 0 || argv.length < 6 || argv.length > 8)
		fail("invalid fixed argument set");
	const values = {};
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		if (
			!["--target", "--model", "--worktree", "--variant"].includes(flag) ||
			flag in values
		)
			fail("unknown or duplicate argument");
		values[flag] = argv[i + 1];
	}
	const target = values["--target"];
	const model = values["--model"];
	const descriptor = MODELS[model];
	if (!descriptor || descriptor.target !== target)
		fail("target/model pair is not approved");
	const variant = values["--variant"];
	if (target === "vibe" && variant !== undefined)
		fail("Vibe variant must be selected by model alias");
	if (target === "opencode-go" && !["low", "max"].includes(variant))
		fail("OpenCode variant must be low or max");
	return {
		target,
		model,
		variant,
		descriptor,
		worktree: safePath(values["--worktree"]),
	};
}

function schemePath(path) {
	return JSON.stringify(path);
}
export function seatbeltProfile({
	worktree,
	runtime,
	proxyPort,
	cliReads = [],
}) {
	if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535)
		fail("invalid proxy port");
	const reads = [
		"/System",
		"/usr",
		"/bin",
		"/sbin",
		"/dev",
		"/private/etc",
		"/Library/Preferences",
		worktree,
		runtime,
		...cliReads,
	];
	const ancestors = new Set(["/"]);
	for (const path of reads) {
		let current = dirname(path);
		while (current !== "/") {
			ancestors.add(current);
			current = dirname(current);
		}
	}
	return [
		"(version 1)",
		"(deny default)",
		"(allow process-exec)",
		"(allow process-fork)",
		"(allow sysctl-read)",
		// dyld needs read-data on / itself; other ancestors need metadata only.
		'(allow file-read* (literal "/"))',
		`(allow file-read-metadata ${[...ancestors]
			.filter((p) => p !== "/")
			.map((p) => `(literal ${schemePath(p)})`)
			.join(" ")})`,
		`(allow file-read* ${reads.map((p) => `(subpath ${schemePath(p)})`).join(" ")})`,
		`(allow file-write* (subpath ${schemePath(worktree)}) (subpath ${schemePath(runtime)}) (literal "/dev/null"))`,
		`(allow network-outbound (remote tcp "localhost:${proxyPort}"))`,
	].join("\n");
}

function constantTimeEquals(actual, expected) {
	const a = Buffer.from(String(actual ?? ""));
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}
function reject(response, code) {
	response.writeHead(code, { "content-type": "text/plain" });
	response.end("proxy request rejected\n");
}
function readBody(request) {
	return new Promise((resolveBody, rejectBody) => {
		const chunks = [];
		let size = 0;
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				request.destroy();
				rejectBody(new Error("body too large"));
			} else chunks.push(chunk);
		});
		request.on("end", () => resolveBody(Buffer.concat(chunks)));
		request.on("error", rejectBody);
	});
}
function redactBuffer(buffer, secret) {
	return Buffer.from(buffer.toString("utf8").split(secret).join("[redacted]"));
}
export function formatOpenCodeGoBridgeDiagnostic({
	chatRequestCount = 0,
	lastUpstreamStatus = 0,
	proxyRejectionCount = 0,
} = {}) {
	const boundedCount = (value) =>
		Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 999999) : 0;
	const status =
		Number.isInteger(lastUpstreamStatus) &&
		lastUpstreamStatus >= 100 &&
		lastUpstreamStatus <= 599
			? lastUpstreamStatus
			: 0;
	return `SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=${boundedCount(chatRequestCount)} upstream_status=${status} proxy_rejections=${boundedCount(proxyRejectionCount)}\n`;
}
export async function startProxy({
	target,
	model,
	secret,
	upstream = UPSTREAM[target],
}) {
	if (!UPSTREAM[target] || !MODELS[model] || MODELS[model].target !== target)
		fail("invalid proxy target");
	const nonce = randomBytes(32).toString("hex");
	const upstreamUrl = new URL(upstream);
	if (!["https:", "http:"].includes(upstreamUrl.protocol))
		fail("invalid upstream protocol");
	if (upstreamUrl.protocol === "http:" && upstreamUrl.hostname !== "127.0.0.1")
		fail("test HTTP upstream must be loopback");
	if (
		upstreamUrl.username ||
		upstreamUrl.password ||
		upstreamUrl.search ||
		upstreamUrl.hash
	)
		fail("upstream URL contains unsupported components");
	const inflight = new Set();
	let chatRequestCount = 0;
	let lastUpstreamStatus = 0;
	let proxyRejectionCount = 0;
	const incrementDiagnosticCount = (current) => Math.min(current + 1, 999999);
	const server = http.createServer(async (request, response) => {
		try {
			if (request.url === "/v1/chat/completions") {
				chatRequestCount = incrementDiagnosticCount(chatRequestCount);
			}
			if (
				request.method !== "POST" ||
				request.url !== "/v1/chat/completions" ||
				!constantTimeEquals(request.headers.authorization, `Bearer ${nonce}`) ||
				request.headers.host !== `127.0.0.1:${server.address().port}`
			) {
				proxyRejectionCount = incrementDiagnosticCount(proxyRejectionCount);
				return reject(response, 403);
			}
			const body = await readBody(request);
			let document;
			try {
				document = JSON.parse(body.toString("utf8"));
			} catch {
				proxyRejectionCount = incrementDiagnosticCount(proxyRejectionCount);
				return reject(response, 400);
			}
			if (
				!document ||
				Array.isArray(document) ||
				document.model !== MODELS[model].upstreamModel
			) {
				proxyRejectionCount = incrementDiagnosticCount(proxyRejectionCount);
				return reject(response, 403);
			}
			const transport = upstreamUrl.protocol === "https:" ? https : http;
			// Preserve only the two client identity fields required by OpenCode Go.
			// Node has already parsed headers; bound values again before forwarding.
			const clientAgent = request.headers["user-agent"];
			const clientSession = request.headers["x-opencode-session"];
			const goHeaders =
				target === "opencode-go"
					? {
							...(typeof clientAgent === "string" &&
							clientAgent.length <= 256 &&
							/^[\x20-\x7e]+$/u.test(clientAgent)
								? { "user-agent": clientAgent }
								: {}),
							...(typeof clientSession === "string" &&
							clientSession.length <= 128 &&
							/^[A-Za-z0-9._:-]+$/u.test(clientSession)
								? { "x-opencode-session": clientSession }
								: {}),
						}
					: {};
			const outbound = transport.request(
				upstreamUrl,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${secret}`,
						"content-type": "application/json",
						accept:
							request.headers.accept === "text/event-stream"
								? "text/event-stream"
								: "application/json",
						"content-length": body.length,
						...goHeaders,
					},
					timeout: 120_000,
				},
				(upstreamResponse) => {
					lastUpstreamStatus =
						Number.isInteger(upstreamResponse.statusCode) &&
						upstreamResponse.statusCode >= 100 &&
						upstreamResponse.statusCode <= 599
							? upstreamResponse.statusCode
							: 0;
					// No redirect is followed. A 3xx remains a failed provider response.
					if (
						(upstreamResponse.statusCode ?? 500) >= 300 &&
						(upstreamResponse.statusCode ?? 500) < 400
					) {
						upstreamResponse.resume();
						proxyRejectionCount = incrementDiagnosticCount(proxyRejectionCount);
						return reject(response, 502);
					}
					const headers = {
						"content-type":
							upstreamResponse.headers["content-type"] ?? "application/json",
					};
					const pieces = [];
					let size = 0;
					upstreamResponse.on("data", (chunk) => {
						size += chunk.length;
						if (size > MAX_BODY)
							upstreamResponse.destroy(new Error("response too large"));
						else pieces.push(chunk);
					});
					upstreamResponse.on("end", () => {
						response.writeHead(upstreamResponse.statusCode ?? 502, headers);
						response.end(redactBuffer(Buffer.concat(pieces), secret));
					});
					upstreamResponse.on("error", () => {
						if (!response.headersSent) {
							proxyRejectionCount =
								incrementDiagnosticCount(proxyRejectionCount);
							reject(response, 502);
						} else response.destroy();
					});
				},
			);
			inflight.add(outbound);
			outbound.once("close", () => inflight.delete(outbound));
			outbound.on("timeout", () =>
				outbound.destroy(new Error("upstream timeout")),
			);
			outbound.on("error", () => {
				if (!response.headersSent) {
					proxyRejectionCount = incrementDiagnosticCount(proxyRejectionCount);
					reject(response, 502);
				} else response.destroy();
			});
			outbound.end(body);
		} catch {
			if (!response.headersSent) {
				proxyRejectionCount = incrementDiagnosticCount(proxyRejectionCount);
				reject(response, 400);
			} else response.destroy();
		}
	});
	await new Promise((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	return {
		server,
		nonce,
		port: server.address().port,
		getDiagnostic: () => ({
			chatRequestCount,
			lastUpstreamStatus,
			proxyRejectionCount,
		}),
		close: () => {
			for (const request of inflight) request.destroy();
			server.closeAllConnections();
			return new Promise((done) => server.close(done));
		},
	};
}

function renderVibeConfig(model, port, runtime) {
	// The simple medium alias follows Vibe's UI mapping to API reasoning_effort=high.
	return `active_model = ${JSON.stringify(model)}\nenable_telemetry = false\nenable_otel = false\nenable_update_checks = false\nenable_auto_update = false\n\n[session_logging]\nsave_dir = ${JSON.stringify(join(runtime, "vibe", "logs", "session"))}\n\n[[providers]]\nname = "mistral"\napi_base = "http://127.0.0.1:${port}/v1"\napi_key_env_var = "MISTRAL_API_KEY"\n\n[[models]]\nname = "zai-glm-5-3"\nprovider = "mistral"\nalias = "glm-5-3-medium"\nthinking = "high"\n\n[[models]]\nname = "zai-glm-5-3"\nprovider = "mistral"\nalias = "glm-5-3"\nthinking = "max"\n`;
}
function renderOpenCodeConfig(port) {
	return JSON.stringify({
		$schema: "https://opencode.ai/config.json",
		share: "disabled",
		autoupdate: false,
		plugin: [],
		provider: {
			"opencode-go": {
				options: {
					baseURL: `http://127.0.0.1:${port}/v1`,
					apiKey: "{env:OPENCODE_API_KEY}",
				},
			},
		},
	});
}
function verifyVibeSession(runtime, model) {
	const sessions = join(runtime, "vibe", "logs", "session");
	if (!existsSync(sessions)) return false;
	const dirs = readdirSync(sessions, { withFileTypes: true }).filter((x) =>
		x.isDirectory(),
	);
	return dirs.some((dir) => {
		try {
			return (
				JSON.parse(readFileSync(join(sessions, dir.name, "meta.json"), "utf8"))
					?.config?.active_model === model
			);
		} catch {
			return false;
		}
	});
}
function cliReadPaths(target, cliPath) {
	return target === "vibe"
		? [VIBE_RUNTIME, UV_PYTHON, cliPath]
		: [
				dirname(cliPath),
				"/opt/homebrew/bin",
				"/opt/homebrew/opt",
				"/opt/homebrew/Cellar",
				"/opt/homebrew/lib",
				"/opt/homebrew/share",
			];
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
	const repack = spawnSync(
		"/usr/bin/git",
		["-C", worktree, "repack", "-a", "-d"],
		{ env, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120_000 },
	);
	if (repack.status !== 0) fail("shared clone could not be detached");
	unlinkSync(alternate);
	const fsck = spawnSync(
		"/usr/bin/git",
		["-C", worktree, "fsck", "--connectivity-only", "--no-reflogs"],
		{ env, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120_000 },
	);
	if (fsck.status !== 0) fail("detached clone connectivity check failed");
}
function killGroup(child, signal) {
	if (child.pid) {
		try {
			process.kill(-child.pid, signal);
		} catch {}
	}
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
export async function runBridge({
	target,
	model,
	variant,
	worktree,
	prompt,
	secret,
	cliPath,
	upstream,
	timeoutMs = MAX_WAIT_MS,
	verifySession = true,
}) {
	if (typeof secret !== "string" || secret.length < 8 || secret.length > 65536)
		fail("credential missing or invalid");
	if (
		typeof prompt !== "string" ||
		!prompt ||
		Buffer.byteLength(prompt) > MAX_PROMPT
	)
		fail("prompt is empty or too large");
	if (!MODELS[model] || MODELS[model].target !== target)
		fail("target/model mismatch");
	const actualCli = cliPath ?? (target === "vibe" ? VIBE : OPENCODE);
	detachSharedClone(worktree);
	const runtime = mkdtempSync(join(dirname(worktree), ".switchyard-keyless-"));
	let proxy;
	let child;
	let interrupted = false;
	try {
		proxy = await startProxy({ target, model, secret, upstream });
		const profile = seatbeltProfile({
			worktree,
			runtime,
			proxyPort: proxy.port,
			cliReads: cliReadPaths(target, actualCli),
		});
		const env = {
			PATH: SAFE_PATH,
			HOME: runtime,
			TMPDIR: runtime,
			TMP: runtime,
			TEMP: runtime,
			USER: "dave",
			LOGNAME: "dave",
			LC_ALL: "C",
			NO_COLOR: "1",
			CI: "1",
			OPENSSL_CONF: "/dev/null",
			XDG_CONFIG_HOME: join(runtime, "config"),
			XDG_DATA_HOME: join(runtime, "data"),
			XDG_CACHE_HOME: join(runtime, "cache"),
			OPENCODE_DISABLE_AUTOUPDATE: "1",
			OPENCODE_DISABLE_SHARE: "1",
			OPENCODE_DISABLE_TELEMETRY: "1",
			VIBE_DISABLE_TELEMETRY: "1",
		};
		let args;
		if (target === "vibe") {
			env.VIBE_HOME = join(runtime, "vibe");
			env.MISTRAL_API_KEY = proxy.nonce;
			writeFileSync(
				join(runtime, "vibe-config.toml"),
				renderVibeConfig(model, proxy.port, runtime),
				{ mode: 0o600 },
			);
			// Vibe expects the config at VIBE_HOME/config.toml.
			const { mkdirSync, copyFileSync } = await import("node:fs");
			mkdirSync(env.VIBE_HOME, { mode: 0o700 });
			copyFileSync(
				join(runtime, "vibe-config.toml"),
				join(env.VIBE_HOME, "config.toml"),
			);
			args = [
				"-p",
				"--agent",
				"accept-edits",
				"--trust",
				"--workdir",
				worktree,
				"--max-turns",
				"12",
				"--output",
				"json",
			];
		} else {
			env.OPENCODE_API_KEY = proxy.nonce;
			env.OPENCODE_CONFIG_CONTENT = renderOpenCodeConfig(proxy.port);
			args = [
				"run",
				"--pure",
				"--agent",
				"build",
				"--auto",
				"--variant",
				variant,
				"--model",
				model,
			];
		}
		const sandbox = "/usr/bin/sandbox-exec";
		child = spawn(sandbox, ["-p", profile, actualCli, ...args], {
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
		const heartbeat = setInterval(
			() =>
				process.stderr.write("switchyard: keyless provider still running\n"),
			15_000,
		);
		const timer = setTimeout(() => {
			interrupted = true;
			killGroup(child, "SIGTERM");
			setTimeout(() => killGroup(child, "SIGKILL"), 1_000).unref();
		}, timeoutMs);
		const onTerm = () => {
			interrupted = true;
			killGroup(child, "SIGTERM");
			setTimeout(() => killGroup(child, "SIGKILL"), 1_000).unref();
		};
		process.once("SIGTERM", onTerm);
		process.once("SIGINT", onTerm);
		let status;
		try {
			status = await new Promise((done) => {
				child.once("error", (error) => done({ error }));
				child.once("close", (code, signal) => done({ code, signal }));
			});
		} finally {
			clearInterval(heartbeat);
			clearTimeout(timer);
			process.removeListener("SIGTERM", onTerm);
			process.removeListener("SIGINT", onTerm);
		}
		if (stdinError)
			fail(
				`${target === "vibe" ? "Vibe" : "OpenCode"} prompt pipe failed (${stdinError.code ?? "unknown"})`,
			);
		if (
			interrupted ||
			status.error ||
			status.signal ||
			outputSize > MAX_OUTPUT ||
			errorSize > MAX_OUTPUT
		)
			fail(
				`provider terminated before a verified completion (code ${status.code ?? "none"}, signal ${status.signal ?? "none"}, error ${status.error?.code ?? "none"}; ${boundedText(Buffer.concat(errors), secret).slice(0, 300)})`,
			);
		if (status.code !== 0 && target === "opencode-go") {
			return {
				code: status.code || 76,
				stdout: formatOpenCodeGoBridgeDiagnostic(proxy.getDiagnostic()),
				stderr: "",
			};
		}
		if (status.code !== 0) {
			return {
				code: status.code || 76,
				stdout: boundedText(Buffer.concat(output), secret),
				stderr: boundedText(Buffer.concat(errors), secret),
			};
		}
		if (
			target === "vibe" &&
			verifySession &&
			!verifyVibeSession(runtime, model)
		)
			fail("Vibe session does not prove the requested model alias");
		return {
			code: 0,
			stdout: boundedText(Buffer.concat(output), secret),
			stderr: boundedText(Buffer.concat(errors), secret),
		};
	} finally {
		const stopped = await settleGroup(child);
		if (proxy) await proxy.close();
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
	const options = parseBridgeArgs(process.argv.slice(2));
	// The broker passes only an anonymous read FD. Neither this process nor any
	// sandboxed descendant starts with the real key in its OS environment.
	const descriptor = process.env.SWITCHYARD_BWS_SECRET_FD;
	if (
		!/^[0-9]+$/u.test(descriptor ?? "") ||
		!Number.isSafeInteger(Number(descriptor)) ||
		Number(descriptor) < 3
	)
		fail("broker credential pipe missing");
	delete process.env.SWITCHYARD_BWS_SECRET_FD;
	const secret = await new Promise((done, rejectSecret) => {
		const chunks = [];
		let size = 0;
		const stream = createReadStream(null, {
			fd: Number(descriptor),
			autoClose: true,
		});
		stream.on("data", (chunk) => {
			size += chunk.length;
			if (size > 4096) {
				stream.destroy();
				rejectSecret(new Error("credential too large"));
			} else chunks.push(chunk);
		});
		stream.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
		stream.on("error", rejectSecret);
	});
	const prompt = await readBoundedStdin();
	const result = await runBridge({ ...options, prompt, secret });
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	process.exitCode = result.code;
}
if (process.argv[1] && resolve(process.argv[1]) === SELF)
	main().catch(() => {
		process.stderr.write("simple-provider-keyless-bridge: failed closed\n");
		process.exitCode = 76;
	});
