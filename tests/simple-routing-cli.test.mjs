import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { handleLaunch, handleRun } from "../src/switchyard/dispatch/index.mjs";
import { parseSimpleArgs } from "../src/switchyard/simple/args.mjs";
import { handleSimple } from "../src/switchyard/simple/cli.mjs";
import {
	guardRoutingLaunch,
	handleRoutingRun,
} from "../src/switchyard/simple/routing-cli.mjs";
import {
	openRoutingRun,
	readRoutingRunState,
} from "../src/switchyard/simple/routing-state.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

function fixture() {
	const project = realpathSync(tempDir("routing-cli-project-"));
	const stateRoot = realpathSync(tempDir("routing-cli-state-"));
	strictEqual(spawnSync("git", ["init", "-q", project]).status, 0);
	writeFileSync(
		join(project, "prompt.txt"),
		"RequiredCapability: standard\nImplement bounded file edit",
	);
	writeFileSync(join(project, "a.txt"), "baseline");
	const receipt = {
		project,
		routingRunId: "run-1",
		taskId: "R1",
		invocationId: "/root/native_routing_recovery",
		route: "native/high",
		capability: "high",
		evidenceKind: "actual-start",
	};
	const manifest = {
		project,
		routingRunId: "run-1",
		tasks: {
			R1: {
				executor: "switchyard",
				required_capability: "standard",
				fallback_routes: ["native/high"],
			},
		},
	};
	const authorizationPath = join(project, "authorization.json");
	const receiptPath = join(project, "actual-start.json");
	writeFileSync(authorizationPath, JSON.stringify(manifest));
	writeFileSync(receiptPath, JSON.stringify(receipt));
	const argv = [
		"native-start",
		"--project",
		project,
		"--routing-run-id",
		"run-1",
		"--task-id",
		"R1",
		"--invocation-id",
		receipt.invocationId,
		"--authorization",
		authorizationPath,
		"--actual-start",
		receiptPath,
	];
	return {
		project,
		stateRoot,
		receipt,
		manifest,
		authorizationPath,
		receiptPath,
		argv,
		deps: { stateRoot, writeResult: () => {} },
	};
}
test("native ACK requires existing state and exact bound canonical task fallback authorization", async () => {
	const f = fixture();
	await rejects(handleRoutingRun(f.argv, f.deps), {
		code: "routing_run_not_found",
	});
	const h = openRoutingRun(f.project, "run-1", f.deps);
	h.release();
	const output = [];
	await handleRoutingRun(f.argv, {
		...f.deps,
		writeResult: (value) => output.push(JSON.parse(value)),
	});
	await handleRoutingRun(f.argv, {
		...f.deps,
		writeResult: (value) => output.push(JSON.parse(value)),
	});
	deepStrictEqual(
		output.map((item) => item.idempotent),
		[false, true],
	);
	strictEqual(
		readRoutingRunState(f.project, "run-1", f.deps).nativeAck.invocationId,
		f.receipt.invocationId,
	);
	writeFileSync(
		f.receiptPath,
		JSON.stringify({ ...f.receipt, invocationId: "conflict" }),
	);
	const argv = [...f.argv];
	argv[argv.indexOf("--invocation-id") + 1] = "conflict";
	await rejects(handleRoutingRun(argv, f.deps), {
		code: "native_ack_conflict",
	});
});
test("wrong project/run/task/route/capability, proposed receipt and missing bound manifest cannot latch", async () => {
	for (const change of [
		{ project: "/wrong" },
		{ routingRunId: "wrong" },
		{ taskId: "wrong" },
		{ route: "native/low", capability: "low" },
		{ evidenceKind: "native-required" },
	]) {
		const f = fixture();
		const h = openRoutingRun(f.project, "run-1", f.deps);
		h.release();
		writeFileSync(f.receiptPath, JSON.stringify({ ...f.receipt, ...change }));
		await rejects(handleRoutingRun(f.argv, f.deps));
		strictEqual(
			readRoutingRunState(f.project, "run-1", f.deps).nativeLatch,
			false,
		);
	}
	const f = fixture();
	const h = openRoutingRun(f.project, "run-1", f.deps);
	h.release();
	delete f.manifest.project;
	writeFileSync(f.authorizationPath, JSON.stringify(f.manifest));
	await rejects(handleRoutingRun(f.argv, f.deps), {
		code: "unauthorized_native_route",
	});
});
test("native ACK refuses pending allocation and inspection preserves exact identity", async () => {
	const f = fixture();
	const h = openRoutingRun(f.project, "run-1", f.deps);
	h.commit({
		pendingAttempt: {
			attemptId: "att",
			taskId: "task",
			runId: "simple-att",
			targetId: "codex",
			capability: "standard",
			startedAt: new Date().toISOString(),
		},
	});
	h.release();
	await rejects(handleRoutingRun(f.argv, f.deps), {
		code: "pending_attempt_exists",
	});
	let result;
	await handleRoutingRun(
		["inspect", "--project", f.project, "--routing-run-id", "run-1"],
		{
			...f.deps,
			writeResult: (value) => {
				result = JSON.parse(value);
			},
		},
	);
	strictEqual(result.state.pendingAttempt.attemptId, "att");
});
test("real simple parser supports flag/ENV IDs; CLI latch yields exit6 without engine/router", async () => {
	const f = fixture();
	const h = openRoutingRun(f.project, "run-1", f.deps);
	h.release();
	await handleRoutingRun(f.argv, f.deps);
	const simple = [
		join(f.project, "prompt.txt"),
		"--project",
		f.project,
		"--capability",
		"standard",
		"--file",
		"a.txt",
		"--check",
		"true",
		"--deadline",
		new Date(Date.now() + 60_000).toISOString(),
		"--routing-run-id",
		"run-1",
	];
	strictEqual(parseSimpleArgs(simple).routingRunId, "run-1");
	const previous = process.env.SWITCHYARD_ROUTING_RUN_ID;
	try {
		process.env.SWITCHYARD_ROUTING_RUN_ID = "run-1";
		strictEqual(parseSimpleArgs(simple.slice(0, -2)).routingRunId, "run-1");
	} finally {
		if (previous === undefined) delete process.env.SWITCHYARD_ROUTING_RUN_ID;
		else process.env.SWITCHYARD_ROUTING_RUN_ID = previous;
	}
	const signalProcess = new EventEmitter();
	let result;
	await handleSimple(simple, {
		...f.deps,
		signalProcess,
		runSimpleTask: () => {
			throw new Error("must not launch engine");
		},
		route: () => {
			throw new Error("must not route");
		},
		writeResult: (value) => {
			result = JSON.parse(value);
		},
	});
	strictEqual(result.direction, "native_latched");
	strictEqual(result.status, "deferred");
	strictEqual(signalProcess.exitCode, 6);
	strictEqual(signalProcess.listenerCount("SIGINT"), 0);
});
test("legacy run/launch exported entry points honor existing latch before handler/container work", async () => {
	const f = fixture();
	const h = openRoutingRun(f.project, "run-1", f.deps);
	h.release();
	await handleRoutingRun(f.argv, f.deps);
	for (const handler of [handleRun, handleLaunch]) {
		const signalProcess = {};
		let output;
		await handler(
			[
				"does-not-exist.md",
				"--project",
				f.project,
				"--routing-run-id",
				"run-1",
			],
			{
				...f.deps,
				signalProcess,
				writeResult: (value) => {
					output = JSON.parse(value);
				},
			},
		);
		strictEqual(output.direction, "native_latched");
		strictEqual(signalProcess.exitCode, 6);
	}
	await rejects(
		async () =>
			guardRoutingLaunch(["--project", f.project, "--routing-run-id"], f.deps),
		{ code: "invalid_routing_run_id" },
	);
});

