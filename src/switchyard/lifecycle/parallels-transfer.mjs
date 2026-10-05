import { PrlctlCallError } from "../adapter/exec-error.mjs";
import {
	PERSISTABLE_PRLCTL_SIGNALS,
	PRLCTL_JOB_MISFIRE,
	PRLCTL_SESSION_NOT_READY,
	PRLCTL_SUBCOMMANDS,
} from "./parallels-primitives.mjs";

export const BWS_SECRET_EXEC =
	"/Users/dave/Documents/Projects/bws/bws-secret-exec.py";
export const OPENCODE_BWS_CONSUMERS = Object.freeze({
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
    let stdinError = null;
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8").slice(0, 2000); });
    // prlctl can exit before it drains a large stdin payload (the pf ruleset).
    // A write to the abandoned pipe is EPIPE/ECONNRESET, not a command result,
    // so swallow that error here and keep only its code -- never the bytes --
    // while the close handler below remains the sole decider of the outcome.
    child.stdin.on("error", (error) => {
      if (error && (error.code === "EPIPE" || error.code === "ECONNRESET")) stdinError = error;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) return resolve();
      const detail = stderr.trim() || (stdinError ? "stdin " + stdinError.code : "");
      reject(new Error("prlctl failed (" + (code ?? signal ?? "unknown") + "): " + detail));
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

export function defaultSleep(milliseconds) {
	if (milliseconds <= 0) return;
	const atomics = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(atomics, 0, 0, milliseconds);
}

export function defaultPidIsAlive(pid) {
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
export function describeBulkTransferFailure(detail, spawnError = null) {
	const text = typeof detail === "string" ? detail : "";
	const attemptMatch = /failed after (\d{1,3}) attempt/.exec(text);
	const exitMatch = /prlctl failed \((\d{1,3})\)/.exec(text);
	const exitCode = exitMatch ? Number(exitMatch[1]) : null;
	// A spawn-level failure -- the helper killed on a timeout, or its output
	// overrunning `maxBuffer` on a large tar -- never reaches the helper's own
	// stderr, so `spawnError` carries the only cause there is. Forwarding its
	// code and killed flag is what makes `prlctl_call_timed_out` reachable on
	// this path at all: classifying a synthetic `{ message }` alone can only ever
	// return the generic code, which puts the transfer back to failing with
	// nothing recorded -- the exact defect this function was added to remove.
	const reason = text || String(spawnError?.code ?? spawnError?.message ?? "");
	return new PrlctlCallError({
		diagnosticCode: classifyPrlctlFailure({
			message: reason,
			code: spawnError?.code,
			killed: spawnError?.killed,
		}),
		subcommand: "exec",
		attempts: attemptMatch ? Number(attemptMatch[1]) : 1,
		exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
		cause: new Error(
			reason
				? `Parallels bulk transfer failed: ${reason}`
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
export function describePrlctlFailure(error, { args, attempts }) {
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
export function validateAttemptCount(value, label) {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new TypeError(`${label} must be an integer >= 1`);
	}
	return value;
}

export function outputText(value) {
	if (Buffer.isBuffer(value)) return value.toString("utf8");
	if (typeof value === "string") return value;
	if (value && typeof value.stdout !== "undefined") {
		return outputText(value.stdout);
	}
	return "";
}

export function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}
