// Parallels lifecycle backend.
//
// The VM name is the ownership record: no sidecar file is part of this
// backend. Bulk transfer is deliberately a host-memory HTTP hop; the
// prlctl stdin channel is reserved for tiny control rules, never tar bytes.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
	PrlctlCallError,
	WorkerBootStageError,
} from "../adapter/exec-error.mjs";
import { ExecutionBackend, normalizeExecArgv } from "./execution-backend.mjs";

export const PARALLELS_WORKING_PREFIX = "switchyard-work-";
export const MAX_AQUA_EXEC_ARGV_BYTES = 600000;
// A cold macOS guest has to reach a logged-in Aqua session before
// `launchctl print gui/<uid>` answers, and 30s was inside the noise band of
// how long that actually takes: the INV-3 gate's whole create-boot-destroy
// leg measured 51s on an idle 18-core host, and the 30s budget produced two
// observed `not ready within 30000ms` failures that each passed on rerun --
// one of them at a load average of 4.3 with 81% CPU idle, so this was never
// host contention. waitForAqua returns the instant the probe succeeds, so a
// larger budget costs nothing on the happy path; it only slows how fast a
// genuinely unbootable guest is reported.
const DEFAULT_AQUA_TIMEOUT_MS = 120_000;
const DEFAULT_AQUA_POLL_MS = 250;

// INV-1 clone hardening. `com.parallels.copypaste` is the only Parallels GUI
// LaunchAgent in the guest, and `prlcopypaste` is the process it starts; the
// prltoolsd LaunchDaemon is deliberately not touched, because `prlctl exec` --
// including every call in this file -- rides on it.
const CLIPBOARD_AGENT_LABEL = "com.parallels.copypaste";
const CLIPBOARD_AGENT_PROCESS = "prlcopypaste";
// Measured on this host: prltoolsd starts at boot and the clipboard agent
// appears about five seconds later, so the settle window has to outlast a
// respawn rather than sampling once into the gap.
const DEFAULT_CLIPBOARD_SETTLE_MS = 8_000;
const DEFAULT_CLIPBOARD_POLL_MS = 1_000;

// Workspace preparation reconciliation. The three commands that build the
// workspace are silent, so prlctl's exit status is the only signal they give
// back -- and prlctl loses that signal outright when its host-side job handle
// misfires. Measured 2026-08-31: `/bin/chmod 700 <parent> <root>` returned
// host status 255 with empty stderr/stdout beyond `PrlJob_GetRetCode: Invalid
// argument`, microseconds after `mkdir -p` and `chown` succeeded on those same
// two paths. PrlJob_GetRetCode is a host-side SDK call, so that is prlctl
// failing to read the guest's result, not the guest refusing the command.
// Every one of these commands is idempotent, so a mismatch is safe to repair
// by simply running the layout again.
const DEFAULT_WORKSPACE_VERIFY_TIMEOUT_MS = 15_000;
const DEFAULT_WORKSPACE_VERIFY_POLL_MS = 500;
const WORKSPACE_PREPARE_ATTEMPTS = 2;
const WORKSPACE_MODE = "700";

// Shutdown settle window. `prlctl stop` returns before Parallels has finished
// tearing the VM down, and a delete issued into that gap is refused with a
// truthful "the virtual machine is busy. The virtual machine is currently
// running." Measured 2026-08-31 on the INV-1 gate: the delete failed, the
// reprobe read `running` once and gave up, and the same VM reported `stopped`
// moments later -- so the stop had in fact succeeded and the teardown leaked a
// VM over a race with itself. A settling state has to be polled to a deadline;
// one instantaneous read of it decides nothing.
const DEFAULT_STOP_SETTLE_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_SETTLE_POLL_MS = 1_000;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UUID =
	/^\{?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}?$/i;
const SAFE_GUEST_PATH = /^\/[A-Za-z0-9._+@%+=:,\-/]*$/;
const SAFE_USER = /^[A-Za-z_][A-Za-z0-9._-]*$/;

/**
 * The Task 1.3 credential layout, relative to the provider account's home.
 *
 * Every path here was measured inside the guest on 2026-08-14, not inferred
 * from the CLI's shape: each file was moved aside and the provider's own auth
 * check re-run through the Aqua session, so a `yes` means that provider
 * actually authenticated from a copied file. Two results are worth keeping in
 * view because they invert the obvious guess. **copilot is file-backed** —
 * `login --help` advertises the system credential store, which on macOS is the
 * login Keychain, but the token lands in `~/.copilot/config.json` and a copy of
 * it works. **agy writes a `gemini` Keychain entry after authenticating** and
 * still fails without its token file, so Keychain presence is not evidence of
 * Keychain backing.
 *
 * `cursor-agent` is deliberately absent. It is the PM3-5 case: file-backed in
 * shape, machine-bound in behavior. With `.config/cursor/auth.json`,
 * `.cursor/cli-config.json`, and `.cursor/agent-cli-state.json` all provisioned
 * it still reported `Not logged in`. A routed VM task must fail here rather
 * than at exec inside a guest that holds a store the CLI refuses.
 */
const VM_CREDENTIAL_LAYOUTS = Object.freeze({
	claude: Object.freeze([".claude/.credentials.json", ".claude.json"]),
	codex: Object.freeze([".codex/auth.json"]),
	agy: Object.freeze([".gemini/antigravity-cli/antigravity-oauth-token"]),
	copilot: Object.freeze([".copilot/config.json"]),
	opencode: Object.freeze([".local/share/opencode/auth.json"]),
});
const DEFAULT_TRANSFER_HOST = "10.211.55.2";
// Bind on the Parallels host-only interface. Binding all interfaces leaves
// the listener reachable from unrelated host networks and was not reachable
// from the guest on this substrate's shared bridge.
const DEFAULT_TRANSFER_LISTEN_HOST = DEFAULT_TRANSFER_HOST;
const MAX_TRANSFER_BYTES = 512 * 1024 * 1024;
// Parallels 27.0.0 intermittently loses the result of a host-side SDK job and
// reports it as one of these on exit 255 with no other output. Measured
// 2026-09-01 against the golden image on an idle host, in a plain shell loop
// with switchyard entirely absent: 5 of 150 serial `prlctl exec` calls
// misfired, 14 of 100 under four concurrent callers, and every serial misfire
// succeeded on the very next call. It is transient and per-call, so a bounded
// retry is the correct response; without one, a run making ~20 exec calls has
// roughly even odds of dying on a fault that costs milliseconds to absorb.
const PRLCTL_JOB_MISFIRE =
	/PrlJob_(?:GetRetCode|GetResult):\s*Invalid argument/i;
// Deliberately NOT retried here. A guest still booting refuses the session with
// this message (48 of the first 100 calls after `prlctl start`), and the
// readiness pollers already own that wait on a timescale of minutes. Retrying
// it inside `_call` would both distort those polls and mask an unbootable
// guest as a slow one. It is classified only so the run record can tell the two
// conditions apart.
const PRLCTL_SESSION_NOT_READY =
	/Unable to open new session in this virtual machine/i;
// Four attempts absorbs the measured misfire rate with margin: at the observed
// ~3.3% serial rate a single retry already clears it, and even at the 14%
// concurrent rate four attempts leaves a ~4-in-10,000 residual per call.
const DEFAULT_PRLCTL_RETRY_ATTEMPTS = 4;
const DEFAULT_PRLCTL_RETRY_BACKOFF_MS = 250;
// Only these may be persisted as the failing subcommand. Every value is a
// literal this file passes to `_call`; allowlisting rather than echoing argv
// keeps a guest-influenced string from reaching a run record.
const PRLCTL_SUBCOMMANDS = Object.freeze(
	new Set([
		"--version",
		"clone",
		"delete",
		"exec",
		"list",
		"set",
		"snapshot-delete",
		"snapshot-list",
		"start",
		"stop",
	]),
);
const PERSISTABLE_PRLCTL_SIGNALS = Object.freeze(
	new Set(["SIGABRT", "SIGHUP", "SIGINT", "SIGKILL", "SIGQUIT", "SIGTERM"]),
);
const PROVIDER_PID_MARKER_PREFIX = "/tmp/switchyard-provider-";
// The bulk-transfer URL is only known once the helper has bound its ephemeral
// port, so it reaches the guest as a plaintext argv assignment that the helper
// substitutes. The variable name deliberately does not contain the placeholder
// token, or the substitution would rewrite the name along with the value.
const XFER_URL_ASSIGNMENT = "SWITCHYARD_XFER_URL=TRANSFER_URL";
const INDEX_LOCK_PATH = "/project/.git/index.lock";
const CLEANUP_STARTED = "cleanup_started";
const PID_OBSERVED = "pid_observed";
const TREE_TERMINATED = "tree_terminated";
const PID_MARKER_REMOVED = "pid_marker_removed";
const INDEX_LOCK_REMOVED = "index_lock_removed";
const KILL_GUEST_PROCESS_TREE = String.raw`
set -eu
root="$1"

children() {
  /bin/ps -axo pid=,ppid= | /usr/bin/awk -v parent="$1" '$2 == parent { print $1 }'
}

collect_descendants() {
  for child in $(children "$1"); do
    printf '%s\n' "$child"
    collect_descendants "$child"
  done
}

alive() {
  /bin/ps -axo pid=,state= | /usr/bin/awk -v target="$1" '$1 == target && $2 !~ /^Z/ { found = 1 } END { exit(found ? 0 : 1) }'
}

signal_tree() {
  signal="$1"
  pid="$2"
  for child in $(collect_descendants "$pid"); do
    /bin/kill "-$signal" "$child" 2>/dev/null || true
  done
  /bin/kill "-$signal" "$pid" 2>/dev/null || true
}

signal_tree TERM "$root"
for _ in $(/usr/bin/seq 1 20); do
  survivors=""
  alive "$root" && survivors="$root"
  descendants="$(collect_descendants "$root")"
  if [ -n "$descendants" ]; then
    if [ -n "$survivors" ]; then
      survivors="$survivors $descendants"
    else
      survivors="$descendants"
    fi
  fi
  [ -z "$survivors" ] && exit 0
  /bin/sleep 0.05
done

signal_tree KILL "$root"
/bin/sleep 0.05
survivors=""
alive "$root" && survivors="$root"
descendants="$(collect_descendants "$root")"
if [ -n "$descendants" ]; then
  if [ -n "$survivors" ]; then
    survivors="$survivors $descendants"
  else
    survivors="$descendants"
  fi
fi
[ -z "$survivors" ]
`;
const BWS_SECRET_EXEC = "/Users/dave/Documents/Projects/bws/bws-secret-exec.py";
const OPENCODE_BWS_CONSUMERS = Object.freeze({
	"opencode-go/": "switchyard-opencode-go-dispatch",
	"mistral/": "switchyard-opencode-mistral-dispatch",
});

