import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
	chmodSync,
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isPersistentFailureMetadata } from "../src/switchyard/adapter/exec-error.mjs";
import { readEvents, readRun } from "../src/switchyard/run-store/index.mjs";
import {
	CHECK_ENVIRONMENT_SIGNATURES,
	classifyCheckEnvironmentFailure,
} from "../src/switchyard/simple/check-environment.mjs";
import { classifyAttemptFailure } from "../src/switchyard/simple/failure-severity.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { repoFixture, sha } from "./helpers/check-dry-run-repo.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

// Built so the tempdir-hygiene scan does not read these fixture strings as calls.
const MKDTEMP = "mkdtemp";

const suite = tempDir("switchyard-check-dry-run-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suite, "runs");

// -- Classifier: one case per signature, null for ordinary failures ------------

test("classifier returns exactly one signature per contract case", () => {
	const cases = [
		["exec_denied", { exitCode: 126 }],
		["tool_missing", { exitCode: 127 }],
		[
			"sandbox_denial",
			{ exitCode: 1, output: "/bin/sh: ./x: Operation not permitted\n" },
		],
		[
			"sandbox_denial",
			{ exitCode: 1, output: "Sandbox: sh(41) deny(1) file-write-create /x\n" },
		],
		[
			"xcode_toolchain",
			{ exitCode: 1, output: "xcode-select: error: no developer tools\n" },
		],
		["xcode_toolchain", { exitCode: 1, output: "xcrun: error: invalid\n" }],
		[
			"xcode_toolchain",
			{ exitCode: 1, output: "You have not agreed to the Xcode license." },
		],
		[
			"xcode_toolchain",
			{ exitCode: 1, output: "error: unable to read data link /x" },
		],
		[
			"xcode_toolchain",
			{ exitCode: 69, output: "Agree to the Xcode license: sudo xcodebuild" },
		],
		[
			"xcode_toolchain",
			{ exitCode: 69, output: "run sudo xcodebuild -license" },
		],
		[
			"xcode_toolchain",
			{ exitCode: 69, output: "agreed to the Xcode license" },
		],
		["tmp_write_denied", { exitCode: 1, output: "couldNotFindTmpDir\n" }],
		[
			"tmp_write_denied",
			{ exitCode: 1, output: `${MKDTEMP}(/x/T/abc): Operation not permitted` },
		],
		[
			"tmp_write_denied",
			{ exitCode: 1, output: `${MKDTEMP}(/x/T/abc) is not permitted` },
		],
	];
	for (const [expected, input] of cases) {
		strictEqual(
			classifyCheckEnvironmentFailure(input),
			expected,
			JSON.stringify(input),
		);
		ok(CHECK_ENVIRONMENT_SIGNATURES.includes(expected));
	}
	deepStrictEqual(
		new Set(cases.map(([signature]) => signature)),
		new Set(CHECK_ENVIRONMENT_SIGNATURES),
	);
});

test("classifier stays conservative: ordinary failures return null", () => {
	const none = [
		{ exitCode: 1, output: "ModuleNotFoundError: No module named x\n" },
		{ exitCode: 1, output: "ImportError: No module named 'yaml'" },
		{ exitCode: 1, output: "cat: x.txt: No such file or directory\n" },
		{ exitCode: 1, output: "" },
		{ exitCode: 2, output: "AssertionError: expected 1 to equal 2\n" },
		{ exitCode: 69, output: "service unavailable" },
		{ exitCode: 1, output: "function deny(user) { return true }" },
		{ exitCode: 1, output: "deny(user) and allow(admin)" },
		{ exitCode: null, output: "killed" },
		{ exitCode: "126", output: "" },
		{ exitCode: 300, output: "" },
		{ exitCode: -1, output: "" },
		{ exitCode: null, signal: "SIGKILL", output: "" },
		{},
		undefined,
	];
	for (const input of none)
		strictEqual(classifyCheckEnvironmentFailure(input), null, String(input));
	// Exit-code rules beat message text, and message rules need no exit code.
	strictEqual(
		classifyCheckEnvironmentFailure({
			exitCode: 127,
			output: "No module named x",
		}),
		"tool_missing",
	);
	strictEqual(
		classifyCheckEnvironmentFailure({
			exitCode: null,
			output: Buffer.from("Operation not permitted"),
		}),
		"sandbox_denial",
	);
});

// -- runSimpleTask with the real sandboxed check session ------------------------

const candidateProvider = async ({ worktreePath }) => {
	writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
	return { success: true, writerLifecycle: "stopped" };
};

async function runTask(
	repo,
	options = {},
	provider = candidateProvider,
	extra,
) {
	let providerCalls = 0;
	const events = [];
	const result = await runSimpleTask(
		{
			...repo,
			capability: "standard",
			files: ["a.txt"],
			checks: ["grep -q candidate a.txt"],
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
			onStatus: (event) => events.push(event),
			executeProvider: async (context) => {
				providerCalls += 1;
				return provider(context, providerCalls);
			},
			...extra,
		},
	);
	return { result, providerCalls, events };
}

const checkerDirectories = (root) =>
	readdirSync(root, { recursive: true }).filter((path) =>
		/(^|\/)checker-[^/]+$/u.test(path),
	);

async function milestones(runId) {
	return (await readEvents(runId))
		.filter((event) => event.milestone?.startsWith("dry_run_check_"))
		.map((event) => [event.milestone, event.checkIndex]);
}

test("a check that execs a denied path fails before any provider starts", async () => {
	const repo = repoFixture();
	const denied = join(tempDir("switchyard-check-dry-run-denied-"), "tool");
	writeFileSync(denied, "#!/bin/sh\nexit 0\n");
	chmodSync(denied, 0o755);
	const command = `sh -c "${denied}"`;
	const { result, providerCalls, events } = await runTask(repo, {
		baselineChecks: ["test -f a.txt"],
		checks: [command],
	});
	strictEqual(providerCalls, 0);
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "check_environment_failed");
	strictEqual(result.failurePhase, "baseline");
	strictEqual(result.errorKind, "environment_failure");
	strictEqual(result.providerStarted, false);
	strictEqual(result.providerReliability.causeCode, "check_environment_failed");
	strictEqual(result.providerReliability.causeCategory, "environment");
	strictEqual(result.providerReliability.baselineStatus, "passed");
	strictEqual(
		classifyAttemptFailure({ result, accountability: result.accountability })
			.severity,
		"baseline",
	);
	const run = await readRun(result.runId);
	const details = run.failureDetails;
	strictEqual(details.failureReason, "check_environment_failed");
	strictEqual(details.checkIndex, 1);
	strictEqual(details.checkIdentity, sha(command));
	strictEqual(details.checkEnvironmentSignature, "exec_denied");
	ok(
		/\/check-evidence\/0-\d+\.log$/u.test(details.outputPath),
		details.outputPath,
	);
	ok(existsSync(details.outputPath));
	strictEqual(statSync(details.outputPath).mode & 0o777, 0o600);
	ok(readFileSync(details.outputPath, "utf8").includes("not permitted"));
	strictEqual(run.lastFailure.providerReliability.phase, "baseline");
	ok(isPersistentFailureMetadata(run.lastFailure));
	deepStrictEqual(await milestones(result.runId), [
		["dry_run_check_started", 1],
		["dry_run_check_finished", 1],
	]);
	ok(
		events.some((event) => event.milestone === "dry_run_check_started"),
		"live status reports each dry-run check",
	);
	deepStrictEqual(checkerDirectories(repo.root), []);
});

