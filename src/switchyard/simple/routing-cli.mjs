/** Inspect routing state and acknowledge caller-owned actual native starts. */
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isProjectLockOwnedBy, readRun } from "../run-store/index.mjs";
import { projectLockArtifacts } from "../run-store/project-lock-files.mjs";
import { classifyRunLiveness } from "../run-store/run-liveness.mjs";
import { SimpleUsageError } from "./args.mjs";
import { inspectRoutingAccountability } from "./failure-accountability.mjs";
import { readFailureRecords, summarizeFailures } from "./failure-log.mjs";
import { closePendingAttempt, releaseRetainedPartial } from "./routing-run.mjs";
import {
	canonicalRoutingProject,
	latchNativeRequired,
	openRoutingRun,
	readRoutingRunState,
	validateNativeAck,
	validateRoutingRunId,
} from "./routing-state.mjs";

class RoutingCliUsageError extends Error {
	constructor(message) {
		super(message);
		this.name = "RoutingCliUsageError";
		this.code = "invalid_invocation";
	}
}
const ROUTING_RUN_USAGE = `Usage: switchyard-dispatch routing-run inspect --project <path> --routing-run-id <id>
       switchyard-dispatch routing-run release-partial --project <path> --routing-run-id <id> --task-id <id> [--discard]
       switchyard-dispatch routing-run close-pending --project <path> --routing-run-id <id> --task-id <id>
       switchyard-dispatch routing-run native-start --project <path> --routing-run-id <id> --authorization <manifest> --actual-start <receipt> --task-id <id> --invocation-id <id>
       switchyard-dispatch routing-run failures [--since <RFC3339>] [--json]
Native acknowledgement requires existing idle state, exact task authorization and an actual-start receipt. The latch gives direction only; future task authority remains caller-owned.`;
const RFC3339 =
	/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u;
