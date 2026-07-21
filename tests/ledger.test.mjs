import { strictEqual, ok } from "node:assert";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { after, before, describe, it } from "node:test";
import { recordDispatch, readLedger } from "../src/switchyard/ledger/index.mjs";

const TEST_LEDGER_DIR = join(cwd(), ".switchyard-test-ledger");
const ORIGINAL_LOG_DIR = join(
	cwd(),
	"node_modules",
	".switchyard-ledger-backup",
);

describe("ledger", () => {
	before(() => {
		// Ensure clean state
		try {
			rmSync(TEST_LEDGER_DIR, { recursive: true, force: true });
		} catch {
			// Ignore
		}
		mkdirSync(TEST_LEDGER_DIR, { recursive: true });
	});

	after(() => {
		try {
			rmSync(TEST_LEDGER_DIR, { recursive: true, force: true });
		} catch {
			// Ignore
		}
	});

	it("should read empty ledger when no file exists", () => {
		// readLedger should return [] when ledger file doesn't exist
		const entries = readLedger();
		ok(Array.isArray(entries), "returns an array");
	});

	it("should record dispatch and read it back", () => {
		recordDispatch({
			provider: "claude",
			model: "claude-opus-4-8",
			taskId: "task-001",
			result: "success",
			reason: "spread",
			percentLeft: 45.2,
		});

		const entries = readLedger();
		ok(entries.length > 0, "ledger has entries after recording");

		const last = entries[entries.length - 1];
		strictEqual(last.provider, "claude");
		strictEqual(last.model, "claude-opus-4-8");
		strictEqual(last.taskId, "task-001");
		strictEqual(last.result, "success");
		strictEqual(last.reason, "spread");
		strictEqual(last.percentLeft, 45.2);
		ok(typeof last.timestamp === "string", "has timestamp");
		ok(typeof last.host === "string", "has hostname");
	});

	it("should record multiple dispatches", () => {
		recordDispatch({
			provider: "codex",
			model: "gpt-5.6-sol",
			taskId: "task-002",
			result: "success",
		});

		recordDispatch({
			provider: "agy",
			model: "Gemini 3.1 Pro (High)",
			taskId: "task-003",
			result: "failed",
			reason: "timeout",
		});

		const entries = readLedger();
		ok(entries.length >= 3, "ledger has at least 3 entries");
	});
});
