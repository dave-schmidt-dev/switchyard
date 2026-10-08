import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import {
	isPersistentFailureDetails,
	isPersistentFailureMetadata,
	sanitizeFailureDetails,
	sanitizeFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";
import { resolveFailure } from "../src/switchyard/diagnostics/failure-registry.mjs";
import { getRunRoot, readRun } from "../src/switchyard/run-store/index.mjs";
import { handleSimple } from "../src/switchyard/simple/cli.mjs";
import {
	appendFailureRecord,
	readFailureRecords,
} from "../src/switchyard/simple/failure-log.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const suite = tempDir("switchyard-failure-detail-tests-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suite, "runs");

function git(path, args) {
	return execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
}

function commit(path) {
	git(path, ["add", "."]);
	git(path, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"fixture",
	]);
}

function fixture() {
	const root = tempDir("switchyard-failure-detail-");
	const projectPath = join(root, "project");
	mkdirSync(projectPath);
	writeFileSync(join(projectPath, "a.txt"), "base\n");
	git(projectPath, ["init", "-q"]);
	commit(projectPath);
	const promptPath = join(root, "prompt");
	writeFileSync(promptPath, "Change a.txt");
	return { root, projectPath, promptPath };
}

function run(repo, options = {}, provider = null, extra = {}) {
	return runSimpleTask(
		{
			...repo,
			capability: "standard",
			files: ["a.txt"],
			checks: ["test -f a.txt"],
			deadlineMs: Date.now() + 180_000,
			...options,
		},
		{
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
			executeProvider: async (context) => {
				if (provider) return provider(context);
				writeFileSync(join(context.worktreePath, "a.txt"), "candidate\n");
				return { success: true, writerLifecycle: "stopped" };
			},
			...extra,
		},
	);
}

const stubbedCheck = async () => ({
	success: true,
	writerLifecycle: "stopped",
});

test("scope rejection persists the rule and bounded paths into run.json failureDetails", async () => {
	const repo = fixture();
	const result = await run(
		repo,
		{},
		async ({ worktreePath }) => {
			writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
			// Task 3.5: a plain undeclared source edit is now kept; a .sh manifest stays refused.
			writeFileSync(join(worktreePath, "extra.sh"), "extra\n");
			return { success: true, writerLifecycle: "stopped" };
		},
		{ runCheck: stubbedCheck },
	);
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "undeclared_paths_changed");
	strictEqual(result.diffRejection.rule, "undeclared_paths_changed");
	ok(result.diffRejection.paths.includes("extra.sh"));
	strictEqual(result.providerReliability.diffRejectionCount, 1);
	strictEqual(result.failureDetails.diffRejectionCount, 1);
	const record = await readRun(result.runId);
	const details = record.failureDetails;
	ok(details, "run.json carries failureDetails");
	strictEqual(details.failureReason, "undeclared_paths_changed");
	strictEqual(details.diffRejectionRule, "undeclared_paths_changed");
	strictEqual(details.diffRejectionCategory, "undeclared");
	strictEqual(details.diffRejectionCount, 1);
	ok(details.diffRejectionPaths.includes("extra.sh"));
	ok(details.diffRejectionPaths.length <= 5);
	strictEqual(record.lastFailure.providerReliability.diffRejectionCount, 1);
	strictEqual(
		record.lastFailure.providerReliability.diffRejectionCategory,
		"undeclared",
	);
	ok(isPersistentFailureDetails(details));
	strictEqual("failureReason" in record.lastFailure, false);
	ok(isPersistentFailureMetadata(record.lastFailure));
});

test("edited-worktree acceptance check failure reports no diff rejection", async () => {
	const repo = fixture();
	const result = await run(
		repo,
		{},
		async ({ worktreePath }) => {
			writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
			return { success: true, writerLifecycle: "stopped" };
		},
		{
			runCheck: async () => ({
				success: false,
				exitCode: 1,
				writerLifecycle: "stopped",
			}),
		},
	);
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "check_failed");
	strictEqual(result.providerReliability.diffRejectionCategory, null);
	strictEqual(result.providerReliability.diffRejectionCount, 0);
	strictEqual(result.failureDetails.diffRejectionCount, undefined);
	strictEqual(result.failureDetails.outputPath, undefined);
	const record = await readRun(result.runId);
	strictEqual(record.failureDetails.diffRejectionCount, undefined);
	strictEqual(record.failureDetails.outputPath, undefined);
	strictEqual(record.lastFailure.providerReliability.diffRejectionCount, 0);
	strictEqual(
		record.lastFailure.providerReliability.diffRejectionCategory,
		null,
	);
});

