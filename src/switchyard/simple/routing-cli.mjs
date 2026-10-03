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
import { readRun } from "../run-store/index.mjs";
import { inspectRoutingAccountability } from "./failure-accountability.mjs";
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
       switchyard-dispatch routing-run native-start --project <path> --routing-run-id <id> --authorization <manifest> --actual-start <receipt> --task-id <id> --invocation-id <id>
Native acknowledgement requires existing idle state, exact task authorization and an actual-start receipt. The latch gives direction only; future task authority remains caller-owned.`;
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
	if (!["inspect", "native-start"].includes(command))
		throw new RoutingCliUsageError("invalid routing-run subcommand");
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