test("each environment signature fails the attempt with its own evidence", async () => {
	for (const [signature, check] of [
		["tool_missing", 'sh -c "exit 127"'],
		["sandbox_denial", `sh -c "echo Operation not permitted >&2; exit 1"`],
		["xcode_toolchain", `sh -c "echo xcrun: error: bad >&2; exit 1"`],
	]) {
		const repo = repoFixture();
		const { result, providerCalls } = await runTask(repo, { checks: [check] });
		strictEqual(providerCalls, 0, signature);
		strictEqual(result.failureReason, "check_environment_failed", signature);
		const details = (await readRun(result.runId)).failureDetails;
		strictEqual(details.checkEnvironmentSignature, signature);
		ok(existsSync(details.outputPath), signature);
		deepStrictEqual(checkerDirectories(repo.root), [], signature);
	}
});

test("a check that fails on the base tree for an ordinary reason proceeds to the provider", async () => {
	const repo = repoFixture();
	const { result, providerCalls } = await runTask(repo);
	strictEqual(providerCalls, 1);
	strictEqual(result.status, "succeeded");
	strictEqual(result.checks[0].status, "passed");
	deepStrictEqual(await milestones(result.runId), [
		["dry_run_check_started", 1],
		["dry_run_check_finished", 1],
	]);
	const finished = (await readEvents(result.runId)).find(
		(event) => event.milestone === "dry_run_check_finished",
	);
	strictEqual(finished.checkStatus, "failed");
	deepStrictEqual(checkerDirectories(repo.root), []);
});

