// @test-phase: other
// Differential acceptance through runSimpleTask with the real sandboxed check
// session: the TASKS "red before the change" done-when fixtures.
import { ok, strictEqual } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readRun } from "../src/switchyard/run-store/index.mjs";
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

const DIFFERENTIAL_NOTE = `judged test by test:\n- \`${CHECK}\``;
const STRICT_NOTE =
	"These acceptance checks already fail on the unmodified checkout, before your change:";

test("pre-existing unrelated failures pass differentially once the targeted test passes", {
	skip: !sandboxed,
}, async () => {
	let prompt = null;
	const { result, providerCalls } = await runTask(
		projectFixture(),
		{},
		async (context) => {
			prompt = context.prompt;
			return implementsFeature(context);
		},
	);
	strictEqual(providerCalls, 1);
	strictEqual(result.status, "succeeded", JSON.stringify(result.checks));
	// The provider heard the differential rule, not the strict one.
	ok(prompt.includes(DIFFERENTIAL_NOTE), prompt);
	ok(!prompt.includes(STRICT_NOTE), prompt);
	// The caller sees how the checks passed without opening run.json.
	strictEqual(result.checkAcceptance, "differential");
	strictEqual(result.toleratedBaselineFailures, 2);
	const { terminalSummary } = await readRun(result.runId);
	strictEqual(terminalSummary.checkAcceptance, "differential");
	strictEqual(terminalSummary.toleratedBaselineFailures, 2);
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

test("a differentially accepted check still passes after an unrelated peer commit advances HEAD", {
	skip: !sandboxed,
}, async () => {
	const repo = projectFixture();
	const { result, providerCalls } = await runTask(repo, {}, async (context) => {
		await implementsFeature(context);
		writeFileSync(join(repo.projectPath, "NOTES.txt"), "peer note\n");
		git(repo.projectPath, ["add", "NOTES.txt"]);
		git(repo.projectPath, [
			"-c",
			"user.name=Peer",
			"-c",
			"user.email=peer@example.invalid",
			"commit",
			"-qm",
			"peer unrelated",
		]);
		return { success: true, writerLifecycle: "stopped" };
	});
	strictEqual(providerCalls, 1);
	// The recheck at the advanced HEAD judges against the original base's
	// failing set; without it the red check would end host_concurrency.
	strictEqual(result.status, "succeeded", JSON.stringify(result));
	strictEqual(result.checks[0].differential.verdict, "accepted");
	strictEqual(result.checkAcceptance, "differential");
	strictEqual(
		readFileSync(join(repo.projectPath, "src", "feature.mjs"), "utf8"),
		"export const feature = () => 42;\n",
	);
	strictEqual(
		readFileSync(join(repo.projectPath, "NOTES.txt"), "utf8"),
		"peer note\n",
	);
});

test("a recheck that passes strictly at the advanced HEAD replaces the differential verdict", {
	skip: !sandboxed,
}, async () => {
	const repo = projectFixture();
	const { result } = await runTask(repo, {}, async (context) => {
		await implementsFeature(context);
		// An unrelated peer commit fixes every pre-existing failure.
		writeFileSync(
			join(repo.projectPath, "tests", "legacy.test.mjs"),
			LEGACY.replace("strictEqual(1, 2)", "strictEqual(1, 1)").replace(
				'strictEqual("a", "b")',
				'strictEqual("a", "a")',
			),
		);
		git(repo.projectPath, ["add", "tests/legacy.test.mjs"]);
		git(repo.projectPath, [
			"-c",
			"user.name=Peer",
			"-c",
			"user.email=peer@example.invalid",
			"commit",
			"-qm",
			"peer fixes legacy",
		]);
		return { success: true, writerLifecycle: "stopped" };
	});
	strictEqual(result.status, "succeeded", JSON.stringify(result));
	strictEqual(result.checks[0].status, "passed");
	strictEqual(result.checks[0].differential, undefined);
	strictEqual(result.checkAcceptance, "strict");
	strictEqual(result.toleratedBaselineFailures, 0);
	strictEqual(
		(await readRun(result.runId)).terminalSummary.checkAcceptance,
		"strict",
	);
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
	strictEqual(result.checkAcceptance, undefined);
	strictEqual(
		(await readRun(result.runId)).terminalSummary.checkAcceptance,
		undefined,
	);
	strictEqual(
		check.differential.after.newFailures[0],
		"tests/legacy.test.mjs::still green",
	);
	// A refused differential keeps the soft check failure that waterfalls.
	strictEqual(
		classifyAttemptFailure({
			result,
			accountability: result.accountability,
		}).severity,
		"soft",
	);
});

test("an intentional red check stays strict and still waterfalls", {
	skip: !sandboxed,
}, async () => {
	const repo = projectFixture();
	const grep = "grep -q 42 src/feature.mjs";
	let prompt = null;
	const passed = await runTask(repo, { checks: [grep] }, async (context) => {
		prompt = context.prompt;
		return implementsFeature(context);
	});
	strictEqual(passed.result.status, "succeeded");
	strictEqual(passed.result.checks[0].status, "passed");
	strictEqual(passed.result.checks[0].differential, undefined);
	strictEqual(passed.result.checkAcceptance, "strict");
	strictEqual(passed.result.toleratedBaselineFailures, 0);
	strictEqual(
		(await readRun(passed.result.runId)).terminalSummary.checkAcceptance,
		"strict",
	);
	// A red check that is not a test runner keeps the strict wording.
	ok(prompt.includes(`${STRICT_NOTE}\n- \`${grep}\``), prompt);
	ok(!prompt.includes("judged test by test"), prompt);

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
