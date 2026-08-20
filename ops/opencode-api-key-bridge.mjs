#!/usr/bin/env node
// Fixed BWS consumer for one ephemeral OpenCode API-key dispatch.
//
// This file is deliberately self-contained and content-pinned by
// bws-secret-exec. It reads a non-secret JSON request on stdin, accepts exactly
// one broker-injected key, and sends that key across a one-use memory-only HTTP
// hop. The guest receives it only in the final OpenCode process environment;
// no key enters argv, auth.json, a shell profile, a log, or a host child env.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const PRLCTL = "/usr/local/bin/prlctl";
const TRANSFER_HOST = "10.211.55.2";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_GUEST_ARGV_BYTES = 600000;
const WORKSPACE_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VARIANTS = new Set([
	"default",
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"thinking",
]);
// OpenCode uses a TUI even for failed noninteractive calls. Remove every ECMA-
// 48 escape form (CSI, OSC, DCS/SOS/PM/APC) plus carriage returns before its
// bytes leave this fixed consumer. A terminal-control byte must never be able
// to erase prior status lines or otherwise manipulate the host transcript.
// biome-ignore lint/complexity/useRegexLiterals: escape grammar must remain string data to avoid literal control bytes.
const TERMINAL_ESCAPE_PATTERN = new RegExp(
	String.raw`\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*(?:\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)`,
	"g",
);
// biome-ignore lint/complexity/useRegexLiterals: escape grammar must remain string data to avoid literal control bytes.
const UNSAFE_CONTROL_PATTERN = new RegExp(
	String.raw`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]`,
	"g",
);
const HOST_ENV = Object.freeze({
	PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
	LC_ALL: "C",
	// bws-secret-exec intentionally removes inherited state, but Parallels uses
	// the account home to find its nonsecret local registration. This is fixed
	// host identity, never caller input and never a credential.
	HOME: "/Users/dave",
	USER: "dave",
	LOGNAME: "dave",
});

// Kept local rather than importing the adapter: BWS pins this exact file, and
// importing mutable workspace code would let a post-pin edit inherit a key.
const OPENCODE_SUPERVISOR = String.raw`set -u
idle=$1
shift
cmd=$1
base=/tmp/switchyard-opencode.$$
out=$base.out
err=$base.err
: >"$out"
: >"$err"
"$@" >"$out" 2>"$err" &
pid=$!
last=0
quiet=0
elapsed=0
killed=0

is_alive() {
	st=$(ps -o state= -p "$1" 2>/dev/null)
	if [ "$?" -eq 0 ] && [ -n "$st" ]; then
		case "$st" in
			Z*) return 1 ;;
			*) return 0 ;;
		esac
	fi
	kill -0 "$1" 2>/dev/null
}

while :; do
	if ! is_alive "$pid"; then
		break
	fi
	osize=$(wc -c <"$out")
	size=$(( osize + $(wc -c <"$err") ))
	if [ "$size" -ne "$last" ]; then
		last=$size
		quiet=0
	else
		quiet=$(( quiet + 1 ))
	fi
	if [ "$osize" -gt 0 ] && [ "$quiet" -ge "$idle" ]; then
		/bin/kill -TERM "$pid" 2>/dev/null || true
		killed=1
		break
	fi
	elapsed=$(( elapsed + 1 ))
	if [ $(( elapsed % 15 )) -eq 0 ]; then
		printf 'switchyard: opencode alive %ss, %s bytes captured, %ss idle\n' "$elapsed" "$last" "$quiet" >&2
	fi
	sleep 1
done
if [ "$killed" -eq 1 ]; then
	kill -TERM "$pid" 2>/dev/null
	i=0
	while [ "$i" -lt 5 ]; do
		if ! is_alive "$pid"; then
			break
		fi
		sleep 1
		i=$(( i + 1 ))
	done
	kill -KILL "$pid" 2>/dev/null
	wait "$pid" 2>/dev/null
	swept=0
	cmd_name=\${cmd##*/}
	for q in $(pgrep -x "$cmd_name" 2>/dev/null); do
		if [ "$q" = "$$" ] || [ "$q" = 1 ]; then
			continue
		fi
		kill -KILL "$q" 2>/dev/null
		swept=$(( swept + 1 ))
	done
	if [ "$swept" -gt 0 ]; then
		printf 'switchyard: swept %s surviving %s process(es)\\n' "$swept" "$cmd" >&2
	fi
	rc=75
else
	wait "$pid" 2>/dev/null
	rc=$?
fi
cat "$out"
cat "$err" >&2
rm -f "$out" "$err"
exit "$rc"`;

