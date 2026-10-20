// @test-phase: other
// A held receipt's differential baselines: only a qualifying baseline whose
// every test id and file is already in recorded form is persisted, a receipt
// round-trips to the Map a check session takes, a schema-1 receipt has none,
// and any malformed entry refuses the receipt with one closed detail.
import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { getRunRoot } from "../src/switchyard/run-store/run-records.mjs";
import {
	BASELINES_INVALID,
	MAX_BASELINE_BYTES,
	MAX_BASELINE_ID_CHARS,
	MAX_BASELINE_TESTS,
	persistedBaselines,
	receiptBaselines,
} from "../src/switchyard/simple/held-baselines.mjs";
import {
	holdVerifiedIntegration,
	readHeldIntegration,
} from "../src/switchyard/simple/held-integration.mjs";
import { git, heldFixture } from "./helpers/held-integration-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(
	tempDir("switchyard-held-baselines-store-"),
	"runs",
);

const NODE = "node --test tests/legacy.test.mjs";
const PYTEST = "python3 -m pytest -q tests";
const FILE = "tests/legacy.test.mjs";

const result = (status, abnormal = false, file = FILE) => ({
	status,
	file,
	abnormal,
});
function baseline(entries, runner = "node") {
	return { runner, tests: new Map(entries) };
}
const RED = baseline([
	[`${FILE}::host clock`, result("failed")],
	[`${FILE}::still green`, result("passed")],
	[`${FILE}::later`, result("skipped")],
]);

test("a qualifying baseline round-trips to the session's Map shape", () => {
	const checks = [NODE, PYTEST];
	const persisted = persistedBaselines(
		new Map([
			[NODE, RED],
			[
				PYTEST,
				baseline(
					[
						[
							"tests/test_a.py::::test_x",
							result("failed", false, "tests/test_a.py"),
						],
					],
					"pytest",
				),
			],
		]),
		checks,
	);
	deepStrictEqual(
		persisted.map(({ command }) => command),
		checks,
	);
	deepStrictEqual(persisted[0].tests[0], [
		`${FILE}::host clock`,
		"failed",
		FILE,
	]);
	const decoded = receiptBaselines({
		schemaVersion: 2,
		checks,
		differentialBaselines: JSON.parse(JSON.stringify(persisted)),
	});
	deepStrictEqual(decoded.get(NODE), RED);
	strictEqual(decoded.get(PYTEST).runner, "pytest");
});

test("recordable ids longer than summary ids retain their exact identity", () => {
	const long = `${FILE}::${"x".repeat(500)}`;
	const value = baseline([[long, result("failed")]]);
	const entries = persistedBaselines(new Map([[NODE, value]]), [NODE]);
	deepStrictEqual(
		receiptBaselines({
			schemaVersion: 2,
			checks: [NODE],
			differentialBaselines: entries,
		}).get(NODE),
		value,
	);
});

test("a baseline that cannot be persisted faithfully is left out", () => {
	const long = `${FILE}::${"x".repeat(MAX_BASELINE_ID_CHARS)}`;
	const cases = {
		"reason only": { runner: "node", reason: "baseline_unavailable" },
		"abnormal test": baseline([[`${FILE}::t`, result("failed", true)]]),
		"no failing test": baseline([[`${FILE}::t`, result("passed")]]),
		"credential-shaped id": baseline([
			[`${FILE}::uses sk-abcdefghijklmnop1234`, result("failed")],
		]),
		"control character": baseline([[`${FILE}::a\u0007b`, result("failed")]]),
		"over-long id": baseline([[long, result("failed")]]),
		"absolute file": baseline([
			[`${FILE}::t`, result("failed", false, "/etc/x")],
		]),
		"escaping file": baseline([
			[`${FILE}::t`, result("failed", false, "../x.test.mjs")],
		]),
		"unknown status": baseline([[`${FILE}::t`, result("xfailed")]]),
	};
	for (const [name, entry] of Object.entries(cases))
		deepStrictEqual(
			persistedBaselines(new Map([[NODE, entry]]), [NODE]),
			[],
			name,
		);
	// Not one of the task's checks, or not an eligible test runner.
	deepStrictEqual(persistedBaselines(new Map([[NODE, RED]]), ["true"]), []);
	deepStrictEqual(
		persistedBaselines(new Map([["grep -q x a", RED]]), ["grep -q x a"]),
		[],
	);
	deepStrictEqual(persistedBaselines(null, [NODE]), []);
});

const many = (count, id = (i) => `t${i}`) =>
	baseline(
		Array.from({ length: count }, (_, i) => [
			id(i),
			result(i === 0 ? "failed" : "passed", false, null),
		]),
	);
const SECOND = "node --test tests/other.test.mjs";
const THIRD = "node --test tests/third.test.mjs";

