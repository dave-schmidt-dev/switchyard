// @test-phase: other
// Differential acceptance inputs: test-runner argv recognition, the reporting
// command, and report reading and parsing.
import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { spawnSync } from "node:child_process";
import {
	linkSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	NODE_TEST_REPORTER_URL,
	nodeTestJsonReporter,
	parseNodeTestReport,
	parsePytestJunit,
	readReportFile,
} from "../src/switchyard/simple/test-report-parse.mjs";
import {
	reportingCommand,
	testRunnerOf,
} from "../src/switchyard/simple/test-runner-argv.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

// -- argv recognition -----------------------------------------------------------

test("pytest, python -m pytest and node --test are eligible test-runner checks", () => {
	for (const [command, runner] of [
		["pytest", "pytest"],
		["pytest -q tests/test_a.py", "pytest"],
		[".venv/bin/pytest -q tests/test_a.py::TestK::test_m", "pytest"],
		[".venv/bin/python -m pytest -q tests", "pytest"],
		["python3.12 -m pytest -k fast -m unit --tb=short -rA tests", "pytest"],
		["python3 -m pytest -p no:cacheprovider -n auto tests/", "pytest"],
		["node --test", "node"],
		["node --test tests/a.test.mjs tests/b.test.mjs", "node"],
		["node --test --test-concurrency=2 --test-timeout=600000 tests", "node"],
	]) {
		const plan = testRunnerOf(command);
		strictEqual(plan?.runner, runner, command);
		strictEqual(plan.eligible, true, command);
		strictEqual(plan.reason, null, command);
	}
});

test("swift test is recognized but stays strict", () => {
	const plan = testRunnerOf(
		"swift test --disable-sandbox --scratch-path .sy/b --cache-path .sy/c",
	);
	strictEqual(plan.runner, "swift");
	strictEqual(plan.eligible, false);
	strictEqual(plan.reason, "unsupported_runner");
});

test("flags that truncate, depend on state or collide with the reporter stay strict", () => {
	for (const command of [
		"pytest -x tests",
		"pytest --exitfirst tests",
		"pytest --maxfail=1 tests",
		"pytest --lf tests",
		"pytest --sw tests",
		"pytest --junitxml=out.xml tests",
		"pytest -o addopts= tests",
		"pytest -p xdist tests",
		"pytest -k",
		"pytest /abs/tests",
		"pytest ../outside",
		"pytest --ignore=/abs",
		"node --test --test-reporter=dot tests",
		"node --test --test-randomize tests",
		"node --test --test-rerun-failures=state.json tests",
		"node --test --experimental-test-coverage tests",
		"node --test --watch tests",
	]) {
		const plan = testRunnerOf(command);
		strictEqual(plan?.eligible, false, command);
		strictEqual(plan.reason, "unsupported_arguments", command);
	}
});

test("anything that is not a plain test-runner argv is not a test-runner check", () => {
	for (const command of [
		"grep -q symbol src/a.py",
		"npm test",
		"node scripts/check.mjs",
		"python -m unittest",
		'pytest -k "a and b"',
		"cd sub && pytest",
		"pytest tests | tee out",
		"CI=1 pytest tests",
		"pytest $(cat list)",
		"uv run pytest",
		"",
	]) {
		strictEqual(testRunnerOf(command), null, command);
	}
});

test("the reporting command only adds reporter flags, quoted for the shell", () => {
	const reportPath = "/tmp/run time/it's/report.xml";
	strictEqual(
		reportingCommand(testRunnerOf("pytest -q tests"), { reportPath }),
		`pytest -q tests '--junitxml=/tmp/run time/it'\\''s/report.xml' -o junit_family=xunit1 --maxfail=0`,
	);
	strictEqual(
		reportingCommand(testRunnerOf("node --test tests/a.test.mjs"), {
			reportPath: "/r/out.jsonl",
			reporter: "/r/rep.mjs",
		}),
		"node --test-reporter=spec --test-reporter-destination=stdout '--test-reporter=/r/rep.mjs' '--test-reporter-destination=/r/out.jsonl' --test tests/a.test.mjs",
	);
	throws(() =>
		reportingCommand(testRunnerOf("swift test"), { reportPath: "/r/x" }),
	);
});

// -- report parsing -------------------------------------------------------------

