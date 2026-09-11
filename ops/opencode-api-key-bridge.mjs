#!/usr/bin/env node
// Fixed BWS consumer for one ephemeral OpenCode API-key dispatch.
//
// This file is deliberately self-contained and content-pinned by
// bws-secret-exec. It reads a non-secret JSON request on stdin, accepts exactly
// one broker-injected key, then writes that key once to the pinned prlctl
// child's stdin. The guest shell consumes the line before launching OpenCode,
// whose stdin is already EOF. No key enters argv, auth.json, a shell profile, a
// log, or a host child env.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PRLCTL = "/usr/local/bin/prlctl";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_GUEST_ARGV_BYTES = 600000;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const BRIDGE_FAILURE_CODE = 75;
const LOST_RESULT_PROBE_ATTEMPTS = 10;
const LOST_RESULT_INITIAL_GRACE_ATTEMPTS = 60;
const LOST_RESULT_WAIT_MS = 1000;
const MAX_PROVIDER_WAIT_ATTEMPTS = 1800;
const PRLCTL_MISFIRE = /PrlJob_(?:GetRetCode|GetResult):\s*Invalid argument/u;
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
set -m
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
failed=0

job_pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')
group_verified() {
	[ "$job_pgid" = "$pid" ]
}

signal_group() {
	signal=$1
	job_pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')
	if ! group_verified; then
		return 1
	fi
	/bin/kill -"$signal" -- "-$pid" 2>/dev/null
}

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
		if ! signal_group TERM; then
			printf 'switchyard: refusing to signal unverified OpenCode process group\n' >&2
			rc=75
			failed=1
			break
		fi
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
	i=0
	while [ "$i" -lt 5 ]; do
		if ! is_alive "$pid"; then
			break
		fi
		sleep 1
		i=$(( i + 1 ))
	done
	if is_alive "$pid"; then
		if ! signal_group KILL; then
			printf 'switchyard: refusing to kill unverified OpenCode process group\n' >&2
		else
			i=0
			while [ "$i" -lt 5 ]; do
				if ! is_alive "$pid"; then
					break
				fi
				sleep 1
				i=$(( i + 1 ))
			done
		fi
	fi
	rc=75
	failed=0
elif [ "$failed" -eq 1 ]; then
	rc=75
else
	wait "$pid" 2>/dev/null
	rc=$?
fi
cat "$out"
cat "$err" >&2
rm -f "$out" "$err"
exit "$rc"`;

// This process owns the marker and terminal status after the foreground
// advanced-terminal launch returns. Its marker is published atomically before
// it can invoke the provider, so reconciliation can distinguish a running job
// from a failed bootstrap without ever reissuing the provider command.
const OPENCODE_GUEST_JOB = String.raw`set -eu
marker=$1
out=$2
err=$3
status=$4
status_tmp=$5
shift 5
marker_tmp="$marker.tmp.$$"

cleanup_before_start() {
	rm -f -- "$marker_tmp" "$marker" "$status_tmp"
}