const reject = (code) => {
	throw Object.assign(new Error(code), { code });
};
function readBoundedJson(path) {
	let fd;
	try {
		const st = lstatSync(path);
		if (
			!st.isFile() ||
			st.isSymbolicLink() ||
			st.nlink !== 1 ||
			st.size > 256 * 1024
		)
			reject("routing_receipt_invalid");
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const actual = fstatSync(fd);
		if (actual.dev !== st.dev || actual.ino !== st.ino || actual.nlink !== 1)
			reject("routing_receipt_invalid");
		return JSON.parse(readFileSync(fd, "utf8"));
	} catch {
		reject("routing_receipt_invalid");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
export async function handleRoutingRun(argv, deps = {}) {
	const [command, ...rest] = argv;
	let values;
	try {
		const parsed = parseArgs({
			args: rest,
			options: {
				project: { type: "string" },
				"routing-run-id": { type: "string" },
				authorization: { type: "string" },
				"actual-start": { type: "string" },
				"task-id": { type: "string" },
				"invocation-id": { type: "string" },
				since: { type: "string" },
				discard: { type: "boolean" },
				json: { type: "boolean" },
				help: { type: "boolean" },
			},
		});
		values = parsed.values;
	} catch {
		throw new RoutingCliUsageError("invalid routing-run arguments");
	}
	const write = deps.writeResult ?? console.log;
	if (values.help) {
		write(ROUTING_RUN_USAGE);
		return;
	}
	if (
		![
			"inspect",
			"native-start",
			"failures",
			"release-partial",
			"close-pending",
		].includes(command)
	)
		throw new RoutingCliUsageError("invalid routing-run subcommand");
	if (command !== "failures" && values.since !== undefined)
		throw new RoutingCliUsageError("--since applies only to failures");
	if (command !== "release-partial" && values.discard !== undefined)
		throw new RoutingCliUsageError("--discard applies only to release-partial");
	if (command === "failures") {
		let since;
		if (values.since !== undefined) {
			if (
				!RFC3339.test(values.since) ||
				!Number.isFinite(Date.parse(values.since))
			)
				throw new RoutingCliUsageError("invalid --since value");
			since = values.since;
		}
		const summary = summarizeFailures(
			readFailureRecords({ stateRoot: deps.stateRoot, since }),
		);
		if (values.json) {
			write(JSON.stringify(summary));
			return;
		}
		const cell = (value) =>
			value == null || value === "" ? "-" : String(value);
		write(
			[
				"count  lastSeen  target  reason  cause  phase",
				...summary.groups.map((group) =>
					[
						group.count,
						group.lastSeen,
						group.targetId,
						group.reason,
						group.causeCode,
						group.phase,
					]
						.map(cell)
						.join("  "),
				),
			].join("\n"),
		);
		return;
	}
	const project = canonicalRoutingProject(
		values.project ? resolve(values.project) : null,
	);
	const runId =
		values["routing-run-id"] ?? process.env.SWITCHYARD_ROUTING_RUN_ID;
	validateRoutingRunId(runId);
	if (command === "inspect") {
		const state = readRoutingRunState(project, runId, {
			stateRoot: deps.stateRoot,
		});
		const accountability = state
			? await inspectRoutingAccountability(state, deps.readRun ?? readRun)
			: null;
		write(
			JSON.stringify({
				ok: Boolean(state),
				routingRunId: runId,
				state,
				accountability,
			}),
		);
		return;
	}
	if (command === "release-partial") {
		if (!values["task-id"])
			throw new RoutingCliUsageError("release-partial requires --task-id");
		const release = deps.releaseRetainedPartial ?? releaseRetainedPartial;
		const result = await release(
			{
				projectPath: project,
				routingRunId: runId,
				taskId: values["task-id"],
				discard: values.discard === true,
			},
			deps,
		);
		write(JSON.stringify(result));
		return;
	}
	if (command === "close-pending") {
		if (!values["task-id"])
			throw new RoutingCliUsageError("close-pending requires --task-id");
		const close = deps.closePendingAttempt ?? closePendingAttempt;
		const result = await close(
			{
				projectPath: project,
				routingRunId: runId,
				taskId: values["task-id"],
			},
			deps,
		);
		write(JSON.stringify(result));
		return;
	}
	if (
		!values.authorization ||
		!values["actual-start"] ||
		!values["task-id"] ||
		!values["invocation-id"]
	)
		throw new RoutingCliUsageError(
			"native-start requires authorization, actual-start, task-id and invocation-id",
		);
	const manifest = readBoundedJson(resolve(values.authorization));
	const receipt = readBoundedJson(resolve(values["actual-start"]));
	if (
		manifest.project !== project ||
		manifest.routingRunId !== runId ||
		!manifest.tasks ||
		typeof manifest.tasks !== "object"
	)
		reject("unauthorized_native_route");
	let task;
	if (Array.isArray(manifest.tasks)) {
		if (manifest.tasks.length > 256) reject("unauthorized_task");
		const matches = manifest.tasks.filter(
			(entry) => entry?.taskId === values["task-id"],
		);
		if (matches.length !== 1) reject("unauthorized_task");
		task = matches[0];
	} else {
		if (
			Object.keys(manifest.tasks).length > 256 ||
			!Object.hasOwn(manifest.tasks, values["task-id"])
		)
			reject("unauthorized_task");
		task = manifest.tasks[values["task-id"]];
	}
	const ack = {
		project: receipt.project,
		routingRunId: receipt.routingRunId,
		taskId: receipt.taskId,
		invocationId: receipt.invocationId,
		route:
			receipt.route === "native"
				? `native/${receipt.capability}`
				: receipt.route,
		capability: receipt.capability,
		evidenceKind: receipt.evidenceKind,
	};
	if (Object.keys(receipt).sort().join() !== Object.keys(ack).sort().join())
		reject("receipt_identity_mismatch");
	validateNativeAck(ack, project, runId);
	const levels = { low: 1, standard: 2, high: 3 };
	const required = task.required_capability ?? task.capability;
	const routes = Array.isArray(task.fallback_routes)
		? task.fallback_routes
		: [task.route === "native" ? `native/${task.capability}` : task.route];
	if (
		!levels[required] ||
		levels[ack.capability] < levels[required] ||
		!routes.includes(ack.route) ||
		ack.taskId !== values["task-id"] ||
		ack.invocationId !== values["invocation-id"]
	)
		reject("unauthorized_native_route");
	const handle = openRoutingRun(project, runId, {
		stateRoot: deps.stateRoot,
		create: false,
	});
	try {
		const idempotent = handle.state.nativeLatch;
		latchNativeRequired(handle.state, handle.commit, ack);
		write(
			JSON.stringify({
				ok: true,
				idempotent,
				routingRunId: runId,
				nativeLatch: true,
			}),
		);
	} finally {
		handle.release();
	}
}
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
/** Legacy queue entry points honor the stable routing session before container creation. */
export function guardRoutingLaunch(argv, deps = {}) {
	let runId = process.env.SWITCHYARD_ROUTING_RUN_ID;
	const args = [...argv];
	const index = args.indexOf("--routing-run-id");
	if (index >= 0) {
		runId = args[index + 1];
		validateRoutingRunId(runId);
		if (args.indexOf("--routing-run-id", index + 1) >= 0)
			throw new RoutingCliUsageError("duplicate routing-run-id");
		args.splice(index, 2);
	}
	if (!runId) return { argv: args, blocked: false };
	validateRoutingRunId(runId);
	const projectIndex = args.indexOf("--project");
	if (projectIndex < 0)
		throw new RoutingCliUsageError("routing session requires --project");
	const project = canonicalRoutingProject(
		resolve(args[projectIndex + 1] ?? ""),
	);
	const state = readRoutingRunState(project, runId, {
		stateRoot: deps.stateRoot,
	});
	if (state?.pendingAttempt) reject("pending_attempt_exists");
	if (!state?.nativeLatch) return { argv: args, blocked: false };
	(deps.writeResult ?? console.log)(
		JSON.stringify({
			status: "deferred",
			direction: "native_latched",
			routingRunId: runId,
		}),
	);
	(deps.signalProcess ?? process).exitCode = 6;
	return { argv: args, blocked: true };
}
