import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isPersistentFailureMetadata } from "../src/switchyard/adapter/exec-error.mjs";
import { resolveFailure } from "../src/switchyard/diagnostics/failure-registry.mjs";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import { readRun } from "../src/switchyard/run-store/index.mjs";
import {
	appendFailureRecord,
	readFailureRecords,
} from "../src/switchyard/simple/failure-log.mjs";
import { classifyAttemptFailure } from "../src/switchyard/simple/failure-severity.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { classifyExecutionFailure } from "../src/switchyard/simple/provider-invocation.mjs";
import { createBridgeRequestRecorder } from "../src/switchyard/simple/request-evidence.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import { LIFECYCLE_CHECKS } from "../src/switchyard/simple/routing-stop-record.mjs";
import { nestedSandboxSkip } from "./helpers/nested-sandbox.mjs";
import { fixture as routingFixture } from "./helpers/simple-routing-fixture.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const suite = tempDir("switchyard-route-phase-failures-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suite, "runs");

function git(path, args) {
	return execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
}

function repoFixture() {
	const root = tempDir("switchyard-route-phase-failures-repo-");
	const projectPath = join(root, "project");
	mkdirSync(projectPath);
	writeFileSync(join(projectPath, "a.txt"), "base\n");
	git(projectPath, ["init", "-q"]);
	git(projectPath, ["add", "."]);
	git(projectPath, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"fixture",
	]);
	const promptPath = join(root, "prompt");
	writeFileSync(promptPath, "Change a.txt");
	return { root, projectPath, promptPath };
}

const writeCandidate = async ({ worktreePath }) => {
	writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
	return { success: true, writerLifecycle: "stopped" };
};

const codexDeps = (repo, provider = writeCandidate) => ({
	tmpdir: repo.root,
	route: () => ({ provider: "Codex (Spark)", reason: "priority_fill" }),
	resolveTargetIdentity: () => ({
		targetId: "codex",
		harnessKey: "codex",
		ambiguous: false,
	}),
	getInvocationDescriptor: () => ({
		target_id: "codex",
		selector: "gpt-5.3-codex-spark",
		invocation_args: [],
	}),
	assertFundedRoute: () => {},
	executeProvider: provider,
});

const taskOptions = (repo, overrides = {}) => ({
	...repo,
	capability: "standard",
	files: ["a.txt"],
	checks: ["test -f a.txt"],
	deadlineMs: Date.now() + 180_000,
	...overrides,
});

// -- Golden rows -------------------------------------------------------------

const REQUEST_REASONS = [
	"request_event_end_invalid",
	"request_event_end_missing",
	"request_event_truncated",
	"request_event_invalid",
	"request_event_after_end",
	"request_event_line_too_long",
	"request_event_write_failed",
	"request_event_close_failed",
];
const ROUTE_REASONS = [
	"no_eligible",
	"no_eligible_provider",
	"route_health_blocked",
	"local_adapter_unavailable",
	"routing_selection_invalid",
];

test("golden rows: the new closed codes classify by reason and phase", () => {
	const golden = [
		// reason, phase, causeCode, causeCategory, severity, errorKind
		[
			"check_setup_failed",
			"prepare",
			"check_setup_failed",
			"environment",
			"baseline",
			"environment_failure",
		],
		...ROUTE_REASONS.map((reason) => [
			reason,
			"route",
			"no_route_available",
			"environment",
			"soft",
			"unclassified_failure",
		]),
		...REQUEST_REASONS.map((reason) => [
			reason,
			"execute",
			"request_evidence_invalid",
			"environment",
			"soft",
			"execution_failed",
		]),
	];
	for (const [reason, phase, code, category, severity, kind] of golden) {
		const resolved = resolveFailure({ reason, phase });
		strictEqual(resolved.causeCode, code, `${reason} causeCode`);
		strictEqual(resolved.causeCategory, category, `${reason} category`);
		strictEqual(resolved.severity, severity, `${reason} severity`);
		strictEqual(resolved.errorKind, kind, `${reason} errorKind`);
	}
});

test("golden rows: a failed provider classifies by its own result", () => {
	for (const [providerResult, reason, code] of [
		[
			{ success: false, code: 76, writerLifecycle: "stopped" },
			"provider_exit_nonzero",
			"provider_exit_nonzero",
		],
		[
			{ success: false, code: null, timedOut: true },
			"provider_deadline_exceeded",
			"provider_deadline_exceeded",
		],
		[
			{ success: false, code: null, cancelled: true },
			"provider_cancelled",
			"cancelled",
		],
		[
			{ success: false, code: null, signal: "SIGKILL" },
			"provider_signalled",
			"provider_signalled",
		],
	]) {
		strictEqual(classifyExecutionFailure(providerResult), reason);
		strictEqual(
			resolveFailure({ reason, phase: "execute", providerResult }).causeCode,
			code,
		);
	}
});