trap 'cleanup_before_start; exit 75' HUP INT TERM
printf '%s\n' "$$" >"$marker_tmp"
mv -f -- "$marker_tmp" "$marker"
set +e
"$@" >"$out" 2>"$err"
rc=$?
set -e
printf '%s\n' "$rc" >"$status_tmp"
mv -f -- "$status_tmp" "$status"
rm -f -- "$marker"
rm -f -- "$marker_tmp" "$status_tmp"
exit "$rc"`;

function fail(message) {
	throw new Error(`opencode-api-key-bridge: ${message}`);
}

function bridgeFailure(reason) {
	return {
		code: BRIDGE_FAILURE_CODE,
		signal: null,
		stdout: Buffer.alloc(0),
		stderr: Buffer.from(`bridge failure: ${reason}\n`),
	};
}

export function normalizeWorkspaceId(value) {
	const normalized = String(value ?? "").replace(/^\{|\}$/gu, "");
	if (!WORKSPACE_ID.test(normalized)) fail("workspaceId must be a VM UUID");
	return normalized;
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
	const canonicalWorkspaceId = normalizeWorkspaceId(workspaceId);
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
	return {
		workspaceId: canonicalWorkspaceId,
		model,
		invocationArgs,
		prompt,
		idleSeconds,
	};
}

export function takeCredential(model, environment = process.env) {
	const go = environment.OPENCODE_GO_API_KEY;
	const mistral = environment.MISTRAL_API_KEY;
	if (Boolean(go) === Boolean(mistral))
		fail("exactly one broker credential is required");
	if (go) {
		if (!model.startsWith("opencode-go/"))
			fail("OpenCode Go credential cannot run this model");
		delete environment.OPENCODE_GO_API_KEY;
		return { secret: go, guestEnv: "OPENCODE_API_KEY" };
	}
	if (!model.startsWith("mistral/"))
		fail("Mistral credential cannot run this model");
	delete environment.MISTRAL_API_KEY;
	return { secret: mistral, guestEnv: "MISTRAL_API_KEY" };
}

export function credentialInput(secret) {
	if (typeof secret !== "string" || secret.length === 0) {
		fail("credential must be a non-empty string");
	}
	if (Buffer.byteLength(secret) > MAX_CREDENTIAL_BYTES) {
		fail("credential exceeds the bounded stdin limit");
	}
	if (/[\r\n\0]/u.test(secret)) {
		fail("credential contains a forbidden line or NUL character");
	}
	return `${secret}\n`;
}

/**
 * Return the non-secret runtime config OpenCode needs to bind a provider key.
 *
 * OpenCode's provider catalog is not guaranteed to read a provider-specific
 * environment variable directly. Its documented, ephemeral configuration path
 * resolves `{env:...}` at launch, so this keeps the Mistral key in the guest
 * process environment and out of auth.json, project files, and argv.
 */
export function runtimeConfigFor(model, guestEnv) {
	if (!model.startsWith("mistral/")) return null;
	if (guestEnv !== "MISTRAL_API_KEY") {
		fail("Mistral runtime config requires the MISTRAL_API_KEY environment");
	}
	return JSON.stringify({
		provider: {
			mistral: {
				options: { apiKey: "{env:MISTRAL_API_KEY}" },
			},
		},
	});
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

function wait(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runControl(args) {
	let result;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		result = await runPrlctl(args);
		if (
			result.code !== 255 ||
			!PRLCTL_MISFIRE.test(result.stderr.toString("utf8"))
		) {
			return result;
		}
		if (attempt < 3) await wait(100 * attempt);
	}
	return result;
}

export function guestJobPaths(workspaceId) {
	const suffix = createHash("sha256")
		.update(workspaceId)
		.digest("hex")
		.slice(0, 32);
	const base = `/tmp/switchyard-opencode-bridge-${suffix}`;
	return {
		marker: `/tmp/switchyard-provider-${suffix}.pid`,
		stdout: `${base}.out`,
		stderr: `${base}.err`,
		status: `${base}.status`,
		statusTemp: `${base}.status.tmp`,
	};
}

export function guestArgs(request, guestEnv) {
	const paths = guestJobPaths(request.workspaceId);
	const runtimeConfig = runtimeConfigFor(request.model, guestEnv);
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
	const detachedJob = [
		"/usr/bin/nohup",
		"/bin/bash",
		"-c",
		OPENCODE_GUEST_JOB,
		"switchyard-opencode-job",
		paths.marker,
		paths.stdout,
		paths.stderr,
		paths.status,
		paths.statusTemp,
		...provider,
	];
	const bootstrap = [
		"set +x",
		"set -eu",
		"set -m",
		"umask 077",
		"IFS= read -r key",
		'[ -n "$key" ]',
		"if IFS= read -r extra; then exit 64; fi",
		`export ${guestEnv}="$key"`,
		...(runtimeConfig
			? [`export OPENCODE_CONFIG_CONTENT=${shellQuote(runtimeConfig)}`]
			: []),
		"unset key extra",
		`marker=${shellQuote(paths.marker)}`,
		`out=${shellQuote(paths.stdout)}`,
		`err=${shellQuote(paths.stderr)}`,
		`status=${shellQuote(paths.status)}`,
		`status_tmp=${shellQuote(paths.statusTemp)}`,
		'rm -f -- "$out" "$err" "$status" "$status_tmp" "$marker" "$marker.tmp."*',
		`"$@" </dev/null >/dev/null 2>&1 &
job_pid=$!
job_pgid=$(ps -o pgid= -p "$job_pid" 2>/dev/null | tr -d '[:space:]')
signal_job_group() {
  signal=$1
  job_pgid=$(ps -o pgid= -p "$job_pid" 2>/dev/null | tr -d '[:space:]')
  [ "$job_pgid" = "$job_pid" ] || return 1
  /bin/kill -"$signal" -- "-$job_pid" 2>/dev/null
}
attempt=0
while [ "$attempt" -lt 50 ]; do
  [ -s "$marker" ] && exit 0
  if ! kill -0 "$job_pid" 2>/dev/null; then exit 75; fi
  attempt=$(( attempt + 1 ))
  sleep 0.1
done
if signal_job_group TERM; then
  attempt=0
  while [ "$attempt" -lt 5 ]; do
    kill -0 "$job_pid" 2>/dev/null || break
    attempt=$(( attempt + 1 ))
    sleep 1
  done
  if kill -0 "$job_pid" 2>/dev/null; then
    signal_job_group KILL || true
    attempt=0
    while [ "$attempt" -lt 5 ]; do
      kill -0 "$job_pid" 2>/dev/null || break
      attempt=$(( attempt + 1 ))
      sleep 1
    done
  fi