function fail(message) {
	throw new Error(`opencode-api-key-bridge: ${message}`);
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function redact(text, secret) {
	return String(text ?? "")
		.split(secret)
		.join("[redacted]");
}

function safeProviderOutput(buffer, secret) {
	return redact(buffer.toString("utf8"), secret)
		.replace(TERMINAL_ESCAPE_PATTERN, "")
		.replaceAll("\r", "\n")
		.replace(UNSAFE_CONTROL_PATTERN, "");
}

function boundedAppend(current, chunk) {
	const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
	if (current.length >= MAX_OUTPUT_BYTES) return current;
	return Buffer.concat([
		current,
		next.subarray(0, MAX_OUTPUT_BYTES - current.length),
	]);
}

function readRequest() {
	const raw = readFileSync(0);
	if (raw.length === 0 || raw.length > MAX_REQUEST_BYTES) {
		fail("request must be a non-empty bounded JSON document");
	}
	let request;
	try {
		request = JSON.parse(raw.toString("utf8"));
	} catch {
		fail("request is not valid JSON");
	}
	if (!request || typeof request !== "object" || Array.isArray(request)) {
		fail("request must be an object");
	}
	const { workspaceId, model, invocationArgs, prompt, idleSeconds } = request;
	if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) {
		fail("workspaceId must be a VM UUID");
	}
	if (
		typeof model !== "string" ||
		!/^(opencode-go|mistral)\/[a-z0-9][a-z0-9._-]*$/i.test(model)
	) {
		fail("model is not an approved OpenCode Go or Mistral selector");
	}
	if (
		typeof prompt !== "string" ||
		prompt.length === 0 ||
		Buffer.byteLength(prompt) > MAX_REQUEST_BYTES
	) {
		fail("prompt must be a non-empty bounded string");
	}
	if (
		!Array.isArray(invocationArgs) ||
		invocationArgs.some((value) => typeof value !== "string")
	) {
		fail("invocationArgs must be a string array");
	}
	if (
		invocationArgs.length !== 0 &&
		(invocationArgs.length !== 2 ||
			invocationArgs[0] !== "--variant" ||
			!VARIANTS.has(invocationArgs[1]))
	) {
		fail("invocationArgs is not an approved OpenCode variant");
	}
	if (!Number.isInteger(idleSeconds) || idleSeconds < 5 || idleSeconds > 3600) {
		fail("idleSeconds must be an integer from 5 through 3600");
	}
	return { workspaceId, model, invocationArgs, prompt, idleSeconds };
}

function takeCredential(model) {
	const go = process.env.OPENCODE_GO_API_KEY;
	const mistral = process.env.MISTRAL_API_KEY;
	if (Boolean(go) === Boolean(mistral))
		fail("exactly one broker credential is required");
	if (go) {
		if (!model.startsWith("opencode-go/"))
			fail("OpenCode Go credential cannot run this model");
		delete process.env.OPENCODE_GO_API_KEY;
		return { secret: go, guestEnv: "OPENCODE_API_KEY" };
	}
	if (!model.startsWith("mistral/"))
		fail("Mistral credential cannot run this model");
	delete process.env.MISTRAL_API_KEY;
	return { secret: mistral, guestEnv: "MISTRAL_API_KEY" };
}

