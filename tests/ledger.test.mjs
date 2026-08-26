import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { cwd } from "node:process";
import { after, before, beforeEach, describe, it } from "node:test";
import {
	getLedgerRotationFailures,
	readLedger,
	readLedgerFromStore,
	recordDispatch,
	recordDispatchIntentToStore,
	recordDispatchToStore,
	resetLedgerRotationFailures,
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

	// The store-backed ledger was a single append-only file with no rotation: on
	// 2026-08-26 it stood at 25.3 MB and 32,448 lines since 2026-08-04, roughly
	// 1.1 MB a day and 89 percent of all Switchyard log volume.
	describe("store ledger rotation", () => {
		const ROTATE_ROOT = join(STORE_DIR, "rotation");
		const LEDGER = join(ROTATE_ROOT, "ledger", "dispatch-ledger.jsonl");
		let originalMax;
		let originalSegments;

		function entry(n) {
			return {
				provider: "claude",
				model: "claude-sonnet-5",
				taskId: `rotate-${n}`,
				result: "success",
			};
		}

		before(() => {
			originalMax = process.env.SWITCHYARD_LEDGER_MAX_BYTES;
			originalSegments = process.env.SWITCHYARD_LEDGER_SEGMENTS;
		});

		beforeEach(() => {
			rmSync(ROTATE_ROOT, { recursive: true, force: true });
			resetLedgerRotationFailures();
			// Small enough that a handful of entries crosses it.
			process.env.SWITCHYARD_LEDGER_MAX_BYTES = "600";
			process.env.SWITCHYARD_LEDGER_SEGMENTS = "2";
		});

		after(() => {
			if (originalMax === undefined) {
				delete process.env.SWITCHYARD_LEDGER_MAX_BYTES;
			} else {
				process.env.SWITCHYARD_LEDGER_MAX_BYTES = originalMax;
			}
			if (originalSegments === undefined) {
				delete process.env.SWITCHYARD_LEDGER_SEGMENTS;
			} else {
				process.env.SWITCHYARD_LEDGER_SEGMENTS = originalSegments;
			}
			rmSync(ROTATE_ROOT, { recursive: true, force: true });
		});

		it("rotates the active file once it exceeds the configured size", async () => {
			for (let n = 0; n < 12; n += 1) {
				await recordDispatchToStore(entry(n), ROTATE_ROOT);
			}
			ok(existsSync(LEDGER), "the active file must still exist");
			ok(existsSync(`${LEDGER}.1`), "a rotated segment must exist");
			ok(
				readFileSync(LEDGER, "utf8").length <
					readFileSync(`${LEDGER}.1`, "utf8").length +
						readFileSync(LEDGER, "utf8").length,
				"the active file must be smaller than the total retained history",
			);
		});

		it("keeps the active file's name stable across a rotation", async () => {
			for (let n = 0; n < 12; n += 1) {
				await recordDispatchToStore(entry(n), ROTATE_ROOT);
			}
			// Readers that hardcode the path must keep working, and the newest
			// entry must be in the ACTIVE file, not in a segment.
			const active = readFileSync(LEDGER, "utf8").trim().split("\n");
			const newest = JSON.parse(active.at(-1));
			strictEqual(newest.taskId, "rotate-11");
		});

		it("bounds the number of retained segments", async () => {
			for (let n = 0; n < 60; n += 1) {
				await recordDispatchToStore(entry(n), ROTATE_ROOT);
			}
			ok(existsSync(`${LEDGER}.1`), "segment 1 must exist");
			ok(existsSync(`${LEDGER}.2`), "segment 2 must exist");
			ok(
				!existsSync(`${LEDGER}.3`),
				"segment 3 must not exist: the segment count is bounded at 2",
			);
		});

		it("loses no entry across a rotation boundary", async () => {
			// Two segments plus the active file, so nothing has aged out yet.
			for (let n = 0; n < 12; n += 1) {
				await recordDispatchToStore(entry(n), ROTATE_ROOT);
			}
			ok(existsSync(`${LEDGER}.1`), "the run must actually have rotated");
			const read = await readLedgerFromStore(ROTATE_ROOT);
			deepStrictEqual(
				read.map((e) => e.taskId),
				Array.from({ length: 12 }, (_, n) => `rotate-${n}`),
				"every entry must be readable, in order, across the boundary",
			);
		});

		it("does not propagate a rotation failure out of the append", async () => {
			for (let n = 0; n < 12; n += 1) {
				await recordDispatchToStore(entry(n), ROTATE_ROOT);
			}
			ok(existsSync(`${LEDGER}.1`), "the run must actually have rotated");
			// A DIRECTORY where segment .2 must go: the shift renames .1 -> .2 and
			// fails, which must be reported and swallowed rather than aborting a
			// run. The ledger is an observability channel.
			rmSync(`${LEDGER}.2`, { recursive: true, force: true });
			mkdirSync(`${LEDGER}.2`, { recursive: true });
			// Non-empty, so the rename onto it cannot succeed.
			mkdirSync(join(`${LEDGER}.2`, "occupied"), { recursive: true });
			resetLedgerRotationFailures();
			for (let n = 100; n < 112; n += 1) {
				await recordDispatchToStore(entry(n), ROTATE_ROOT);
			}
			ok(
				getLedgerRotationFailures() > 0,
				"the rotation failure must be counted, not silent",
			);
			const read = await readLedgerFromStore(ROTATE_ROOT);
			ok(
				read.some((e) => e.taskId === "rotate-111"),
				"entries must keep landing even when rotation cannot proceed",
			);
		});

		it("does not rotate a file that is still under the bound", async () => {
			process.env.SWITCHYARD_LEDGER_MAX_BYTES = String(8 * 1024 * 1024);
			for (let n = 0; n < 12; n += 1) {
				await recordDispatchToStore(entry(n), ROTATE_ROOT);
			}
			ok(
				!existsSync(`${LEDGER}.1`),
				"no segment may be created below the threshold",
			);
			strictEqual((await readLedgerFromStore(ROTATE_ROOT)).length, 12);
		});
	});

	it("writes a sanitized project-local intent receipt", () => {
		const intentStore = join(STORE_DIR, "intent-sanitization");
		recordDispatchIntentToStore(
			{
				taskId: "task-intent",
				provider: "claude",
				model: "claude-sonnet-5",
				requiredCapability: "standard",
				resolvedTargetId: "claude",
				descriptorIdentity: "descriptor-sha",
				descriptorHarness: "claude",
				roster_schema_version: 1,
				hostname: "secret-host",
				credential: "secret-credential",
				env: { TOKEN: "secret-token" },
				prompt: "private prompt",
				diff: "private diff",
				invocationDescriptor: { invocation_args: ["private arg"] },
			},
			intentStore,
		);

		return readLedgerFromStore(intentStore).then((entries) => {
			strictEqual(entries.length, 1);
			const entry = entries[0];
			strictEqual(entry.intent, true);
			strictEqual(entry.recordType, "intent");
			ok(/^sha256:[a-f0-9]{64}$/.test(entry.taskId));
			ok(/^sha256:[a-f0-9]{64}$/.test(entry.model));
			strictEqual(entry.host, undefined);
			strictEqual(entry.hostname, undefined);
			strictEqual(entry.credential, undefined);
			strictEqual(entry.env, undefined);
			strictEqual(entry.prompt, undefined);
			strictEqual(entry.diff, undefined);
			strictEqual(entry.invocationDescriptor, undefined);
		});
	});

	it("redacts unsafe values even when they use allowlisted intent keys", async () => {
		const intentStore = join(TEST_LEDGER_DIR, "intent-adversarial");
		recordDispatchIntentToStore(
			{
				taskId: "service.prod.company.com",
				provider: "sk-proj-opaquevalue",
				model: "service.prod.company.com",
				requiredCapability: "sk-proj-opaquevalue",
				resolvedTargetId: "service.prod.company.com",
				descriptorIdentity: "sk-proj-opaquevalue",
				descriptorHarness: "sk-proj-opaquevalue",
				roster_sha256: "service.prod.company.com",
				resolved_target: "service.prod.company.com",
				resolved_harness: "sk-proj-opaquevalue",
				resolved_selector: "service.prod.company.com",
				resolved_credential_profile: "sk-proj-opaquevalue",
			},
			intentStore,
		);

		const [entry] = await readLedgerFromStore(intentStore);
		ok(!JSON.stringify(entry).includes("service.prod.company.com"));
		ok(!JSON.stringify(entry).includes("sk-proj-opaquevalue"));
		ok(/^sha256:[a-f0-9]{64}$/.test(entry.taskId));
		strictEqual(entry.provider, undefined);
		ok(/^sha256:[a-f0-9]{64}$/.test(entry.model));
		strictEqual(entry.requiredCapability, undefined);
		ok(/^sha256:[a-f0-9]{64}$/.test(entry.resolvedTargetId));
		strictEqual(entry.descriptorIdentity, undefined);
		strictEqual(entry.descriptorHarness, undefined);
		strictEqual(entry.roster_sha256, undefined);
		ok(/^sha256:[a-f0-9]{64}$/.test(entry.resolved_target));
		strictEqual(entry.resolved_harness, undefined);
		ok(/^sha256:[a-f0-9]{64}$/.test(entry.resolved_selector));
		ok(/^sha256:[a-f0-9]{64}$/.test(entry.resolved_credential_profile));
	});
});