// This helper runs in a separate Node process because the synchronous
// lifecycle API blocks the caller's event loop while prlctl is running. The
// helper owns only an HTTP listener and an async prlctl child; all payloads
// remain in process memory and are framed back to the parent over stdout.
export const BULK_TRANSFER_HELPER = String.raw`
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const input = readFileSync(0);
const newline = input.indexOf(10);
if (newline < 0) throw new Error("missing transfer header");
const config = JSON.parse(input.subarray(0, newline).toString("utf8"));
const payload = input.subarray(newline + 1);
const token = randomUUID();
const expectedPath = "/" + token;
const maxBytes = config.maxBytes;
let received = null;

function run(args, stdin = null) {
  return new Promise((resolve, reject) => {
    const child = spawn("prlctl", args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8").slice(0, 2000); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error("prlctl failed (" + (code ?? signal ?? "unknown") + "): " + stderr.trim()));
    });
    child.stdin.end(stdin);
  });
}

// This process makes its own prlctl calls, so it needs its own copy of the
// misfire tolerance the synchronous backend applies at its _call chokepoint.
// Without it the bulk transfer was the one production path where a lost
// host-side SDK job result killed a dispatch outright. The signature is
// injected rather than restated here so the retry and the parent's
// classification of the same text cannot drift apart.
const misfire = new RegExp(config.misfireSource, "i");
let attemptsMade = 0;

// Safe to repeat: a misfire means prlctl could not read the RESULT of the
// command, and every call here is idempotent -- loading a pf anchor, or a guest
// fetch-and-extract (push) / tar-and-upload (pull) that lands on the same path
// with the same bytes. Repeating one costs a transfer, not a side effect.
async function runIdempotent(args, stdin = null) {
  for (let attempt = 1; ; attempt += 1) {
    attemptsMade = Math.max(attemptsMade, attempt);
    try {
      return await run(args, stdin);
    } catch (error) {
      const text = String((error && error.message) || "");
      if (attempt >= config.retryAttempts || !misfire.test(text)) throw error;
      await new Promise((resolve) => setTimeout(resolve, config.retryBackoffMs * attempt));
    }
  }
}

const server = createServer((request, response) => {
  if (request.url !== expectedPath) {
    response.writeHead(404).end();
    return;
  }
  if (config.direction === "push" && request.method === "GET") {
    response.writeHead(200, { "content-length": payload.length, "content-type": "application/octet-stream" });
    response.end(payload);
    return;
  }
  if (config.direction === "pull" && request.method === "PUT") {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
      else request.destroy(new Error("transfer exceeds configured limit"));
    });
    request.once("error", () => response.destroy());
    request.once("end", () => {
      received = Buffer.concat(chunks, size);
      response.writeHead(204).end();
    });
    return;
  }
  response.writeHead(405).end();
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, config.listenHost, resolve);
  });
  const address = server.address();
  const url = "http://" + config.transferHost + ":" + address.port + "/" + token;
  const rule = "pass out quick on en0 proto tcp from any to " + config.transferHost + " port " + address.port + "\n";
  try {
    await runIdempotent(config.pfArgs, Buffer.from(rule, "utf8"));
    const guestArgs = config.guestArgs.map((value) => value.replaceAll("TRANSFER_URL", url));
    await runIdempotent(guestArgs);
    if (config.direction === "pull" && !received) throw new Error("guest did not upload a tar");
  } finally {
    try { await run(config.cleanupArgs); } catch { /* cleanup is best effort */ }
  }
  server.close();
  const body = received ?? Buffer.alloc(0);
  const digest = createHash("sha256").update(config.direction === "push" ? payload : body).digest("hex");
  process.stdout.write(JSON.stringify({ bytes: config.direction === "push" ? payload.length : body.length, sha256: digest }) + "\n");
  if (config.direction === "pull") process.stdout.write(body);
} catch (error) {
  try { server.close(); } catch { /* already closed */ }
  process.stderr.write("bulk transfer failed after " + attemptsMade + " attempt(s): " + String(error?.message ?? "unknown") + "\n");
  process.exitCode = 1;
}
`;

function defaultSleep(milliseconds) {
	if (milliseconds <= 0) return;
	const atomics = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(atomics, 0, 0, milliseconds);
}

function defaultPidIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

/**
 * Every place a thrown prlctl failure may carry its signature.
 *
 * `execFileSync` puts the child's stderr on `error.stderr`, but an injected
 * `prlctlFn` (tests, and the bulk-transfer helper) may raise a plain Error
 * whose message is the only evidence, so all three are searched.
 * @param {unknown} error
 * @returns {string}
 */
function prlctlFailureText(error) {
	const parts = [];
	for (const field of ["stderr", "stdout", "message"]) {
		const value = error?.[field];
		if (typeof value === "string") parts.push(value);
		else if (Buffer.isBuffer(value)) parts.push(value.toString("utf8"));
	}
	return parts.join("\n");
}

/**
 * Classify a thrown prlctl failure into a closed diagnostic code.
 *
 * Signature matching comes first so a misfire is still recognized when the
 * harness also killed the child, which is the ambiguous case the old code
 * could not distinguish at all.
 * @param {unknown} error
 * @returns {string} member of the prlctl diagnostic vocabulary
 */
function classifyPrlctlFailure(error) {
	const text = prlctlFailureText(error);
	if (PRLCTL_JOB_MISFIRE.test(text)) return "prlctl_job_misfire";
	if (PRLCTL_SESSION_NOT_READY.test(text)) return "prlctl_session_not_ready";
	if (error?.killed === true || error?.code === "ETIMEDOUT") {
		return "prlctl_call_timed_out";
	}
	return "prlctl_call_failed";
}

/**
 * Classify a failed bulk-transfer helper run.
 *
 * The helper is a separate process, so its prlctl failures never reach `_call`
 * and were the one production path that surfaced a bare Error: a misfire there
 * reached the run record as `worker_boot_exception`, naming the stage and not
 * the cause. Both numbers in its stderr line are formats this module defines
 * itself -- "prlctl failed (255):" from the helper's own `run`, and the attempt
 * count added alongside it -- so reading them back is a private protocol, not
 * prose matching. The helper process's own exit status is deliberately ignored:
 * it is 1 for every failure and is not prlctl's.
 * @param {string} detail Trimmed helper stderr.
 * @returns {PrlctlCallError}
 */
export function describeBulkTransferFailure(detail) {
	const text = typeof detail === "string" ? detail : "";
	const attemptMatch = /failed after (\d{1,3}) attempt/.exec(text);
	const exitMatch = /prlctl failed \((\d{1,3})\)/.exec(text);
	const exitCode = exitMatch ? Number(exitMatch[1]) : null;
	return new PrlctlCallError({
		diagnosticCode: classifyPrlctlFailure({ message: text }),
		subcommand: "exec",
		attempts: attemptMatch ? Number(attemptMatch[1]) : 1,
		exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
		cause: new Error(
			text
				? `Parallels bulk transfer failed: ${text}`
				: "Parallels bulk transfer failed",
		),
	});
}

/**
 * Wrap a thrown prlctl failure in the reviewed error type, preserving the
 * original as `cause` for local debugging while exposing only closed,
 * bounded fields for persistence.
 * @param {unknown} error
 * @param {{args: string[], attempts: number}} context
 * @returns {PrlctlCallError}
 */
function describePrlctlFailure(error, { args, attempts }) {
	const subcommand = PRLCTL_SUBCOMMANDS.has(args?.[0]) ? args[0] : null;
	const status = error?.status;
	const signal = error?.signal;
	return new PrlctlCallError({
		diagnosticCode: classifyPrlctlFailure(error),
		subcommand,
		attempts,
		exitCode: Number.isSafeInteger(status) ? status : null,
		signal: PERSISTABLE_PRLCTL_SIGNALS.has(signal) ? signal : null,
		killed: error?.killed === true || error?.code === "ETIMEDOUT",
		cause: error,
	});
}

/**
 * Validate a retry-attempt count. One means "no retry", which is a legitimate
 * caller choice, so the floor is 1 rather than 2.
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function validateAttemptCount(value, label) {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new TypeError(`${label} must be an integer >= 1`);
	}
	return value;
}

function outputText(value) {
	if (Buffer.isBuffer(value)) return value.toString("utf8");
	if (typeof value === "string") return value;
	if (value && typeof value.stdout !== "undefined") {
		return outputText(value.stdout);
	}
	return "";
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function providerPidMarkerPath(workspaceId) {
	const digest = createHash("sha256").update(String(workspaceId)).digest("hex");
	return `${PROVIDER_PID_MARKER_PREFIX}${digest.slice(0, 32)}.pid`;
}

function validateGuestPath(value, label) {
	if (typeof value !== "string" || !SAFE_GUEST_PATH.test(value)) {
		throw new Error(`${label} must be an absolute safe guest path`);
	}
	if (value.split("/").includes("..")) {
		throw new Error(`${label} must not contain parent traversal`);
	}
	return value;
}

function validateUser(value) {
	if (typeof value !== "string" || !SAFE_USER.test(value)) {
		throw new Error("provider user must be a safe account name");
	}
	return value;
}

/**
 * The provider account's home directory. `prlctl exec` enters the guest with
 * `HOME=/`, and macOS sudoers preserves it across `sudo -u`, so `-H` does not
 * override it. Everything that has to agree on one home — credential
 * provisioning, the login shell's profile, and the provider's own cache and
 * config directories — resolves it here.
 * @param {string} providerUser
 * @returns {string}
 */
function providerHomePath(providerUser) {
	return `/Users/${validateUser(providerUser)}`;
}

function resolveWorkspacePath(value, providerUser) {
	const user = validateUser(providerUser);
	const physicalRoot = `${providerHomePath(user)}/.switchyard/project`;
	if (value === "/project") return physicalRoot;
	if (value.startsWith("/project/")) {
		return `${physicalRoot}${value.slice("/project".length)}`;
	}
	return value;
}

/**
 * A `KEY=value` assignment that survives prlctl's join-and-reparse untouched:
 * printable ASCII only, and no character the guest's single parse would act on.
 * @param {string} value
 * @returns {string}
 */
function validateEnvAssignment(value) {
	if (
		typeof value !== "string" ||
		!/^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9._+@%=:,/-]*$/.test(value)
	) {
		throw new Error("env assignment must be a safe KEY=value pair");
	}
	return value;
}

function validateUid(value) {
	if (!/^\d+$/.test(String(value ?? "")) || Number(value) <= 0) {
		throw new Error("aquaUid must be a positive numeric uid");
	}
	return String(value);
}

function validateTransferHost(value) {
	if (
		typeof value !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(value) ||
		value.includes("..")
	) {
		throw new Error("transferHost must be a safe host address");
	}
	return value;
}

function validateTar(value) {
	if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
		throw new TypeError("tar must be an in-memory Buffer or Uint8Array");
	}
	if (value.byteLength > MAX_TRANSFER_BYTES) {
		throw new Error("tar exceeds the configured in-memory transfer limit");
	}
	return Buffer.from(value);
}

/**
 * The name Parallels itself gives the parent snapshot it creates for a linked
 * clone, verified against prlctl 26.4.1 on 2026-08-26.
 *
 * Nothing in this module matches snapshots by name — clone-time detection is a
 * before-and-after id diff, which needs no name. This constant exists as the
 * single source of truth for `ops/switchyard-reaper.sh`, a standalone shell
 * script that must duplicate the literal because it reads no project code, and
 * `tests/reaper-script.test.mjs` fails if the two drift.
 */
export const PARALLELS_LINKED_SNAPSHOT_NAME = "Snapshot for linked clone";