function runPrlctl(args, input = null) {
	return new Promise((resolve, reject) => {
		const child = spawn(PRLCTL, args, {
			env: HOST_ENV,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		child.stdout.on("data", (chunk) => {
			stdout = boundedAppend(stdout, chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr = boundedAppend(stderr, chunk);
		});
		child.once("error", reject);
		child.once("close", (code, signal) =>
			resolve({ code, signal, stdout, stderr }),
		);
		child.stdin.end(input);
	});
}

function guestArgs(request, url, guestEnv) {
	const marker = `/tmp/switchyard-provider-${createHash("sha256").update(request.workspaceId).digest("hex").slice(0, 32)}.pid`;
	const provider = [
		"sh",
		"-c",
		OPENCODE_SUPERVISOR,
		"sh",
		String(request.idleSeconds),
		"/Users/switchyard/.local/bin/opencode",
		"run",
		...request.invocationArgs,
		"--model",
		request.model,
		request.prompt,
	];
	const bootstrap = [
		"set -eu",
		`key=$(/usr/bin/curl --fail --silent --show-error --location --max-time 30 ${shellQuote(url)})`,
		'[ -n "$key" ]',
		`export ${guestEnv}="$key"`,
		"unset key",
		// Do not exec here: the marker must remain until the provider child exits
		// and then be removed by the EXIT trap. Its PID is the outer shell, so
		// Parallels' existing process-tree cleanup also reaches the supervisor.
		`marker=${shellQuote(marker)}`,
		'printf "%s\\n" "$$" >"$marker"',
		"trap 'rm -f -- \"$marker\"' EXIT HUP INT TERM",
		'"$@"',
	].join("; ");
	const command = ["/bin/bash", "-lc", bootstrap, "bridge", ...provider];
	const quoted = command.map(shellQuote).join(" ");
	const payload = Buffer.from(
		`cd /Users/switchyard/.switchyard/project && exec ${quoted}`,
		"utf8",
	).toString("base64");
	const args = [
		"exec",
		request.workspaceId,
		"--use-advanced-terminal",
		"launchctl",
		"asuser",
		"503",
		"sudo",
		"-u",
		"switchyard",
		"/usr/bin/env",
		"HOME=/Users/switchyard",
		"USER=switchyard",
		"LOGNAME=switchyard",
		"/bin/bash",
		"-lc",
		shellQuote(`eval "$(printf %s ${payload} | /usr/bin/base64 -D)"`),
	];
	if (
		args.reduce((total, value) => total + Buffer.byteLength(value), 0) >
		MAX_GUEST_ARGV_BYTES
	) {
		fail("guest command exceeds the ARG_MAX-safe limit");
	}
	return args;
}

async function main() {
	const request = readRequest();
	const { secret, guestEnv } = takeCredential(request.model);
	const token = randomUUID();
	let served = false;
	const server = createServer((req, res) => {
		if (req.method !== "GET" || req.url !== `/${token}` || served) {
			res.writeHead(404).end();
			return;
		}
		served = true;
		res.writeHead(200, {
			"content-type": "application/octet-stream",
			"content-length": Buffer.byteLength(secret),
		});
		res.end(secret);
	});
	let cleanupTransfer = null;
	let terminating = false;
	const stopOnSignal = () => {
		if (terminating) return;
		terminating = true;
		void (async () => {
			try {
				await cleanupTransfer?.();
			} finally {
				server.close();
				process.exitCode = 143;
			}
		})();
	};
	process.once("SIGINT", stopOnSignal);
	process.once("SIGTERM", stopOnSignal);
	try {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, TRANSFER_HOST, resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string")
			fail("transfer listener did not bind a TCP port");
		const anchor = `com.apple/switchyard-c3/opencode-key/${randomUUID().replaceAll("-", "").slice(0, 8)}`;
		const rule = `pass out quick on en0 proto tcp from any to ${TRANSFER_HOST} port ${address.port}\n`;
		const enabled = await runPrlctl(
			["exec", request.workspaceId, "/sbin/pfctl", "-a", anchor, "-f", "-"],
			rule,
		);
		if (enabled.code !== 0)
			fail("could not authorize the one-use guest transfer");
		cleanupTransfer = () =>
			runPrlctl([
				"exec",
				request.workspaceId,
				"/sbin/pfctl",
				"-a",
				anchor,
				"-F",
				"all",
			]);
		try {
			const result = await runPrlctl(
				guestArgs(
					request,
					`http://${TRANSFER_HOST}:${address.port}/${token}`,
					guestEnv,
				),
			);
			const visibleOutput = safeProviderOutput(result.stdout, secret).trim();
			const visibleError = safeProviderOutput(result.stderr, secret).trim();
			if (visibleOutput.length === 0 && visibleError.length === 0) {
				process.stderr.write(
					`opencode-api-key-bridge: guest exited ${result.code ?? result.signal ?? "unknown"} without a provider diagnostic (credential consumed: ${served ? "yes" : "no"}; stdout bytes: ${result.stdout.length}; stderr bytes: ${result.stderr.length})\n`,
				);
			}
			process.stdout.write(safeProviderOutput(result.stdout, secret));
			process.stderr.write(safeProviderOutput(result.stderr, secret));
			if (result.code !== 0) process.exitCode = result.code ?? 1;
		} finally {
			await cleanupTransfer();
			cleanupTransfer = null;
		}
		if (!served && process.exitCode === undefined)
			fail("guest did not consume the one-use credential");
	} finally {
		process.removeListener("SIGINT", stopOnSignal);
		process.removeListener("SIGTERM", stopOnSignal);
		server.close();
	}
}

main().catch((error) => {
	process.stderr.write(
		`opencode-api-key-bridge: ${error?.message ?? "unknown failure"}\n`,
	);
	process.exitCode = 1;
});