test("baseline failure links terminal and durable details to redacted check evidence", async () => {
	const repo = fixture();
	const token = "sk-fixture-baseline-token-000000";
	const rawOutput = `BASELINE_FAILURE_TAIL Bearer ${token}`;
	const command =
		"node -e 'process.stdout.write(" +
		JSON.stringify(rawOutput) +
		");process.exit(2)'";
	const result = await run(repo, { baselineChecks: [command] });
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "baseline_check_failed");
	strictEqual(result.providerStarted, false);
	const record = await readRun(result.runId);
	const evidencePath = join(
		getRunRoot(result.runId),
		"check-evidence",
		"0-1.log",
	);
	strictEqual(result.failureDetails.outputPath, evidencePath);
	strictEqual(record.failureDetails.outputPath, evidencePath);
	strictEqual(result.failureDetails.checkIndex, 1);
	strictEqual(
		record.failureDetails.checkIdentity,
		result.failureDetails.checkIdentity,
	);
	const evidence = readFileSync(evidencePath, "utf8");
	ok(evidence.includes("BASELINE_FAILURE_TAIL"));
	ok(evidence.includes("Bearer [REDACTED]"));
	ok(!evidence.includes(token));
	const serialized = JSON.stringify({ result, record });
	ok(!serialized.includes(rawOutput));
	ok(!serialized.includes(token));
});

test("timed-out check repair preserves provider timeout evidence in terminal and run.json", async () => {
	const repo = fixture();
	let providerCalls = 0;
	let checkCalls = 0;
	const result = await run(
		repo,
		{ repairChecks: true },
		async ({ worktreePath }) => {
			providerCalls += 1;
			writeFileSync(join(worktreePath, "a.txt"), `provider ${providerCalls}\n`);
			return providerCalls === 1
				? { success: true, code: 0, writerLifecycle: "stopped" }
				: {
						success: false,
						code: 76,
						timedOut: true,
						writerLifecycle: "stopped",
					};
		},
		{
			runCheck: async () => {
				checkCalls += 1;
				return {
					success: false,
					code: 1,
					timedOut: false,
					writerLifecycle: "stopped",
				};
			},
			healthDecision: Object.assign(
				() => ({ available: false, mode: "enforce", suppress: false }),
				{ mode: "enforce" },
			),
		},
	);
	strictEqual(providerCalls, 2);
	strictEqual(checkCalls, 1);
	strictEqual(result.status, "failed");
	strictEqual(result.failurePhase, "execute");
	strictEqual(result.failureReason, "provider_deadline_exceeded");
	strictEqual(
		result.providerReliability.causeCode,
		"provider_deadline_exceeded",
	);
	strictEqual(result.providerReliability.timedOut, true);
	strictEqual(result.failureDetails.timedOut, true);

	const record = await readRun(result.runId);
	strictEqual(
		record.lastFailure.providerReliability.causeCode,
		result.providerReliability.causeCode,
	);
	strictEqual(
		record.lastFailure.providerReliability.timedOut,
		result.providerReliability.timedOut,
	);
	strictEqual(record.failureDetails.timedOut, result.failureDetails.timedOut);
});