function snapshotIdsFromOutput(output) {
	const text = outputText(output);
	const ids = new Set();
	try {
		const parsed = JSON.parse(text);
		const visit = (value) => {
			if (!value || typeof value !== "object") return;
			if (Array.isArray(value)) {
				for (const item of value) visit(item);
				return;
			}
			for (const [key, item] of Object.entries(value)) {
				if (
					/^(?:id|snapshot[_-]?id)$/i.test(key) &&
					typeof item === "string" &&
					item.length > 0
				) {
					ids.add(item);
				}
				visit(item);
			}
		};
		visit(parsed);
	} catch {
		for (const match of text.matchAll(
			/\{?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}?/gi,
		)) {
			ids.add(match[0]);
		}
	}
	return ids;
}

function snapshotDifference(after, before) {
	return [...after].filter((id) => !before.has(id));
}

function measurePathBytes(path) {
	const entry = lstatSync(path);
	if (!entry.isDirectory()) return entry.size;
	return readdirSync(path, { withFileTypes: true }).reduce((total, child) => {
		const childPath = `${path}/${child.name}`;
		return total + measurePathBytes(childPath);
	}, 0);
}

function diskBytesFromInfo(info, diskUsageFn = null) {
	const text = outputText(info);
	const image = text.match(/\bimage=['"]([^'"]+)['"]/i)?.[1];
	if (image) {
		const bytes = diskUsageFn ? diskUsageFn(image) : measurePathBytes(image);
		if (Number.isFinite(Number(bytes)) && Number(bytes) > 0) {
			return Number(bytes);
		}
	}
	const size = text.match(
		/\b(?:size|capacity)\s*[=:]\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?\b/i,
	);
	if (size) {
		const units = {
			B: 1,
			KB: 1024,
			MB: 1024 ** 2,
			GB: 1024 ** 3,
			TB: 1024 ** 4,
		};
		const bytes =
			Number(size[1]) * (units[String(size[2] ?? "B").toUpperCase()] ?? 1);
		if (Number.isFinite(bytes) && bytes > 0) return bytes;
	}
	throw new Error(
		"linked clone disk measurement was not present in prlctl output",
	);
}

function validateRunId(runId) {
	if (typeof runId !== "string" || !SAFE_RUN_ID.test(runId)) {
		throw new Error("runId must be a non-empty safe identifier");
	}
	return runId;
}

function validatePid(pid) {
	if (!Number.isInteger(pid) || pid <= 0) {
		throw new Error("creatorPid must be a positive integer");
	}
	return pid;
}

/**
 * Validate a millisecond knob at construction rather than at the wait itself.
 *
 * Every one of these values ends up as an argument to `sleepFn`, whose default
 * is a blocking `Atomics.wait`. A NaN or negative there is not a bad poll
 * interval, it is a hung teardown with no diagnostic, so an out-of-range value
 * has to be refused where the caller can still see which knob it named.
 * Timeouts accept 0 -- "do not wait" is a meaningful budget -- while a poll
 * interval of 0 is a busy loop and is refused.
 * @param {unknown} value
 * @param {string} name
 * @param {number} minimum
 * @returns {number}
 */
function validateDurationMs(value, name, minimum) {
	if (!Number.isSafeInteger(value) || value < minimum) {
		throw new Error(`${name} must be an integer of at least ${minimum}ms`);
	}
	return value;
}

/**
 * Build the only VM name this backend may create or reclaim.
 * @param {string} runId
 * @param {number} creatorPid
 * @returns {string}
 */
export function buildParallelsWorkingName(runId, creatorPid) {
	return `${PARALLELS_WORKING_PREFIX}${validateRunId(runId)}-${validatePid(creatorPid)}`;
}

/**
 * Parse ownership from a VM name. The PID is the final hyphen-delimited
 * component, so run IDs may contain hyphens without weakening the proof.
 * @param {unknown} name
 * @returns {{name: string, runId: string, creatorPid: number}|null}
 */
export function parseParallelsWorkingName(name) {
	if (typeof name !== "string" || !name.startsWith(PARALLELS_WORKING_PREFIX)) {
		return null;
	}
	const remainder = name.slice(PARALLELS_WORKING_PREFIX.length);
	const separator = remainder.lastIndexOf("-");
	if (separator <= 0) return null;
	const runId = remainder.slice(0, separator);
	const pidText = remainder.slice(separator + 1);
	if (!SAFE_RUN_ID.test(runId) || !/^[1-9]\d*$/.test(pidText)) return null;
	return { name, runId, creatorPid: Number(pidText) };
}

/**
 * Validate the evidence required before selecting a linked clone.
 *
 * Parallels creates a snapshot on the golden image for a linked clone and
 * does not protect that image from destructive operations. A positive disk
 * measurement and finite clone-to-boot duration are therefore a prerequisite
 * for using `--linked`; missing or malformed evidence fails closed.
 * @param {unknown} measurement
 * @returns {{diskBytes: number, cloneToBootMs: number}}
 */
export function validateLinkedCloneMeasurement(measurement) {
	if (!measurement || typeof measurement !== "object") {
		throw new Error(
			"refusing linked clone: positive disk and finite clone-to-boot measurements are required",
		);
	}
	const diskBytes = Number(measurement.diskBytes ?? measurement.onDiskBytes);
	const cloneToBootMs = Number(measurement.cloneToBootMs ?? measurement.bootMs);
	if (
		!Number.isFinite(diskBytes) ||
		diskBytes <= 0 ||
		!Number.isFinite(cloneToBootMs) ||
		cloneToBootMs < 0
	) {
		throw new Error(
			"refusing linked clone: positive disk and finite clone-to-boot measurements are required",
		);
	}
	return { diskBytes, cloneToBootMs };
}

function parseVmList(output) {
	return outputText(output)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const fields = line.includes("\t")
				? line.split("\t").map((field) => field.trim())
				: line.split(/\s+/);
			if (fields.length < 3) return null;
			const [uuid, status, ...nameParts] = fields;
			const name = nameParts.join(" ").trim();
			if (!uuid || !status || !name || name.toLowerCase() === "name")
				return null;
			return {
				uuid,
				status,
				name,
				ownership: parseParallelsWorkingName(name),
			};
		})
		.filter(Boolean);
}

function isUuid(value) {
	return typeof value === "string" && UUID.test(value);
}

/**
 * Synchronous Parallels lifecycle implementation with injectable VM calls.
 *
 * `prlctlFn` receives `(argv, options)` and returns the command's stdout (or
 * an execFileSync-compatible Buffer/string). Supplying it, `sleepFn`,
 * `nowFn`, and `pidIsAlive` makes clone/boot/destroy/reclamation hermetic.
 * @public
 */
export class ParallelsExecutionBackend extends ExecutionBackend {
	constructor({
		prlctlFn,
		execFn,
		bulkTransferFn = null,
		sleepFn = defaultSleep,
		nowFn = Date.now,
		pidIsAlive = defaultPidIsAlive,
		creatorPid = process.pid,
		aquaUid = null,
		aquaTimeoutMs = DEFAULT_AQUA_TIMEOUT_MS,
		aquaPollMs = DEFAULT_AQUA_POLL_MS,
		clipboardSettleMs = DEFAULT_CLIPBOARD_SETTLE_MS,
		clipboardPollMs = DEFAULT_CLIPBOARD_POLL_MS,
		workspaceVerifyTimeoutMs = DEFAULT_WORKSPACE_VERIFY_TIMEOUT_MS,
		workspaceVerifyPollMs = DEFAULT_WORKSPACE_VERIFY_POLL_MS,
		stopSettleTimeoutMs = DEFAULT_STOP_SETTLE_TIMEOUT_MS,
		stopSettlePollMs = DEFAULT_STOP_SETTLE_POLL_MS,
		goldenImage = null,
		snapshotSidecarRoot = null,
		runId = null,
		measureLinkedCloneFn = null,
		diskUsageFn = null,
		requireLinkedCloneMeasurement = true,
		providerUser = "switchyard",
		transferHost = DEFAULT_TRANSFER_HOST,
		transferListenHost = DEFAULT_TRANSFER_LISTEN_HOST,
		maxTransferBytes = MAX_TRANSFER_BYTES,
		prlctlRetryAttempts = DEFAULT_PRLCTL_RETRY_ATTEMPTS,
		prlctlRetryBackoffMs = DEFAULT_PRLCTL_RETRY_BACKOFF_MS,
	} = {}) {
		super();
		if (typeof prlctlFn === "function") {
			this.prlctlFn = prlctlFn;
		} else {
			const invoke = execFn ?? execFileSync;
			this.prlctlFn = (args, options = {}) =>
				invoke("prlctl", args, {
					encoding: "utf8",
					stdio: "pipe",
					...options,
				});
		}
		this.bulkTransferFn = bulkTransferFn;
		this.prlctlRetryAttempts = validateAttemptCount(
			prlctlRetryAttempts,
			"prlctlRetryAttempts",
		);
		this.prlctlRetryBackoffMs = validateDurationMs(
			prlctlRetryBackoffMs,
			"prlctlRetryBackoffMs",
			0,
		);
		this.sleepFn = sleepFn;
		this.nowFn = nowFn;
		this.pidIsAlive = pidIsAlive;
		this.creatorPid = validatePid(creatorPid);
		this.aquaUid = aquaUid;
		this.aquaTimeoutMs = validateDurationMs(aquaTimeoutMs, "aquaTimeoutMs", 0);
		this.aquaPollMs = validateDurationMs(aquaPollMs, "aquaPollMs", 1);
		this.clipboardSettleMs = validateDurationMs(
			clipboardSettleMs,
			"clipboardSettleMs",
			0,
		);
		this.clipboardPollMs = validateDurationMs(
			clipboardPollMs,
			"clipboardPollMs",
			1,
		);
		this.workspaceVerifyTimeoutMs = validateDurationMs(
			workspaceVerifyTimeoutMs,
			"workspaceVerifyTimeoutMs",
			0,
		);
		this.workspaceVerifyPollMs = validateDurationMs(
			workspaceVerifyPollMs,
			"workspaceVerifyPollMs",
			1,
		);
		this.stopSettleTimeoutMs = validateDurationMs(
			stopSettleTimeoutMs,
			"stopSettleTimeoutMs",
			0,
		);
		this.stopSettlePollMs = validateDurationMs(
			stopSettlePollMs,
			"stopSettlePollMs",
			1,
		);
		this.goldenImage = goldenImage;
		// Injected rather than imported: this backend depends on Node builtins
		// and its own base class only, and its testability rests on injected
		// seams (nowFn, sleepFn, prlctlFn). Importing run-store here to reach
		// getVmAdmissionRoot() would give up both. Null disables the sidecar,
		// which is the correct posture for a backend with nowhere durable to
		// write: destroy() still cleans up in-process.
		this.snapshotSidecarRoot = snapshotSidecarRoot;
		this.runId = typeof runId === "string" && runId ? runId : null;
		this.measureLinkedCloneFn = measureLinkedCloneFn;
		this.diskUsageFn = diskUsageFn;
		this.linkedMeasurementReceipts = new WeakSet();
		this.linkedSnapshotsByUuid = new Map();
		this.requireLinkedCloneMeasurement = requireLinkedCloneMeasurement;
		this.providerUser = validateUser(providerUser);
		this.transferHost = validateTransferHost(transferHost);
		if (
			typeof transferListenHost !== "string" ||
			!/^[A-Za-z0-9.:-]+$/.test(transferListenHost)
		) {
			throw new Error("transferListenHost must be a safe host address");
		}
		this.transferListenHost = transferListenHost;
		if (!Number.isInteger(maxTransferBytes) || maxTransferBytes <= 0) {
			throw new Error("maxTransferBytes must be a positive integer");
		}
		this.maxTransferBytes = maxTransferBytes;
	}