test("CLI provenance preserves flag and ENV silence; generated standalone IDs emit one stderr warning", async () => {
	const f = fixture();
	const previous = process.env.SWITCHYARD_ROUTING_RUN_ID;
	const args = [
		join(f.project, "prompt.txt"),
		"--project",
		f.project,
		"--capability",
		"standard",
		"--file",
		"a.txt",
		"--check",
		"true",
		"--deadline",
		new Date(Date.now() + 60_000).toISOString(),
	];
	const invoke = async (argv) => {
		const warnings = [];
		let result;
		await handleSimple(argv, {
			...f.deps,
			signalProcess: new EventEmitter(),
			runSimpleTask: async () => ({
				status: "failed",
				failurePhase: "baseline",
				failureReason: "baseline_check_failed",
			}),
			writeWarning: (message) => warnings.push(message),
			writeResult: (value) => {
				result = JSON.parse(value);
			},
		});
		return { result, warnings };
	};
	try {
		delete process.env.SWITCHYARD_ROUTING_RUN_ID;
		const flag = await invoke([...args, "--routing-run-id", "flag-run"]);
		strictEqual(flag.result.routingRunIdSource, "flag");
		deepStrictEqual(flag.warnings, []);
		process.env.SWITCHYARD_ROUTING_RUN_ID = "env-run";
		const environment = await invoke(args);
		strictEqual(environment.result.routingRunIdSource, "environment");
		strictEqual(environment.result.routingRunId, "env-run");
		deepStrictEqual(environment.warnings, []);
		const precedence = await invoke([...args, "--routing-run-id=explicit"]);
		strictEqual(precedence.result.routingRunIdSource, "flag");
		strictEqual(precedence.result.routingRunId, "explicit");
		deepStrictEqual(precedence.warnings, []);
		delete process.env.SWITCHYARD_ROUTING_RUN_ID;
		const first = await invoke(args);
		const second = await invoke(args);
		for (const generated of [first, second]) {
			strictEqual(generated.result.routingRunIdSource, "generated");
			strictEqual(generated.warnings.length, 1);
			strictEqual(
				generated.warnings[0].includes("standalone routing ID"),
				true,
			);
		}
		strictEqual(
			first.result.routingRunId === second.result.routingRunId,
			false,
		);
	} finally {
		if (previous === undefined) delete process.env.SWITCHYARD_ROUTING_RUN_ID;
		else process.env.SWITCHYARD_ROUTING_RUN_ID = previous;
	}
});

