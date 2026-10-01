import { deepStrictEqual, strictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import { route } from "../src/switchyard/router/index.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import {
	latchNativeRequired,
	openRoutingRun,
	readRoutingRunState,
} from "../src/switchyard/simple/routing-state.mjs";
import { withDispatchQualifiedDescriptors } from "./helpers/router-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

function fixture(overrides = {}) {
	const projectPath = realpathSync(tempDir("routing-project-"));
	const stateRoot = realpathSync(tempDir("routing-state-"));
	const calls = [];
	const records = new Map();
	const options = {
		projectPath,
		routingRunId: "run-1",
		capability: "standard",
		deadlineMs: Date.now() + 60_000,
		dirtyOverlay: true,
		files: ["a.txt"],
		checks: ["true"],
	};
	const deps = {
		stateRoot,
		getImplementorPriority: () => 1,
		assertFundedRoute: () => {},
		route: ({ availableProviders }) => ({
			provider: availableProviders[0] ?? null,
			reason: "no_eligible",
		}),
		readRun: async (id) => records.get(id),
	};
	deps.runSimpleTask = async (opts, context) => {
		const selected = context.route({
			availableProviders: overrides.__targets ?? [
				"antigravity-claude",
				"codex",
				"vibe",
			],
			only: opts.onlyProviders ?? [],
		});
		if (!selected.provider)
			return {
				status: "failed",
				failurePhase: "route",
				failureReason: "no_eligible_provider",
			};
		const targetId = selected.resolvedTargetId ?? selected.provider;
		calls.push(targetId);
		const pending = readRoutingRunState(projectPath, options.routingRunId, {
			stateRoot,
		}).pendingAttempt;
		strictEqual(pending.targetId, targetId);
		const behavior = overrides[targetId] ?? {};
		const status = behavior.status ?? "succeeded";
		const failed = status === "failed";
		const worktree = behavior.retained ? "retained" : "removed";
		const failureReason =
			behavior.result?.failureReason ??
			(failed ? "provider_exit_nonzero" : null);
		const failurePhase =
			behavior.result?.failurePhase ?? (failed ? "execute" : null);
		const errorKind =
			behavior.result?.errorKind ?? (failed ? "execution_failed" : null);
		const result = {
			runId: context.runId,
			taskId: context.taskId,
			attemptId: context.attemptId,
			targetId,
			status,
			failureReason,
			failurePhase,
			errorKind,
			partialWorktree: behavior.retained ? join(projectPath, "retained") : null,
			recovery: {
				schemaVersion: 1,
				result: {
					status,
					failureReason,
					failurePhase,
				},
				identity: {
					taskId: context.taskId,
					attemptId: context.attemptId,
					scope: (() => {
						const hash = (value) =>
							`sha256:${createHash("sha256").update(value).digest("hex")}`;
						const scope = {
							files: opts.files,
							checks: opts.checks.map((command, index) => ({
								index: index + 1,
								digest: hash(command),
							})),
						};
						return { ...scope, digest: hash(JSON.stringify(scope)) };
					})(),
				},
				cleanup: {
					writer: { state: "stopped" },
					projectLock: { state: "released" },
					worktree: {
						state: worktree,
						path: behavior.retained ? join(projectPath, "retained") : null,
					},
				},
			},
			...behavior.result,
		};
		records.set(context.runId, {
			runId: context.runId,
			projectPath,
			orderedTaskIds: [context.taskId],
			resolvedTargetId: targetId,
			state: status,
			cleanupState: "complete",
			// Real run records persist sanitized metadata, never the raw result.
			lastFailure:
				status === "failed"
					? {
							errorKind: result.errorKind,
							reasonCode: result.errorKind,
							reason:
								"Provider execution failed before a reviewed integration.",
						}
					: null,
			worktree: { state: worktree, writerStopped: true },
			...behavior.record,
		});
		return result;
	};
	return { options, deps, calls, records };
}
test("waterfall excludes failed targets across calls while success is reusable", async () => {
	const f = fixture({
		"antigravity-claude": { status: "failed" },
		codex: { status: "failed" },
	});
	const first = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(first.direction, "complete");
	deepStrictEqual(f.calls, ["antigravity-claude", "codex", "vibe"]);
	await runSimpleRoutingTask(f.options, f.deps);
	deepStrictEqual(f.calls, ["antigravity-claude", "codex", "vibe", "vibe"]);
	f.options.routingRunId = "run-2";
	await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(f.calls[4], "antigravity-claude");
});
test("exhaustion never latches; actual acknowledgement makes subsequent call zero engine/router", async () => {
	const f = fixture({
		"antigravity-claude": { status: "failed" },
		codex: { status: "failed" },
		vibe: { status: "failed" },
	});
	strictEqual(
		(await runSimpleRoutingTask(f.options, f.deps)).direction,
		"native_required",
	);
	const h = openRoutingRun(f.options.projectPath, "run-1", {
		stateRoot: f.deps.stateRoot,
	});
	strictEqual(h.state.nativeLatch, false);
	latchNativeRequired(h.state, h.commit, {
		project: f.options.projectPath,
		routingRunId: "run-1",
		taskId: "native-task",
		invocationId: "/root/native_routing_recovery",
		route: "native/high",
		capability: "high",
		evidenceKind: "actual-start",
	});
	h.release();
	f.deps.runSimpleTask = () => {
		throw new Error("must not call");
	};
	f.deps.route = f.deps.runSimpleTask;
	strictEqual(
		(await runSimpleRoutingTask(f.options, f.deps)).direction,
		"native_latched",
	);
});
test("unknown lifecycle, mismatched durable result, retained partials, permissions and checks stop", async () => {
	for (const behavior of [
		{ result: { recovery: null } },
		{ record: { projectPath: "/wrong" } },
		{ retained: true },
		{ result: { errorKind: "permission_denied" } },
		{
			result: {
				failureReason: "check_failed",
				failurePhase: "checks",
				errorKind: "check_failed",
			},
		},
	]) {
		const f = fixture({
			"antigravity-claude": { status: "failed", ...behavior },
		});
		const result = await runSimpleRoutingTask(f.options, f.deps);
		strictEqual(result.direction, "stop");
		strictEqual(f.calls.length, 1);
	}
});
test("pending crash stops before any engine and signals/deadline cannot renew", async () => {
	const f = fixture();
	const h = openRoutingRun(f.options.projectPath, "run-1", {
		stateRoot: f.deps.stateRoot,
	});
	h.commit({
		pendingAttempt: {
			attemptId: "old-attempt",
			taskId: "old-task",
			runId: "old-run",
			targetId: "codex",
			capability: "standard",
			startedAt: new Date().toISOString(),
		},
	});
	h.release();
	strictEqual(
		(await runSimpleRoutingTask(f.options, f.deps)).stopReason,
		"pending_attempt_exists",
	);
	strictEqual(f.calls.length, 0);
	const fresh = fixture();
	fresh.options.deadlineMs = 1;
	strictEqual(
		(await runSimpleRoutingTask(fresh.options, fresh.deps)).stopReason,
		"deadline_expired",
	);
	fresh.options.deadlineMs = Date.now() + 1000;
	fresh.deps.signal = AbortSignal.abort();
	strictEqual(
		(await runSimpleRoutingTask(fresh.options, fresh.deps)).stopReason,
		"provider_cancelled",
	);
});
test("failed pin is never reused and pre-route input failures do not invoke router", async () => {
	const f = fixture({ "antigravity-claude": { status: "failed" } });
	f.options.onlyProviders = ["antigravity-claude"];
	strictEqual(
		(await runSimpleRoutingTask(f.options, f.deps)).direction,
		"stop",
	);
	strictEqual(
		(await runSimpleRoutingTask(f.options, f.deps)).stopReason,
		"pinned_target_failed",
	);
	strictEqual(f.calls.length, 1);
	const fresh = fixture();
	fresh.deps.route = () => {
		throw new Error("no route before preflight");
	};
	fresh.deps.runSimpleTask = async () => ({
		status: "failed",
		failureReason: "baseline_mutation",
		failurePhase: "baseline",
	});
	strictEqual(
		(await runSimpleRoutingTask(fresh.options, fresh.deps)).direction,
		"stop",
	);
	deepStrictEqual(
		readRoutingRunState(fresh.options.projectPath, "run-1", {
			stateRoot: fresh.deps.stateRoot,
		}).failedTargetIds,
		[],
	);
});
test("baseline failure stops without marking the target failed for the run", async () => {
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			result: {
				failurePhase: "baseline",
				failureReason: "baseline_check_failed",
				errorKind: "environment_failure",
			},
		},
	});
	const outcome = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(outcome.direction, "stop");
	deepStrictEqual(f.calls, ["antigravity-claude"]);
	const state = readRoutingRunState(f.options.projectPath, "run-1", {
		stateRoot: f.deps.stateRoot,
	});
	deepStrictEqual(state.failedTargetIds, []);
	strictEqual(state.attempts.length, 1);
	strictEqual(state.attempts[0].terminal, "skipped");
});
test("allocation and terminal durability failure stop before reroute", async () => {
	for (const failAt of [1, 2]) {
		const f = fixture({ "antigravity-claude": { status: "failed" } });
		let commits = 0;
		f.deps.openRoutingRun = (...args) => {
			const h = openRoutingRun(...args);
			return {
				get state() {
					return h.state;
				},
				release: h.release,
				commit: (patch) => {
					if (++commits === failAt)
						throw Object.assign(new Error("write failed"), {
							code: "routing_state_write_failed",
						});
					h.commit(patch);
				},
			};
		};
		strictEqual(
			(await runSimpleRoutingTask(f.options, f.deps)).stopReason,
			"routing_state_write_failed",
		);
		strictEqual(f.calls.length, failAt === 1 ? 0 : 1);
	}
});
test("production router preserves tier1 roster order, tier2 headroom, quota and descriptor gates", async () => {
	const f = fixture({
		"antigravity-claude": { status: "failed" },
		codex: { status: "failed" },
		__targets: ["antigravity-claude", "codex", "vibe", "copilot-student"],
	});
	const roster = withDispatchQualifiedDescriptors(
		JSON.parse(
			readFileSync(new URL("./fixtures/roster.fixture.json", import.meta.url)),
		),
	);
	const claude = structuredClone(roster.targets.antigravity);
	claude.snapshot_name = "Antigravity (Claude)";
	claude.implementor_priority = 1;
	roster.targets = {
		"antigravity-claude": claude,
		codex: { ...roster.targets.codex, implementor_priority: 1 },
		"copilot-student": {
			...roster.targets["copilot-student"],
			implementor_priority: 2,
		},
		vibe: {
			...structuredClone(claude),
			snapshot_name: "Vibe",
			implementor_priority: 2,
		},
	};
	const path = join(f.deps.stateRoot, "roster.json");
	writeFileSync(path, JSON.stringify(roster));
	const previous = process.env.SWITCHYARD_ROSTER_PATH;
	process.env.SWITCHYARD_ROSTER_PATH = path;
	__resetRosterCacheForTests();
	try {
		const snapshotRead = {
			snapshotStatus: "fresh",
			snapshotMtime: Date.now(),
			snapshotAgeMsAtRoute: 0,
			snapshot: {
				providers: [
					{
						name: "copilot-student",
						ok: true,
						windows: [{ percent_left: 50 }],
					},
					{ name: "Vibe", ok: true, windows: [{ percent_left: 90 }] },
					{ name: "codex", ok: true, windows: [{ percent_left: 99 }] },
					{
						name: "Antigravity (Claude)",
						ok: true,
						windows: [{ percent_left: 10 }],
					},
				],
			},
		};
		f.deps.route = (input) =>
			route({
				...input,
				snapshotRead,
				hasInvocationDescriptor: () => true,
				modelForCapability: () => "fixture",
			});
		strictEqual(
			(await runSimpleRoutingTask(f.options, f.deps)).direction,
			"complete",
		);
		deepStrictEqual(f.calls, ["antigravity-claude", "codex", "vibe"]);
		f.calls.length = 0;
		f.options.routingRunId = "fresh";
		snapshotRead.snapshot.providers[0].windows[0].percent_left = 0;
		snapshotRead.snapshot.providers[1].windows[0].percent_left = 0;
		strictEqual(
			(await runSimpleRoutingTask(f.options, f.deps)).direction,
			"native_required",
		);
		deepStrictEqual(f.calls, ["antigravity-claude", "codex"]);
		f.calls.length = 0;
		f.options.routingRunId = "headroom";
		snapshotRead.snapshot.providers[0].windows[0].percent_left = 99;
		snapshotRead.snapshot.providers[1].windows[0].percent_left = 60;
		strictEqual(
			(await runSimpleRoutingTask(f.options, f.deps)).direction,
			"complete",
		);
		deepStrictEqual(f.calls, [
			"antigravity-claude",
			"codex",
			"copilot-student",
		]);
		f.calls.length = 0;
		f.options.routingRunId = "descriptor";
		f.deps.route = (input) =>
			route({
				...input,
				snapshotRead,
				hasInvocationDescriptor: (name) => name !== "copilot-student",
				modelForCapability: () => "fixture",
			});
		strictEqual(
			(await runSimpleRoutingTask(f.options, f.deps)).direction,
			"complete",
		);
		deepStrictEqual(f.calls, ["antigravity-claude", "codex", "vibe"]);
	} finally {
		if (previous === undefined) delete process.env.SWITCHYARD_ROSTER_PATH;
		else process.env.SWITCHYARD_ROSTER_PATH = previous;
		__resetRosterCacheForTests();
	}
});

