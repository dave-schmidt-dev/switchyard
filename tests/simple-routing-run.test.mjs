import { deepStrictEqual, strictEqual } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import { route } from "../src/switchyard/router/index.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import {
	latchNativeRequired,
	openRoutingRun,
	readRoutingRunState,
} from "../src/switchyard/simple/routing-state.mjs";
import { withDispatchQualifiedDescriptors } from "./helpers/router-fixtures.mjs";
import { fixture } from "./helpers/simple-routing-fixture.mjs";

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
test("unknown lifecycle and mismatched durable result stop; a retained partial continues then blocks the next call", async () => {
	for (const behavior of [
		{ result: { recovery: null } },
		{ record: { projectPath: "/wrong" } },
	]) {
		const f = fixture({
			"antigravity-claude": { status: "failed", ...behavior },
		});
		const result = await runSimpleRoutingTask(f.options, f.deps);
		strictEqual(result.direction, "stop");
		strictEqual(f.calls.length, 1);
	}
	const retained = fixture({
		"antigravity-claude": { status: "failed", retained: true },
	});
	const continued = await runSimpleRoutingTask(retained.options, retained.deps);
	strictEqual(continued.direction, "complete");
	strictEqual(retained.calls.length, 2);
	strictEqual(continued.retainedPartials.length, 1);
	const blocked = await runSimpleRoutingTask(retained.options, retained.deps);
	strictEqual(blocked.stopReason, "partial_work_retained");
	strictEqual(retained.calls.length, 2);
	// permission_denied is unrecognized → soft/execution_failed → continues to next target
	const f2 = fixture({
		"antigravity-claude": {
			status: "failed",
			result: { errorKind: "permission_denied" },
		},
	});
	const r2 = await runSimpleRoutingTask(f2.options, f2.deps);
	strictEqual(r2.direction, "complete");
	strictEqual(f2.calls.length, 2);
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
	strictEqual(outcome.stopReason, "baseline_failed");
	deepStrictEqual(f.calls, ["antigravity-claude"]);
	const state = readRoutingRunState(f.options.projectPath, "run-1", {
		stateRoot: f.deps.stateRoot,
	});
	deepStrictEqual(state.failedTargetIds, []);
	strictEqual(state.attempts.length, 1);
	strictEqual(state.attempts[0].terminal, "skipped");
	strictEqual(state.attempts[0].reason, "baseline_failed");
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
test("production router uses tier1 roster order when pace is unknown, tier2 headroom, quota and descriptor gates", async () => {
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
	// Exercise production target resolution against this test's roster.
	delete f.deps.resolveTargetIdentity;
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

for (const causeCode of [
	"environment_failure",
	"scope_rejected",
	"input_rejected",
	"acceptance_check_failed",
	"cancelled",
	"cleanup_failed",
	"unknown",
]) {
	test(`typed ${causeCode} never poisons provider memory`, async () => {
		const diagnostic = createProviderReliabilityDiagnostic({
			causeCode,
			phase: "provider",
		});
		const f = fixture({
			"antigravity-claude": {
				status: "failed",
				result: {
					providerReliability: diagnostic,
					failureReason: "check_failed",
					failurePhase: "checks",
					errorKind: "check_failed",
				},
			},
		});
		const result = await runSimpleRoutingTask(f.options, f.deps);
		// Provider memory must never be poisoned: failedTargetIds stays [] and terminal stays "skipped".
		// Directions and stop reasons follow the new classification rules.
		deepStrictEqual(result.failedTargetIds, []);
		strictEqual(result.attempts[0].terminal, "skipped");
		// The fixture encodes errorKind:"check_failed" on all variants, so rule 3a (check)
		// fires before category-specific soft rules. Hard categories still stop.
		const attempt = result.attempts[0];
		if (
			causeCode === "cancelled" ||
			causeCode === "cleanup_failed" ||
			causeCode === "input_rejected"
		) {
			// hard: causeCategory cleanup/cancellation/input wins before rule 3a
			strictEqual(result.direction, "stop");
			strictEqual(attempt.reason, "unsafe_failure");
		} else {
			// soft: errorKind=check_failed (rule 3a) → check_failed reason, continues to next target
			strictEqual(result.direction, "complete");
			strictEqual(attempt.reason, "check_failed");
		}
	});
}
test("typed unknown retry excludes immediately, shares logical task and allows target in a later call", async () => {
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			result: {
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "provider_exit_nonzero",
					phase: "provider",
				}),
			},
		},
	});
	const first = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(first.direction, "complete");
	deepStrictEqual(f.calls, ["antigravity-claude", "codex"]);
	deepStrictEqual(first.failedTargetIds, []);
	strictEqual(new Set(first.attempts.map((a) => a.taskId)).size, 1);
	strictEqual(new Set(first.attempts.map((a) => a.attemptId)).size, 2);
	await runSimpleRoutingTask(f.options, f.deps);
	deepStrictEqual(f.calls, [
		"antigravity-claude",
		"codex",
		"antigravity-claude",
		"codex",
	]);
});
test("typed provider blame requires identity-matched trusted durable provenance", async () => {
	const providerReliability = createProviderReliabilityDiagnostic({
		causeCode: "auth_expired",
		phase: "provider",
	});
	for (const trusted of [true, false]) {
		const f = fixture({
			"antigravity-claude": {
				status: "failed",
				result: { providerReliability },
				record: {
					lastFailure: {
						errorKind: "execution_failed",
						providerReliability,
						diagnosticCode: "auth_expired",
						diagnosticOrigin: trusted ? "adapter" : "provider",
						diagnosticEvidenceAvailable: true,
						failurePhase: "provider_execution",
					},
				},
			},
		});
		const result = await runSimpleRoutingTask(f.options, f.deps);
		strictEqual(result.direction, "complete");
		deepStrictEqual(
			result.failedTargetIds,
			trusted ? ["antigravity-claude"] : [],
		);
	}
});

