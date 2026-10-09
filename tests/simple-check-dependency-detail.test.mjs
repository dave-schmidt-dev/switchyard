import { notStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isPersistentFailureDetails } from "../src/switchyard/adapter/exec-error.mjs";
import { resolveFailure } from "../src/switchyard/diagnostics/failure-registry.mjs";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import { readRun } from "../src/switchyard/run-store/index.mjs";
import { readFailureRecords } from "../src/switchyard/simple/failure-log.mjs";
import { classifyAttemptFailure } from "../src/switchyard/simple/failure-severity.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import { nestedSandboxSkip } from "./helpers/nested-sandbox.mjs";
import { fixture } from "./helpers/simple-routing-fixture.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const suite = tempDir("switchyard-check-dependency-detail-tests-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suite, "runs");

const sandboxSkip =
	process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")
		? "requires macOS sandbox-exec"
		: false;

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

function fixtureRepo({ packageManifest = null } = {}) {
	const root = tempDir("switchyard-check-dependency-detail-");
	const projectPath = join(root, "project");
	mkdirSync(projectPath);
	writeFileSync(join(projectPath, "a.txt"), "base\n");
	if (packageManifest)
		writeFileSync(join(projectPath, "package.json"), packageManifest);
	git(projectPath, ["init", "-q"]);
	commit(projectPath);
	const promptPath = join(root, "prompt");
	writeFileSync(promptPath, "Change a.txt");
	return { root, projectPath, promptPath };
}

async function run(repo, options = {}, provider = null) {
	let providerCalls = 0;
	const result = await runSimpleTask(
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
				providerCalls += 1;
				if (provider) return provider(context);
				writeFileSync(join(context.worktreePath, "a.txt"), "candidate\n");
				return { success: true, writerLifecycle: "stopped" };
			},
		},
	);
	return { result, providerCalls };
}

test("a candidate-changed manifest refuses as a hard check cause, never a baseline one", {
	skip: nestedSandboxSkip || sandboxSkip,
}, async () => {
	const repo = fixtureRepo({
		packageManifest: JSON.stringify({ name: "fixture", version: "1.0.0" }),
	});
	const { result, providerCalls } = await run(
		repo,
		{
			files: ["a.txt", "package.json"],
			allowManifests: ["package.json"],
			// A node-tool check arms dependency verification without needing
			// an offline npm cache to provision a dependency tree.
			checks: ["node --version"],
		},
		async ({ worktreePath }) => {
			writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
			writeFileSync(
				join(worktreePath, "package.json"),
				JSON.stringify({
					name: "fixture",
					version: "1.0.0",
					dependencies: { evil: "1.0.0" },
				}),
			);
			return { success: true, writerLifecycle: "stopped" };
		},
	);
	strictEqual(providerCalls, 1);
	strictEqual(result.status, "failed");
	strictEqual(result.providerStarted, true);
	strictEqual(result.failurePhase, "checks");
	strictEqual(result.errorKind, "check_failed");
	strictEqual(
		result.providerReliability.causeCode,
		"check_manifest_changed_by_diff",
	);
	strictEqual(result.providerReliability.causeCategory, "check");
	strictEqual(
		classifyAttemptFailure({
			result,
			accountability: result.accountability,
		}).severity,
		"hard",
	);
	const record = await readRun(result.runId);
	const details = record.failureDetails;
	ok(details, "run.json carries failureDetails");
	strictEqual(details.dependencyCheck, "manifest_changed_by_diff");
	strictEqual(details.manifestName, "package.json");
	strictEqual(details.failureReason, "check_dependencies_unverified");
	ok(isPersistentFailureDetails(details));
	strictEqual("dependencyCheck" in record.lastFailure, false);
	strictEqual("manifestName" in record.lastFailure, false);
});