// Captured from pytest 9.1 with -o junit_family=xunit1 (bodies trimmed).
const PYTEST_XML = `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="1" failures="2" skipped="2" tests="7" time="0.012" hostname="h"><testcase classname="tests.test_a" name="test_ok" file="tests/test_a.py" line="1" time="0.000" /><testcase classname="tests.test_a" name="test_bad" file="tests/test_a.py" line="3" time="0.000"><failure message="assert 1 == 2">def test_bad():
&gt;       assert 1 == 2
E       assert 1 == 2</failure></testcase><testcase classname="tests.test_a" name="test_skip" file="tests/test_a.py" line="5" time="0.000"><skipped type="pytest.skip" message="x">tests/test_a.py:6: x</skipped></testcase><testcase classname="tests.test_a" name="test_xf" file="tests/test_a.py" line="8" time="0.000"><skipped type="pytest.xfail" message="" /></testcase><testcase classname="tests.test_a" name="test_p[a&amp;b &lt;1&gt;]" file="tests/test_a.py" line="11" time="0.000" /><testcase classname="tests.test_a.TestK" name="test_m" file="tests/test_a.py" line="15" time="0.000" /><testcase classname="" name="tests.test_broken" file="tests/test_broken.py" time="0.000"><error message="collection failure">ImportError</error></testcase></testsuite></testsuites>`;

test("pytest junit maps failure and error to failed, skip and xfail to skipped", () => {
	const tests = parsePytestJunit(PYTEST_XML);
	deepStrictEqual(Object.fromEntries(tests), {
		"tests/test_a.py::tests.test_a::test_ok": {
			status: "passed",
			file: "tests/test_a.py",
			abnormal: false,
		},
		"tests/test_a.py::tests.test_a::test_bad": {
			status: "failed",
			file: "tests/test_a.py",
			abnormal: false,
		},
		"tests/test_a.py::tests.test_a::test_skip": {
			status: "skipped",
			file: "tests/test_a.py",
			abnormal: false,
		},
		"tests/test_a.py::tests.test_a::test_xf": {
			status: "skipped",
			file: "tests/test_a.py",
			abnormal: false,
		},
		"tests/test_a.py::tests.test_a::test_p[a&b <1\\>]": {
			status: "passed",
			file: "tests/test_a.py",
			abnormal: false,
		},
		"tests/test_a.py::tests.test_a.TestK::test_m": {
			status: "passed",
			file: "tests/test_a.py",
			abnormal: false,
		},
		"tests/test_broken.py::::tests.test_broken": {
			status: "failed",
			file: "tests/test_broken.py",
			abnormal: false,
		},
	});
});

test("a malformed, truncated or ambiguous junit report is refused whole", () => {
	const cases = [
		PYTEST_XML.replace('tests="7"', 'tests="8"'),
		PYTEST_XML.slice(0, -20),
		PYTEST_XML.replace("&amp;b", "&b"),
		PYTEST_XML.replace("&amp;b", "&nbsp;b"),
		PYTEST_XML.replace(
			'name="test_m"',
			'name="test_m"><testcase name="x"/></testcase><testcase name="y"',
		),
		`<!DOCTYPE x>${PYTEST_XML}`,
		PYTEST_XML.replace('name="test_ok"', 'name="test_bad"'),
		PYTEST_XML.replace('name="test_ok"', 'name="test_ok" name="again"'),
		'<testsuites><testsuite tests="0"></testsuite></testsuites><failure/>',
		"<testsuites></testsuites>",
		"not xml at all",
		`${PYTEST_XML}trailing`,
		`junk${PYTEST_XML}`,
		`${PYTEST_XML}<testsuites><testsuite tests="0"></testsuite></testsuites>`,
		PYTEST_XML.replace("&gt;       assert", "&bogus;       assert"),
		PYTEST_XML.replace("&gt;       assert", "& assert"),
		// A skipped call whose teardown errored is neither skipped nor failed.
		PYTEST_XML.replace(
			"tests/test_a.py:6: x</skipped>",
			'tests/test_a.py:6: x</skipped><error message="teardown">boom</error>',
		).replace('errors="1"', 'errors="2"'),
	];
	for (const xml of cases)
		throws(() => parsePytestJunit(xml), { code: "report_invalid" });
});

const ROOT = "/private/var/run/checkout";

function nodeLines(entries, end = { end: true, count: entries.length }) {
	return `${[...entries.map((entry) => ({ abnormal: false, ...entry })), end]
		.map((entry) => JSON.stringify(entry))
		.join("\n")}\n`;
}