test("trusted typed provider cause without a started writer never enters provider memory", async () => {
	const providerReliability = createProviderReliabilityDiagnostic({
		causeCode: "auth_expired",
		phase: "provider",
	});
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			result: { providerReliability },
			record: {
				lastFailure: {
					errorKind: "execution_failed",
					providerReliability,
					diagnosticCode: "auth_expired",
					diagnosticOrigin: "adapter",
					diagnosticEvidenceAvailable: true,
					failurePhase: "provider_execution",
				},
			},
		},
	});
	const engine = f.deps.runSimpleTask;
	f.deps.runSimpleTask = async (options, context) => {
		const result = await engine(options, context);
		result.recovery.cleanup.writer.state = "never_started";
		result.recovery.cleanup.worktree = { state: "not_created", path: null };
		f.records.get(context.runId).worktree = null;
		return result;
	};
	const result = await runSimpleRoutingTask(f.options, f.deps);
	// A writer that never started is a soft failure: the waterfall moves on.
	strictEqual(result.direction, "complete");
	strictEqual(result.attempts[0].terminal, "skipped");
	strictEqual(result.attempts[0].reason, "execution_failed");
	deepStrictEqual(result.failedTargetIds, []);
	strictEqual(f.calls[0], "antigravity-claude");
	strictEqual(f.calls.length, 2);
	deepStrictEqual(
		readRoutingRunState(f.options.projectPath, f.options.routingRunId, {
			stateRoot: f.deps.stateRoot,
		}).failedTargetIds,
		[],
	);
});

test("typed diagnostic identity ignores key order while preserving mismatched evidence refusal", async () => {
	const durable = createProviderReliabilityDiagnostic({
		causeCode: "auth_expired",
		phase: "provider",
	});
	for (const mismatch of [false, true]) {
		const evidence = Object.fromEntries(
			Object.entries(
				mismatch
					? createProviderReliabilityDiagnostic({
							causeCode: "quota_exhausted",
							phase: "provider",
						})
					: durable,
			).reverse(),
		);
		const f = fixture({
			"antigravity-claude": {
				status: "failed",
				result: { providerReliability: evidence },
				record: {
					lastFailure: {
						errorKind: "execution_failed",
						providerReliability: durable,
						diagnosticCode: "auth_expired",
						diagnosticOrigin: "adapter",
						diagnosticEvidenceAvailable: true,
						failurePhase: "provider_execution",
					},
				},
			},
		});
		f.options.capability = "high";
		const result = await runSimpleRoutingTask(f.options, f.deps);
		strictEqual(result.direction, "stop");
		strictEqual(
			result.result.accountability.owner,
			mismatch ? "unknown" : "provider",
		);
		strictEqual(result.result.accountability.providerMemoryEligible, !mismatch);
		strictEqual(result.attempts[0].terminal, mismatch ? "skipped" : "failed");
		deepStrictEqual(
			result.failedTargetIds,
			mismatch ? [] : ["antigravity-claude"],
		);
	}
});