	/**
	 * The single funnel for every synchronous prlctl invocation.
	 *
	 * Do not give this call a timeout, and do not kill an orchestrator that is
	 * blocked in it. prlctl 26.4.1 segfaults when a signal reaches it after its
	 * parent has exited: it jumps to address 0 through `_sigtramp` while blocked
	 * in `QWaitCondition::wait` inside ParallelsVirtualizationSDK. Measured
	 * 2026-08-14 17:33:00 — pid 10735, five minutes into an operation whose
	 * parent was already gone. That crash leaked nothing, but an interrupted
	 * clone is exactly the orphan INV-3's reclamation exists to sweep, and the
	 * sweep only fires for a creator PID it can prove dead.
	 *
	 * The operations here are long by nature: a full clone of the golden image
	 * runs for minutes. Bound them by making the operation smaller, never by
	 * killing it partway.
	 */
	/**
	 * Invoke prlctl, absorbing the measured host-side SDK job misfire.
	 *
	 * This is the single chokepoint every one of the backend's prlctl call
	 * sites already funnelled through, which is why the retry lives here rather
	 * than being sprinkled across ~26 call sites that would each have to
	 * remember it. Only `prlctl_job_misfire` is retried; a timeout, a
	 * not-yet-booted guest, and an ordinary non-zero exit are all real answers
	 * that a caller must see on the first attempt. Every failure that escapes
	 * is a `PrlctlCallError` carrying exit code, signal, killed-by-us, and the
	 * attempt count, so a run record can say what happened instead of "no
	 * metadata recorded".
	 *
	 * @param {string[]} args
	 * @param {object} [options] execFileSync options, plus `retry: false` to opt out.
	 * @returns {string|Buffer} prlctl stdout
	 * @throws {PrlctlCallError}
	 */
	_call(args, options = {}) {
		const { retry = true, ...invokeOptions } = options;
		const maxAttempts = retry ? this.prlctlRetryAttempts : 1;
		for (let attempt = 1; ; attempt += 1) {
			try {
				return this.prlctlFn(args, invokeOptions);
			} catch (error) {
				const failure = describePrlctlFailure(error, {
					args,
					attempts: attempt,
				});
				if (
					failure.diagnosticCode !== "prlctl_job_misfire" ||
					attempt >= maxAttempts
				) {
					throw failure;
				}
				// Linear backoff. The fault clears on the next call in every
				// measured case, so this is a courtesy pause for the dispatcher
				// rather than a wait for a slow resource to free up.
				this.sleepFn(this.prlctlRetryBackoffMs * attempt);
			}
		}
	}

	/**
	 * Preserve a failed stop/kill result unless the exact VM is independently
	 * observed stopped. Parallels can return 255 after completing a stop, so the
	 * command result alone is not sufficient evidence that deletion is unsafe.
	 * Conversely, never let a failed stop fall through to delete while the VM
	 * still reports running (or has disappeared from the authoritative list).
	 */
	_reprobeStopped(entry, cause) {
		const current = this._awaitSettled(entry, cause);
		if (!current) throw cause;
		return current;
	}

	/**
	 * Poll the authoritative list until the exact UUID is stopped or gone.
	 *
	 * Shutdown is asynchronous: `prlctl stop` returns while Parallels is still
	 * releasing the VM, and during that window the VM answers `running` and
	 * refuses deletion as busy. Waiting the window out is the whole point --
	 * sampling once resolves the race by coin flip. Returns the stopped entry,
	 * or undefined when the UUID has left the list; throws `cause` if the VM is
	 * still running when the deadline expires, so a genuinely stuck VM is
	 * reported with the failure that led here rather than a timeout of our own.
	 */
	_awaitSettled(entry, cause) {
		const timeoutMs = this.stopSettleTimeoutMs;
		const startedAt = this.nowFn();
		for (;;) {
			let current;
			try {
				current = this.listAll().find(
					(candidate) => candidate.uuid === entry.uuid,
				);
			} catch {
				throw cause;
			}
			if (!current) return undefined;
			if (/^stopped$/i.test(String(current.status ?? ""))) return current;
			const elapsedMs = this.nowFn() - startedAt;
			if (elapsedMs >= timeoutMs) throw cause;
			this.sleepFn(Math.min(this.stopSettlePollMs, timeoutMs - elapsedMs));
		}
	}

	/**
	 * Reconcile a failed delete. An absent exact UUID is positive evidence that
	 * Parallels completed the delete despite its nonzero result; every present
	 * state must still be stopped before a retry is allowed.
	 */
	_reprobeStoppedOrAbsent(entry, cause) {
		return this._awaitSettled(entry, cause) !== undefined;
	}

	preflight() {
		return outputText(this._call(["--version"])).trim();
	}

	/**
	 * Build the complete prlctl argument vector for one guest command.
	 *
	 * Two properties of `prlctl exec` shape this, both measured against a live
	 * guest rather than assumed:
	 *
	 * 1. It does not pass its argument vector through. It joins the arguments
	 *    with spaces and the guest applies exactly one round of shell parsing
	 *    to the result, so an unquoted prompt is word-split at its first space
	 *    and the tail of a multi-line argument runs as separate commands.
	 * 2. It cannot carry a byte above 0x7F. Every multi-byte UTF-8 character —
	 *    an em dash, a curly quote, an accented name, CJK, an emoji — corrupts
	 *    the command line the guest reconstructs, which surfaces as an
	 *    unbalanced-quote syntax error rather than as mangled text.
	 *
	 * So the guest command is shell-quoted here and then base64-encoded, and
	 * what crosses the boundary is only the base64 alphabet. Callers append
	 * nothing: `argv` is the whole command, because a transport that never
	 * sees the full vector cannot encode it.
	 *
	 * @param {string} workspaceId
	 * @param {string[]} argv complete guest command vector
	 * @param {{cwd?: string, aquaUid?: string|number, providerUser?: string,
	 *          recordPid?: boolean, env?: string[]}} [options]
	 * @returns {string[]}
	 */
	_buildAquaExecArgs(
		workspaceId,
		argv,
		{
			cwd = "/project",
			aquaUid,
			providerUser,
			recordPid = false,
			env = [],
		} = {},
	) {
		const command = normalizeExecArgv(argv);
		const uid = validateUid(aquaUid ?? this.aquaUid);
		const user = validateUser(providerUser ?? this.providerUser);
		const resolvedCwd = resolveWorkspacePath(cwd, user);
		validateGuestPath(resolvedCwd, "cwd");
		const pidPath = providerPidMarkerPath(workspaceId);
		const quotedCommand = command.map((entry) => shellQuote(entry)).join(" ");
		const launch = `exec ${quotedCommand}`;
		const inner = recordPid
			? `cd ${shellQuote(resolvedCwd)} || exit $?; trap 'rm -f -- ${shellQuote(pidPath)}' EXIT; ${quotedCommand} <&0 & provider_pid=$!; echo "$provider_pid" > ${shellQuote(pidPath)}; wait "$provider_pid"; provider_status=$?; exit "$provider_status"`
			: `cd ${shellQuote(resolvedCwd)} && ${launch}`;
		const payload = Buffer.from(inner, "utf8").toString("base64");
		const args = [
			"exec",
			workspaceId,
			"--use-advanced-terminal",
			"launchctl",
			"asuser",
			uid,
			"sudo",
			"-u",
			user,
			// The account's environment has to be established before bash starts,
			// not inside the -c script: `-l` sources /etc/profile and then
			// $HOME/.bash_profile *first*, and with the inherited HOME=/ it would
			// read the wrong profile and leave providers writing their caches to a
			// read-only /.
			"/usr/bin/env",
			`HOME=${providerHomePath(user)}`,
			`USER=${user}`,
			`LOGNAME=${user}`,
			// Extra assignments stay outside the base64 payload so a value that is
			// only known once the transport is running — the bulk-transfer URL and
			// its ephemeral port — can still be substituted into the argv.
			...env.map((entry) => validateEnvAssignment(entry)),
			"/bin/bash",
			"-lc",
			// The decode runs in a command substitution, so the provider still
			// inherits this process's stdin, stdout, stderr and exit status.
			shellQuote(`eval "$(printf %s ${payload} | /usr/bin/base64 -D)"`),
		];
		const totalBytes = args.reduce(
			(total, entry) => total + Buffer.byteLength(entry, "utf8"),
			0,
		);
		if (totalBytes > MAX_AQUA_EXEC_ARGV_BYTES) {
			throw new Error(
				`guest command exceeds the macOS ARG_MAX-safe limit (${totalBytes} bytes > ${MAX_AQUA_EXEC_ARGV_BYTES} bytes); this VM lane cannot execute a payload this large`,
			);
		}
		return args;
	}

	/**
	 * Return the exact transport for one provider command. It runs in the
	 * provider's Aqua session and inherits its stdin, stdout, stderr, exit
	 * status, and killable prlctl process handle.
	 * @param {string[]} [options.env] Extra `KEY=value` assignments for the
	 *   guest process — e.g. an interactive login that needs
	 *   `NO_OPEN_BROWSER=1`. Real dispatch never needs this; it exists for
	 *   `auth/index.mjs`'s interactive login, which shares this exact
	 *   inherit-stdio transport rather than a second one.
	 */
	execArgv(
		workspaceId,
		{
			cwd = "/project",
			aquaUid,
			providerUser,
			argv,
			recordPid = false,
			env,
		} = {},
	) {
		return {
			command: "prlctl",
			args: this._buildAquaExecArgs(workspaceId, argv, {
				cwd,
				aquaUid,
				providerUser,
				recordPid,
				env,
			}),
		};
	}

	/**
	 * Return the fixed BWS consumer invocation for a one-off OpenCode API-key
	 * dispatch. The request is non-secret stdin: the pinned consumer obtains the
	 * key itself and keeps it out of host argv, guest disk, and auth.json.
	 *
	 * @param {string} workspaceId Linked-clone UUID.
	 * @param {{model:string, invocationArgs:string[], prompt:string, idleSeconds:number}} request
	 * @returns {{command:string, args:string[], input:string}|null}
	 */
	ephemeralOpenCodeKeyExecution(workspaceId, request = {}) {
		if (!UUID.test(String(workspaceId ?? ""))) {
			throw new Error(
				"workspaceId must be a VM UUID for ephemeral OpenCode credentials",
			);
		}
		const model = String(request.model ?? "");
		const prefix = Object.keys(OPENCODE_BWS_CONSUMERS).find((entry) =>
			model.startsWith(entry),
		);
		if (!prefix) return null;
		if (
			!Array.isArray(request.invocationArgs) ||
			request.invocationArgs.some((value) => typeof value !== "string") ||
			typeof request.prompt !== "string" ||
			!Number.isInteger(request.idleSeconds)
		) {
			throw new TypeError("ephemeral OpenCode request is malformed");
		}
		return {
			command: BWS_SECRET_EXEC,
			args: [OPENCODE_BWS_CONSUMERS[prefix], "--"],
			input: JSON.stringify({
				workspaceId: String(workspaceId).replace(/^\{|\}$/g, ""),
				model,
				invocationArgs: request.invocationArgs,
				prompt: request.prompt,
				idleSeconds: request.idleSeconds,
			}),
			cleanupContext: { workspaceId },
		};
	}