test("inspect reports unknown missing records without changing the durable routing state", async () => {
	const { recordAttemptOutcome } = await import(
		"../src/switchyard/simple/routing-state.mjs"
	);
	const f = fixture();
	const h = openRoutingRun(f.project, "run-1", f.deps);
	const pending = {
		taskId: "task",
		attemptId: "attempt",
		runId: "simple-linked",
		targetId: "codex",
		capability: "standard",
		startedAt: new Date().toISOString(),
	};
	h.commit({ pendingAttempt: pending });
	recordAttemptOutcome(h.state, h.commit, {
		...pending,
		terminal: "succeeded",
		reason: "succeeded",
		closedAt: new Date().toISOString(),
		partialWorktree: null,
	});
	h.release();
	let output;
	await handleRoutingRun(
		["inspect", "--project", f.project, "--routing-run-id", "run-1"],
		{
			...f.deps,
			readRun: async () => {
				throw new Error("missing");
			},
			writeResult: (value) => {
				output = JSON.parse(value);
			},
		},
	);
	strictEqual(output.state.attempts[0].terminal, "succeeded");
	strictEqual(output.accountability.totals.succeededAttempts, 0);
	strictEqual(output.accountability.totals.unknownAttempts, 1);
	strictEqual(
		output.accountability.attempts[0].accountability.owner,
		"unknown",
	);
});