test("a failed baseline never reaches the dry run", async () => {
	const repo = repoFixture();
	const { result, providerCalls } = await runTask(repo, {
		baselineChecks: ["sh -c 'exit 1'"],
		checks: ['sh -c "exit 127"'],
	});
	strictEqual(providerCalls, 0);
	strictEqual(result.failureReason, "baseline_check_failed");
	deepStrictEqual(await milestones(result.runId), []);
	deepStrictEqual(checkerDirectories(repo.root), []);
});

test("cancelling during the dry run launches no provider and leaves no checker", async () => {
	const repo = repoFixture();
	const controller = new AbortController();
	const { result, providerCalls } = await runTask(
		repo,
		{ checks: ["sleep 20"] },
		candidateProvider,
		{
			signal: controller.signal,
			onStatus: (event) => {
				if (event.milestone === "dry_run_check_started") controller.abort();
			},
		},
	);
	strictEqual(providerCalls, 0);
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "provider_cancelled");
	strictEqual(result.failurePhase, "checks");
	strictEqual(result.providerReliability.causeCode, "cancelled");
	deepStrictEqual(checkerDirectories(repo.root), []);
});

test("a check that breaks only after the provider is an environment failure, not a repair", async () => {
	const repo = repoFixture();
	const command = `sh -c "grep -q candidate a.txt && exit 127; exit 0"`;
	const { result, providerCalls } = await runTask(
		repo,
		{ checks: [command], repairChecks: true },
		candidateProvider,
	);
	strictEqual(
		providerCalls,
		1,
		"no repair provider runs for an environment fault",
	);
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "check_environment_failed");
	strictEqual(result.failurePhase, "checks");
	strictEqual(result.providerReliability.causeCode, "check_environment_failed");
	strictEqual(result.providerReliability.repairStatus, "ineligible");
	strictEqual(
		classifyAttemptFailure({ result, accountability: result.accountability })
			.severity,
		"baseline",
	);
	const details = (await readRun(result.runId)).failureDetails;
	strictEqual(details.checkEnvironmentSignature, "tool_missing");
	strictEqual(details.checkIndex, 1);
	strictEqual(details.checkIdentity, sha(command));
	ok(/\/check-evidence\/1-1\.log$/u.test(details.outputPath));
	ok(existsSync(details.outputPath));
	deepStrictEqual(checkerDirectories(repo.root), []);
});

test("an ordinary post-provider check failure keeps its own code", async () => {
	const repo = repoFixture();
	const { result, providerCalls } = await runTask(repo, {
		checks: ["grep -q never-present a.txt"],
	});
	strictEqual(providerCalls, 1);
	strictEqual(result.failureReason, "check_failed");
	strictEqual(result.providerReliability.causeCode, "acceptance_check_failed");
	strictEqual(
		(await readRun(result.runId)).failureDetails.checkEnvironmentSignature,
		undefined,
	);
});

test("a post-provider check that only prints a sandbox message is an ordinary failure", async () => {
	const repo = repoFixture();
	const command = `sh -c "grep -q candidate a.txt && { echo Operation not permitted >&2; exit 1; }; exit 0"`;
	const { result, providerCalls } = await runTask(repo, { checks: [command] });
	strictEqual(providerCalls, 1);
	strictEqual(result.failureReason, "check_failed");
	strictEqual(result.providerReliability.causeCode, "acceptance_check_failed");
	strictEqual(
		(await readRun(result.runId)).failureDetails.checkEnvironmentSignature,
		undefined,
	);
});

test("a dry-run check that outlives its cap times out alone and the task proceeds", async () => {
	const repo = repoFixture();
	const stamps = {};
	const command = `sh -c "grep -q candidate a.txt || sleep 60"`;
	const startedAt = Date.now();
	const { result, providerCalls } = await runTask(
		repo,
		{ checks: [command], deadlineMs: Date.now() + 600_000 },
		candidateProvider,
		{
			dryRunCheckCapMs: 600,
			onStatus: (event) => {
				if (event.milestone?.startsWith("dry_run_check_"))
					stamps[event.milestone] = Date.now();
			},
		},
	);
	ok(Date.now() - startedAt < 30_000, "the 60 s sleep was cut by the cap");
	ok(
		stamps.dry_run_check_finished - stamps.dry_run_check_started < 20_000,
		"the dry-run check ended on its own cap, long before the 60 s sleep",
	);
	strictEqual(providerCalls, 1);
	strictEqual(result.status, "succeeded");
	const finished = (await readEvents(result.runId)).find(
		(event) => event.milestone === "dry_run_check_finished",
	);
	strictEqual(finished.checkStatus, "failed");
	deepStrictEqual(checkerDirectories(repo.root), []);
});