test("ordinary real checker failure persists its owner-side evidence path", async () => {
	const repo = fixture();
	const events = [];
	let providerCalls = 0;
	const result = await run(
		repo,
		{
			checks: [
				`node -e 'if(require("fs").readFileSync("a.txt","utf8").trim()!=="base")process.exit(1)'`,
			],
		},
		async ({ worktreePath }) => {
			providerCalls += 1;
			writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
			return { success: true, writerLifecycle: "stopped" };
		},
		{ onStatus: (event) => events.push(event) },
	);
	strictEqual(providerCalls, 1);
	ok(
		events.some(
			(event) =>
				event.phase === "baseline" &&
				event.milestone === "dry_run_check_finished" &&
				event.checkStatus === "passed",
		),
		"pre-provider check passes on the base tree",
	);
	strictEqual(result.failureReason, "check_failed");
	const outputPath = result.failureDetails.outputPath;
	ok(typeof outputPath === "string" && existsSync(outputPath));
	strictEqual(result.checks[0].outputPath, outputPath);
	const record = await readRun(result.runId);
	strictEqual(record.failureDetails.outputPath, outputPath);
	ok(
		events.some(
			(event) =>
				event.phase === "checks" &&
				event.milestone === "check_finished" &&
				event.checkStatus === "failed",
		),
		"candidate check fails after the provider runs",
	);
	strictEqual("output" in record.failureDetails, false);
});

test("failed repair persists the latest real checker evidence path", async () => {
	const repo = fixture();
	const events = [];
	let providerCalls = 0;
	const result = await run(
		repo,
		{
			repairChecks: true,
			checks: [
				`node -e 'if(require("fs").readFileSync("a.txt","utf8").trim()!=="base")process.exit(1)'`,
			],
		},
		async ({ worktreePath }) => {
			providerCalls += 1;
			writeFileSync(
				join(worktreePath, "a.txt"),
				`candidate-${providerCalls}\n`,
			);
			return { success: true, writerLifecycle: "stopped" };
		},
		{ onStatus: (event) => events.push(event) },
	);
	strictEqual(providerCalls, 2);
	strictEqual(result.failureReason, "check_repair_failed");
	const outputPath = result.failureDetails.outputPath;
	ok(typeof outputPath === "string" && existsSync(outputPath));
	strictEqual(basename(outputPath), "2-1.log");
	const firstFailurePath = join(dirname(outputPath), "1-1.log");
	ok(existsSync(firstFailurePath));
	ok(firstFailurePath !== outputPath);
	strictEqual(result.checks[0].outputPath, outputPath);
	const record = await readRun(result.runId);
	strictEqual(record.failureDetails.outputPath, outputPath);
	strictEqual("output" in record.failureDetails, false);
	ok(
		events.some(
			(event) =>
				event.phase === "baseline" &&
				event.milestone === "dry_run_check_finished" &&
				event.checkStatus === "passed",
		),
		"pre-provider check passes on the base tree",
	);
});

test("failed repair provider evidence does not reuse the prior check artifact", async () => {
	const repo = fixture();
	const providerOutputPath = join(repo.root, "provider-failure.log");
	let providerCalls = 0;
	const result = await run(
		repo,
		{
			repairChecks: true,
			checks: [
				`node -e 'if(require("fs").readFileSync("a.txt","utf8").trim()!=="base")process.exit(1)'`,
			],
		},
		async ({ worktreePath }) => {
			providerCalls += 1;
			if (providerCalls === 1) {
				writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
				return { success: true, writerLifecycle: "stopped" };
			}
			writeFileSync(providerOutputPath, "provider diagnostic\n");
			return {
				success: false,
				code: 76,
				writerLifecycle: "stopped",
				outputPath: providerOutputPath,
			};
		},
	);
	strictEqual(providerCalls, 2);
	strictEqual(result.failurePhase, "execute");
	ok(existsSync(providerOutputPath));
	ok(existsSync(result.checks[0].outputPath));
	strictEqual(result.failureDetails.outputPath, providerOutputPath);
	const record = await readRun(result.runId);
	strictEqual(record.failureDetails.outputPath, providerOutputPath);
});

test("rejection totals exceed the bounded displayed path list", async () => {
	const repo = fixture();
	const result = await run(
		repo,
		{},
		async ({ worktreePath }) => {
			writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
			for (let i = 0; i < 7; i++)
				writeFileSync(join(worktreePath, `extra-${i}.sh`), "extra\n");
			return { success: true, writerLifecycle: "stopped" };
		},
		{ runCheck: stubbedCheck },
	);
	strictEqual(result.failureReason, "undeclared_paths_changed");
	strictEqual(result.diffRejection.paths.length, 5);
	strictEqual(result.providerReliability.diffRejectionCount, 7);
	strictEqual(result.failureDetails.diffRejectionCount, 7);
	const record = await readRun(result.runId);
	strictEqual(record.failureDetails.diffRejectionPaths.length, 5);
	strictEqual(record.failureDetails.diffRejectionCount, 7);
	strictEqual(record.lastFailure.providerReliability.diffRejectionCount, 7);
});