test("overflow of the total test count discards every baseline", () => {
	const checks = [NODE, SECOND, THIRD];
	for (const entries of [
		[
			[NODE, many(MAX_BASELINE_TESTS - 1)],
			[SECOND, many(2)],
			[THIRD, many(1)],
		],
		[
			[NODE, RED],
			[SECOND, many(MAX_BASELINE_TESTS + 1)],
		],
	])
		strictEqual(persistedBaselines(new Map(entries), checks).length, 0);
	const atLimit = persistedBaselines(
		new Map([
			[NODE, many(MAX_BASELINE_TESTS - 1)],
			[SECOND, many(1)],
		]),
		checks,
	);
	strictEqual(
		atLimit.reduce((sum, entry) => sum + entry.tests.length, 0),
		MAX_BASELINE_TESTS,
	);
});

test("overflow of the total serialized bytes discards every baseline", () => {
	const wide = many(3_000, (i) => `${"w".repeat(200)}${i}`);
	const checks = [NODE, SECOND, THIRD];
	for (const command of [NODE, SECOND])
		strictEqual(
			persistedBaselines(new Map([[command, wide]]), checks).length,
			1,
		);
	strictEqual(
		persistedBaselines(
			new Map([
				[NODE, wide],
				[SECOND, wide],
				[THIRD, RED],
			]),
			checks,
		).length,
		0,
	);
	strictEqual(
		persistedBaselines(
			new Map([
				[NODE, RED],
				[SECOND, many(6_000, (i) => `${"w".repeat(200)}${i}`)],
			]),
			checks,
		).length,
		0,
	);
});

test("the byte cap includes array punctuation and UTF-8 bytes", () => {
	const command = `${NODE} `;
	const unicode = many(1, () => "é");
	const one = persistedBaselines(new Map([[command, unicode]]), [command]);
	const overhead = Buffer.byteLength(JSON.stringify(one));
	const exact = command + " ".repeat(MAX_BASELINE_BYTES - overhead);
	const checks = [exact, `${exact} `];
	const atLimit = persistedBaselines(new Map([[exact, unicode]]), checks);
	strictEqual(Buffer.byteLength(JSON.stringify(atLimit)), MAX_BASELINE_BYTES);
	deepStrictEqual(
		receiptBaselines({
			schemaVersion: 2,
			checks,
			differentialBaselines: atLimit,
		}).get(exact),
		unicode,
	);
	strictEqual(
		persistedBaselines(new Map([[`${exact} `, unicode]]), checks).length,
		0,
	);
});

test("untrusted receipts over either aggregate cap are refused", () => {
	const checks = [NODE, SECOND];
	const encoded = (command, value) =>
		persistedBaselines(new Map([[command, value]]), checks)[0];
	for (const entries of [
		[encoded(NODE, many(MAX_BASELINE_TESTS)), encoded(SECOND, many(1))],
		[NODE, SECOND].map((command) =>
			encoded(
				command,
				many(3_000, (i) => `${"w".repeat(200)}${i}`),
			),
		),
	])
		throws(
			() =>
				receiptBaselines({
					schemaVersion: 2,
					checks,
					differentialBaselines: entries,
				}),
			{ code: "held_receipt_invalid", detail: BASELINES_INVALID },
		);
});

test("a schema-1 receipt carries no baselines and rechecks strictly", () => {
	strictEqual(receiptBaselines({ schemaVersion: 1, checks: [NODE] }), null);
	throws(
		() =>
			receiptBaselines({
				schemaVersion: 1,
				checks: [NODE],
				differentialBaselines: [],
			}),
		{ code: "held_receipt_invalid", detail: BASELINES_INVALID },
	);
});

test("every malformed baseline entry refuses the receipt", () => {
	const good = persistedBaselines(new Map([[NODE, RED]]), [NODE])[0];
	const tests = (rows) => ({ ...good, tests: rows });
	const cases = {
		"not an array": "x",
		"duplicate command": [good, good],
		"unknown command": [{ ...good, command: "node --test other.mjs" }],
		"wrong runner": [{ ...good, runner: "pytest" }],
		"extra key": [{ ...good, abnormal: false }],
		"missing key": [{ command: good.command, runner: "node" }],
		"bad status": [tests([[`${FILE}::t`, "broken", FILE]])],
		"duplicate id": [
			tests([
				[`${FILE}::t`, "failed", FILE],
				[`${FILE}::t`, "passed", FILE],
			]),
		],
		"short tuple": [tests([[`${FILE}::t`, "failed"]])],
		"no failure": [tests([[`${FILE}::t`, "passed", FILE]])],
		"empty tests": [tests([])],
		"redacted id": [
			tests([[`${FILE}::sk-abcdefghijklmnop1234`, "failed", FILE]]),
		],
		"escaping file": [tests([[`${FILE}::t`, "failed", "../t.mjs"]])],
		"null entry": [null],
	};
	for (const [name, differentialBaselines] of Object.entries(cases))
		throws(
			() =>
				receiptBaselines({
					schemaVersion: 2,
					checks: [NODE],
					differentialBaselines,
				}),
			{ code: "held_receipt_invalid", detail: BASELINES_INVALID },
			name,
		);
	throws(() => receiptBaselines({ schemaVersion: 2, checks: [NODE] }), {
		detail: BASELINES_INVALID,
	});
	deepStrictEqual(
		receiptBaselines({
			schemaVersion: 2,
			checks: [],
			differentialBaselines: [],
		}),
		new Map(),
	);
});

