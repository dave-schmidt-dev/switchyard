// @test-phase: other
import { ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { test } from "node:test";
import {
	isPersistentFailureDetails,
	isPersistentFailureMetadata,
	sanitizeFailureDetails,
} from "../src/switchyard/adapter/exec-error.mjs";
import { getRunRoot, readRun } from "../src/switchyard/run-store/index.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { nestedSandboxSkip } from "./helpers/nested-sandbox.mjs";
import { tempDir, tempDirIn } from "./helpers/tempdir.mjs";

// A deep owned scratch root, built here rather than taken from the ambient
// TMPDIR: every evidence and checker path below it is longer than the generic
// 256-character detail bound, as under the 111-character ship-hook root.
const deep = join(tempDir("switchyard-deep-root-"), "d".repeat(160));
mkdirSync(deep);
process.env.SWITCHYARD_RUN_STORE_ROOT = join(deep, "runs");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";

const GENERIC_DETAIL_MAX_CHARS = 256;
const PATH_REFERENCE_MAX_CHARS = 1024;

function git(path, args) {
	return execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
}

function repoFixture() {
	const root = tempDirIn(deep, "repo-");
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

function run(repo, options) {
	let providerCalls = 0;
	const result = runSimpleTask(
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
			executeProvider: async () => {
				providerCalls += 1;
				return { success: true, writerLifecycle: "stopped" };
			},
		},
	);
	return result.then((value) => ({ result: value, providerCalls }));
}

test("path references keep their own PATH_MAX bound; other strings keep 256", () => {
	const at = (length) => `/${"p".repeat(length - 1)}`;
	for (const field of ["outputPath", "checkExecutable", "hostExecutable"]) {
		for (const length of [
			GENERIC_DETAIL_MAX_CHARS + 1,
			PATH_REFERENCE_MAX_CHARS,
		]) {
			const details = { [field]: at(length) };
			strictEqual(sanitizeFailureDetails(details)?.[field], at(length), field);
			ok(isPersistentFailureDetails(details), field);
		}
		strictEqual(
			sanitizeFailureDetails({ [field]: at(PATH_REFERENCE_MAX_CHARS + 1) }),
			null,
			`${field} over PATH_MAX still drops`,
		);
		strictEqual(
			sanitizeFailureDetails({ [field]: `${at(300)}\nx` }),
			null,
			`${field} with a control character drops`,
		);
	}
	strictEqual(
		sanitizeFailureDetails({ checkExecutable: "relative/bin/xcrun" }),
		null,
	);
	// The generic detail bound is unchanged for every other string field.
	strictEqual(sanitizeFailureDetails({ manifestName: "m".repeat(257) }), null);
	strictEqual(sanitizeFailureDetails({ failureReason: "r".repeat(257) }), null);
});

test("a deep-root baseline failure keeps its openable evidence path", {
	skip: nestedSandboxSkip,
}, async () => {
	const repo = repoFixture();
	const { result, providerCalls } = await run(repo, {
		baselineChecks: [
			"node -e 'process.stdout.write(\"DEEP_ROOT_TAIL\");process.exit(2)'",
		],
	});
	strictEqual(providerCalls, 0);
	strictEqual(result.failureReason, "baseline_check_failed");
	const evidencePath = join(
		getRunRoot(result.runId),
		"check-evidence",
		"0-1.log",
	);
	ok(evidencePath.length > GENERIC_DETAIL_MAX_CHARS, `${evidencePath.length}`);
	strictEqual(result.failureDetails.outputPath, evidencePath);
	const record = await readRun(result.runId);
	strictEqual(record.failureDetails.outputPath, evidencePath);
	ok(isPersistentFailureDetails(record.failureDetails));
	ok(readFileSync(evidencePath, "utf8").includes("DEEP_ROOT_TAIL"));
});

test("a deep checker root keeps both executable references", {
	skip: nestedSandboxSkip,
}, async () => {
	const repo = repoFixture();
	const { result, providerCalls } = await run(repo, {
		checks: ["xcrun definitely-missing-tool-xyz"],
	});
	strictEqual(providerCalls, 0);
	strictEqual(result.failureReason, "check_environment_failed");
	const record = await readRun(result.runId);
	const details = record.failureDetails;
	strictEqual(details.checkEnvironmentSignature, "tool_missing");
	ok(isAbsolute(details.checkExecutable), details.checkExecutable);
	ok(details.checkExecutable.startsWith(repo.root), details.checkExecutable);
	ok(
		details.checkExecutable.length > GENERIC_DETAIL_MAX_CHARS,
		`${details.checkExecutable.length}`,
	);
	strictEqual(basename(details.hostExecutable), "xcrun");
	ok(existsSync(details.outputPath), details.outputPath);
	ok(isPersistentFailureDetails(details));
	ok(record.lastFailure.reason.includes(details.checkExecutable));
	ok(isPersistentFailureMetadata(record.lastFailure));
});