test("scope-rejection details round-trip through the failure-log record", async () => {
	const repo = fixture();
	const result = await run(
		repo,
		{},
		async ({ worktreePath }) => {
			writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
			// Task 3.5: a plain undeclared source edit is now kept; a .sh manifest stays refused.
			writeFileSync(join(worktreePath, "extra.sh"), "extra\n");
			return { success: true, writerLifecycle: "stopped" };
		},
		{ runCheck: stubbedCheck },
	);
	const stateRoot = tempDir("switchyard-failure-detail-log-");
	const logged = appendFailureRecord(
		{
			recordType: "attempt",
			targetId: "codex",
			reason: result.failureReason,
			causeCode: "scope_rejected",
			phase: "diff",
			failurePhase: result.failurePhase,
			errorKind: result.errorKind,
			failureReason: result.failureReason,
			diffRejectionRule: result.diffRejection.rule,
			diffRejectionPaths: result.diffRejection.paths,
		},
		{ stateRoot },
	);
	strictEqual(logged.failureReason, "undeclared_paths_changed");
	strictEqual(logged.diffRejectionRule, "undeclared_paths_changed");
	deepStrictEqual(logged.diffRejectionPaths, ["extra.sh"]);
	deepStrictEqual(readFailureRecords({ stateRoot })[0], logged);
});

test("manifest review rejection persists the manifest rule and matching paths", async () => {
	const repo = fixture();
	writeFileSync(join(repo.projectPath, "package.json"), "{}\n");
	commit(repo.projectPath);
	const result = await run(repo, { files: ["package.json"] });
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "manifest_review_required");
	strictEqual(result.diffRejection.rule, "manifest_review_required");
	const record = await readRun(result.runId);
	const details = record.failureDetails;
	strictEqual(details.failureReason, "manifest_review_required");
	strictEqual(details.diffRejectionRule, "manifest_review_required");
	strictEqual(details.diffRejectionCategory, "manifest_review");
	deepStrictEqual(details.diffRejectionPaths, ["package.json"]);
	ok(isPersistentFailureDetails(details));
});

test("unsafe_diff git-control tamper persists failureReason and diagnosticCode", () => {
	const failure = sanitizeFailureMetadata({
		result: "execution_failed",
		errorKind: "policy_violation",
		diagnosticCode: "git_control_tampered",
		diagnosticOrigin: "harness",
		diagnosticEvidenceAvailable: true,
		exitCode: 76,
	});
	const details = sanitizeFailureDetails({
		failureReason: "unsafe_diff",
		diffRejectionCategory: "unsafe",
		diffRejectionCount: 4,
		exitCode: 76,
	});
	strictEqual(failure.errorKind, "policy_violation");
	strictEqual(failure.diagnosticCode, "git_control_tampered");
	strictEqual(failure.exitCode, 76);
	deepStrictEqual(details, {
		failureReason: "unsafe_diff",
		diffRejectionCategory: "unsafe",
		diffRejectionCount: 4,
	});
	ok(isPersistentFailureMetadata(failure));
	ok(isPersistentFailureDetails(details));
	strictEqual(isPersistentFailureDetails({ ...details, extra: 1 }), false);
	strictEqual(
		isPersistentFailureDetails({ ...details, diffRejectionCount: -1 }),
		false,
	);
});

