import { ok, rejects, strictEqual } from "node:assert";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	advanceState,
	applyRetention,
	getStateRoot,
	initializeRun,
	readRun,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import {
	makeOptions,
	TEST_ROOT,
	uniqueRunId,
	VM_ADMISSION_ROOT,
} from "./helpers/run-store-fixtures.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_ROOT, "store");
process.env.SWITCHYARD_VM_ADMISSION_ROOT = VM_ADMISSION_ROOT;
process.env.SWITCHYARD_ROSTER_PATH = resolve(
	"tests/fixtures/roster.fixture.json",
);
after(() => {
	try {
		rmSync(TEST_ROOT, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
afterEach(() => {
	try {
		rmSync(join(TEST_ROOT, "store"), { recursive: true, force: true });
		rmSync(VM_ADMISSION_ROOT, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("retention", () => {
	async function createTerminalRun(idSuffix, overrides = {}) {
		const opts = makeOptions({
			runId: `retention-${idSuffix}-${uniqueRunId().slice(0, 8)}`,
		});
		await initializeRun(opts);

		let run = await advanceState(opts.runId, "succeeded");
		run = await updateRun(
			opts.runId,
			{ cleanupState: "complete", ...overrides },
			run.revision,
		);
		return run;
	}
	function writeMalformedRun(runId, rawContent) {
		const runDir = join(getStateRoot(), "runs", runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "run.json"), rawContent, "utf8");
		return runDir;
	}
	it("quarantines a run with an unsupported schemaVersion, surfacing SchemaError's static message", async () => {
		const runId = `quarantine-schema-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(runId, JSON.stringify({ schemaVersion: 99, runId }));

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 1);
		strictEqual(result.quarantined[0].runId, runId);
		strictEqual(
			result.quarantined[0].reason,
			"Unsupported schemaVersion (expected 1 or 2)",
		);
	});
	it("dryRun suppresses deletion of eligible runs but still quarantines malformed ones", async () => {
		const malformedRunId = `quarantine-dry-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(malformedRunId, "{ this is not json");
		const goodRun = await createTerminalRun("dry-keep");

		const result = await applyRetention({
			maxRuns: 0,
			maxAgeDays: 0,
			now: new Date(Date.now() + 86_400_000).toISOString(),
			dryRun: true,
		});
		// dryRun only suppresses the DELETION of eligible valid runs — the
		// protective quarantine move must still happen, or a malformed record
		// would fail this same scan forever under a dry-run-only dispatch.
		strictEqual(result.quarantined.length, 1);
		strictEqual(result.quarantined[0].runId, malformedRunId);
		strictEqual(
			existsSync(join(getStateRoot(), "runs", malformedRunId)),
			false,
			"the malformed run must leave the active scan even under dryRun",
		);
		strictEqual(
			existsSync(
				join(getStateRoot(), ".quarantine", malformedRunId, "run.json"),
			),
			true,
			"the malformed run must be moved into quarantine even under dryRun",
		);
		// ...while the eligible valid run is only reported, never deleted.
		strictEqual(result.deletedCount, 1);
		const r = await readRun(goodRun.runId);
		strictEqual(r.state, "succeeded");
	});
	it("quarantining a malformed run does not affect valid records in the same sweep", async () => {
		const badRunId = `quarantine-mixed-bad-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(badRunId, "garbage");
		const goodRun = await createTerminalRun("mixed-good");

		const result = await applyRetention({ maxRuns: 0 });
		strictEqual(result.deletedCount, 1);
		strictEqual(result.quarantined.length, 1);
		strictEqual(result.quarantined[0].runId, badRunId);

		await rejects(readRun(goodRun.runId), /Run not found/);
		await rejects(readRun(badRunId), /Run not found/);
		strictEqual(
			existsSync(join(getStateRoot(), ".quarantine", badRunId, "run.json")),
			true,
		);
	});
	it("does not quarantine a run directory whose run.json is absent (ENOENT)", async () => {
		const runId = `quarantine-nojson-${uniqueRunId().slice(0, 8)}`;
		const runDir = join(getStateRoot(), "runs", runId);
		mkdirSync(runDir, { recursive: true });
		// No run.json at all. This is the transient-missing signal a
		// concurrent initializeRun mid-flight produces (the window between
		// ensureDir and the atomic run.json write), which is indistinguishable
		// from a genuinely malformed record on this signal — so the
		// conservative choice is to leave the directory in place for a later
		// sweep rather than quarantine a legitimate run's directory.

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 0);
		strictEqual(
			existsSync(runDir),
			true,
			"a directory without run.json must be left in the active scan",
		);
		strictEqual(
			existsSync(join(getStateRoot(), ".quarantine", runId)),
			false,
			"a directory without run.json must not be quarantined",
		);
	});
	it("preserves a pre-existing quarantine artifact instead of overwriting it", async () => {
		const runId = `quarantine-collide-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(runId, "garbage");

		// Pre-seed `.quarantine/<runId>` with an existing artifact that must
		// survive the sweep untouched — the collision the move must never
		// overwrite or replace.
		const existingQuarantine = join(getStateRoot(), ".quarantine", runId);
		mkdirSync(existingQuarantine, { recursive: true });
		writeFileSync(
			join(existingQuarantine, "pre-existing.txt"),
			"keep me",
			"utf8",
		);

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 1);
		const entry = result.quarantined[0];
		strictEqual(entry.runId, runId);
		ok(
			entry.destination !== existingQuarantine,
			"a suffixed destination must be used on collision",
		);
		ok(
			entry.destination.startsWith(existingQuarantine),
			"the suffixed destination stays under .quarantine/<runId>",
		);
		strictEqual(
			existsSync(join(existingQuarantine, "pre-existing.txt")),
			true,
			"the pre-existing quarantine artifact must survive untouched",
		);
		strictEqual(
			existsSync(join(entry.destination, "run.json")),
			true,
			"the newly quarantined run must be preserved alongside the existing artifact",
		);
		strictEqual(
			existsSync(join(getStateRoot(), "runs", runId)),
			false,
			"the malformed run must leave the active scan",
		);
	});
	it("skips a run whose run.json is unreadable (EACCES) instead of quarantining it", {
		skip:
			process.platform === "win32" || process.getuid?.() === 0
				? "permissions not applicable on Windows or when running as root (uid 0 can still read mode-000 files)"
				: false,
	}, async () => {
		const runId = `quarantine-eacces-${uniqueRunId().slice(0, 8)}`;
		const runDir = join(getStateRoot(), "runs", runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "run.json"), "garbage {{{", "utf8");
		// chmod 000 makes readFile throw EACCES before JSON.parse can run, so
		// this read fails with a filesystem/IO error, NOT a SchemaError — the
		// non-SchemaError branch must skip, never quarantine. (The garbage
		// content is irrelevant; it is never reached.)
		chmodSync(join(runDir, "run.json"), 0o000);

		try {
			const result = await applyRetention({});
			strictEqual(result.quarantined.length, 0);
			strictEqual(
				existsSync(runDir),
				true,
				"an unreadable run.json is not a positive corruption signal; the directory must be left in the active scan",
			);
			strictEqual(
				existsSync(join(getStateRoot(), ".quarantine", runId)),
				false,
				"an unreadable run.json must not be quarantined",
			);
		} finally {
			// Restore permissions so the temp tree cleans up cleanly.
			chmodSync(join(runDir, "run.json"), 0o600);
		}
	});
	it("skips a run whose run.json is a directory (EISDIR) instead of quarantining it", async () => {
		const runId = `quarantine-eisdir-${uniqueRunId().slice(0, 8)}`;
		const runDir = join(getStateRoot(), "runs", runId);
		mkdirSync(runDir, { recursive: true });
		// readFile on a directory throws EISDIR — a non-SchemaError
		// filesystem/IO error that must be skipped conservatively, never
		// quarantined.
		mkdirSync(join(runDir, "run.json"));

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 0);
		strictEqual(
			existsSync(runDir),
			true,
			"a directory-shaped run.json must be left in the active scan, not quarantined",
		);
		strictEqual(
			existsSync(join(getStateRoot(), ".quarantine", runId)),
			false,
			"a directory-shaped run.json must not be quarantined",
		);
	});
	it("returns the raw on-disk destination and a separately sanitized destinationDisplay for bidi/zero-width names", async () => {
		const name = `quarantine-bidi-\u202e\u200b\u200e${uniqueRunId().slice(0, 8)}`;
		const runDir = join(getStateRoot(), "runs", name);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "run.json"), "garbage", "utf8");

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 1);
		const entry = result.quarantined[0];

		// The raw on-disk destination is preserved verbatim for machine use.
		const expectedDestination = join(getStateRoot(), ".quarantine", name);
		strictEqual(entry.destination, expectedDestination);
		strictEqual(existsSync(entry.destination), true);

		// The display variant is sanitized: no control, format, or separator
		// characters may survive.
		ok(
			!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(entry.destinationDisplay),
			"destinationDisplay must never carry control, format, or separator characters",
		);
		ok(
			!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(entry.runId),
			"runId metadata must never carry control, format, or separator characters",
		);
		ok(
			entry.destinationDisplay !== entry.destination,
			"destinationDisplay must differ from the raw destination when the name needs sanitization",
		);
		strictEqual(
			existsSync(runDir),
			false,
			"the bidi/zero-width-named run must still leave the active scan",
		);
	});
	it("returns destinationDisplay identical to the raw destination when no sanitization is needed", async () => {
		const runId = `quarantine-plain-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(runId, "garbage");

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 1);
		const entry = result.quarantined[0];
		strictEqual(entry.destination, join(getStateRoot(), ".quarantine", runId));
		strictEqual(entry.destinationDisplay, entry.destination);
	});
	it("sanitizes control and format characters in directory names from quarantine metadata", async () => {
		const runId = `quarantine-ctrl-${uniqueRunId().slice(0, 8)}\nINJECT`;
		writeMalformedRun(runId, "garbage");

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 1);
		const entry = result.quarantined[0];
		ok(
			!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(entry.runId),
			"returned runId metadata must never carry control or format characters",
		);
		ok(
			!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(entry.destinationDisplay),
			"returned destinationDisplay metadata must never carry control or format characters",
		);
		// The raw destination is the verbatim on-disk path, control
		// characters and all, so machine callers can still act on it.
		strictEqual(entry.destination, join(getStateRoot(), ".quarantine", runId));
		strictEqual(existsSync(entry.destination), true);
		// The raw directory was still moved out of the active scan, control
		// characters and all.
		strictEqual(existsSync(join(getStateRoot(), "runs", runId)), false);
	});
	it("a repeated sweep is idempotent: nothing left to quarantine or delete", async () => {
		const badRunId = `quarantine-repeat-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(badRunId, "garbage");
		await createTerminalRun("repeat-good");

		const first = await applyRetention({ maxRuns: 0 });
		strictEqual(first.quarantined.length, 1);
		strictEqual(first.deletedCount, 1);

		const second = await applyRetention({ maxRuns: 0 });
		strictEqual(
			second.quarantined.length,
			0,
			"already-quarantined runs are not re-reported on a repeated sweep",
		);
		strictEqual(
			second.deletedCount,
			0,
			"already-deleted runs are not re-reported on a repeated sweep",
		);
	});
	it("classifies each malformed category with a static, sanitized reason", async () => {
		const cases = [
			{
				name: `q-invalid-json-${uniqueRunId().slice(0, 8)}`,
				content: "not json {{",
				reason: "run.json contains invalid JSON",
			},
			{
				name: `q-non-object-${uniqueRunId().slice(0, 8)}`,
				content: "null",
				reason: "run.json is not a valid object",
			},
			{
				name: `q-bad-schema-${uniqueRunId().slice(0, 8)}`,
				content: JSON.stringify({ schemaVersion: 99 }),
				reason: "Unsupported schemaVersion (expected 1 or 2)",
			},
			{
				name: `q-missing-field-${uniqueRunId().slice(0, 8)}`,
				content: JSON.stringify({ schemaVersion: 1 }),
				reason: "runId must be a string",
			},
			{
				name: `dir name with spaces-${uniqueRunId().slice(0, 8)}`,
				content: "ignored",
				reason: "Invalid runId",
			},
		];
		for (const c of cases) writeMalformedRun(c.name, c.content);

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, cases.length);
		const byId = new Map(result.quarantined.map((e) => [e.runId, e]));
		for (const c of cases) {
			ok(byId.has(c.name), `expected ${c.name} to be quarantined`);
			strictEqual(byId.get(c.name).reason, c.reason);
			ok(
				!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(byId.get(c.name).reason),
				"a quarantined reason must never carry control or format characters",
			);
		}
	});
});