test("severity: setup stops the waterfall, route and ledger failures do not", () => {
	const classify = (failureReason, failurePhase, causeCode, phase) =>
		classifyAttemptFailure({
			result: {
				failureReason,
				failurePhase,
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode,
					phase,
				}),
			},
		});
	strictEqual(
		classify(
			"check_environment_unavailable",
			"prepare",
			"check_setup_failed",
			"prepare",
		).severity,
		"baseline",
	);
	strictEqual(
		classify("no_eligible_provider", "route", "no_route_available", "route")
			.severity,
		"soft",
	);
	strictEqual(
		classify(
			"request_event_end_invalid",
			"execute",
			"request_evidence_invalid",
			"provider",
		).severity,
		"soft",
	);
});

// -- S7: check-session setup before any baseline check ------------------------

test("a check-session setup throw with no baseline checks is check_setup_failed", {
	skip: nestedSandboxSkip,
}, async () => {
	const repo = repoFixture();
	let providerCalls = 0;
	const result = await runSimpleTask(
		taskOptions(repo, { checks: ["switchyard_missing_check_tool --version"] }),
		codexDeps(repo, async () => {
			providerCalls += 1;
			return { success: true, writerLifecycle: "stopped" };
		}),
	);
	strictEqual(providerCalls, 0);
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "check_environment_unavailable");
	strictEqual(result.failurePhase, "prepare");
	strictEqual(result.errorKind, "environment_failure");
	const reliability = result.providerReliability;
	strictEqual(reliability.causeCode, "check_setup_failed");
	strictEqual(reliability.causeCategory, "environment");
	strictEqual(reliability.phase, "prepare");
	strictEqual(reliability.baselineStatus, "not_requested");
	ok(!JSON.stringify(result).includes("baseline_check_failed"));
	strictEqual(
		classifyAttemptFailure({ result, accountability: result.accountability })
			.severity,
		"baseline",
	);
	const run = await readRun(result.runId);
	strictEqual(
		run.failureDetails.failureReason,
		"check_environment_unavailable",
	);
	strictEqual(
		run.lastFailure.providerReliability.causeCode,
		"check_setup_failed",
	);
	strictEqual(run.lastFailure.providerReliability.phase, "prepare");
	ok(isPersistentFailureMetadata(run.lastFailure));
});

test("a dependency refusal during setup keeps its own closed code", async () => {
	const repo = repoFixture();
	const outside = tempDir("switchyard-route-phase-failures-venv-");
	symlinkSync(outside, join(repo.projectPath, ".venv"));
	const result = await runSimpleTask(taskOptions(repo), codexDeps(repo));
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "check_venv_outside_project");
	strictEqual(result.failurePhase, "prepare");
	strictEqual(
		result.providerReliability.causeCode,
		"check_venv_outside_project",
	);
	strictEqual(
		classifyAttemptFailure({ result, accountability: result.accountability })
			.severity,
		"baseline",
	);
});

// -- Request-evidence ledger errors -------------------------------------------

const END_MISMATCH = 'SWITCHYARD_PROXY_END_V1 {"requests":5}\n';
const END_VALID = 'SWITCHYARD_PROXY_END_V1 {"requests":0}\n';

function runBridge(repo, { stderr, provider }) {
	return runSimpleTask(taskOptions(repo, { onlyProviders: ["opencode-go"] }), {
		tmpdir: repo.root,
		route: () => ({ provider: "OpenCode Go", reason: "priority_fill" }),
		resolveTargetIdentity: () => ({
			targetId: "opencode-go",
			harnessKey: "opencode",
			ambiguous: false,
		}),
		getInvocationDescriptor: () => ({
			target_id: "opencode-go",
			selector: "opencode-go/deepseek-v4.1-flash",
			invocation_args: ["--variant", "max"],
		}),
		assertFundedRoute: () => {},
		probeSimpleLauncher: async () => ({
			success: true,
			probeWriterLifecycle: "never_started",
		}),
		createBridgeRequestRecorder,
		runCheck: async () => ({ success: true, writerLifecycle: "stopped" }),
		executeProvider: async (context) => {
			if (stderr) context.onStderrChunk(Buffer.from(stderr));
			return provider(context);
		},
	});
}

const failedProvider = (extra) => async () => ({
	success: false,
	code: 76,
	writerLifecycle: "stopped",
	...extra,
});

