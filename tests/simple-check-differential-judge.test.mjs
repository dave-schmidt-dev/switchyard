// @test-phase: other
// Differential acceptance judgement: the comparison rule and the per-session
// baseline and candidate state machine, including a real pytest run.
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	compareTestRuns,
	createDifferentialChecks,
	RECORDED_ID_CHARS,
	RECORDED_IDS,
} from "../src/switchyard/simple/check-differential.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

function nodeLines(entries, end = { end: true, count: entries.length }) {
	return `${[...entries, end].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

// -- the comparison rule --------------------------------------------------------

const runOf = (entries) =>
	new Map(
		Object.entries(entries).map(([id, status]) => [
			id,
			{ status, file: id.split("::")[0] },
		]),
	);
const BASELINE = runOf({
	"tests/legacy.py::clock": "failed",
	"tests/legacy.py::green": "passed",
	"tests/legacy.py::platform": "skipped",
});
const DECLARED = ["tests/feature.py", "src/feature.py"];

function verdict(after) {
	return compareTestRuns({
		baseline: BASELINE,
		after: runOf(after),
		declaredFiles: DECLARED,
	});
}

test("the task's own passing test with only pre-existing failures is accepted", () => {
	const result = verdict({
		"tests/legacy.py::clock": "failed",
		"tests/legacy.py::green": "passed",
		"tests/legacy.py::platform": "skipped",
		"tests/feature.py::works": "passed",
	});
	deepStrictEqual(result, {
		accepted: true,
		reason: null,
		newFailures: [],
		targeted: { total: 1, passed: 1 },
	});
});

test("each guard rail refuses with its own reason", () => {
	const base = {
		"tests/legacy.py::clock": "failed",
		"tests/legacy.py::green": "passed",
		"tests/legacy.py::platform": "skipped",
		"tests/feature.py::works": "passed",
	};
	const cases = [
		[{ ...base, "tests/legacy.py::green": "failed" }, "new_failure"],
		[{ ...base, "tests/feature.py::edge": "failed" }, "new_failure"],
		[{ ...base, "tests/legacy.py::platform": "failed" }, "new_failure"],
		[
			Object.fromEntries(
				Object.entries(base).filter(([id]) => !id.endsWith("::green")),
			),
			"baseline_test_missing",
		],
		[
			{
				"tests/legacy.py::clock": "failed",
				"tests/feature.py::works": "passed",
			},
			"test_count_dropped",
		],
		[{ ...base, "tests/legacy.py::clock": "skipped" }, "baseline_test_skipped"],
		[{ ...base, "tests/legacy.py::green": "todo" }, "baseline_test_skipped"],
		[{ ...base, "tests/legacy.py::clock": "passed" }, "no_failures_reported"],
		[
			{
				"tests/legacy.py::clock": "failed",
				"tests/legacy.py::green": "passed",
				"tests/legacy.py::platform": "skipped",
			},
			"no_targeted_tests",
		],
		[{ ...base, "tests/feature.py::works": "skipped" }, "no_targeted_tests"],
		[
			{ ...base, "tests/feature.py::later": "skipped" },
			"targeted_test_not_passed",
		],
	];
	for (const [after, reason] of cases) {
		const result = verdict(after);
		strictEqual(result.accepted, false, reason);
		strictEqual(result.reason, reason, JSON.stringify(after));
	}
});

test("a declared file's baseline failure must now pass; its pre-existing skip may stay", () => {
	const baseline = runOf({
		"tests/feature.py::old": "failed",
		"tests/feature.py::mac_only": "skipped",
		"tests/legacy.py::clock": "failed",
	});
	const still = compareTestRuns({
		baseline,
		after: runOf({
			"tests/feature.py::old": "failed",
			"tests/feature.py::mac_only": "skipped",
			"tests/legacy.py::clock": "failed",
			"tests/feature.py::new": "passed",
		}),
		declaredFiles: DECLARED,
	});
	strictEqual(still.reason, "targeted_test_not_passed");
	const fixed = compareTestRuns({
		baseline,
		after: runOf({
			"tests/feature.py::old": "passed",
			"tests/feature.py::mac_only": "skipped",
			"tests/legacy.py::clock": "failed",
		}),
		declaredFiles: ["./tests/feature.py"],
	});
	deepStrictEqual(fixed, {
		accepted: true,
		reason: null,
		newFailures: [],
		targeted: { total: 2, passed: 1 },
	});
});

// -- per-session state machine --------------------------------------------------

const SHELL = { kind: "shell" };

function session(declaredFiles = ["tests/feature.test.mjs"]) {
	const runtime = tempDir("switchyard-differential-runtime-");
	const checkout = tempDir("switchyard-differential-checkout-");
	const checks = createDifferentialChecks({ declaredFiles });
	return {
		checks,
		runtime,
		checkout,
		plan: (command, extra = {}) =>
			checks.plan({
				command,
				execution: SHELL,
				baseRun: false,
				testBaseline: false,
				runtime,
				checkout,
				...extra,
			}),
	};
}

const failedRun = { success: false, code: 1, writerLifecycle: "stopped" };
const entry = (checkout, name, status, file = "tests/legacy.test.mjs") => ({
	path: [name],
	file: `${checkout}/${file}`,
	type: "test",
	status,
});

function captureBaseline(s, command, entries, result = failedRun) {
	const plan = s.plan(command, { baseRun: true, testBaseline: true });
	if (plan?.reportPath) writeFileSync(plan.reportPath, nodeLines(entries));
	return { plan, judged: s.checks.judge(plan, command, result) };
}

const CMD = "node --test tests";

test("only the dry run's base-tree run of a test-runner check is rewritten", () => {
	const s = session();
	strictEqual(
		s.plan("grep -q x a", { baseRun: true, testBaseline: true }),
		null,
	);
	strictEqual(s.plan(CMD, { baseRun: true, testBaseline: false }), null);
	strictEqual(
		s.plan(CMD, {
			baseRun: true,
			testBaseline: true,
			execution: { kind: "local" },
		}),
		null,
	);
	const plan = s.plan(CMD, { baseRun: true, testBaseline: true });
	strictEqual(plan.phase, "baseline");
	ok(plan.shellCommand.startsWith("node --test-reporter=spec "));
	ok(existsSync(plan.shellCommand.match(/'--test-reporter=([^']+)'/u)[1]));
	// No baseline captured yet: a candidate run is unchanged.
	strictEqual(s.plan(CMD), null);
});

test("a green baseline keeps the check strict with no record", () => {
	const s = session();
	const { judged } = captureBaseline(s, CMD, [], {
		success: true,
		code: 0,
		writerLifecycle: "stopped",
	});
	strictEqual(judged.success, true);
	strictEqual(s.plan(CMD), null);
});

test("a red baseline that could not be captured records why the check stayed strict", () => {
	for (const [result, write] of [
		[{ ...failedRun, code: 2 }, true],
		[{ ...failedRun, timedOut: true }, true],
		[{ ...failedRun, signal: "SIGKILL" }, true],
		[failedRun, false],
	]) {
		const s = session();
		const plan = s.plan(CMD, { baseRun: true, testBaseline: true });
		if (write)
			writeFileSync(
				plan.reportPath,
				nodeLines([entry(s.checkout, "a", "failed")]),
			);
		strictEqual(s.checks.judge(plan, CMD, result), result);
		const after = s.plan(CMD);
		strictEqual(after.shellCommand, null);
		deepStrictEqual(s.checks.judge(after, CMD, failedRun).differential, {
			runner: "node",
			verdict: "refused",
			reason: "baseline_unavailable",
		});
		const pass = { success: true, code: 0 };
		strictEqual(s.checks.judge(after, CMD, pass), pass);
	}
});

test("an ineligible runner that is red at baseline records its reason", () => {
	const s = session();
	const command = "swift test --disable-sandbox";
	const { plan } = captureBaseline(s, command, []);
	strictEqual(plan.shellCommand, null);
	const after = s.plan(command);
	deepStrictEqual(s.checks.judge(after, command, failedRun).differential, {
		runner: "swift",
		verdict: "refused",
		reason: "unsupported_runner",
	});
});

function acceptedSession() {
	const s = session();
	captureBaseline(s, CMD, [
		entry(s.checkout, "clock", "failed"),
		entry(s.checkout, "green", "passed"),
	]);
	return s;
}

test("a candidate run is accepted only after a clean report against the baseline", () => {
	const s = acceptedSession();
	const plan = s.plan(CMD);
	strictEqual(plan.phase, "after");
	writeFileSync(
		plan.reportPath,
		nodeLines([
			entry(s.checkout, "clock", "failed"),
			entry(s.checkout, "green", "passed"),
			entry(s.checkout, "works", "passed", "tests/feature.test.mjs"),
		]),
	);
	const judged = s.checks.judge(plan, CMD, failedRun);
	strictEqual(judged.success, true);
	strictEqual(judged.code, 1, "the real exit code is kept");
	deepStrictEqual(judged.differential, {
		runner: "node",
		verdict: "accepted",
		reason: null,
		baseline: {
			total: 2,
			failedCount: 1,
			failed: ["tests/legacy.test.mjs::clock"],
		},
		after: {
			total: 3,
			failedCount: 1,
			failed: ["tests/legacy.test.mjs::clock"],
			newFailures: [],
		},
		targeted: { total: 1, passed: 1 },
	});
	// A strict pass stays a plain pass.
	const green = { success: true, code: 0 };
	strictEqual(s.checks.judge(s.plan(CMD), CMD, green), green);
});

test("a candidate run that cannot be judged keeps its strict failure", () => {
	const cases = [
		[{ ...failedRun, code: 127 }, "environment_failure"],
		[{ ...failedRun, diagnosticCode: "x" }, "environment_failure"],
		[{ ...failedRun, timedOut: true }, "exit_status_unusable"],
		[{ ...failedRun, silenceTimedOut: true }, "exit_status_unusable"],
		[{ ...failedRun, code: 2 }, "exit_status_unusable"],
		[failedRun, "report_unavailable"],
	];
	for (const [result, reason] of cases) {
		const s = acceptedSession();
		const judged = s.checks.judge(s.plan(CMD), CMD, result);
		strictEqual(judged.success, false, reason);
		strictEqual(judged.differential.reason, reason);
		strictEqual(judged.differential.baseline.failedCount, 1);
	}
});

test("recorded ids are bounded, redacted and free of control characters", () => {
	const s = session();
	const many = Array.from({ length: 30 }, (_, index) =>
		entry(s.checkout, `legacy ${String(index).padStart(2, "0")}`, "failed"),
	);
	const secret = entry(
		s.checkout,
		"leaks sk-abcdefghijklmnop\u0007 token",
		"failed",
	);
	const long = entry(s.checkout, "x".repeat(400), "failed");
	captureBaseline(s, CMD, [...many, secret, long]);
	const plan = s.plan(CMD);
	writeFileSync(plan.reportPath, nodeLines([...many, secret, long]));
	const { differential } = s.checks.judge(plan, CMD, failedRun);
	strictEqual(differential.reason, "no_targeted_tests");
	strictEqual(differential.baseline.failedCount, 32);
	strictEqual(differential.baseline.failed.length, RECORDED_IDS);
	ok(
		differential.baseline.failed.every((id) => id.length <= RECORDED_ID_CHARS),
	);
	const all = JSON.stringify(differential);
	ok(!all.includes("sk-abcdefghijklmnop"));
	ok(!all.includes("\\u0007"));
	ok(all.includes("[REDACTED]"));
});

test("the host never writes the reporter through a link planted in the runtime", () => {
	const s = session();
	const target = join(s.runtime, "target.txt");
	writeFileSync(target, "host file");
	symlinkSync(target, join(s.runtime, "sy-node-test-reporter-1.mjs"));
	const plan = s.plan(CMD, { baseRun: true, testBaseline: true });
	strictEqual(plan.shellCommand, null);
	strictEqual(plan.reason, "baseline_unavailable");
	strictEqual(readFileSync(target, "utf8"), "host file");
});

// -- real pytest ------------------------------------------------------------------

const venv = process.env.SWITCHYARD_TEST_PYTEST_VENV;
const python = venv ? join(venv, "bin", "python") : null;

test("real pytest output with an addopts -x is captured whole and judged", {
	skip:
		python && existsSync(python) ? false : "SWITCHYARD_TEST_PYTEST_VENV unset",
}, () => {
	const checkout = tempDir("switchyard-differential-pytest-");
	const runtime = tempDir("switchyard-differential-pytest-runtime-");
	mkdirSync(join(checkout, "tests"));
	writeFileSync(join(checkout, "pytest.ini"), "[pytest]\naddopts = -x\n");
	writeFileSync(
		join(checkout, "tests", "test_legacy.py"),
		"def test_clock():\n    assert 1 == 2\n\ndef test_green():\n    assert True\n",
	);
	const command = `${python} -m pytest -q -p no:cacheprovider tests`;
	const checks = createDifferentialChecks({
		declaredFiles: ["tests/test_feature.py"],
	});
	const run = (plan) => {
		const ran = spawnSync("/bin/sh", ["-c", plan.shellCommand], {
			cwd: checkout,
			encoding: "utf8",
			timeout: 120_000,
		});
		return { success: ran.status === 0, code: ran.status, output: ran.stdout };
	};
	const args = { command, execution: SHELL, runtime, checkout };
	const baseline = checks.plan({ ...args, baseRun: true, testBaseline: true });
	checks.judge(baseline, command, run(baseline));
	writeFileSync(
		join(checkout, "tests", "test_feature.py"),
		"def test_feature():\n    assert True\n",
	);
	const after = checks.plan({ ...args, baseRun: false });
	const judged = checks.judge(after, command, run(after));
	strictEqual(judged.success, true, JSON.stringify(judged.differential));
	deepStrictEqual(judged.differential.baseline, {
		total: 2,
		failedCount: 1,
		failed: ["tests/test_legacy.py::tests.test_legacy::test_clock"],
	});
	strictEqual(judged.differential.after.total, 3);
	deepStrictEqual(judged.differential.targeted, { total: 1, passed: 1 });
});