test("node JSON-lines report ids are checkout-relative suite paths", () => {
	const tests = parseNodeTestReport(
		nodeLines([
			{
				path: ["grp", "in bad"],
				file: `${ROOT}/t/c.test.mjs`,
				type: "test",
				status: "failed",
			},
			{
				path: ["grp"],
				file: `${ROOT}/t/c.test.mjs`,
				type: "suite",
				status: "failed",
			},
			{
				path: ["todo"],
				file: `${ROOT}/t/c.test.mjs`,
				type: "test",
				status: "todo",
			},
			{ path: ["global"], file: null, type: "test", status: "passed" },
		]),
		["/var/run/checkout", ROOT],
	);
	deepStrictEqual(Object.fromEntries(tests), {
		"t/c.test.mjs::grp > in bad": {
			status: "failed",
			file: "t/c.test.mjs",
			abnormal: false,
		},
		"t/c.test.mjs::grp": {
			status: "failed",
			file: "t/c.test.mjs",
			abnormal: false,
		},
		"t/c.test.mjs::todo": {
			status: "todo",
			file: "t/c.test.mjs",
			abnormal: false,
		},
		"::global": { status: "passed", file: null, abnormal: false },
	});
});

test("identity separators inside names and files are escaped, so ids never collide", () => {
	const at = (file, path) => ({
		path,
		file: `${ROOT}/${file}`,
		type: "test",
		status: "passed",
	});
	const tests = parseNodeTestReport(
		nodeLines([
			at("t.mjs", ["a > b"]),
			at("t.mjs", ["a", "b"]),
			at("a::b.mjs", ["c"]),
			at("a.mjs", ["b::c"]),
			at("t.mjs", ["x\\"]),
		]),
		[ROOT],
	);
	deepStrictEqual(
		[...tests.keys()],
		[
			"t.mjs::a \\> b",
			"t.mjs::a > b",
			"a\\:\\:b.mjs::c",
			"a.mjs::b\\:\\:c",
			"t.mjs::x\\\\",
		],
	);
	const pytest = parsePytestJunit(
		'<testsuite tests="2"><testcase file="a.py" classname="k::x" name="t"/><testcase file="a.py" classname="k" name="x::t"/></testsuite>',
	);
	deepStrictEqual(
		[...pytest.keys()],
		["a.py::k\\:\\:x::t", "a.py::k::x\\:\\:t"],
	);
});

