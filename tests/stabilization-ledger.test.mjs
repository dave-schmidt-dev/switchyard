import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	LEDGER_COLUMNS,
	parseStabilizationLedger,
	validateStabilizationLedger,
} from "../scripts/check-stabilization-ledger.mjs";

describe("stabilization ledger", () => {
	it("has a closed schema and exact Task 0.1 candidate binding", () => {
		const rows = validateStabilizationLedger(
			readFileSync("STABILIZATION.md", "utf8"),
		);
		strictEqual(rows.length >= 1, true);
		deepStrictEqual(LEDGER_COLUMNS, [
			"task",
			"candidate",
			"policy-rg",
			"gitignore-rg",
			"diff-check",
			"lint",
			"deadcode",
			"phase-gate",
		]);
		const taskZeroOne = rows.find((row) => row.task === "0.1");
		strictEqual(taskZeroOne?.candidate, "326bc7b");
		strictEqual(taskZeroOne?.["phase-gate"], "passed");
	});

	it("rejects extra columns and candidate drift", () => {
		const valid = readFileSync("STABILIZATION.md", "utf8");
		throws(
			() =>
				parseStabilizationLedger(
					valid.replace("| phase-gate |", "| phase-gate | leaked |"),
				),
			/ledger_columns_mismatch/,
		);
		throws(
			() => validateStabilizationLedger(valid.replace("326bc7b", "deadbee")),
			/ledger_candidate_binding_missing/,
		);
	});
});
