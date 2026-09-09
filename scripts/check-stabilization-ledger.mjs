#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LEDGER_COLUMNS = Object.freeze([
	"task",
	"candidate",
	"policy-rg",
	"gitignore-rg",
	"diff-check",
	"lint",
	"deadcode",
	"phase-gate",
]);
const ROW_STATUS = new Set(["passed", "pending", "not-run"]);

function fail(code) {
	const error = new Error(code);
	error.code = code;
	throw error;
}

function tableCells(line) {
	if (!line.startsWith("|") || !line.endsWith("|")) fail("ledger_table_syntax");
	return line
		.slice(1, -1)
		.split("|")
		.map((cell) => cell.trim());
}

/** Parse the closed local stabilization ledger without accepting extra rows or fields. */
export function parseStabilizationLedger(text) {
	const lines = text.split(/\r?\n/).filter(Boolean);
	if (lines.length < 4 || lines[0] !== "# Stabilization Ledger") {
		fail("ledger_header_missing");
	}
	if (lines[1] !== "<!-- schema: stabilization-ledger/v1 -->") {
		fail("ledger_schema_missing");
	}
	const header = tableCells(lines[2]);
	if (JSON.stringify(header) !== JSON.stringify(LEDGER_COLUMNS)) {
		fail("ledger_columns_mismatch");
	}
	const separator = tableCells(lines[3]);
	if (
		separator.length !== LEDGER_COLUMNS.length ||
		separator.some((cell) => cell !== "---")
	) {
		fail("ledger_separator_invalid");
	}
	const rows = lines.slice(4).map((line) => {
		const cells = tableCells(line);
		if (cells.length !== LEDGER_COLUMNS.length) fail("ledger_row_column_count");
		const row = Object.fromEntries(
			LEDGER_COLUMNS.map((column, index) => [column, cells[index]]),
		);
		if (!/^\d+\.\d+$/.test(row.task)) fail("ledger_task_invalid");
		if (!/^[0-9a-f]{7,40}$/i.test(row.candidate))
			fail("ledger_candidate_invalid");
		for (const column of LEDGER_COLUMNS.slice(2)) {
			if (!ROW_STATUS.has(row[column])) fail("ledger_status_invalid");
		}
		return row;
	});
	if (rows.length === 0) fail("ledger_rows_required");
	const taskIds = new Set(rows.map((row) => row.task));
	if (taskIds.size !== rows.length) fail("ledger_duplicate_task");
	return rows;
}

export function validateStabilizationLedger(
	text,
	expectedCandidate = "326bc7b",
) {
	const rows = parseStabilizationLedger(text);
	const taskZeroOne = rows.find((row) => row.task === "0.1");
	if (!taskZeroOne || taskZeroOne.candidate !== expectedCandidate) {
		fail("ledger_candidate_binding_missing");
	}
	if (
		taskZeroOne["policy-rg"] !== "passed" ||
		taskZeroOne["gitignore-rg"] !== "passed" ||
		taskZeroOne["diff-check"] !== "passed" ||
		taskZeroOne.lint !== "passed" ||
		taskZeroOne.deadcode !== "passed" ||
		taskZeroOne["phase-gate"] !== "passed"
	) {
		fail("ledger_task_zero_one_receipt_invalid");
	}
	return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [ledgerPath = "STABILIZATION.md", expectedCandidate] =
		process.argv.slice(2);
	validateStabilizationLedger(
		readFileSync(ledgerPath, "utf8"),
		expectedCandidate,
	);
}
