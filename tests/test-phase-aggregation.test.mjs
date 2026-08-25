import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_PHASES, runPhases } from "../scripts/run-test-phases.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const PACKAGE_JSON_PATH = resolve(PKG_ROOT, "package.json");

describe("test phase aggregation runner", () => {
	it("proves the second phase still runs when the first phase exits non-zero", () => {
		const executed = [];
		const phases = ["test:serial", "test:other"];
		const logs = [];

		const exitCode = runPhases({
			phases,
			run(phase) {
				executed.push(phase);
				if (phase === "test:serial") {
					return 1;
				}
				return 0;
			},
			log(msg) {
				logs.push(msg);
			},
		});

		deepStrictEqual(executed, ["test:serial", "test:other"]);
		strictEqual(exitCode, 1);
	});

	it("proves the aggregated status is the first non-zero phase status, and 0 only when every phase exits 0", () => {
		// All phases exit 0 -> 0
		const allPass = runPhases({
			phases: ["phase-a", "phase-b"],
			run: () => 0,
			log: () => {},
		});
		strictEqual(allPass, 0);

		// First phase fails (status 2), second succeeds (status 0) -> returns 2
		const firstFails = runPhases({
			phases: ["phase-a", "phase-b"],
			run: (phase) => (phase === "phase-a" ? 2 : 0),
			log: () => {},
		});
		strictEqual(firstFails, 2);

		// First phase succeeds (status 0), second fails (status 3) -> returns 3
		const secondFails = runPhases({
			phases: ["phase-a", "phase-b"],
			run: (phase) => (phase === "phase-b" ? 3 : 0),
			log: () => {},
		});
		strictEqual(secondFails, 3);

		// Both phases fail with different codes (status 4 then status 5) -> returns first non-zero (4)
		const bothFail = runPhases({
			phases: ["phase-a", "phase-b"],
			run: (phase) => (phase === "phase-a" ? 4 : 5),
			log: () => {},
		});
		strictEqual(bothFail, 4);

		// Multiple phases: third phase fails
		const multiPhase = runPhases({
			phases: ["p1", "p2", "p3", "p4"],
			run: (phase) => (phase === "p3" ? 7 : 0),
			log: () => {},
		});
		strictEqual(multiPhase, 7);
	});

	it("asserts the summary output contains an exit status entry for test:serial and one for test:other", () => {
		const logs = [];
		runPhases({
			phases: ["test:serial", "test:other"],
			run: (phase) => (phase === "test:serial" ? 0 : 1),
			log: (msg) => logs.push(msg),
		});

		strictEqual(logs.length, 1);
		const summary = logs[0];

		ok(
			summary.includes("test:serial"),
			`summary must contain test:serial entry: ${summary}`,
		);
		ok(
			summary.includes("test:other"),
			`summary must contain test:other entry: ${summary}`,
		);
		ok(
			/test:serial[^\n,]*(?:exit\s+0|\b0\b)/.test(summary),
			`summary must report exit status for test:serial: ${summary}`,
		);
		ok(
			/test:other[^\n,]*(?:exit\s+1|\b1\b)/.test(summary),
			`summary must report exit status for test:other: ${summary}`,
		);
	});

	it("defaults to DEFAULT_PHASES (test:serial and test:other)", () => {
		deepStrictEqual(DEFAULT_PHASES, ["test:serial", "test:other"]);

		const executed = [];
		runPhases({
			run: (phase) => {
				executed.push(phase);
				return 0;
			},
			log: () => {},
		});

		deepStrictEqual(executed, ["test:serial", "test:other"]);
	});

	it("verifies package.json test script equals node scripts/run-test-phases.mjs and contains no &&", () => {
		const rawPkg = readFileSync(PACKAGE_JSON_PATH, "utf8");
		const pkg = JSON.parse(rawPkg);

		strictEqual(
			pkg.scripts.test,
			"node scripts/run-test-phases.mjs",
			"package.json test script must equal 'node scripts/run-test-phases.mjs'",
		);
		ok(
			!pkg.scripts.test.includes("&&"),
			"package.json test script must not contain '&&'",
		);
		ok(
			typeof pkg.scripts["test:serial"] === "string" &&
				pkg.scripts["test:serial"].length > 0,
			"test:serial script must remain defined",
		);
		ok(
			typeof pkg.scripts["test:other"] === "string" &&
				pkg.scripts["test:other"].length > 0,
			"test:other script must remain defined",
		);
	});
});
