import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { cwd } from "node:process";
import { after, before, describe, it } from "node:test";
import {
	readLedger,
	readLedgerFromStore,
	recordDispatch,
	recordDispatchToStore,
} from "../src/switchyard/ledger/index.mjs";

const TEST_LEDGER_DIR = join(cwd(), ".switchyard-test-ledger");
const _ORIGINAL_LOG_DIR = join(
	cwd(),
	"node_modules",
	".switchyard-ledger-backup",
);

// recordDispatch()/readLedger() (exercised below, including the "backward
// compat" case) default to the real ~/.logs/switchyard/dispatch-ledger.jsonl.
// Redirect for the whole file so this suite never writes to the real ledger.
before(() => {
	mkdirSync(TEST_LEDGER_DIR, { recursive: true });
	process.env.SWITCHYARD_LEDGER_PATH = join(
		TEST_LEDGER_DIR,
		"dispatch-ledger.jsonl",
	);
});

after(() => {
	delete process.env.SWITCHYARD_LEDGER_PATH;
	rmSync(TEST_LEDGER_DIR, { recursive: true, force: true });
});

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

	it("should read empty ledger when no file exists", async () => {
		const entries = await readLedgerFromStore(
			join(TEST_LEDGER_DIR, "nonexistent"),
		);
		ok(Array.isArray(entries), "returns an array");
		strictEqual(entries.length, 0, "returns an empty array");
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
		const before = readLedger().length;

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
		strictEqual(entries.length, before + 2, "two new dispatches were appended");
		strictEqual(entries[entries.length - 2].taskId, "task-002");
		strictEqual(entries[entries.length - 1].taskId, "task-003");
	});
});

describe("ledger run-store backed", () => {
	const STORE_DIR = join(cwd(), ".switchyard-test-store-ledger");

	before(() => {
		try {
			rmSync(STORE_DIR, { recursive: true, force: true });
		} catch {
			// Ignore
		}
		mkdirSync(STORE_DIR, { recursive: true });
	});

	after(() => {
		try {
			rmSync(STORE_DIR, { recursive: true, force: true });
		} catch {
			// Ignore
		}
	});

	it("recordDispatchToStore writes to project-local ledger", async () => {
		await recordDispatchToStore(
			{
				provider: "claude",
				model: "claude-sonnet-5",
				taskId: "task-store-1",
				result: "success",
				reason: "spread",
				percentLeft: 42,
			},
			STORE_DIR,
		);

		const entries = await readLedgerFromStore(STORE_DIR);
		strictEqual(entries.length, 1);
		strictEqual(entries[0].provider, "claude");
		strictEqual(entries[0].model, "claude-sonnet-5");
		strictEqual(entries[0].taskId, "task-store-1");
		strictEqual(entries[0].result, "success");
		strictEqual(entries[0].reason, "spread");
		strictEqual(entries[0].percentLeft, 42);
		strictEqual(entries[0].storeBacked, true);
		ok(typeof entries[0].timestamp === "string");
		ok(typeof entries[0].host === "string");
	});

	it("readLedgerFromStore reads entries back", async () => {
		const before = (await readLedgerFromStore(STORE_DIR)).length;

		await recordDispatchToStore(
			{
				provider: "codex",
				model: "gpt-5.6",
				taskId: "task-store-2",
				result: "failed",
			},
			STORE_DIR,
		);

		const entries = await readLedgerFromStore(STORE_DIR);
		strictEqual(entries.length, before + 1, "one new entry was appended");
	});

	it("project-local ledger path is under ledger/dispatch-ledger.jsonl", async () => {
		// Verify the ledger file exists at the expected path
		const ledgerDir = resolve(STORE_DIR, "ledger");
		const ledgerFile = join(ledgerDir, "dispatch-ledger.jsonl");

		const entries = await readLedgerFromStore(STORE_DIR);
		ok(entries.length > 0, "entries exist, file must be at correct path");

		const { statSync } = await import("node:fs");
		const stat = statSync(ledgerFile);
		ok(stat.isFile(), "ledger file exists and is a regular file");
	});

	it("readLedgerFromStore returns empty array for missing store", async () => {
		const entries = await readLedgerFromStore(join(STORE_DIR, "nonexistent"));
		deepStrictEqual(entries, []);
	});

	it("backward compat: existing recordDispatch still works", () => {
		recordDispatch({
			provider: "claude",
			model: "claude-sonnet-5",
			taskId: "task-legacy",
			result: "success",
		});

		const entries = readLedger();
		ok(entries.length > 0, "legacy ledger still works");
	});
});