test("a failed provider keeps its own code whether or not the bridge end record is valid", async () => {
	for (const [label, stderr, extra, reason] of [
		["invalid end", END_MISMATCH, {}, "provider_exit_nonzero"],
		["valid end", END_VALID, {}, "provider_exit_nonzero"],
		["no end record", "", {}, "provider_exit_nonzero"],
		[
			"timed out, invalid end",
			END_MISMATCH,
			{ code: null, timedOut: true },
			"provider_deadline_exceeded",
		],
	]) {
		const repo = repoFixture();
		const result = await runBridge(repo, {
			stderr,
			provider: failedProvider(extra),
		});
		strictEqual(result.status, "failed", label);
		strictEqual(result.failureReason, reason, label);
		strictEqual(result.failurePhase, "execute", label);
		strictEqual(result.providerReliability.causeCode, reason, label);
		strictEqual(result.providerReliability.phase, "provider", label);
	}
});

test("a successful provider with an invalid bridge ledger fails as request_evidence_invalid", async () => {
	for (const [stderr, reason] of [
		[END_MISMATCH, "request_event_end_invalid"],
		["", "request_event_end_missing"],
	]) {
		const repo = repoFixture();
		const result = await runBridge(repo, { stderr, provider: writeCandidate });
		strictEqual(result.status, "failed", reason);
		strictEqual(result.failureReason, reason);
		strictEqual(result.failurePhase, "execute");
		strictEqual(
			result.providerReliability.causeCode,
			"request_evidence_invalid",
		);
		strictEqual(result.providerReliability.causeCategory, "environment");
		const run = await readRun(result.runId);
		strictEqual(run.failureDetails.failureReason, reason);
		strictEqual(
			run.lastFailure.providerReliability.causeCode,
			"request_evidence_invalid",
		);
	}
});

// -- S8: route failures in the retry waterfall --------------------------------

const routeFailure = (context, overrides = {}) => ({
	runId: context.runId,
	taskId: context.taskId,
	attemptId: context.attemptId,
	status: "failed",
	failurePhase: "route",
	failureReason: "no_eligible_provider",
	errorKind: "unclassified_failure",
	providerReliability: createProviderReliabilityDiagnostic({
		causeCode: "no_route_available",
		phase: "route",
	}),
	...overrides,
});

const allFail = {
	"antigravity-claude": { status: "failed" },
	codex: { status: "failed" },
	vibe: { status: "failed" },
};

test("a route failure after earlier attempts logs its own attempt and names the stop", async () => {
	const f = routingFixture(allFail);
	const inner = f.deps.runSimpleTask;
	let routeRunId = null;
	f.deps.runSimpleTask = async (opts, context) => {
		const result = await inner(opts, context);
		if (result.failurePhase !== "route") return result;
		routeRunId = context.runId;
		return routeFailure(context);
	};
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "native_required");
	const records = readFailureRecords({ stateRoot: f.deps.stateRoot });
	strictEqual(records.length, 5);
	const attempts = records.filter((r) => r.recordType === "attempt");
	strictEqual(attempts.length, 4);
	const unrouted = attempts[3];
	strictEqual(unrouted.targetId, null);
	strictEqual(unrouted.runId, routeRunId);
	strictEqual(unrouted.causeCode, "no_route_available");
	strictEqual(unrouted.causeCategory, "environment");
	strictEqual(unrouted.phase, "route");
	strictEqual(unrouted.failurePhase, "route");
	strictEqual(unrouted.errorKind, "unclassified_failure");
	strictEqual(unrouted.severity, "soft");
	ok(!attempts.slice(0, 3).some((a) => a.runId === routeRunId));
	const stop = records[4];
	strictEqual(stop.recordType, "stop");
	strictEqual(stop.stopReason, "native_required");
	strictEqual(stop.exhaustionCause, "task_failures");
	strictEqual(stop.runId, routeRunId);
	strictEqual(stop.attemptId, unrouted.attemptId);
	strictEqual(stop.taskId, unrouted.taskId);
	strictEqual(stop.targetId, null);
	strictEqual(stop.causeCode, "no_route_available");
	strictEqual(stop.causeCategory, "environment");
	strictEqual(stop.phase, "route");
	strictEqual(stop.errorKind, "unclassified_failure");
});

test("a failed result that is not this iteration's own is neither logged nor used to name the stop", async () => {
	const f = routingFixture(allFail);
	const inner = f.deps.runSimpleTask;
	f.deps.runSimpleTask = async (opts, context) => {
		const result = await inner(opts, context);
		return result.failurePhase === "route"
			? routeFailure(context, { runId: "simple-someone-else" })
			: result;
	};
	await runSimpleRoutingTask(f.options, f.deps);
	const records = readFailureRecords({ stateRoot: f.deps.stateRoot });
	strictEqual(records.length, 4);
	strictEqual(records.filter((r) => r.recordType === "attempt").length, 3);
	strictEqual(records[3].recordType, "stop");
	strictEqual(records[3].targetId, "vibe");
	strictEqual(records[3].runId, records[2].runId);
});

