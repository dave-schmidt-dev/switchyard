// @test-phase: other
// Differential acceptance through runSimpleTask with the real sandboxed check
// session: the TASKS "red before the change" done-when fixtures.
import { ok, strictEqual } from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { classifyAttemptFailure } from "../src/switchyard/simple/failure-severity.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { git } from "./helpers/check-dry-run-repo.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const suite = tempDir("switchyard-check-differential-run-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suite, "runs");
const sandboxed = existsSync("/usr/bin/sandbox-exec");

const CHECK = "node --test tests/legacy.test.mjs tests/feature.test.mjs";
// Two unrelated tests that already fail on the base tree, and one that passes.
const LEGACY = `import { test } from "node:test";
import { strictEqual } from "node:assert";
test("host clock", () => strictEqual(1, 2));
test("host network", () => strictEqual("a", "b"));
test("still green", () => strictEqual(1, 1));
`;
const FEATURE_PASSING = `import { test } from "node:test";
import { strictEqual } from "node:assert";
import { feature } from "../src/feature.mjs";
test("feature works", () => strictEqual(feature(), 42));
`;

function projectFixture() {
	const root = tempDir("switchyard-check-differential-repo-");
	const projectPath = join(root, "project");
	mkdirSync(join(projectPath, "tests"), { recursive: true });
	mkdirSync(join(projectPath, "src"));
	writeFileSync(join(projectPath, "tests", "legacy.test.mjs"), LEGACY);
	writeFileSync(
		join(projectPath, "src", "feature.mjs"),
		"export const feature = () => 0;\n",
	);
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
	writeFileSync(promptPath, "Make feature() return 42 and test it.");
	return { root, projectPath, promptPath };
}

const implementsFeature = async ({ worktreePath }) => {
	writeFileSync(
		join(worktreePath, "src", "feature.mjs"),
		"export const feature = () => 42;\n",
	);
	writeFileSync(
		join(worktreePath, "tests", "feature.test.mjs"),
		FEATURE_PASSING,
	);
	return { success: true, writerLifecycle: "stopped" };
};

async function runTask(repo, options, provider) {
	let providerCalls = 0;
	const result = await runSimpleTask(
		{
			...repo,
			capability: "standard",
			files: ["src/feature.mjs", "tests/feature.test.mjs"],
			checks: [CHECK],
			repairChecks: false,
			deadlineMs: Date.now() + 240_000,
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
				return provider(context, providerCalls);
			},
		},
	);
	return { result, providerCalls };
}

test("a check that should pass but is red at baseline stops before provider launch", {
	skip: !sandboxed,
}, async () => {
	const { result, providerCalls } = await runTask(
		projectFixture(),
		{ baselineChecks: ["node --test tests/legacy.test.mjs"] },
		implementsFeature,
	);
	strictEqual(providerCalls, 0);
	strictEqual(result.failureReason, "baseline_check_failed");
});

test("pre-existing unrelated failures pass differentially once the targeted test passes", {
	skip: !sandboxed,
}, async () => {
	const { result, providerCalls } = await runTask(
		projectFixture(),
		{},
		implementsFeature,
	);
	strictEqual(providerCalls, 1);
	strictEqual(result.status, "succeeded", JSON.stringify(result.checks));
	const [check] = result.checks;
	strictEqual(check.status, "passed");
	const { differential } = check;
	strictEqual(differential.runner, "node");
	strictEqual(differential.verdict, "accepted");
	strictEqual(differential.reason, null);
	strictEqual(differential.baseline.failedCount, 2);
	strictEqual(differential.after.failedCount, 2);
	strictEqual(differential.after.newFailures.length, 0);
	strictEqual(differential.targeted.total, 1);
	strictEqual(differential.targeted.passed, 1);
	ok(
		differential.baseline.failed.includes("tests/legacy.test.mjs::host clock"),
	);
	ok(existsSync(differential.evidencePath), "the nonzero run kept evidence");
});

test("a candidate that adds a new failure is refused", {
	skip: !sandboxed,
}, async () => {
	const { result, providerCalls } = await runTask(
		projectFixture(),
		{
			files: [
				"src/feature.mjs",
				"tests/feature.test.mjs",
				"tests/legacy.test.mjs",
			],
		},
		async (context) => {
			await implementsFeature(context);
			writeFileSync(
				join(context.worktreePath, "tests", "legacy.test.mjs"),
				LEGACY.replace("strictEqual(1, 1)", "strictEqual(1, 3)"),
			);
			return { success: true, writerLifecycle: "stopped" };
		},
	);
	strictEqual(providerCalls, 1);
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "check_failed");
	const [check] = result.checks;
	strictEqual(check.status, "failed");
	strictEqual(check.differential.verdict, "refused");
	strictEqual(check.differential.reason, "new_failure");
	strictEqual(
		check.differential.after.newFailures[0],
		"tests/legacy.test.mjs::still green",
	);
});

test("an intentional red check stays strict and still waterfalls", {
	skip: !sandboxed,
}, async () => {
	const repo = projectFixture();
	const grep = "grep -q 42 src/feature.mjs";
	const passed = await runTask(repo, { checks: [grep] }, implementsFeature);
	strictEqual(passed.result.status, "succeeded");
	strictEqual(passed.result.checks[0].status, "passed");
	strictEqual(passed.result.checks[0].differential, undefined);

	const missed = await runTask(
		projectFixture(),
		{ checks: [grep] },
		async ({ worktreePath }) => {
			writeFileSync(
				join(worktreePath, "src", "feature.mjs"),
				"export const feature = () => 41;\n",
			);
			return { success: true, writerLifecycle: "stopped" };
		},
	);
	strictEqual(missed.result.failureReason, "check_failed");
	strictEqual(missed.result.checks[0].differential, undefined);
	// check_failed is a soft failure: the routing waterfall tries the next target.
	strictEqual(
		classifyAttemptFailure({
			result: missed.result,
			accountability: missed.result.accountability,
		}).severity,
		"soft",
	);
});
