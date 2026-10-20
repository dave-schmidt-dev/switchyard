/** `simple cancel`: signal one in-flight simple run whose worker is proven live. */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { projectLockArtifacts } from "../run-store/project-lock-files.mjs";
import { isProjectLockOwnedBy } from "../run-store/project-locks.mjs";
import { classifyRunLiveness } from "../run-store/run-liveness.mjs";
import { readRun } from "../run-store/run-records.mjs";
import { SimpleUsageError } from "./args.mjs";
import { canonicalRoutingProject } from "./routing-state.mjs";

const SIMPLE_CANCEL_DEFAULT_TIMEOUT_S = 60;
const SIMPLE_CANCEL_MAX_TIMEOUT_S = 300;
const SIMPLE_CANCEL_POLL_MS = 50;
const SIMPLE_CANCEL_TERMINAL_STATES = new Set([
	"succeeded",
	"failed",
	"deferred",
]);
const SIMPLE_CANCEL_USAGE = `Usage: switchyard-dispatch simple cancel --project <path> --run-id <id> [--timeout-seconds <n>]
Cancels one in-flight simple run. The run record must name a live worker by the
run-liveness identity rule and carry a matching start token (the launch nonce is
accepted as the legacy fallback). The command sends SIGTERM and then waits for
the run's project lock to be released and the record to reach a terminal state;
the default wait is 60 seconds and the maximum is 300. Output is one JSON
object: {runId, cancelled, lockReleased, terminalStatus}. A dead, terminal or
mismatched worker returns cancelled=false with reason=worker_not_live and no
signal is sent; the worker records the signal as cancelSource signal_sigterm
through the existing cancellation path.`;
function cancelSleep(ms) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
function cancelTimeoutMs(value) {
	if (value === undefined) return SIMPLE_CANCEL_DEFAULT_TIMEOUT_S * 1000;
	if (!/^\d{1,3}$/u.test(value))
		throw new SimpleUsageError("--timeout-seconds must be a whole number");
	const seconds = Number(value);
	if (seconds < 0 || seconds > SIMPLE_CANCEL_MAX_TIMEOUT_S)
		throw new SimpleUsageError(
			`--timeout-seconds must be between 0 and ${SIMPLE_CANCEL_MAX_TIMEOUT_S}`,
		);
	return seconds * 1000;
}
function recordedWorkerIdentity(record) {
	const pid = record?.workerPid;
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	const startToken = record.workerStartToken ?? record.workerNonce;
	if (typeof startToken !== "string" || startToken.length === 0) return null;
	return { pid, startToken };
}
function livenessOptions(deps) {
	return deps.probePid === undefined ? {} : { probePid: deps.probePid };
}
// The recorded run is cancellable only when the pid it names is live under the
// shared run-liveness rule and the run's project lock is held by that same pid
// (and start token, when the lock records one). Start tokens are nonces, not
// OS-derived, so the held lock is the only proof that a live pid is still the
// recorded worker and not a reused pid; without it no signal is sent.
async function liveRecordedWorker(record, project, runId, deps) {
	const identity = recordedWorkerIdentity(record);
	if (identity === null) return null;
	if (classifyRunLiveness(record, livenessOptions(deps)) !== "live")
		return null;
	const listLocks = deps.projectLockArtifacts ?? projectLockArtifacts;
	let artifacts = [];
	try {
		artifacts = await listLocks(project);
	} catch {
		return null;
	}
	const lock = artifacts.find(
		(artifact) => artifact.kind === "lock" && artifact.body?.runId === runId,
	);
	if (lock?.body?.holderPid !== identity.pid) return null;
	const holderToken = lock.body.holderStartToken;
	if (holderToken !== undefined && holderToken !== identity.startToken)
		return null;
	return identity;
}
/** Cancel one in-flight simple run once its recorded worker is proven live. */
export async function handleSimpleCancel(argv, deps = {}) {
	let values;
	try {
		({ values } = parseArgs({
			args: argv,
			options: {
				project: { type: "string" },
				"run-id": { type: "string" },
				"timeout-seconds": { type: "string" },
				help: { type: "boolean" },
			},
		}));
	} catch {
		throw new SimpleUsageError("invalid cancel arguments");
	}
	const write = deps.writeResult ?? console.log;
	if (values.help) {
		write(SIMPLE_CANCEL_USAGE);
		return { help: true };
	}
	if (!values.project) throw new SimpleUsageError("cancel requires --project");
	if (!values["run-id"]) throw new SimpleUsageError("cancel requires --run-id");
	const timeoutMs = cancelTimeoutMs(values["timeout-seconds"]);
	const project = canonicalRoutingProject(resolve(values.project));
	const runId = values["run-id"];
	const now = deps.now ?? Date.now;
	const readRunRecord = deps.readRun ?? readRun;
	const ownedByRun = deps.isProjectLockOwnedBy ?? isProjectLockOwnedBy;
	const emit = (result) => {
		write(JSON.stringify(result));
		return result;
	};
	let record;
	try {
		record = await readRunRecord(runId);
	} catch {
		return emit({
			runId,
			cancelled: false,
			lockReleased: false,
			terminalStatus: null,
			reason: "run_not_found",
		});
	}
	if (
		typeof record.projectPath !== "string" ||
		resolve(record.projectPath) !== project
	) {
		return emit({
			runId,
			cancelled: false,
			lockReleased: false,
			terminalStatus: null,
			reason: "project_mismatch",
		});
	}
	let lockReleased = false;
	try {
		lockReleased = !(await ownedByRun(project, runId));
	} catch {
		lockReleased = false;
	}
	let terminalStatus = SIMPLE_CANCEL_TERMINAL_STATES.has(record.state)
		? record.state
		: null;
	if (terminalStatus && lockReleased) {
		return emit({
			runId,
			cancelled: false,
			lockReleased: true,
			terminalStatus,
			reason: "run_terminal",
		});
	}
	const identity = await liveRecordedWorker(record, project, runId, deps);
	if (identity === null) {
		return emit({
			runId,
			cancelled: false,
			lockReleased,
			terminalStatus,
			reason: "worker_not_live",
		});
	}
	try {
		(deps.killProcess ?? process.kill)(identity.pid, "SIGTERM");
	} catch (error) {
		if (error?.code !== "ESRCH" && error?.code !== "EPERM") throw error;
		return emit({
			runId,
			cancelled: false,
			lockReleased,
			terminalStatus,
			reason: "worker_not_live",
		});
	}
	const deadline = now() + timeoutMs;
	const sleep = deps.sleep ?? cancelSleep;
	for (;;) {
		record = (await readRunRecord(runId).catch(() => null)) ?? record;
		terminalStatus = SIMPLE_CANCEL_TERMINAL_STATES.has(record?.state)
			? record.state
			: null;
		try {
			lockReleased = !(await ownedByRun(project, runId));
		} catch {
			lockReleased = false;
		}
		if (terminalStatus && lockReleased) {
			return emit({
				runId,
				cancelled: true,
				lockReleased: true,
				terminalStatus,
			});
		}
		const remaining = deadline - now();
		if (remaining <= 0) {
			return emit({
				runId,
				cancelled: true,
				lockReleased,
				terminalStatus,
			});
		}
		await sleep(Math.min(SIMPLE_CANCEL_POLL_MS, remaining));
	}
}