test("the real engine's second-call route failure is logged and the stop matches its run", {
	skip: nestedSandboxSkip,
}, async () => {
	const repo = repoFixture();
	const stateRoot = realpathSync(
		tempDir("switchyard-route-phase-failures-state-"),
	);
	const answer = await runSimpleRoutingTask(
		taskOptions(repo, { routingRunId: "route-phase-failures" }),
		{
			...codexDeps(repo, async () => ({
				success: false,
				code: 1,
				writerLifecycle: "stopped",
			})),
			stateRoot,
			getImplementorPriority: () => 1,
			route: ({ availableProviders }) =>
				availableProviders.length > 0
					? { provider: availableProviders[0], reason: "priority_fill" }
					: { provider: null, reason: "no_eligible" },
			runSimpleTask,
		},
	);
	strictEqual(answer.direction, "native_required", JSON.stringify(answer));
	const failedRun = answer.result;
	strictEqual(failedRun.failurePhase, "route");
	strictEqual(failedRun.providerReliability.causeCode, "no_route_available");
	const records = readFailureRecords({ stateRoot });
	const attempts = records.filter((r) => r.recordType === "attempt");
	strictEqual(attempts.length, 2);
	strictEqual(attempts[0].targetId, "codex");
	strictEqual(attempts[0].causeCode, "provider_exit_nonzero");
	strictEqual(attempts[1].targetId, null);
	strictEqual(attempts[1].runId, failedRun.runId);
	strictEqual(attempts[1].causeCode, "no_route_available");
	const stop = records.at(-1);
	strictEqual(stop.recordType, "stop");
	strictEqual(stop.runId, failedRun.runId);
	strictEqual(stop.runId === attempts[0].runId, false);
	strictEqual(stop.causeCode, "no_route_available");
	strictEqual(stop.phase, "route");
	const run = await readRun(failedRun.runId);
	strictEqual(
		run.lastFailure.providerReliability.causeCode,
		"no_route_available",
	);
});

// -- lifecycle_unconfirmed names the failing check -----------------------------

test("lifecycle_unconfirmed stops carry a closed lifecycleCheck", async () => {
	for (const [override, expected] of [
		[{ record: { projectPath: "/elsewhere" } }, "record_project"],
		[{ record: { resolvedTargetId: "other" } }, "record_target"],
		[{ record: { state: "failed" } }, "record_state"],
		[{ result: { runId: "simple-other" } }, "run_id"],
		[{ result: { taskId: "other-task" } }, "task_id"],
	]) {
		const f = routingFixture({ "antigravity-claude": override });
		const answer = await runSimpleRoutingTask(f.options, f.deps);
		strictEqual(answer.stopReason, "lifecycle_unconfirmed", expected);
		strictEqual(answer.lifecycleCheck, expected);
		ok(LIFECYCLE_CHECKS.includes(answer.lifecycleCheck));
		const stop = readFailureRecords({ stateRoot: f.deps.stateRoot }).at(-1);
		strictEqual(stop.recordType, "stop");
		strictEqual(stop.stopReason, "lifecycle_unconfirmed");
		strictEqual(stop.lifecycleCheck, expected);
	}
	const f = routingFixture();
	f.deps.readRun = async () => {
		throw new Error("unreadable");
	};
	const answer = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(answer.stopReason, "lifecycle_unconfirmed");
	strictEqual(answer.lifecycleCheck, "run_record_unreadable");
});

test("the failure log keeps lifecycleCheck closed and absent unless supplied", () => {
	const stateRoot = tempDir("switchyard-route-phase-failures-log-");
	const closed = appendFailureRecord(
		{ recordType: "stop", lifecycleCheck: "run_id" },
		{ stateRoot },
	);
	strictEqual(closed.lifecycleCheck, "run_id");
	const open = appendFailureRecord(
		{ recordType: "stop", lifecycleCheck: "made_up_check" },
		{ stateRoot },
	);
	strictEqual(open.lifecycleCheck, null);
	const plain = appendFailureRecord({ recordType: "stop" }, { stateRoot });
	strictEqual("lifecycleCheck" in plain, false);
	deepStrictEqual(
		readFailureRecords({ stateRoot }).map((r) => r.lifecycleCheck ?? null),
		["run_id", null, null],
	);
});