test("a usage-error invocation writes one failure-log record of type invocation", async () => {
	const invocationRoot = tempDir("switchyard-failure-detail-invocation-");
	const prior = process.env.SWITCHYARD_RUN_STORE_ROOT;
	process.env.SWITCHYARD_RUN_STORE_ROOT = invocationRoot;
	let envelope = null;
	const signalProcess = new EventEmitter();
	try {
		await handleSimple(["--bogus"], {
			writeResult: (text) => {
				envelope = JSON.parse(text);
			},
			stderr: { write: () => {} },
			signalProcess,
		});
	} finally {
		if (prior === undefined) delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		else process.env.SWITCHYARD_RUN_STORE_ROOT = prior;
	}
	strictEqual(envelope.status, "failed");
	strictEqual(envelope.failureReason, "invalid_invocation");
	ok(typeof envelope.usageError === "string");
	ok(envelope.usageError.length > 0);
	strictEqual(signalProcess.exitCode, 2);
	const records = readFailureRecords({ stateRoot: invocationRoot });
	strictEqual(records.length, 1);
	const record = records[0];
	strictEqual(record.recordType, "invocation");
	strictEqual(record.reason, "invalid_invocation");
	strictEqual(record.failurePhase, "preflight");
	strictEqual(record.errorKind, "validation_failed");
	strictEqual(record.preflightCode, "invalid_invocation");
	ok(typeof record.usageError === "string" && record.usageError.length > 0);
});

test("failure-log detail fields round-trip with their declared types", () => {
	const stateRoot = tempDir("switchyard-failure-detail-types-");
	const record = appendFailureRecord(
		{
			recordType: "attempt",
			targetId: "codex",
			reason: "provider_exit_nonzero",
			causeCode: "provider_exit_nonzero",
			timedOut: true,
			cancelled: false,
			exitCode: 76,
			diffRejectionRule: "undeclared_paths_changed",
			diffRejectionPaths: ["extra.txt", "sneaky\x1b.txt"],
		},
		{ stateRoot },
	);
	strictEqual(record.timedOut, true);
	strictEqual(record.cancelled, false);
	strictEqual(record.exitCode, 76);
	strictEqual(record.diffRejectionRule, "undeclared_paths_changed");
	deepStrictEqual(record.diffRejectionPaths, ["extra.txt", "sneaky?.txt"]);
	const invalid = appendFailureRecord(
		{
			recordType: "attempt",
			targetId: "codex",
			timedOut: "yes",
			cancelled: 1,
			exitCode: -1,
			diffRejectionRule: 42,
			diffRejectionPaths: "not-an-array",
		},
		{ stateRoot },
	);
	strictEqual(invalid.timedOut, null);
	strictEqual(invalid.cancelled, null);
	strictEqual(invalid.exitCode, null);
	strictEqual(invalid.diffRejectionRule, null);
	strictEqual(invalid.diffRejectionPaths, null);
	const bounded = appendFailureRecord(
		{
			recordType: "attempt",
			targetId: "codex",
			diffRejectionPaths: [
				"one",
				"two",
				"three",
				"four",
				"x".repeat(300),
				"six",
			],
		},
		{ stateRoot },
	);
	strictEqual(bounded.diffRejectionPaths.length, 5);
	strictEqual(bounded.diffRejectionPaths[4].length, 200);
	const base = appendFailureRecord(
		{ recordType: "attempt", targetId: "codex" },
		{ stateRoot },
	);
	strictEqual("failureReason" in base, false);
	strictEqual("timedOut" in base, false);
	strictEqual("diffRejectionPaths" in base, false);
	strictEqual("preflightCode" in base, false);
});

test("registry rows carry the integrate diff categories and rejection details", () => {
	strictEqual(
		resolveFailure({ reason: "dirty_overlay_drift" }).diffCategory,
		"concurrent_change",
	);
	strictEqual(
		resolveFailure({
			reason: "project_head_changed_concurrently",
		}).diffCategory,
		"concurrent_change",
	);
	strictEqual(
		resolveFailure({
			reason: "ambiguous_combined_rename_spelling",
		}).diffCategory,
		"integration",
	);
	strictEqual(
		resolveFailure({ reason: "undeclared_paths_changed" }).diffCategory,
		"undeclared",
	);
	const scopeRejection = resolveFailure({ reason: "unsafe_diff" });
	ok(scopeRejection.detailFields.includes("failureReason"));
	ok(scopeRejection.detailFields.includes("diffRejectionRule"));
	ok(scopeRejection.detailFields.includes("diffRejectionPaths"));
	ok(
		resolveFailure({ reason: "run_store_write_failed" }).detailFields.includes(
			"failureReason",
		),
	);
});