test("an unparseable check records its command sub-cause and position", {
	skip: nestedSandboxSkip || sandboxSkip,
}, async () => {
	const repo = fixtureRepo();
	const { result, providerCalls } = await run(repo, {
		checks: ["echo $(pwd)"],
	});
	strictEqual(providerCalls, 0);
	strictEqual(result.status, "failed");
	strictEqual(result.failurePhase, "prepare");
	strictEqual(result.failureReason, "check_dependencies_unverified");
	strictEqual(
		result.providerReliability.causeCode,
		"check_dependencies_unverified",
	);
	strictEqual(
		classifyAttemptFailure({
			result,
			accountability: result.accountability,
		}).severity,
		"baseline",
	);
	const record = await readRun(result.runId);
	const details = record.failureDetails;
	ok(details, "run.json carries failureDetails");
	strictEqual(details.dependencyCheck, "command_unparsed");
	strictEqual(details.checkIndex, 1);
	strictEqual(details.failureReason, "check_dependencies_unverified");
	ok(isPersistentFailureDetails(details));
});

test("dependency refusal severity is baseline before the provider and hard after", () => {
	for (const phase of ["preflight", "route", "prepare", "baseline"]) {
		const resolved = resolveFailure({
			reason: "check_dependencies_unverified",
			phase,
		});
		strictEqual(resolved.severity, "baseline", phase);
		strictEqual(resolved.causeCode, "check_dependencies_unverified", phase);
	}
	for (const phase of ["execute", "provider", "diff", "checks"]) {
		strictEqual(
			resolveFailure({ reason: "check_dependencies_unverified", phase })
				.severity,
			"hard",
			phase,
		);
	}
	const manifest = resolveFailure({
		reason: "check_manifest_changed_by_diff",
		phase: "checks",
	});
	strictEqual(manifest.causeCode, "check_manifest_changed_by_diff");
	strictEqual(manifest.causeCategory, "check");
	strictEqual(manifest.severity, "hard");
});

test("a routing run stops on the repository refusal cause, not baseline_failed", async () => {
	const cases = [
		{
			causeCode: "check_manifest_changed_by_diff",
			errorKind: "check_failed",
			stopReason: "check_manifest_changed_by_diff",
		},
		{
			causeCode: "check_dependencies_unverified",
			errorKind: "environment_failure",
			stopReason: "check_dependencies_unverified",
		},
	];
	for (const { causeCode, errorKind, stopReason } of cases) {
		const f = fixture({
			"antigravity-claude": {
				status: "failed",
				result: {
					providerReliability: createProviderReliabilityDiagnostic({
						causeCode,
						phase: "check",
					}),
					failureReason: "check_dependencies_unverified",
					failurePhase: "checks",
					errorKind,
				},
			},
		});
		f.deps.resolveTargetIdentity = (id) => ({ targetId: id });
		const outcome = await runSimpleRoutingTask(f.options, f.deps);
		strictEqual(outcome.direction, "stop", causeCode);
		strictEqual(outcome.stopReason, stopReason, causeCode);
		notStrictEqual(outcome.stopReason, "baseline_failed", causeCode);
		strictEqual(
			outcome.classification.severity,
			"hard",
			`${causeCode} severity`,
		);
		strictEqual(outcome.attempts[0].terminal, "skipped", causeCode);
		strictEqual(outcome.attempts[0].reason, "unsafe_failure", causeCode);
		const records = readFailureRecords({ stateRoot: f.deps.stateRoot });
		const stop = records.find((record) => record.recordType === "stop");
		strictEqual(stop.stopReason, stopReason, causeCode);
		notStrictEqual(stop.stopReason, "baseline_failed", causeCode);
		strictEqual(stop.causeCode, causeCode);
		const attempt = records.find((record) => record.recordType === "attempt");
		strictEqual(attempt.severity, "hard", causeCode);
		strictEqual(attempt.reason, "unsafe_failure", causeCode);
		strictEqual(attempt.causeCode, causeCode);
	}
});

test("a pre-provider dependency refusal still stops the run as baseline", async () => {
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			result: {
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "check_dependencies_unverified",
					phase: "prepare",
				}),
				failureReason: "check_dependencies_unverified",
				failurePhase: "prepare",
				errorKind: "environment_failure",
			},
		},
	});
	f.deps.resolveTargetIdentity = (id) => ({ targetId: id });
	const outcome = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(outcome.direction, "stop");
	strictEqual(outcome.stopReason, "baseline_failed");
	strictEqual(outcome.classification.severity, "baseline");
	strictEqual(outcome.attempts[0].terminal, "skipped");
});