fi
exit 75`,
	].join("; ");
	const command = ["/bin/bash", "-lc", bootstrap, "bridge", ...detachedJob];
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

async function guestFile(workspaceId, path, runControlFn = runControl) {
	return runControlFn(["exec", workspaceId, "/bin/cat", path]);
}

async function cleanupGuestJob(workspaceId, paths, runControlFn = runControl) {
	return runControlFn([
		"exec",
		workspaceId,
		"/bin/sh",
		"-c",
		`rm -f -- \
${shellQuote(paths.stdout)} \
${shellQuote(paths.stderr)} \
${shellQuote(paths.status)} \
${shellQuote(paths.statusTemp)} \
${shellQuote(paths.marker)} \
${shellQuote(paths.marker)}.tmp.*`,
	]);
}

export async function reconcileGuestResult(
	request,
	launchResult,
	{
		runControlFn = runControl,
		waitFn = wait,
		maxAttempts = MAX_PROVIDER_WAIT_ATTEMPTS,
		lostResultProbeAttempts = LOST_RESULT_PROBE_ATTEMPTS,
		waitMs = LOST_RESULT_WAIT_MS,
	} = {},
) {
	const paths = guestJobPaths(request.workspaceId);
	const failClosed = (reason) =>
		launchResult.code === 0 ? bridgeFailure(reason) : launchResult;
	const launchLostResult =
		launchResult.code === 255 &&
		PRLCTL_MISFIRE.test(launchResult.stderr.toString("utf8"));
	const initialGraceAttempts = launchLostResult
		? Math.max(lostResultProbeAttempts, LOST_RESULT_INITIAL_GRACE_ATTEMPTS)
		: lostResultProbeAttempts;
	let sawMarker = false;
	let statusResult = null;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			statusResult = await guestFile(
				request.workspaceId,
				paths.status,
				runControlFn,
			);
		} catch {
			return failClosed("status read failed");
		}
		if (statusResult.code === 0) break;
		if (statusResult.code !== 1) return failClosed("status read failed");
		let markerResult;
		try {
			markerResult = await runControlFn([
				"exec",
				request.workspaceId,
				"/bin/test",
				"-s",
				paths.marker,
			]);
		} catch {
			return failClosed("marker read failed");
		}
		if (markerResult.code !== 0 && markerResult.code !== 1) {
			return failClosed("marker read failed");
		}
		sawMarker ||= markerResult.code === 0;
		if (!sawMarker && attempt >= initialGraceAttempts) {
			return failClosed("marker missing");
		}
		if (attempt % 15 === 0) {
			process.stderr.write(
				`switchyard: awaiting reconciled OpenCode result ${attempt}s\n`,
			);
		}
		await waitFn(waitMs);
	}
	if (statusResult?.code !== 0) {
		return failClosed(sawMarker ? "status timeout" : "marker missing");
	}
	const statusText = statusResult.stdout.toString("utf8").trim();
	if (
		!/^(?:0|[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/u.test(statusText)
	) {
		return failClosed("status invalid");
	}
	let stdoutResult;
	let stderrResult;
	try {
		[stdoutResult, stderrResult] = await Promise.all([
			guestFile(request.workspaceId, paths.stdout, runControlFn),
			guestFile(request.workspaceId, paths.stderr, runControlFn),
		]);
	} catch {
		return failClosed("provider output read failed");
	}
	if (stdoutResult.code !== 0 || stderrResult.code !== 0) {
		return failClosed("provider output read failed");
	}
	let cleanupResult;
	try {
		cleanupResult = await cleanupGuestJob(
			request.workspaceId,
			paths,
			runControlFn,
		);
	} catch {
		return failClosed("cleanup failed");
	}
	if (cleanupResult.code !== 0) return failClosed("cleanup failed");
	return {
		code: Number.parseInt(statusText, 10),
		signal: null,
		stdout: stdoutResult.stdout,
		stderr: stderrResult.stdout,
	};
}

async function main() {
	const request = readRequest();
	const { secret, guestEnv } = takeCredential(request.model);
	const input = credentialInput(secret);
	const launchResult = await runPrlctl(guestArgs(request, guestEnv), input);
	const result = await reconcileGuestResult(request, launchResult);
	const visibleOutput = safeProviderOutput(result.stdout, secret).trim();
	const visibleError = safeProviderOutput(result.stderr, secret).trim();
	if (visibleOutput.length === 0 && visibleError.length === 0) {
		process.stderr.write(
			`opencode-api-key-bridge: guest exited ${result.code ?? result.signal ?? "unknown"} without a provider diagnostic (stdout bytes: ${result.stdout.length}; stderr bytes: ${result.stderr.length})\n`,
		);
	}
	process.stdout.write(safeProviderOutput(result.stdout, secret));
	process.stderr.write(safeProviderOutput(result.stderr, secret));
	if (result.code !== 0) process.exitCode = result.code ?? 1;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error) => {
		process.stderr.write(
			`opencode-api-key-bridge: ${error?.message ?? "unknown failure"}\n`,
		);
		process.exitCode = 1;
	});
}
