// @test-phase: other
// Differential acceptance against real runners: the reporting rewrite keeps
// each check's exit status, writes its report outside the checkout, and a
// pytest collection error after the change is refused.
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { createDifferentialChecks } from "../src/switchyard/simple/check-differential.mjs";
import { NODE_TEST_REPORTER_URL } from "../src/switchyard/simple/test-report-parse.mjs";
import {
	reportingCommand,
	testRunnerOf,
} from "../src/switchyard/simple/test-runner-argv.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const venv = process.env.SWITCHYARD_TEST_PYTEST_VENV;
const python = venv ? join(venv, "bin", "python") : null;
const noPytest =
	python && existsSync(python) ? false : "SWITCHYARD_TEST_PYTEST_VENV unset";
const SHELL = { kind: "shell" };

// A child node run must not inherit this runner's test context.
function childEnv() {
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	return env;
}

function sh(command, cwd) {
	return spawnSync("/bin/sh", ["-c", command], {
		cwd,
		env: childEnv(),
		encoding: "utf8",
		timeout: 120_000,
	});
}

// Every file under `root`, relative and sorted.
function listing(root) {
	return readdirSync(root, { recursive: true })
		.map((path) => String(path))
		.sort();
}

function pytestCheckout(files) {
	const checkout = tempDir("switchyard-differential-exit-py-");
	mkdirSync(join(checkout, "tests"));
	for (const [path, text] of Object.entries(files))
		writeFileSync(join(checkout, path), text);
	return checkout;
}

const LEGACY_PY =
	"def test_clock():\n    assert 1 == 2\n\ndef test_green():\n    assert True\n";
const MODULE_PY =
	"def test_a():\n    assert True\n\ndef test_b():\n    assert True\n\ndef test_c():\n    assert True\n";

test("the reporting rewrite keeps each pytest exit status and writes only to the runtime", {
	skip: noPytest,
}, () => {
	const command = `${python} -m pytest -q -p no:cacheprovider tests`;
	const runner = testRunnerOf(command);
	for (const [label, files, status] of [
		["passing", { "tests/test_ok.py": "def test_ok():\n    assert True\n" }, 0],
		["failing", { "tests/test_legacy.py": LEGACY_PY }, 1],
		["collection error", { "tests/test_bad.py": "def test_a(:\n" }, 2],
		["no tests", { "tests/helper.py": "VALUE = 1\n" }, 5],
	]) {
		const checkout = pytestCheckout(files);
		const runtime = tempDir("switchyard-differential-exit-runtime-");
		const plain = sh(command, checkout);
		strictEqual(plain.status, status, `${label}: ${plain.stdout}`);
		const before = listing(checkout);
		const reportPath = join(runtime, "report.xml");
		const reporting = sh(
			reportingCommand(runner, {
				reportPath,
				reporter: NODE_TEST_REPORTER_URL,
			}),
			checkout,
		);
		strictEqual(reporting.status, plain.status, label);
		deepStrictEqual(listing(checkout), before, label);
		ok(relative(checkout, reportPath).startsWith(".."), label);
	}
});

test("the reporting rewrite keeps each node --test exit status and writes only to the runtime", () => {
	const command = "node --test tests";
	const runner = testRunnerOf(command);
	for (const [label, text, status] of [
		["passing", 'test("ok", () => {});\n', 0],
		["failing", 'test("bad", () => { throw new Error("no"); });\n', 1],
		["no tests", "", 0],
	]) {
		const checkout = tempDir("switchyard-differential-exit-node-");
		mkdirSync(join(checkout, "tests"));
		writeFileSync(
			join(checkout, "tests", "a.test.mjs"),
			`import { test } from "node:test";\n${text}`,
		);
		const runtime = tempDir("switchyard-differential-exit-runtime-");
		const plain = sh(command, checkout);
		strictEqual(plain.status, status, `${label}: ${plain.stdout}`);
		const before = listing(checkout);
		const reportPath = join(runtime, "report.jsonl");
		const reporting = sh(
			reportingCommand(runner, {
				reportPath,
				reporter: NODE_TEST_REPORTER_URL,
			}),
			checkout,
		);
		strictEqual(reporting.status, plain.status, label);
		deepStrictEqual(listing(checkout), before, label);
		ok(existsSync(reportPath), label);
	}
});

test("a planned report path lives in the checker runtime, never the checkout", () => {
	const runtime = tempDir("switchyard-differential-exit-runtime-");
	const checkout = tempDir("switchyard-differential-exit-checkout-");
	const checks = createDifferentialChecks({ declaredFiles: [] });
	const plan = checks.plan({
		command: "node --test tests",
		execution: SHELL,
		baseRun: true,
		testBaseline: true,
		runtime,
		checkout,
	});
	strictEqual(relative(runtime, plan.reportPath).startsWith(".."), false);
	ok(relative(checkout, plan.reportPath).startsWith(".."));
	ok(plan.shellCommand.includes(plan.reportPath));
});

// Baseline: one unrelated failure, and a module of three passing tests. After
// the change that module no longer imports.
function collectionErrorRun(addopts) {
	const checkout = pytestCheckout({
		"tests/test_legacy.py": LEGACY_PY,
		"tests/test_mod.py": MODULE_PY,
		...(addopts ? { "pytest.ini": `[pytest]\naddopts = ${addopts}\n` } : {}),
	});
	const runtime = tempDir("switchyard-differential-exit-runtime-");
	const command = `${python} -m pytest -q -p no:cacheprovider tests`;
	const checks = createDifferentialChecks({
		declaredFiles: ["tests/test_mod.py"],
	});
	const run = (plan) => {
		const ran = sh(plan.shellCommand, checkout);
		return {
			success: ran.status === 0,
			code: ran.status,
			writerLifecycle: "stopped",
		};
	};
	const args = { command, execution: SHELL, runtime, checkout };
	const baseline = checks.plan({ ...args, baseRun: true, testBaseline: true });
	checks.judge(baseline, command, run(baseline));
	ok(checks.qualifies(command));
	writeFileSync(join(checkout, "tests", "test_mod.py"), "def test_a(:\n");
	const after = checks.plan({ ...args, baseRun: false });
	return checks.judge(after, command, run(after));
}

test("a pytest collection error after the change is refused because the test count dropped", {
	skip: noPytest,
}, () => {
	const judged = collectionErrorRun("--continue-on-collection-errors");
	strictEqual(judged.success, false);
	strictEqual(judged.code, 1);
	strictEqual(judged.differential.verdict, "refused");
	strictEqual(judged.differential.reason, "test_count_dropped");
	strictEqual(judged.differential.baseline.total, 5);
	strictEqual(judged.differential.after.total, 3);
});

test("a pytest collection error that stops the run keeps its strict failure", {
	skip: noPytest,
}, () => {
	const judged = collectionErrorRun(null);
	strictEqual(judged.success, false);
	strictEqual(judged.code, 2);
	strictEqual(judged.differential.verdict, "refused");
	strictEqual(judged.differential.reason, "exit_status_unusable");
});
