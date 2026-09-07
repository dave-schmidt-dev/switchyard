import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	aggregateVmGateOutcomes,
	DEFAULT_PHASES,
	defaultRun,
	runPhases,
} from "../scripts/run-test-phases.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const PACKAGE_JSON_PATH = resolve(PKG_ROOT, "package.json");

describe("test phase aggregation runner", () => {
	function runSerialWithGateRecords(records, onSpawn = () => {}) {
		return defaultRun("test:serial", {
			spawn: (_command, _args, options) => {
				onSpawn(options);
				for (const record of records) {
					appendFileSync(
						options.env.SWITCHYARD_VM_GATE_OUTCOME_FILE,
						`${JSON.stringify(record)}\n`,
					);
				}
				return { status: 0, stdout: "", stderr: "" };
			},
		});
	}

	it("keeps live serial phase stdio inherited while validating gate outcomes", () => {
		let spawnOptions;
		const result = runSerialWithGateRecords(
			[
				{ schemaVersion: 1, gate: "inv1", status: "executed" },
				{
					schemaVersion: 1,
					gate: "inv3",
					status: "unavailable-with-proof",
					reason: "Parallels is unavailable",
				},
			],
			(options) => {
				spawnOptions = options;
			},
		);
		strictEqual(spawnOptions.stdio, "inherit");
		strictEqual(result.status, 0);
		strictEqual(result.vmGates.inv1.status, "executed");
	});

	it("defaultRun accepts both executed and proven-unavailable VM gates", () => {
		const executed = runSerialWithGateRecords([
			{ schemaVersion: 1, gate: "inv1", status: "executed" },
			{
				schemaVersion: 1,
				gate: "inv3",
				status: "unavailable-with-proof",
				reason: "Parallels is unavailable",
			},
		]);
		strictEqual(executed.status, 0);
		strictEqual(executed.vmGates.inv1.status, "executed");
		strictEqual(executed.vmGates.inv3.status, "unavailable-with-proof");
	});

	it("defaultRun rejects missing, unknown, and unproven VM gate outcomes", () => {
		const missing = runSerialWithGateRecords([
			{ schemaVersion: 1, gate: "inv1", status: "executed" },
		]);
		strictEqual(missing.status, 1);

		const unknown = runSerialWithGateRecords([
			{ schemaVersion: 1, gate: "inv1", status: "skipped" },
			{ schemaVersion: 1, gate: "inv3", status: "executed" },
		]);
		strictEqual(unknown.status, 1);

		const unproven = runSerialWithGateRecords([
			{ schemaVersion: 1, gate: "inv1", status: "unavailable-with-proof" },
			{ schemaVersion: 1, gate: "inv3", status: "executed" },
		]);
		strictEqual(unproven.status, 1);
	});

	it("requires proof for an unavailable VM gate and preserves executed state", () => {
		deepStrictEqual(
			aggregateVmGateOutcomes({
				inv1: { status: "executed" },
				inv3: {
					status: "unavailable-with-proof",
					reason: "both VM slots are held",
				},
			}),
			{
				status: "unavailable-with-proof",
				gates: {
					inv1: { status: "executed" },
					inv3: {
						status: "unavailable-with-proof",
						reason: "both VM slots are held",
					},
				},
			},
		);
		strictEqual(
			aggregateVmGateOutcomes({ inv1: { status: "skipped" } }).status,
			"failed",
		);
		strictEqual(
			aggregateVmGateOutcomes({ inv1: { status: "failed" } }).status,
			"failed",
		);
	});

	it("includes VM-gate outcomes in the phase summary without changing exit aggregation", () => {
		const logs = [];
		const status = runPhases({
			phases: ["test:serial"],
			run: () => ({
				status: 0,
				vmGates: {
					inv1: {
						status: "unavailable-with-proof",
						reason: "Parallels is unavailable",
					},
				},
			}),
			log: (message) => logs.push(message),
		});
		strictEqual(status, 0);
		ok(logs[0].includes("test:serial/inv1 (unavailable-with-proof)"));
	});

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
