import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import {
	deriveFailureAccountability,
	inspectRoutingAccountability,
	linkedRoutingRecordMatches,
} from "../src/switchyard/simple/failure-accountability.mjs";
import { createSimpleProviderReliabilityDiagnostic } from "../src/switchyard/simple/reliability.mjs";

const diagnostic = (causeCode, more = {}) =>
	createProviderReliabilityDiagnostic({
		causeCode,
		phase: "provider",
		...more,
	});
test("closed ownership classes never infer provider responsibility from checks or raw text", () => {
	for (const [code, owner] of [
		["environment_failure", "environment"],
		["scope_rejected", "contract"],
		["input_rejected", "caller"],
		["acceptance_check_failed", "check_system"],
		["cancelled", "caller"],
		["cleanup_failed", "cleanup"],
		["provider_exit_nonzero", "unknown"],
	]) {
		const result = deriveFailureAccountability({
			providerReliability: diagnostic(code),
		});
		strictEqual(result.version, 1);
		strictEqual(result.owner, owner);
		strictEqual(result.providerMemoryEligible, false);
	}
	for (const value of [
		undefined,
		null,
		{},
		{
			...diagnostic("auth_expired"),
			causeCategory: "provider",
			extra: "secret",
		},
	])
		strictEqual(
			deriveFailureAccountability({
				providerReliability: value,
				provenance: { stderr: "auth expired" },
			}).owner,
			"unknown",
		);
});
test("provider attribution requires authoritative existing diagnostic provenance", () => {
	for (const origin of ["adapter", "provider", "launcher", undefined]) {
		const result = deriveFailureAccountability({
			providerReliability: diagnostic("auth_expired"),
			provenance: {
				diagnosticCode: "auth_expired",
				diagnosticOrigin: origin,
				diagnosticEvidenceAvailable: true,
				failurePhase: "provider_execution",
			},
		});
		strictEqual(result.providerMemoryEligible, origin === "adapter");
	}
	for (const provenance of [
		{
			diagnosticCode: "auth_expired",
			diagnosticOrigin: "adapter",
			diagnosticEvidenceAvailable: false,
			failurePhase: "provider_execution",
		},
		{
			diagnosticCode: "quota_exhausted",
			diagnosticOrigin: "adapter",
			diagnosticEvidenceAvailable: true,
			failurePhase: "provider_execution",
		},
	])
		strictEqual(
			deriveFailureAccountability({
				providerReliability: diagnostic("auth_expired"),
				provenance,
			}).owner,
			"unknown",
		);
	strictEqual(
		deriveFailureAccountability({
			providerReliability: diagnostic("cli_usage_error"),
			provenance: {
				diagnosticCode: "cli_usage_error",
				diagnosticOrigin: "launcher",
				diagnosticEvidenceAvailable: true,
				failurePhase: "provider_execution",
			},
		}).owner,
		"provider",
	);
	strictEqual(
		deriveFailureAccountability({
			providerReliability: diagnostic("provider_deadline_exceeded", {
				timedOut: true,
			}),
		}).owner,
		"provider",
	);
	strictEqual(
		deriveFailureAccountability({
			providerReliability: diagnostic("provider_deadline_exceeded"),
		}).owner,
		"unknown",
	);
});
const attempt = (
	runId,
	taskId = "task",
	targetId = "codex",
	terminal = "succeeded",
) => ({ runId, taskId, targetId, terminal, attemptId: `attempt-${runId}` });
const record = (a, more = {}) => ({
	runId: a.runId,
	projectPath: "/project",
	orderedTaskIds: [a.taskId],
	resolvedTargetId: a.targetId,
	state: a.terminal === "succeeded" ? "succeeded" : "failed",
	cleanupState: "complete",
	worktree: { state: "removed" },
	...more,
});
test("every linked identity and terminal mismatch rejects the record", () => {
	const a = attempt("run");
	strictEqual(linkedRoutingRecordMatches(record(a), a, "/project"), true);
	for (const override of [
		{ runId: "other" },
		{ projectPath: "/other" },
		{ orderedTaskIds: ["other"] },
		{ orderedTaskIds: [a.taskId, "other"] },
		{ resolvedTargetId: "vibe" },
		{ state: "failed" },
		{ lastFailure: { taskId: "other" } },
		{ worktree: { taskId: "other" } },
		{ worktree: { attemptId: "other" } },
	])
		strictEqual(
			linkedRoutingRecordMatches(record(a, override), a, "/project"),
			false,
		);
	strictEqual(linkedRoutingRecordMatches(null, a, "/project"), false);
});
test("inspect separates verified attempts, unique task successes, missing links and cleanup failure", async () => {
	const attempts = [
		attempt("a"),
		attempt("b"),
		attempt("c", "task", "vibe", "skipped"),
		attempt("d", "missing"),
		attempt("e", "spoof"),
		attempt("f", "failed", "vibe", "failed"),
	];
	const report = await inspectRoutingAccountability(
		{ canonicalProjectPath: "/project", attempts },
		async (id) => {
			const a = attempts.find((a) => a.runId === id);
			if (id === "d") throw new Error("missing secret");
			if (id === "e") return record(a, { resolvedTargetId: "vibe" });
			return record(
				a,
				id === "b"
					? { cleanupState: "failed", worktree: { state: "retained" } }
					: id === "c"
						? {
								lastFailure: {
									providerReliability: diagnostic("environment_failure"),
								},
							}
						: {},
			);
		},
	);
	deepStrictEqual(report.totals, {
		attempts: 6,
		succeededAttempts: 2,
		failedAttempts: 2,
		unknownAttempts: 2,
		uniqueTasks: 4,
		succeededTasks: 1,
	});
	deepStrictEqual(report.providers[0], {
		targetId: "codex",
		attempts: 4,
		succeededAttempts: 2,
		failedAttempts: 0,
		unknownAttempts: 2,
		uniqueTasks: 3,
		succeededTasks: 1,
	});
	strictEqual(report.attempts[1].outcome, "succeeded");
	strictEqual(report.attempts[0].accountability, null);
	strictEqual(report.attempts[1].accountability, null);
	strictEqual(report.attempts[1].cleanup.state, "failed");
	strictEqual(report.attempts[2].outcome, "failed");
	strictEqual(report.attempts[2].accountability.owner, "environment");
	strictEqual(report.attempts[3].accountability.owner, "unknown");
	strictEqual(JSON.stringify(report).includes("secret"), false);
	deepStrictEqual(
		(
			await inspectRoutingAccountability(
				{ canonicalProjectPath: "/project", attempts: [] },
				() => {},
			)
		).providers,
		[],
	);
});
test("permission and typed environment failures use only existing closed diagnostic values", () => {
	for (const errorKind of ["permission_denied", "environment_failure"])
		strictEqual(
			createSimpleProviderReliabilityDiagnostic({
				failureReason: "EACCES",
				failurePhase: "prepare",
				errorKind,
			}).causeCode,
			"environment_failure",
		);
	strictEqual(
		createSimpleProviderReliabilityDiagnostic({
			failureReason: "included_usage_unverified",
			failurePhase: "preflight",
			errorKind: "policy_violation",
		}).causeCode,
		"scope_rejected",
	);
});