function holdInput(repo, runId, extra = {}) {
	const head = git(repo.projectPath, ["rev-parse", "HEAD"]);
	return {
		runId,
		taskId: "t",
		attemptId: "a",
		projectPath: repo.projectPath,
		diff: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-base\n+candidate\n",
		baseRevision: head,
		verifiedHead: head,
		files: ["a.txt"],
		scopeFiles: ["a.txt"],
		readOnlyInputs: [],
		allowManifests: [],
		allowExecutables: [],
		checks: [NODE],
		changedFiles: ["a.txt"],
		undeclaredPaths: [],
		declaredFingerprint: "unused",
		expectedOutputs: [],
		differentialBaselines: new Map([[NODE, RED]]),
		...extra,
	};
}

function hold(input) {
	mkdirSync(getRunRoot(input.runId), { recursive: true, mode: 0o700 });
	const held = holdVerifiedIntegration(input);
	strictEqual(held.ok, true);
	const record = {
		runId: input.runId,
		state: "succeeded",
		terminalSummary: { status: "held", integration: held.summary },
	};
	return { held, record };
}

test("a held receipt stores the baselines its digest binds", () => {
	const repo = heldFixture();
	const runId = "simple-held-baselines-bound";
	const { held, record } = hold(holdInput(repo, runId));
	const receipt = JSON.parse(readFileSync(held.summary.receiptPath, "utf8"));
	strictEqual(receipt.schemaVersion, 2);
	strictEqual(receipt.differentialBaselines[0].command, NODE);
	const loaded = readHeldIntegration(record, repo.projectPath, runId);
	deepStrictEqual(loaded.differentialBaselines.get(NODE), RED);

	// Edited baselines are refused by the digest; re-signed malformed ones by
	// validation.
	receipt.differentialBaselines[0].tests[0][1] = "passed";
	const bytes = `${JSON.stringify(receipt)}\n`;
	writeFileSync(held.summary.receiptPath, bytes);
	throws(() => readHeldIntegration(record, repo.projectPath, runId), {
		detail: "receipt_digest_mismatch",
	});
	record.terminalSummary.integration.receiptSha256 = createHash("sha256")
		.update(bytes)
		.digest("hex");
	throws(() => readHeldIntegration(record, repo.projectPath, runId), {
		code: "held_receipt_invalid",
		detail: BASELINES_INVALID,
	});
});

test("either aggregate overflow holds a receipt with no baselines", () => {
	const repo = heldFixture();
	for (const [kind, value] of [
		["count", many(MAX_BASELINE_TESTS + 1)],
		["bytes", many(6_000, (i) => `${"w".repeat(200)}${i}`)],
	]) {
		const runId = `simple-held-baselines-${kind}-overflow`;
		const { record } = hold(
			holdInput(repo, runId, {
				differentialBaselines: new Map([[NODE, value]]),
			}),
		);
		const loaded = readHeldIntegration(record, repo.projectPath, runId);
		deepStrictEqual(loaded.receipt.differentialBaselines, []);
		deepStrictEqual(loaded.differentialBaselines, new Map());
	}
});

test("a receipt too large with its baselines is held without them", () => {
	const repo = heldFixture();
	const runId = "simple-held-baselines-oversized";
	const expectedOutputs = Array.from({ length: 6_500 }, (_, i) => ({
		path: `${"p".repeat(80)}${i}`,
		size: 0,
		sha256: "0".repeat(64),
		mode: 0o644,
	}));
	const wide = baseline(
		Array.from({ length: 3_500 }, (_, i) => [
			`${FILE}::${"t".repeat(200)}${i}`,
			result(i === 0 ? "failed" : "passed"),
		]),
	);
	// The baselines fit their own bound; only the whole receipt is too large.
	strictEqual(persistedBaselines(new Map([[NODE, wide]]), [NODE]).length, 1);
	const { held, record } = hold(
		holdInput(repo, runId, {
			expectedOutputs,
			differentialBaselines: new Map([[NODE, wide]]),
		}),
	);
	const receipt = JSON.parse(readFileSync(held.summary.receiptPath, "utf8"));
	deepStrictEqual(receipt.differentialBaselines, []);
	const loaded = readHeldIntegration(record, repo.projectPath, runId);
	deepStrictEqual(loaded.differentialBaselines, new Map());
});
