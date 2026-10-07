import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { join } from "node:path";
import { test } from "node:test";
import {
	FAILURE_REGISTRY,
	resolveFailure,
} from "../src/switchyard/diagnostics/failure-registry.mjs";
import {
	DRY_RUN_CHECK_CAP_MS,
	dryRunAcceptanceChecks,
} from "../src/switchyard/simple/check-dry-run.mjs";
import {
	classifyCheckEnvironmentFailure,
	classifyFailedCheck,
	EVIDENCE_TAIL_BYTES,
} from "../src/switchyard/simple/check-environment.mjs";
import { createSimpleCheckSessions } from "../src/switchyard/simple/check-session.mjs";
import { git, repoFixture, sha } from "./helpers/check-dry-run-repo.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

// Built so the tempdir-hygiene scan does not read these fixture strings as calls.
const MKDTEMP = "mkdtemp";

const suite = tempDir("switchyard-check-dry-run-unit-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suite, "runs");

test("after the provider only exit 126/127 and a Seatbelt deny line classify", () => {
	const post = (check) =>
		classifyFailedCheck({ success: false, ...check }, { preProvider: false });
	strictEqual(post({ code: 126 }), "exec_denied");
	strictEqual(post({ code: 127 }), "tool_missing");
	strictEqual(
		post({ code: 1, output: "Sandbox: sh(4) deny(1) file-write-create /x" }),
		"sandbox_denial",
	);
	// A genuine regression can print any of these, so text alone proves nothing.
	for (const output of [
		"Operation not permitted",
		"xcrun: error: x",
		"xcode-select: error: x",
		"You have not agreed to the Xcode license",
		"unable to read data link",
		"couldNotFindTmpDir",
		`${MKDTEMP}(/x): Operation not permitted`,
	])
		strictEqual(post({ code: 1, stderr: output }), null, output);
	strictEqual(post({ code: 69, output: "see xcodebuild -license" }), null);
	strictEqual(
		classifyCheckEnvironmentFailure({
			exitCode: 1,
			output: "Operation not permitted",
			preProvider: false,
		}),
		null,
	);
});

test("the exit-69 licence rule applies in the dry run", () => {
	const input = { exitCode: 69, output: "see xcodebuild -license" };
	strictEqual(classifyCheckEnvironmentFailure(input), "xcode_toolchain");
	strictEqual(
		classifyFailedCheck({ success: false, code: 69, output: input.output }),
		"xcode_toolchain",
	);
	strictEqual(
		classifyFailedCheck(
			{ success: false, code: 1, output: "Operation not permitted" },
			{ preProvider: true },
		),
		"sandbox_denial",
	);
});

test("a failed check classifies from the evidence tail, never on pass or timeout", () => {
	const failed = { success: false, code: 1 };
	strictEqual(classifyFailedCheck({ success: true, code: 127 }), null);
	strictEqual(classifyFailedCheck(null), null);
	strictEqual(classifyFailedCheck({ ...failed, code: 127 }), "tool_missing");
	strictEqual(
		classifyFailedCheck({ ...failed, code: 127, timedOut: true }),
		null,
	);
	strictEqual(
		classifyFailedCheck({ ...failed, code: 126, silenceTimedOut: true }),
		null,
	);
	strictEqual(
		classifyFailedCheck({ ...failed, stderr: "Operation not permitted" }),
		"sandbox_denial",
	);
	const filler = "x".repeat(EVIDENCE_TAIL_BYTES);
	strictEqual(
		classifyFailedCheck({
			...failed,
			output: `Operation not permitted\n${filler}`,
		}),
		null,
		"a marker beyond the retained tail is not evidence",
	);
	strictEqual(
		classifyFailedCheck({
			...failed,
			output: `${filler}\nOperation not permitted`,
		}),
		"sandbox_denial",
	);
});

test("registry: check_environment_failed is a baseline-severity environment row", () => {
	const row = FAILURE_REGISTRY.get("check_environment_failed");
	strictEqual(row.causeCode, "check_environment_failed");
	strictEqual(row.causeCategory, "environment");
	strictEqual(row.errorKind, "environment_failure");
	strictEqual(row.severity, "baseline");
	strictEqual(row.providerCaused, false);
	deepStrictEqual(
		[...row.detailFields],
		[
			"failureReason",
			"checkIndex",
			"checkIdentity",
			"checkEnvironmentSignature",
			"outputPath",
		],
	);
	for (const phase of ["baseline", "checks"]) {
		const resolved = resolveFailure({
			reason: "check_environment_failed",
			phase,
		});
		strictEqual(resolved.causeCode, "check_environment_failed", phase);
		strictEqual(resolved.severity, "baseline", phase);
		strictEqual(resolved.errorKind, "environment_failure", phase);
	}
});

// -- dryRunAcceptanceChecks (injected runCheck) --------------------------------

const settled = { success: true, code: 0, writerLifecycle: "stopped" };
const failing = (extra) => ({
	success: false,
	code: 1,
	writerLifecycle: "stopped",
	...extra,
});

function dryRun(checks, runCheck, extra = {}) {
	const events = [];
	return {
		events,
		done: dryRunAcceptanceChecks({
			checks,
			runCheck,
			deadlineMs: 10_000_000,
			now: () => 0,
			onProgress: (event) => events.push(event),
			...extra,
		}),
	};
}

test("each dry-run check gets min(remaining, 120 s) and one start and finish event", async () => {
	strictEqual(DRY_RUN_CHECK_CAP_MS, 120_000);
	const budgets = [];
	const run = dryRun(["c-one", "c-two"], async ({ timeoutMs, onProgress }) => {
		budgets.push(timeoutMs);
		onProgress();
		return settled;
	});
	const result = await run.done;
	strictEqual(result.status, "passed");
	deepStrictEqual(budgets, [120_000, 120_000]);
	deepStrictEqual(
		run.events.map(({ event, checkIndex, checkIdentity }) => [
			event,
			checkIndex,
			checkIdentity,
		]),
		[
			["dry_run_check_started", 1, sha("c-one")],
			["dry_run_check_progress", 1, sha("c-one")],
			["dry_run_check_finished", 1, sha("c-one")],
			["dry_run_check_started", 2, sha("c-two")],
			["dry_run_check_progress", 2, sha("c-two")],
			["dry_run_check_finished", 2, sha("c-two")],
		],
	);
	strictEqual(
		run.events.find((event) => event.event === "dry_run_check_finished")
			.checkStatus,
		"passed",
	);
	const short = [];
	await dryRun(
		["c"],
		async ({ timeoutMs }) => {
			short.push(timeoutMs);
			return settled;
		},
		{ deadlineMs: 30_000 },
	).done;
	deepStrictEqual(short, [30_000]);
	const injected = [];
	await dryRun(
		["c"],
		async ({ timeoutMs }) => {
			injected.push(timeoutMs);
			return settled;
		},
		{ capMs: 250 },
	).done;
	deepStrictEqual(injected, [250]);
	for (const capMs of [0, -1, Number.NaN, undefined]) {
		const budgets = [];
		await dryRun(
			["c"],
			async ({ timeoutMs }) => {
				budgets.push(timeoutMs);
				return settled;
			},
			{ capMs },
		).done;
		deepStrictEqual(budgets, [120_000], String(capMs));
	}
});

test("ordinary failures and timeouts proceed; the first environment failure stops", async () => {
	const seen = [];
	const proceed = dryRun(["a", "b", "c"], async ({ command }) => {
		seen.push(command);
		return command === "a"
			? failing({ output: "assertion failed" })
			: failing({
					code: null,
					timedOut: true,
					stderr: "Operation not permitted",
				});
	});
	const ok3 = await proceed.done;
	strictEqual(ok3.status, "passed");
	deepStrictEqual(seen, ["a", "b", "c"]);

	const ran = [];
	const stop = dryRun(["p", "q", "r"], async ({ command }) => {
		ran.push(command);
		return command === "q"
			? failing({
					code: 126,
					signal: "SIGKILL",
					outputPath: "/evidence/0-2.log",
				})
			: settled;
	});
	const result = await stop.done;
	deepStrictEqual(ran, ["p", "q"]);
	strictEqual(result.status, "environment_failed");
	strictEqual(result.checkIndex, 2);
	strictEqual(result.checkIdentity, sha("q"));
	strictEqual(result.signature, "exec_denied");
	strictEqual(result.outputPath, "/evidence/0-2.log");
	strictEqual(result.exitCode, 126);
	strictEqual(result.signal, "SIGKILL");
	strictEqual(result.writerLifecycle, "stopped");
});

test("cancellation, deadline and unconfirmed process groups stop the dry run", async () => {
	const aborted = await dryRun(["a"], async () => settled, {
		signal: { aborted: true },
	}).done;
	strictEqual(aborted.status, "cancelled");
	for (const code of ["cancelled", "deadline_expired"]) {
		const result = await dryRun(["a"], async () => {
			throw Object.assign(new Error(code), { code });
		}).done;
		strictEqual(result.status, code);
	}
	const expired = await dryRun(["a"], async () => settled, {
		deadlineMs: 5,
		now: () => 5,
	}).done;
	strictEqual(expired.status, "deadline_expired");
	const calls = [];
	const unconfirmed = await dryRun(["a", "b"], async ({ command }) => {
		calls.push(command);
		return { ...settled, writerLifecycle: "unavailable" };
	}).done;
	strictEqual(unconfirmed.status, "unconfirmed");
	strictEqual(unconfirmed.writerLifecycle, "unavailable");
	deepStrictEqual(calls, ["a"]);
	await rejects(
		dryRun(["a"], async () => {
			throw Object.assign(new Error("boom"), { code: "other_failure" });
		}).done,
		{ code: "other_failure" },
	);
});

// -- Real check session: the per-call cap shortens a run -----------------------

test("a session check honours a shorter per-call timeout", async () => {
	const repo = repoFixture();
	const session = createSimpleCheckSessions({
		taskRoot: repo.root,
		projectPath: repo.projectPath,
		baseRevision: git(repo.projectPath, ["rev-parse", "HEAD"]),
		baseTree: git(repo.projectPath, ["rev-parse", "HEAD^{tree}"]),
		files: ["a.txt"],
		commands: ["sleep 30"],
		taskId: "dry-run-cap",
		deadlineMs: Date.now() + 120_000,
	});
	try {
		await session.prepare(null, 0);
		const startedAt = Date.now();
		const result = await session.run({ command: "sleep 30", timeoutMs: 400 });
		ok(Date.now() - startedAt < 20_000, "the 400 ms cap ended the check");
		strictEqual(result.success, false);
		strictEqual(result.timedOut, true);
	} finally {
		session.remove();
	}
});