test("target funding rejection advances locally without poisoning failure memory", async () => {
	const f = fixture();
	f.deps.assertFundedRoute = (id) => {
		if (id === "antigravity-claude")
			throw Object.assign(new Error("unverified"), {
				code: "included_usage_unverified",
			});
	};
	strictEqual(
		(await runSimpleRoutingTask(f.options, f.deps)).direction,
		"complete",
	);
	deepStrictEqual(f.calls, ["codex"]);
	deepStrictEqual(
		readRoutingRunState(f.options.projectPath, "run-1", {
			stateRoot: f.deps.stateRoot,
		}).failedTargetIds,
		[],
	);
});

test("routing ID provenance exposes supplied and ENV identity; generated IDs warn and isolate", async () => {
	const f = fixture();
	f.options.deadlineMs = 1;
	const warnings = [];
	f.deps.onRoutingWarning = (message) => warnings.push(message);
	const previous = process.env.SWITCHYARD_ROUTING_RUN_ID;
	try {
		delete process.env.SWITCHYARD_ROUTING_RUN_ID;
		const supplied = await runSimpleRoutingTask(f.options, f.deps);
		strictEqual(supplied.routingRunIdSource, "flag");
		strictEqual(warnings.length, 0);
		f.options.routingRunId = null;
		process.env.SWITCHYARD_ROUTING_RUN_ID = "env-run";
		const environment = await runSimpleRoutingTask(f.options, f.deps);
		strictEqual(environment.routingRunIdSource, "environment");
		strictEqual(environment.routingRunId, "env-run");
		strictEqual(warnings.length, 0);
		delete process.env.SWITCHYARD_ROUTING_RUN_ID;
		const first = await runSimpleRoutingTask(f.options, f.deps);
		const second = await runSimpleRoutingTask(f.options, f.deps);
		strictEqual(first.routingRunIdSource, "generated");
		strictEqual(second.routingRunIdSource, "generated");
		strictEqual(first.routingRunId === second.routingRunId, false);
		strictEqual(warnings.length, 2);
		strictEqual(
			warnings.every(
				(message) =>
					message.includes("standalone routing ID") &&
					message.includes("--routing-run-id"),
			),
			true,
		);
		for (const result of [first, second])
			strictEqual(
				readRoutingRunState(f.options.projectPath, result.routingRunId, {
					stateRoot: f.deps.stateRoot,
				}).routingRunId,
				result.routingRunId,
			);
	} finally {
		if (previous === undefined) delete process.env.SWITCHYARD_ROUTING_RUN_ID;
		else process.env.SWITCHYARD_ROUTING_RUN_ID = previous;
	}
});