test("candidate typed failures roundtrip through reachable committed readers by default", async () => {
	const { join } = await import("node:path");
	const { execFileSync } = await import("node:child_process");
	const { rmSync, realpathSync } = await import("node:fs");
	const { tempDir } = await import("./helpers/tempdir.mjs");
	const { initializeRun, updateRun } = await import(
		"../src/switchyard/run-store/index.mjs"
	);
	const { sanitizeFailureMetadata } = await import(
		"../src/switchyard/adapter/exec-error.mjs"
	);
	const { openRoutingRun, recordAttemptOutcome } = await import(
		"../src/switchyard/simple/routing-state.mjs"
	);
	const { makeOptions } = await import("./helpers/run-store-fixtures.mjs");
	const baselineCommit = "5c77335c8bec3f1ff6dddcc4521a3de893de7310";
	const archiveRoot = process.env.SWITCHYARD_COMPATIBILITY_ROOT
		? null
		: tempDir("accountability-committed-reader-");
	const compatibilityRoot =
		process.env.SWITCHYARD_COMPATIBILITY_ROOT ?? archiveRoot;
	const prior = process.env.SWITCHYARD_RUN_STORE_ROOT;
	const storeRoot = tempDir("accountability-compatibility-");
	process.env.SWITCHYARD_RUN_STORE_ROOT = join(storeRoot, "store");
	try {
		if (archiveRoot) {
			const archive = execFileSync(
				"git",
				["archive", baselineCommit, "src", "package.json"],
				{
					cwd: new URL("..", import.meta.url),
					maxBuffer: 32 * 1024 * 1024,
					timeout: 10000,
				},
			);
			execFileSync("tar", ["-xf", "-", "-C", archiveRoot], {
				input: archive,
				timeout: 10000,
			});
		}
		const oldAdapter = await import(
			`${compatibilityRoot}/src/switchyard/adapter/exec-error.mjs`
		);
		const oldReader = await import(
			`${compatibilityRoot}/src/switchyard/run-store/index.mjs`
		);
		const oldRouting = await import(
			`${compatibilityRoot}/src/switchyard/simple/routing-state.mjs`
		);
		for (const causeCode of [
			"auth_expired",
			"provider_exit_nonzero",
			"environment_failure",
			"scope_rejected",
			"input_rejected",
			"acceptance_check_failed",
			"cancelled",
			"cleanup_failed",
		]) {
			const options = makeOptions();
			await initializeRun(options);
			const metadata = sanitizeFailureMetadata({
				result: "execution_failed",
				errorKind: "execution_failed",
				providerReliability: diagnostic(causeCode),
				failurePhase: "provider_execution",
			});
			deepStrictEqual(
				oldAdapter.sanitizeFailureMetadata({
					...metadata,
					result: "execution_failed",
				}),
				metadata,
			);
			await updateRun(
				options.runId,
				{ state: "failed", lastFailure: metadata, cleanupState: "complete" },
				1,
			);
			deepStrictEqual(
				(await oldReader.readRun(options.runId)).lastFailure,
				metadata,
			);
		}
		const project = realpathSync(tempDir("accountability-routing-project-"));
		const stateRoot = realpathSync(tempDir("accountability-routing-state-"));
		const handle = openRoutingRun(project, "compatibility-run", { stateRoot });
		const pending = {
			taskId: "task",
			attemptId: "attempt",
			runId: "linked-run",
			targetId: "codex",
			capability: "standard",
			startedAt: new Date().toISOString(),
		};
		try {
			handle.commit({ pendingAttempt: pending });
			recordAttemptOutcome(handle.state, handle.commit, {
				...pending,
				terminal: "skipped",
				reason: "unsafe_failure",
				closedAt: new Date().toISOString(),
				partialWorktree: null,
			});
		} finally {
			handle.release();
		}
		const routing = oldRouting.readRoutingRunState(
			project,
			"compatibility-run",
			{ stateRoot },
		);
		strictEqual(routing.schemaVersion, 1);
		strictEqual(routing.attempts[0].terminal, "skipped");
		deepStrictEqual(routing.failedTargetIds, []);
	} finally {
		if (prior === undefined) delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		else process.env.SWITCHYARD_RUN_STORE_ROOT = prior;
		if (archiveRoot) rmSync(archiveRoot, { recursive: true, force: true });
		rmSync(storeRoot, { recursive: true, force: true });
	}
});