	/**
	 * Return the marker path used by execArgv for this VM workspace.
	 * @param {string} workspaceId
	 * @returns {string}
	 */
	providerPidPath(workspaceId) {
		return providerPidMarkerPath(workspaceId);
	}

	/** Execute one small control command through the same Aqua identity route. */
	execGuest(workspaceId, command, args = [], options = {}) {
		if (
			typeof command !== "string" ||
			!/^[A-Za-z0-9._+@%/=:-]+$/.test(command)
		) {
			throw new Error("guest command must be a safe executable name");
		}
		if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
			throw new TypeError("guest command arguments must be strings");
		}
		// Retry is OFF by default here and must stay that way. `execGuest` runs
		// caller-supplied guest commands, and its callers include every provider
		// adapter's actual execution call (codex, agy, copilot, opencode, vibe).
		// A job misfire means prlctl could not read the RESULT of a command the
		// guest may well have completed, so retrying one of those would re-run a
		// paid provider task and repeat its side effects. The misfire is cheap
		// to absorb only where the payload is idempotent, which is the backend's
		// own provisioning and inspection calls, not this path. A caller that
		// knows its command is safe to repeat may pass `retry: true`.
		return this._call(
			this._buildAquaExecArgs(workspaceId, [command, ...args], options),
			{ retry: false, ...(options.prlctlOptions ?? {}) },
		);
	}

	/**
	 * Read a PID marker written by a future launch wrapper. Task 4.2 has no
	 * caller that needs a supervisor; this helper keeps the guest PID handoff
	 * explicit for the timeout task without adding one.
	 */
	getGuestPid(workspaceId, pidPath) {
		validateGuestPath(pidPath, "pidPath");
		const output = outputText(
			this.execGuest(workspaceId, "/bin/cat", [pidPath], { cwd: "/" }),
		).trim();
		if (!/^\d+$/.test(output) || Number(output) <= 0) {
			throw new Error("guest PID marker was missing or invalid");
		}
		return Number(output);
	}

	_runBulkTransfer({ direction, workspaceId, payload, guestArgs }) {
		const tar = direction === "push" ? validateTar(payload) : Buffer.alloc(0);
		// pf anchor names are bounded by the kernel's fixed buffer. The golden
		// ruleset already delegates this child namespace, so an 8-byte random
		// suffix is sufficient without exceeding that bound.
		const anchor = `com.apple/switchyard-c3/switchyard-transfer/${randomUUID()
			.replaceAll("-", "")
			.slice(0, 8)}`;
		const config = {
			direction,
			transferHost: this.transferHost,
			listenHost: this.transferListenHost,
			maxBytes: this.maxTransferBytes,
			misfireSource: PRLCTL_JOB_MISFIRE.source,
			retryAttempts: this.prlctlRetryAttempts,
			retryBackoffMs: this.prlctlRetryBackoffMs,
			guestArgs,
			pfArgs: ["exec", workspaceId, "/sbin/pfctl", "-a", anchor, "-f", "-"],
			cleanupArgs: [
				"exec",
				workspaceId,
				"/sbin/pfctl",
				"-a",
				anchor,
				"-F",
				"all",
			],
		};
		const descriptor = { ...config, workspaceId, tar };
		if (typeof this.bulkTransferFn === "function") {
			const result = this.bulkTransferFn(descriptor);
			if (direction === "pull") return validateTar(result);
			return {
				bytes: tar.length,
				sha256: createHash("sha256").update(tar).digest("hex"),
				...(result && typeof result === "object" ? result : {}),
			};
		}

		const input = Buffer.concat([
			Buffer.from(`${JSON.stringify(config)}\n`, "utf8"),
			tar,
		]);
		const result = spawnSync(
			process.execPath,
			["--input-type=module", "-e", BULK_TRANSFER_HELPER],
			{
				input,
				encoding: null,
				maxBuffer: this.maxTransferBytes + 1024 * 1024,
			},
		);
		if (result.error || result.status !== 0) {
			throw describeBulkTransferFailure(outputText(result.stderr).trim());
		}
		const output = Buffer.from(result.stdout ?? Buffer.alloc(0));
		const separator = output.indexOf(10);
		if (separator < 0)
			throw new Error("Parallels bulk transfer returned no receipt");
		let receipt;
		try {
			receipt = JSON.parse(output.subarray(0, separator).toString("utf8"));
		} catch {
			throw new Error("Parallels bulk transfer returned an invalid receipt");
		}
		if (direction === "pull")
			return validateTar(output.subarray(separator + 1));
		return receipt;
	}

	/**
	 * Transfer a tar to a guest directory through a temporary host HTTP
	 * endpoint. The endpoint is permitted by one guest-only pf anchor and the
	 * anchor is flushed in the helper's finally path.
	 */
	pushTar(workspaceId, tar, destination = "/project", options = {}) {
		const user = validateUser(options.providerUser ?? this.providerUser);
		const resolvedDestination = resolveWorkspacePath(destination, user);
		validateGuestPath(resolvedDestination, "destination");
		// A caller that knows exactly which paths it extracted can name them and
		// skip the recursive sweep below. Credential provisioning must: one of
		// claude's two files lives at the root of the provider's home, so a
		// `chown -R` of that destination would descend through the seeded
		// workspace and everything else the account owns.
		const chownTargets =
			Array.isArray(options.chownTargets) && options.chownTargets.length > 0
				? options.chownTargets.map((value) =>
						validateGuestPath(resolveWorkspacePath(value, user), "chownTarget"),
					)
				: null;
		const script =
			`set -o pipefail; /bin/mkdir -p -- ${shellQuote(resolvedDestination)} && ` +
			`/usr/bin/curl --fail --silent --show-error --location --retry 15 --retry-delay 1 --retry-connrefused --output - "$SWITCHYARD_XFER_URL" | ` +
			`/usr/bin/tar -xpf - -C ${shellQuote(resolvedDestination)}`;
		const guestArgs =
			options.providerUser || options.aquaUid
				? this._buildAquaExecArgs(workspaceId, ["/bin/bash", "-lc", script], {
						cwd: "/",
						aquaUid: options.aquaUid,
						providerUser: options.providerUser,
						env: [XFER_URL_ASSIGNMENT],
					})
				: [
						"exec",
						workspaceId,
						"/usr/bin/env",
						XFER_URL_ASSIGNMENT,
						"/bin/bash",
						"-lc",
						shellQuote(script),
					];
		const receipt = this._runBulkTransfer({
			direction: "push",
			workspaceId,
			payload: tar,
			guestArgs,
		});
		// BSD tar preserves the archive's root ownership even when the
		// extraction is initiated by the provider account. Normalize only the
		// destination subtree so generated Xcode projects and Git metadata are
		// writable without weakening the sealed system volume.
		this._call(
			chownTargets
				? ["exec", workspaceId, "/usr/sbin/chown", user, ...chownTargets]
				: [
						"exec",
						workspaceId,
						"/usr/sbin/chown",
						"-R",
						user,
						resolvedDestination,
					],
		);
		return receipt;
	}

	/** Pull a guest path through the same in-memory HTTP endpoint. */
	pullTar(workspaceId, sourcePath, options = {}) {
		const user = validateUser(options.providerUser ?? this.providerUser);
		const resolvedSourcePath = resolveWorkspacePath(sourcePath, user);
		validateGuestPath(resolvedSourcePath, "sourcePath");
		const parent = dirname(resolvedSourcePath);
		const name = basename(resolvedSourcePath);
		const script =
			`/usr/bin/tar -cpf - -C ${shellQuote(parent)} ${shellQuote(name)} | ` +
			`/usr/bin/curl --fail --silent --show-error --request PUT --data-binary @- "$SWITCHYARD_XFER_URL"`;
		const guestArgs =
			options.providerUser || options.aquaUid
				? this._buildAquaExecArgs(workspaceId, ["/bin/bash", "-lc", script], {
						cwd: "/",
						aquaUid: options.aquaUid,
						providerUser: options.providerUser,
						env: [XFER_URL_ASSIGNMENT],
					})
				: [
						"exec",
						workspaceId,
						"/usr/bin/env",
						XFER_URL_ASSIGNMENT,
						"/bin/bash",
						"-lc",
						shellQuote(script),
					];
		return this._runBulkTransfer({ direction: "pull", workspaceId, guestArgs });
	}

	/**
	 * Provision one Task 1.3 tar-provisionable provider's credential files into
	 * the provider's home. Unknown or non-tar providers fail closed; there is no
	 * Keychain copy fallback and no guest-side supervisor.
	 *
	 * `credentials` is a list because a provider can need more than one file at
	 * more than one depth, and the caller supplies each file's bytes while this
	 * method owns the allowlist — a caller cannot name a destination, only pick
	 * from the measured layout.
	 * @param {string} workspaceId VM UUID
	 * @param {object} options
	 * @param {string} options.provider Routed provider name
	 * @param {{file: string, tar: Buffer}[]} options.credentials Home-relative
	 *   path plus its in-memory tar, one entry per file in the provider's layout
	 * @param {number|string} [options.aquaUid] Guest Aqua UID
	 * @param {string} [options.providerUser] Guest provider account
	 */
	provisionCredentials(
		workspaceId,
		{ provider, credentials, aquaUid, providerUser } = {},
	) {
		const providerKey = String(provider ?? "").toLowerCase();
		const layout = VM_CREDENTIAL_LAYOUTS[providerKey];
		if (!layout)
			throw new Error(
				`provider is not tar-provisionable on macOS: ${provider}`,
			);
		const supplied = new Map();
		for (const entry of Array.isArray(credentials) ? credentials : []) {
			const file = String(entry?.file ?? "");
			if (!layout.includes(file))
				throw new Error(
					`unexpected credential file for ${providerKey}: ${file}`,
				);
			supplied.set(file, entry.tar);
		}
		// Every file in the layout, or none. claude is why this is a list and not
		// a single path: measured in the guest, it reports `"loggedIn": false`
		// with `.claude.json` alone and with `.claude/.credentials.json` alone.
		// A partial push would leave a guest that looks provisioned and behaves
		// unauthenticated, which is the PM3-5 failure the layout exists to stop.
		for (const file of layout) {
			if (!supplied.has(file))
				throw new Error(`missing credential file for ${providerKey}: ${file}`);
		}
		const user = validateUser(providerUser ?? this.providerUser);
		const files = layout.map((file) => {
			const credentialPath = validateGuestPath(
				`${providerHomePath(user)}/${file}`,
				"credentialPath",
			);
			const receipt = this.pushTar(
				workspaceId,
				supplied.get(file),
				dirname(credentialPath),
				{ aquaUid, providerUser: user, chownTargets: [credentialPath] },
			);
			// The transfer runs as the provider account. This chmod is deliberately
			// also routed through Aqua so the auth check measures the same identity.
			this.execGuest(workspaceId, "/bin/chmod", ["600", credentialPath], {
				cwd: "/",
				aquaUid,
				providerUser: user,
			});
			return { path: credentialPath, ...receipt };
		});
		return { provider: providerKey, files };
	}

	/** Inspect provider processes from the same Aqua identity as execution. */
	inspectProcess(workspaceId) {
		return this._call(
			this._buildAquaExecArgs(
				workspaceId,
				["/bin/ps", "-axo", "pid=,command="],
				{ cwd: "/" },
			),
		);
	}

	/**
	 * Kill the recorded provider tree in a VM, then clear its stale Git lock.
	 * This is called through provider-lifecycle's existing cleanup parameter;
	 * it never destroys the VM.
	 * @param {string} command
	 * @param {string[]} args
	 * @returns {{workspaceId: string, pid: number}}
	 */
	cleanupProviderProcess(
		command,
		args,
		{ onStatus, workspaceId: requestedWorkspaceId } = {},
	) {
		const bridgeInvocation =
			command === BWS_SECRET_EXEC &&
			Array.isArray(args) &&
			Object.values(OPENCODE_BWS_CONSUMERS).includes(args[0]);
		if (
			(command !== "prlctl" || !Array.isArray(args) || args[0] !== "exec") &&
			!bridgeInvocation
		) {
			return null;
		}
		const workspaceId = bridgeInvocation ? requestedWorkspaceId : args[1];
		if (typeof workspaceId !== "string" || workspaceId.length === 0) {
			throw new Error("Parallels provider cleanup received no VM handle");
		}
		let cleanupStage = CLEANUP_STARTED;
		onStatus?.({
			phase: "execution",
			event: "provider_cleanup_started",
			status: "Guest provider cleanup started",
		});
		try {
			const pid = this.getGuestPid(
				workspaceId,
				this.providerPidPath(workspaceId),
			);
			cleanupStage = PID_OBSERVED;
			onStatus?.({
				phase: "execution",
				event: "provider_pid_observed",
				status: "Guest provider PID observed",
			});
			this.execGuest(
				workspaceId,
				"/bin/bash",
				["-lc", KILL_GUEST_PROCESS_TREE, "switchyard-kill-tree", String(pid)],
				{ cwd: "/" },
			);
			cleanupStage = TREE_TERMINATED;
			onStatus?.({
				phase: "execution",
				event: "provider_tree_gone",
				status: "Guest provider tree confirmed gone",
			});
			this.execGuest(
				workspaceId,
				"/bin/rm",
				["-f", "--", this.providerPidPath(workspaceId)],
				{ cwd: "/" },
			);
			cleanupStage = PID_MARKER_REMOVED;
			onStatus?.({
				phase: "execution",
				event: "provider_pid_marker_removed",
				status: "Guest provider PID marker removed",
			});
			this.execGuest(workspaceId, "/bin/rm", ["-f", "--", INDEX_LOCK_PATH], {
				cwd: "/",
			});
			cleanupStage = INDEX_LOCK_REMOVED;
			onStatus?.({
				phase: "execution",
				event: "provider_index_lock_removed",
				status: "Guest Git index lock removed",
			});
			onStatus?.({
				phase: "execution",
				event: "provider_cleanup_complete",
				status: "Guest provider cleanup complete; VM retained",
			});
			return { cleanupStage, workspaceId, pid };
		} catch (error) {
			if (error && typeof error === "object") error.cleanupStage = cleanupStage;
			// Two causes reach here and the bare event could not tell them
			// apart: the kill script ran and reported survivors (execFileSync
			// sets `status`), or the guest exec never ran at all (a transport
			// failure sets `code`/`signal` and no status). Carrying the stage
			// and the exit status makes one event self-describing instead of
			// requiring the reader to infer the stage from which later events
			// are absent. All three values are content-free: a name from a
			// fixed set, an integer, and a signal name.
			const status = error?.status;
			const signal = error?.signal;
			onStatus?.({
				phase: "execution",
				event: "provider_cleanup_failed",
				status: "Guest provider cleanup could not confirm process exit",
				cleanupStage,
				...(Number.isSafeInteger(status) ? { exitCode: status } : {}),
				...(typeof signal === "string" ? { signal } : {}),
			});
			throw error;
		}
	}

	listAll() {
		return parseVmList(this._call(["list", "-a", "-o", "uuid,status,name"]));
	}

	/**
	 * List only VMs whose complete reserved name proves a Switchyard owner.
	 * Foreign and malformed-prefix VMs are intentionally omitted.
	 */
	listManaged() {
		return this.listAll()
			.filter((entry) => entry.ownership)
			.map(({ ownership, ...entry }) => ({ ...entry, ...ownership }));
	}

	resolveHandle(handle, { allowUnmanaged = false } = {}) {
		const requested =
			handle && typeof handle === "object"
				? { uuid: handle.uuid, name: handle.name }
				: { uuid: isUuid(handle) ? handle : null, name: handle };
		if (!requested.uuid && !requested.name) {
			throw new Error("VM handle must be a Parallels UUID or VM name");
		}
		const entry = this.listAll().find(
			(candidate) =>
				(requested.uuid && candidate.uuid === requested.uuid) ||
				(requested.name && candidate.name === requested.name),
		);
		if (!entry) throw new Error("VM handle does not identify an existing VM");
		if (!entry.ownership && !allowUnmanaged) {
			throw new Error(`refusing unmanaged Parallels VM: ${entry.name}`);
		}
		return entry.ownership ? { ...entry, ...entry.ownership } : entry;
	}

	assertGoldenImageAvailable(goldenImage = this.goldenImage) {
		const owned = this.listManaged();
		if (owned.length > 0) {
			const names = owned.map((entry) => entry.name).join(", ");
			throw new Error(
				`refusing golden image ${goldenImage ?? "<unnamed>"}: owned clones exist (${names})`,
			);
		}
		return true;
	}

	/** Start the golden image only when no owned clone can reference it. */
	bootGoldenImage(goldenImage = this.goldenImage, options = {}) {
		if (!goldenImage) throw new Error("goldenImage is required");
		this.assertGoldenImageAvailable(goldenImage);
		const entry = this.resolveHandle(goldenImage, { allowUnmanaged: true });
		return this.boot(entry.uuid, {
			...options,
			skipGoldenCheck: true,
			allowUnmanaged: true,
		});
	}

	/**
	 * Stop the golden image itself — never delete it. `destroy()`/`stopAndDelete()`
	 * are for disposable managed clones; the golden image is the one VM every
	 * future clone is made from, so this method's entire reason to exist is to
	 * NOT be those. Used to leave the golden image stopped again after
	 * `auth/index.mjs` boots it directly to check or refresh a provider's
	 * credential, so a subsequent dispatch's `bootGoldenImage()`/clone is not
	 * blocked by it still running.
	 */
	stopGoldenImage(handle = this.goldenImage) {
		if (!handle) throw new Error("goldenImage is required");
		const entry = this.resolveHandle(handle, { allowUnmanaged: true });
		this._call(["stop", entry.uuid]);
		return { uuid: entry.uuid, name: entry.name, status: "stopped" };
	}

	/**
	 * Boot a managed VM and wait for its Aqua launchd domain.
	 * @returns {{uuid: string, name: string, status: string}}
	 */
	boot(handle, options = {}) {
		const entry = this.resolveHandle(handle, {
			allowUnmanaged: options.allowUnmanaged === true,
		});
		const golden = options.goldenImage ?? this.goldenImage;
		if (!options.skipGoldenCheck && golden && entry.name === golden) {
			this.assertGoldenImageAvailable(golden);
		}
		this._call(["start", entry.uuid]);
		this.waitForAqua(entry.uuid, options);
		return { uuid: entry.uuid, name: entry.name, status: "running" };
	}

	waitForAqua(uuid, options = {}) {
		const uid = options.aquaUid ?? this.aquaUid;
		if (!/^\d+$/.test(String(uid ?? ""))) {
			throw new Error("aquaUid is required to probe the Aqua launchd domain");
		}
		const domain = `gui/${uid}`;
		const timeoutMs = options.aquaTimeoutMs ?? this.aquaTimeoutMs;
		const pollMs = options.aquaPollMs ?? this.aquaPollMs;
		const onStatus = options.onStatus;
		const startedAt = this.nowFn();
		const emit = (event) => {
			if (typeof onStatus === "function") onStatus(event);
		};

		for (;;) {
			try {
				this._call(["exec", uuid, "launchctl", "print", domain], {
					timeout: Math.max(1, Math.min(5_000, timeoutMs)),
				});
				emit({ type: "aqua-ready", uuid, domain });
				return;
			} catch (error) {
				const elapsedMs = this.nowFn() - startedAt;
				if (elapsedMs >= timeoutMs) {
					throw new Error(
						`Aqua domain ${domain} was not ready within ${timeoutMs}ms`,
						{ cause: error },
					);
				}
				emit({ type: "aqua-wait", uuid, domain, elapsedMs });
				this.sleepFn(Math.min(pollMs, timeoutMs - elapsedMs));
			}
		}
	}

	listSnapshotIds(goldenImage) {
		return snapshotIdsFromOutput(this._call(["snapshot-list", goldenImage]));
	}

	deleteSnapshots(goldenImage, snapshotIds) {
		for (const snapshotId of snapshotIds) {
			this._call(["snapshot-delete", goldenImage, "--id", snapshotId]);
		}
	}

	/**
	 * Directory holding one sidecar per linked clone, or null when no durable
	 * root was injected.
	 * @returns {string|null}
	 */
	snapshotSidecarDir() {
		return this.snapshotSidecarRoot
			? join(this.snapshotSidecarRoot, "linked-snapshots")
			: null;
	}

	/**
	 * Map a Parallels uuid to a sidecar filename.
	 *
	 * Parallels reports uuids brace-wrapped (`{9f6e...}`). Strip everything
	 * outside the hex-and-dash alphabet so the value can never traverse out of
	 * the sidecar directory or name a file the caller did not intend.
	 * @param {string} uuid
	 * @returns {string|null} null when the uuid has no usable characters
	 */
	snapshotSidecarPath(uuid) {
		const dir = this.snapshotSidecarDir();
		if (!dir || typeof uuid !== "string") return null;
		const safe = uuid.replace(/[^A-Za-z0-9-]/g, "");
		return safe ? join(dir, `${safe}.json`) : null;
	}

	/**
	 * Record which golden-image snapshots a clone created, durably.
	 *
	 * The in-process map is enough for destroy() but useless to reclaim(),
	 * which runs in a different process against VMs whose creator is dead. Left
	 * in-process only, every crashed or killed run leaks its parent snapshot
	 * onto the one VM that is not disposable: one such orphan sat on
	 * switchyard-golden-6 for 13 days.
	 *
	 * Throws rather than swallowing. A lost sidecar is exactly the orphan this
	 * record exists to prevent, and create()'s caller already rolls the clone
	 * and its snapshots back when this stage fails.
	 * @param {string} uuid clone VM uuid
	 * @param {{goldenImage: string, snapshotIds: string[]}} metadata
	 */
	writeSnapshotSidecar(uuid, metadata) {
		const path = this.snapshotSidecarPath(uuid);
		if (!path) return;
		mkdirSync(this.snapshotSidecarDir(), { recursive: true });
		writeFileSync(
			path,
			`${JSON.stringify({
				vmUuid: uuid,
				goldenImage: metadata.goldenImage,
				snapshotIds: metadata.snapshotIds,
				runId: this.runId,
				creatorPid: this.creatorPid,
				recordedAt: this.nowFn(),
			})}\n`,
			"utf8",
		);
	}

	/**
	 * Read a clone's sidecar, or null when it is missing, unreadable, or does
	 * not carry the two fields a delete decision needs. A corrupt sidecar is
	 * treated as absent: the snapshots then survive for human review, which is
	 * the safe direction on an image that cannot be recreated cheaply.
	 * @param {string} uuid
	 * @returns {{goldenImage: string, snapshotIds: string[]}|null}
	 */
	readSnapshotSidecar(uuid) {
		const path = this.snapshotSidecarPath(uuid);
		if (!path) return null;
		let parsed;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return null;
		}
		if (!parsed || typeof parsed.goldenImage !== "string") return null;
		if (!Array.isArray(parsed.snapshotIds)) return null;
		const snapshotIds = parsed.snapshotIds.filter(
			(id) => typeof id === "string" && id.length > 0,
		);
		if (snapshotIds.length !== parsed.snapshotIds.length) return null;
		return { ...parsed, snapshotIds };
	}

	/** Remove a clone's sidecar. Absent is success. */
	deleteSnapshotSidecar(uuid) {
		const path = this.snapshotSidecarPath(uuid);
		if (path) rmSync(path, { force: true });
	}

	cleanupLinkedSnapshots(goldenImage, snapshotIds) {
		if (!goldenImage || !snapshotIds?.length) return;
		const remaining = snapshotDifference(
			this.listSnapshotIds(goldenImage),
			new Set(),
		).filter((snapshotId) => snapshotIds.includes(snapshotId));
		if (remaining.length > 0) this.deleteSnapshots(goldenImage, remaining);
	}

	/**
	 * Measure a real linked clone when no test probe is injected. The probe is
	 * created, booted, measured, and destroyed before its receipt is accepted by
	 * create(); a fabricated measurement object can never authorize cloning.
	 */
	measureLinkedCloneLifecycle(goldenImage, options = {}) {
		const golden = this.resolveHandle(goldenImage, { allowUnmanaged: true });
		if (!/^stopped$/i.test(String(golden.status ?? ""))) {
			throw new Error(
				"linked-clone measurement requires a stopped golden image",
			);
		}
		const beforeSnapshots = this.listSnapshotIds(goldenImage);
		const probeName = buildParallelsWorkingName(
			`measurement-${randomUUID()}`,
			this.creatorPid,
		);
		const startedAt = this.nowFn();
		let probe = null;
		let createdSnapshots = [];
		try {
			this._call(["clone", goldenImage, "--name", probeName, "--linked"]);
			probe = this.listAll().find((entry) => entry.name === probeName);
			if (!probe?.ownership)
				throw new Error("linked-clone probe returned no UUID");
			createdSnapshots = snapshotDifference(
				this.listSnapshotIds(goldenImage),
				beforeSnapshots,
			);
			const diskBytes = diskBytesFromInfo(
				this._call(["list", "-i", probe.uuid]),
				this.diskUsageFn,
			);
			this.boot(probe.uuid, options);
			return validateLinkedCloneMeasurement({
				diskBytes,
				cloneToBootMs: Math.max(0, this.nowFn() - startedAt),
			});
		} finally {
			if (probe?.uuid) {
				try {
					this.stopAndDelete(probe);
				} finally {
					this.cleanupLinkedSnapshots(goldenImage, createdSnapshots);
				}
			}
		}
	}

	/**
	 * Measure linked-clone evidence through a real probe or an injected
	 * hermetic probe. No caller-supplied object is accepted directly.
	 */
	measureLinkedClone(goldenImage, options = {}) {
		const measure =
			this.measureLinkedCloneFn ??
			((image, measureOptions) =>
				this.measureLinkedCloneLifecycle(image, measureOptions));
		const evidence = validateLinkedCloneMeasurement(
			measure(goldenImage, options),
		);
		const receipt = Object.freeze({
			...evidence,
			goldenImage,
			measuredAt: this.nowFn(),
		});
		this.linkedMeasurementReceipts.add(receipt);
		return receipt;
	}

	create(goldenImage, options = {}) {
		if (!goldenImage || typeof goldenImage !== "string") {
			throw new Error("goldenImage is required");
		}
		const runId = options.runId ?? randomUUID();
		const creatorPid = validatePid(options.creatorPid ?? this.creatorPid);
		const name = buildParallelsWorkingName(runId, creatorPid);
		const linked = options.linked ?? true;
		if (linked && this.requireLinkedCloneMeasurement) {
			const evidence = options.linkedCloneMeasurement;
			if (
				!evidence ||
				!this.linkedMeasurementReceipts.has(evidence) ||
				evidence.goldenImage !== goldenImage
			) {
				throw new Error(
					"linked clone requires a measurement receipt produced for this golden image",
				);
			}
		}

		const snapshotBefore = linked ? this.listSnapshotIds(goldenImage) : null;
		let createdSnapshots = [];
		let entry = null;
		try {
			const cloneArgs = ["clone", goldenImage, "--name", name];
			if (linked) cloneArgs.push("--linked");
			// Not retried: the working name is deterministic, so a second attempt
			// after a misfire collides on the existing clone and reports a name
			// conflict rather than the fault that actually happened.
			this._call(cloneArgs, { retry: false });
			if (linked) {
				createdSnapshots = snapshotDifference(
					this.listSnapshotIds(goldenImage),
					snapshotBefore,
				);
			}
			entry = this.listAll().find((candidate) => candidate.name === name);
			if (!entry?.ownership) {
				throw new Error(
					`cloned VM ${name} was not returned with a UUID handle`,
				);
			}
			if (linked) {
				const metadata = { goldenImage, snapshotIds: createdSnapshots };
				this.linkedSnapshotsByUuid.set(entry.uuid, metadata);
				this.writeSnapshotSidecar(entry.uuid, metadata);
			}
			this.boot(entry.uuid, options);
			try {
				this._hardenClone(entry.uuid, options);
			} catch (error) {
				throw new WorkerBootStageError("clone_hardening_failed", error);
			}
			try {
				this._prepareWorkspace(
					entry.uuid,
					options.providerUser ?? this.providerUser,
				);
			} catch (error) {
				throw new WorkerBootStageError("workspace_prepare_failed", error);
			}
			return entry.uuid;
		} catch (error) {
			// The prlctl client can report an error after the bundle was created.
			// Probe and roll back unconditionally; an absent exact name is a
			// harmless no-op, while a partial create cannot be left behind.
			try {
				this.rollback(name, entry?.uuid, {
					goldenImage: linked ? goldenImage : null,
					snapshotBefore,
					snapshotIds: createdSnapshots,
				});
			} catch (rollbackError) {
				error.rollbackError = rollbackError;
			}
			throw error;
		}
	}

	/**
	 * Disarm the guest clipboard agent on this clone, then prove it is gone.
	 *
	 * INV-1 is asserted when the golden image is built but consumed here, at
	 * dispatch, and the two moments drifted apart: a Parallels Guest Tools
	 * refresh inside the golden on 2026-08-21 restored the package-owned
	 * `com.parallels.copypaste` LaunchAgent that the build had renamed away, and
	 * every clone taken afterwards synced the host pasteboard into the guest
	 * with nothing on this path to notice. A clone is disposable, so enforce the
	 * posture per clone instead of inheriting it on faith.
	 *
	 * Enforcement here does not retire the golden-image repair or the build-time
	 * assertion; it removes their drift from the dispatch path.
	 *
	 * @param {string} workspaceId Cloned VM handle
	 * @param {{aquaUid?: string|number, clipboardSettleMs?: number,
	 *   clipboardPollMs?: number}} [options]
	 */
	_hardenClone(workspaceId, options = {}) {
		// A missing uid fails the clone rather than skipping the teardown. An
		// unenforced clone reporting success is the exact shape this method
		// exists to close, and it must not be reintroduced one level down.
		const uid = validateUid(options.aquaUid ?? this.aquaUid);
		const label = `gui/${uid}/${CLIPBOARD_AGENT_LABEL}`;
		const settleMs = options.clipboardSettleMs ?? this.clipboardSettleMs;
		const pollMs = options.clipboardPollMs ?? this.clipboardPollMs;

		this._disarmClipboard(workspaceId, label);

		// Any sighting inside the settle window fails the clone. If prltoolsd
		// supervises the agent directly, `bootout` and `disable` cannot hold it
		// down, and dispatch has to stop rather than quietly run in a guest that
		// still reaches the host pasteboard.
		const deadline = this.nowFn() + settleMs;
		for (;;) {
			const residue = this._clipboardResidue(workspaceId, label);
			if (residue) {
				throw new Error(
					`clipboard isolation could not be enforced on ${workspaceId}: ${residue}`,
				);
			}
			const remaining = deadline - this.nowFn();
			if (remaining <= 0) return;
			this.sleepFn(Math.min(pollMs, remaining));
		}
	}

	/**
	 * Unload the clipboard agent, refuse future loads, and kill any live copy.
	 * Every step is expected to fail on a correctly repaired golden image, where
	 * there is nothing left to unload, so failures are not escalated here --
	 * `_clipboardResidue` is what decides the outcome.
	 */
	_disarmClipboard(workspaceId, label) {
		const attempts = [
			["/bin/launchctl", "bootout", label],
			["/bin/launchctl", "disable", label],
			["/usr/bin/pkill", "-f", CLIPBOARD_AGENT_PROCESS],
		];
		for (const argv of attempts) {
			try {
				this._call(["exec", workspaceId, ...argv], { timeout: 10_000 });
			} catch {
				// Already absent, or launchd has nothing to unload.
			}
		}
	}

	/**
	 * Describe why the guest is still clipboard-capable, or null when it is not.
	 * Both halves matter: the launchd label proves the service is registered,
	 * the process check catches a copy that is running without it.
	 */
	_clipboardResidue(workspaceId, label) {
		try {
			this._call(["exec", workspaceId, "/bin/launchctl", "print", label], {
				timeout: 10_000,
			});
			return `${label} is still loaded`;
		} catch {
			// Not registered in the Aqua domain, which is the wanted state.
		}
		try {
			const pids = String(
				this._call(
					[
						"exec",
						workspaceId,
						"/usr/bin/pgrep",
						"-f",
						CLIPBOARD_AGENT_PROCESS,
					],
					{ timeout: 10_000 },
				) ?? "",
			).trim();
			if (pids) {
				return `${CLIPBOARD_AGENT_PROCESS} is running (pid ${pids.split(/\s+/).join(", ")})`;
			}
		} catch {
			// pgrep exits non-zero when nothing matches.
		}
		return null;
	}

	/**
	 * Describe every way this VM currently violates the no-host-rights posture,
	 * or an empty array when it holds. Reports; never repairs.
	 *
	 * The golden image is the one VM that is not disposable, and
	 * `withBootedGoldenImage` boots and mutates it. Anything a body left behind
	 * survives into every clone taken afterwards, so the posture the build
	 * certifies has to be re-read on the way out rather than assumed.
	 *
	 * A check that cannot run throws rather than returning "clean": an
	 * unverifiable posture proves nothing, and reporting it as held is the
	 * failure this method exists to close.
	 *
	 * @param {string} uuid a RUNNING VM handle — the guest half needs to exec
	 * @param {{aquaUid?: string|number}} [options]
	 * @returns {string[]} human-readable violations, empty when the posture holds
	 */
	describePostureViolations(uuid, options = {}) {
		const violations = [];
		const info = String(this._call(["list", "-i", uuid], { timeout: 30_000 }));
		// Same three host-side facts the INV-1 gate reads off `prlctl list -i`.
		for (const [label, pattern] of [
			["host shared folders are attached", /Host Shared Folders:\s*\(-\)/],
			["host-defined sharing is on", /Host defined sharing:\s*Off/],
			["the host profile is shared", /Shared Profile:\s*\(-\)/],
		]) {
			if (!pattern.test(info)) violations.push(label);
		}

		const mounts = String(
			this._call(["exec", uuid, "/sbin/mount"], { timeout: 30_000 }) ?? "",
		);
		const hostMounts = mounts
			.split("\n")
			.filter((line) => /prl_fs|\bmacOS\b.*on \//.test(line));
		if (hostMounts.length > 0) {
			violations.push(
				`host filesystem is mounted (${hostMounts.length} mount(s))`,
			);
		}

		const uid = validateUid(options.aquaUid ?? this.aquaUid);
		const residue = this._clipboardResidue(
			uuid,
			`gui/${uid}/${CLIPBOARD_AGENT_LABEL}`,
		);
		if (residue) violations.push(`clipboard is still available: ${residue}`);

		return violations;
	}

	/**
	 * Create the isolated logical workspace before the non-admin user enters it.
	 *
	 * The stage is defined by the state it leaves behind, not by three exit
	 * codes prlctl may never have read (see DEFAULT_WORKSPACE_VERIFY_TIMEOUT_MS).
	 * So apply the layout, then ask the guest what the state actually is, and
	 * repair once before giving up. That is the same posture `_reprobeStopped`
	 * takes toward a stop Parallels reports as failed after completing it, and
	 * it is strictly stronger than what it replaces: a passing run now proves
	 * owner and mode on both directories, which is the INV-1 property this
	 * stage exists to establish and which no exit code ever demonstrated.
	 */
	_prepareWorkspace(workspaceId, providerUser) {
		const user = validateUser(providerUser);
		const root = resolveWorkspacePath("/project", user);
		const parent = root.slice(0, root.lastIndexOf("/"));
		const paths = [parent, root];
		let cause = null;
		for (let attempt = 1; ; attempt += 1) {
			cause =
				this._applyWorkspaceLayout(workspaceId, user, root, paths) ?? cause;
			const mismatch = this._reprobeWorkspace(workspaceId, user, paths, cause);
			if (!mismatch) return;
			if (attempt >= WORKSPACE_PREPARE_ATTEMPTS) throw mismatch;
		}
	}

	/**
	 * Run the three idempotent layout commands, returning the first failure
	 * rather than throwing it. A failure here is a hypothesis about the guest,
	 * not a verdict; `_reprobeWorkspace` decides.
	 * @returns {Error|null}
	 */
	_applyWorkspaceLayout(workspaceId, user, root, paths) {
		let firstFailure = null;
		for (const argv of [
			["/bin/mkdir", "-p", root],
			["/usr/sbin/chown", user, ...paths],
			["/bin/chmod", WORKSPACE_MODE, ...paths],
		]) {
			try {
				this._call(["exec", workspaceId, ...argv]);
			} catch (error) {
				firstFailure ??= error;
			}
		}
		return firstFailure;
	}

	/**
	 * Read the workspace's owner and mode back out of the guest.
	 *
	 * `stat` is chosen because it produces output: an empty result is therefore
	 * itself evidence that the probe -- not the workspace -- is what failed, and
	 * is retried rather than believed. A probe that never produces output within
	 * the budget rethrows the layout's own failure, so a genuinely broken guest
	 * still reports the command that broke instead of this reconciliation.
	 *
	 * @returns {Error|null} null when the state is correct, otherwise the
	 *   mismatch to raise if repair does not settle it.
	 */
	_reprobeWorkspace(workspaceId, user, paths, cause) {
		const expected = paths.map(() => `${user}:${WORKSPACE_MODE}`).join("\n");
		const timeoutMs = this.workspaceVerifyTimeoutMs;
		const startedAt = this.nowFn();
		let probeFailure = null;
		for (;;) {
			let observed = null;
			try {
				const raw = this._call([
					"exec",
					workspaceId,
					"/usr/bin/stat",
					"-f",
					"%Su:%Lp",
					...paths,
				]);
				const text = String(raw ?? "").trim();
				if (text) observed = text;
			} catch (error) {
				probeFailure = error;
			}
			if (observed !== null) {
				if (observed === expected) return null;
				return new Error(
					`workspace ${paths.join(" ")} is ${JSON.stringify(observed)}, expected ${JSON.stringify(expected)}`,
					{ cause: cause ?? probeFailure },
				);
			}
			const elapsedMs = this.nowFn() - startedAt;
			if (elapsedMs >= timeoutMs) {
				throw (
					cause ??
					probeFailure ??
					new Error(
						`workspace ${paths.join(" ")} could not be verified within ${timeoutMs}ms`,
					)
				);
			}
			this.sleepFn(Math.min(this.workspaceVerifyPollMs, timeoutMs - elapsedMs));
		}
	}

	rollback(
		name,
		uuid = null,
		{ goldenImage = null, snapshotBefore = null, snapshotIds = [] } = {},
	) {
		const target =
			uuid ?? this.listAll().find((entry) => entry.name === name)?.uuid;
		if (!target) return false;
		this.stopAndDelete({ uuid: target, name });
		this.linkedSnapshotsByUuid.delete(target);
		if (goldenImage) {
			const candidates = snapshotIds.length
				? snapshotIds
				: snapshotBefore
					? snapshotDifference(
							this.listSnapshotIds(goldenImage),
							snapshotBefore,
						)
					: [];
			this.cleanupLinkedSnapshots(goldenImage, candidates);
		}
		return true;
	}

	stopAndDelete(entry, { forceOnly = false } = {}) {
		let forced = false;
		if (forceOnly) {
			if (!/^stopped$/i.test(String(entry.status ?? ""))) {
				forced = true;
				try {
					this._call(["stop", entry.uuid, "--kill"]);
				} catch (error) {
					this._reprobeStopped(entry, error);
				}
			}
		} else {
			try {
				this._call(["stop", entry.uuid]);
			} catch {
				forced = true;
				try {
					this._call(["stop", entry.uuid, "--kill"]);
				} catch (killError) {
					this._reprobeStopped(entry, killError);
				}
			}
		}
		try {
			this._call(["delete", entry.uuid]);
		} catch (error) {
			if (!forced) {
				try {
					this._call(["stop", entry.uuid, "--kill"]);
				} catch {
					// The state probe below decides whether a failed kill completed
					// asynchronously; retain the original delete failure if it did not.
				}
			}
			forced = true;
			if (!this._reprobeStoppedOrAbsent(entry, error))
				return {
					uuid: entry.uuid,
					name: entry.name,
					forced,
				};
			try {
				this._call(["delete", entry.uuid]);
			} catch (retryError) {
				if (this._reprobeStoppedOrAbsent(entry, retryError)) throw retryError;
			}
		}
		return { uuid: entry.uuid, name: entry.name, forced };
	}

	destroy(handle) {
		const entry = this.resolveHandle(handle);
		// The sidecar is the fallback, not the primary: a clone created by this
		// same process is already in the map, and reading it back would make the
		// common path depend on the filesystem for no gain.
		const metadata =
			this.linkedSnapshotsByUuid.get(entry.uuid) ??
			this.readSnapshotSidecar(entry.uuid);
		const result = this.stopAndDelete(entry);
		this.linkedSnapshotsByUuid.delete(entry.uuid);
		if (metadata) {
			this.cleanupLinkedSnapshots(metadata.goldenImage, metadata.snapshotIds);
		}
		// Only after cleanup: a sidecar removed ahead of the snapshots it names
		// converts a retryable failure into a permanent orphan.
		this.deleteSnapshotSidecar(entry.uuid);
		return result;
	}

	/**
	 * Reclaim only exact-prefix VMs whose embedded creator PID is dead.
	 * When supplied, eligibility is an ownership filter selected by the caller;
	 * an ineligible entry is reported and never stopped, deleted, or inspected
	 * for snapshots.
	 */
	reclaim({ dryRun = false, onStatus, eligibility = null } = {}) {
		// `skipped` answers one question only: which VMs were left alone. The
		// snapshot channels are separate because a VM can be reclaimed AND have
		// its snapshots left behind, so a single list would have to mean two
		// contradictory things about the same entry.
		const result = {
			reclaimed: [],
			reclaimedSnapshots: [],
			skipped: [],
			skippedSnapshots: [],
			errors: [],
		};
		for (const entry of this.listManaged()) {
			if (eligibility !== null) {
				let eligible = false;
				try {
					eligible = eligibility(entry) === true;
				} catch {
					eligible = false;
				}
				if (!eligible) {
					result.skipped.push({ ...entry, reason: "ineligible" });
					onStatus?.({ type: "skip", name: entry.name, reason: "ineligible" });
					continue;
				}
			}
			const alive = this.pidIsAlive(entry.creatorPid);
			if (alive) {
				result.skipped.push({ ...entry, reason: "owner-alive" });
				onStatus?.({ type: "skip", name: entry.name, reason: "owner-alive" });
				continue;
			}
			if (dryRun) {
				result.reclaimed.push({ ...entry, dryRun: true });
				continue;
			}
			// Read before the delete: once the VM is gone its uuid is the only
			// way back to the sidecar, and a failure here must not cost the
			// record.
			const metadata = this.readSnapshotSidecar(entry.uuid);
			try {
				const removed = this.stopAndDelete(entry, { forceOnly: true });
				result.reclaimed.push(removed);
				onStatus?.({ type: "reclaimed", name: entry.name });
			} catch (error) {
				result.errors.push({ name: entry.name, reason: error.message });
				continue;
			}
			// The absolute rule, enforced here rather than by convention:
			// reclaim deletes only snapshot ids it finds in a sidecar this code
			// wrote. Nothing discovered by listing is ever eligible, so a
			// snapshot that predates the sidecar convention — such as
			// switchyard-golden-26-5 — survives every path through this method.
			if (!metadata) {
				result.skippedSnapshots.push({
					name: entry.name,
					uuid: entry.uuid,
					reason: "no-snapshot-sidecar",
				});
				onStatus?.({
					type: "skip",
					name: entry.name,
					reason: "no-snapshot-sidecar",
				});
				continue;
			}
			try {
				this.cleanupLinkedSnapshots(metadata.goldenImage, metadata.snapshotIds);
				this.deleteSnapshotSidecar(entry.uuid);
				result.reclaimedSnapshots.push({
					name: entry.name,
					goldenImage: metadata.goldenImage,
					snapshotIds: metadata.snapshotIds,
				});
				onStatus?.({
					type: "reclaimed-snapshots",
					name: entry.name,
					count: metadata.snapshotIds.length,
				});
			} catch (error) {
				result.errors.push({ name: entry.name, reason: error.message });
			}
		}
		return result;
	}
}