test("a node report without its end line, or naming files outside the checkout, is refused", () => {
	const entry = {
		path: ["a"],
		file: `${ROOT}/a.test.mjs`,
		type: "test",
		status: "passed",
	};
	for (const text of [
		nodeLines([entry]).replace(/\{"end".*\n$/u, ""),
		nodeLines([entry], { end: true, count: 2 }),
		nodeLines([{ ...entry, file: "/elsewhere/a.test.mjs" }]),
		nodeLines([{ ...entry, file: `${ROOT}/../a.test.mjs` }]),
		nodeLines([entry, entry]),
		nodeLines([{ ...entry, status: "flaky" }]),
		nodeLines([{ ...entry, path: [] }]),
		`${nodeLines([entry])}${JSON.stringify(entry)}\n`,
		nodeLines([entry]).slice(0, -1),
		"{not json}\n",
		`${JSON.stringify(entry)}\n{"end":true,"count":1}\n`,
		`${JSON.stringify({ ...entry, abnormal: "no" })}\n{"end":true,"count":1}\n`,
	])
		throws(() => parseNodeTestReport(text, [ROOT]), { code: "report_invalid" });
});

// A child of a node:test file inherits NODE_TEST_CONTEXT and skips running files.
function childEnv() {
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	return env;
}

test("the node reporter keeps a parent test's own failure that junit drops", async () => {
	const dir = tempDir("switchyard-differential-reporter-");
	writeFileSync(
		join(dir, "c.test.mjs"),
		`import { describe, it, test } from "node:test";
describe("grp", () => { it("in ok", () => {}); it("in bad", () => { throw new Error("q"); }); });
test("parent throws", async (t) => { await t.test("kid", () => {}); throw new Error("parent"); });
test("skipped", { skip: true }, () => {});
test("todo", { todo: true }, () => { throw new Error("t"); });
test("hangs", { timeout: 20 }, () => new Promise((resolve) => setTimeout(resolve, 2000)));
test("aborted", { signal: AbortSignal.timeout(20) }, () => new Promise((resolve) => setTimeout(resolve, 2000)));
`,
	);
	writeFileSync(
		join(dir, "killed.test.mjs"),
		`import { test } from "node:test";
test("killed", () => { process.kill(process.pid, "SIGKILL"); });
`,
	);
	const report = join(dir, "report.jsonl");
	const run = spawnSync(
		process.execPath,
		[
			`--test-reporter=${NODE_TEST_REPORTER_URL}`,
			`--test-reporter-destination=${report}`,
			"--test",
			"c.test.mjs",
			"killed.test.mjs",
		],
		{
			cwd: dir,
			encoding: "utf8",
			timeout: 60_000,
			env: childEnv(),
		},
	);
	strictEqual(run.status, 1, run.stderr);
	const tests = parseNodeTestReport(readFileSync(report, "utf8"), [dir]);
	deepStrictEqual(
		Object.fromEntries(
			[...tests].map(([id, { status, abnormal }]) => [
				id,
				abnormal ? `${status}, abnormal` : status,
			]),
		),
		{
			"c.test.mjs::grp > in ok": "passed",
			"c.test.mjs::grp > in bad": "failed",
			"c.test.mjs::grp": "failed",
			"c.test.mjs::parent throws > kid": "passed",
			"c.test.mjs::parent throws": "failed",
			"c.test.mjs::skipped": "skipped",
			"c.test.mjs::todo": "todo",
			"c.test.mjs::hangs": "failed, abnormal",
			"c.test.mjs::aborted": "failed, abnormal",
			"killed.test.mjs::killed.test.mjs": "failed, abnormal",
		},
	);
});

test("the reporter rebuilds suite paths from start events", async () => {
	async function* events() {
		yield { type: "test:start", data: { name: "s", nesting: 0 } };
		yield { type: "test:start", data: { name: "a", nesting: 1 } };
		yield {
			type: "test:fail",
			data: {
				name: "a",
				nesting: 1,
				file: "/f",
				details: { type: "test", error: { failureType: "testCodeFailure" } },
			},
		};
		yield {
			type: "test:pass",
			data: { name: "s", nesting: 0, file: "/f", details: { type: "suite" } },
		};
		yield { type: "test:pass", data: { name: "late", nesting: 0, skip: "x" } };
		yield {
			type: "test:fail",
			data: {
				name: "t",
				nesting: 0,
				details: { error: { failureType: "testTimeoutFailure" } },
			},
		};
		yield {
			type: "test:fail",
			data: {
				name: "f",
				nesting: 0,
				details: { error: { failureType: "testCodeFailure", exitCode: 3 } },
			},
		};
		// An abort crossing process isolation arrives as a bare Error.
		yield {
			type: "test:fail",
			data: { name: "bare", nesting: 0, details: { error: {} } },
		};
	}
	const lines = [];
	for await (const line of nodeTestJsonReporter(events())) lines.push(line);
	deepStrictEqual(
		lines.map((line) => JSON.parse(line)),
		[
			{
				path: ["s", "a"],
				file: "/f",
				type: "test",
				status: "failed",
				abnormal: false,
			},
			{
				path: ["s"],
				file: "/f",
				type: "suite",
				status: "passed",
				abnormal: false,
			},
			{
				path: ["late"],
				file: null,
				type: "test",
				status: "skipped",
				abnormal: false,
			},
			{
				path: ["t"],
				file: null,
				type: "test",
				status: "failed",
				abnormal: true,
			},
			{
				path: ["f"],
				file: null,
				type: "test",
				status: "failed",
				abnormal: true,
			},
			{
				path: ["bare"],
				file: null,
				type: "test",
				status: "failed",
				abnormal: true,
			},
			{ end: true, count: 6 },
		],
	);
});

test("a report is read only from one regular, singly linked, bounded file", () => {
	const dir = tempDir("switchyard-differential-read-");
	const plain = join(dir, "report.xml");
	writeFileSync(plain, "<x/>");
	strictEqual(readReportFile(plain), "<x/>");
	strictEqual(readReportFile(join(dir, "missing.xml")), null);
	const secret = join(dir, "secret.txt");
	writeFileSync(secret, "token");
	const linked = join(dir, "linked.xml");
	symlinkSync(secret, linked);
	strictEqual(readReportFile(linked), null);
	const hard = join(dir, "hard.xml");
	linkSync(secret, hard);
	strictEqual(readReportFile(hard), null);
	strictEqual(readReportFile(plain, 3), null);
	mkdirSync(join(dir, "dir.xml"));
	strictEqual(readReportFile(join(dir, "dir.xml")), null);
	// A FIFO with no writer would block a plain open forever.
	const fifo = join(dir, "fifo.xml");
	strictEqual(spawnSync("/usr/bin/mkfifo", [fifo]).status, 0);
	strictEqual(readReportFile(fifo), null);
});
