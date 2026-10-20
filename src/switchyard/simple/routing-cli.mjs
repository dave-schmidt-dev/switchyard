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
import { parseRfc3339 } from "../rfc3339.mjs";
import { readRun } from "../run-store/run-records.mjs";
import { inspectRoutingAccountability } from "./failure-accountability.mjs";
import { readFailureRecords, summarizeFailures } from "./failure-log.mjs";
import { applyHeldIntegration } from "./held-apply.mjs";
import { inspectHeldIntegrations } from "./held-integration.mjs";
import {
	closePendingAttempt,
	releaseRetainedPartial,
} from "./routing-recovery.mjs";
import {
	canonicalRoutingProject,
	latchNativeRequired,
	openRoutingRun,
	readRoutingRunState,
	validateNativeAck,
	validateRoutingRunId,
} from "./routing-state.mjs";

export { handleSimpleCancel } from "./simple-cancel.mjs";

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
       switchyard-dispatch routing-run apply --project <path> --run-id <simple-run-id> [--timeout <minutes>]
release-partial and close-pending --task-id take the --task-id given to simple or the persisted task hash.
apply integrates the patch a simple --integrate hold run verified, re-running the integration gate against the current HEAD (acceptance checks re-run when HEAD moved, within --timeout, default 10 minutes, at most 30). It never applies any other diff and refuses with one closed reason, exiting 1.
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
				"run-id": { type: "string" },
				timeout: { type: "string" },
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
			"apply",
		].includes(command)
	)
		throw new RoutingCliUsageError("invalid routing-run subcommand");
	if (command !== "failures" && values.since !== undefined)
		throw new RoutingCliUsageError("--since applies only to failures");
	if (command !== "release-partial" && values.discard !== undefined)
		throw new RoutingCliUsageError("--discard applies only to release-partial");
	if (
		command !== "apply" &&
		(values["run-id"] !== undefined || values.timeout !== undefined)
	)
		throw new RoutingCliUsageError(
			"--run-id and --timeout apply only to apply",
		);
	if (command === "failures") {
		let since;
		if (values.since !== undefined) {
			if (!RFC3339.test(values.since) || !parseRfc3339(values.since))
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
	if (command === "apply") {
		const timeout = values.timeout ?? "10";
		if (!values["run-id"] || !/^[1-9][0-9]?$/u.test(timeout) || +timeout > 30)
			throw new RoutingCliUsageError(
				"apply requires --run-id and a --timeout of 1 to 30 minutes",
			);
		const now = deps.now ?? Date.now;
		const result = await (deps.applyHeldIntegration ?? applyHeldIntegration)(
			{
				projectPath: project,
				runId: values["run-id"],
				deadlineMs: now() + Number(timeout) * 60_000,
			},
			{
				...deps,
				onProgress: (event) =>
					(deps.writeProgress ?? console.error)(
						`dispatch: routing-run apply run=${values["run-id"]} phase=${event.phase}${event.checkIndex ? ` check=${event.checkIndex}` : ""}`,
					),
			},
		);
		write(JSON.stringify(result));
		if (!result.ok) (deps.signalProcess ?? process).exitCode = 1;
		return;
	}
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
		// A held run is a succeeded attempt whose patch is not in the tree yet.
		const heldIntegrations = state
			? await inspectHeldIntegrations(state, deps.readRun ?? readRun)
			: [];
		write(
			JSON.stringify({
				ok: Boolean(state),
				routingRunId: runId,
				state,
				accountability,
				heldIntegrations,
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
