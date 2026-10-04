import { notStrictEqual, ok, strictEqual } from "node:assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
	describeExecError,
	sanitizeFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";
import {
	readLedgerFromStore,
	recordDispatchToStore,
} from "../src/switchyard/ledger/index.mjs";
import {
	__resetRosterCacheForTests,
	getRosterProvenance,
} from "../src/switchyard/roster/index.mjs";
import {
	FIXTURE_PATH,
	PROVENANCE_KEYS,
	previousHomeDir,
	previousRosterPath,
	setHomeDir,
	setRosterPath,
} from "./helpers/provenance-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let tmpDir;
before(() => {
	setRosterPath(FIXTURE_PATH);
});
afterEach(() => {
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
	setRosterPath(FIXTURE_PATH);
	setHomeDir(previousHomeDir);
});
after(() => {
	if (previousRosterPath === undefined)
		delete process.env.SWITCHYARD_ROSTER_PATH;
	else process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
	setHomeDir(previousHomeDir);
	__resetRosterCacheForTests();
});
describe("roster_sha256 is stable across a simulated `roster smoke` write-back", () => {
	it("flipping a qualification in the on-disk roster does not move the loader-computed sha", () => {
		// Baseline sha from the committed fixture.
		setRosterPath(FIXTURE_PATH);
		const shaBefore = getRosterProvenance().roster_sha256;

		// Simulate a smoke write-back: read the fixture, flip a qualification
		// status (and stamp a timestamp, as smoke does), write to a temp path.
		tmpDir = tempDir("switchyard-provenance-");
		const roster = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
		roster.targets["opencode-go"].qualifications["fixture/opencode-standard"] =
			{
				status: "qualified",
				last_smoke: "2026-07-31T12:00:00Z",
			};
		roster.targets["claude-code"].qualifications["fixture-claude-high"].status =
			"qualified";
		const writtenBack = join(tmpDir, "roster.smoke.json");
		writeFileSync(writtenBack, JSON.stringify(roster, null, 2), "utf8");

		setRosterPath(writtenBack);
		const shaAfter = getRosterProvenance().roster_sha256;

		strictEqual(
			shaAfter,
			shaBefore,
			"qualification write-back must not move the sha",
		);
	});

	it("changing a real routing field DOES move the loader-computed sha (control)", () => {
		setRosterPath(FIXTURE_PATH);
		const shaBefore = getRosterProvenance().roster_sha256;

		tmpDir = tempDir("switchyard-provenance-");
		const roster = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
		roster.targets["opencode-go"].slots.low[0].priority = 99; // real change
		const changed = join(tmpDir, "roster.changed.json");
		writeFileSync(changed, JSON.stringify(roster, null, 2), "utf8");

		setRosterPath(changed);
		const shaAfter = getRosterProvenance().roster_sha256;

		notStrictEqual(shaAfter, shaBefore);
	});
});
describe("recordDispatchToStore — provenance parity with the file ledger", () => {
	it("preserves the six provenance fields written into a store-backed ledger", async () => {
		tmpDir = tempDir("switchyard-provenance-store-");
		const provenance = {
			roster_schema_version: 1,
			roster_sha256: "a".repeat(64),
			resolved_target: "opencode-go",
			resolved_harness: "opencode",
			resolved_selector: "fixture/opencode-low",
			resolved_credential_profile: "go",
			requiredCapability: "low",
		};
		await recordDispatchToStore(
			{
				provider: "OpenCode Go",
				model: "fixture/opencode-low",
				taskId: "T-store",
				result: "success",
				...provenance,
			},
			tmpDir,
		);

		const entries = await readLedgerFromStore(tmpDir);
		strictEqual(entries.length, 1);
		for (const key of PROVENANCE_KEYS)
			ok(key in entries[0], `store entry missing ${key}`);
		strictEqual(entries[0].resolved_target, "opencode-go");
		strictEqual(entries[0].resolved_harness, "opencode");
		strictEqual(entries[0].roster_schema_version, 1);
		strictEqual(entries[0].resolved_credential_profile, "go");
	});

	it("persists static failure metadata without raw output or host paths", async () => {
		tmpDir = tempDir("switchyard-provenance-failure-");
		await recordDispatchToStore(
			{
				provider: "claude",
				model: "fixture-claude-high",
				taskId: "1.1",
				result: "execution_failed",
				errorKind: "provider_private_reason",
				reason: "SECRET_CANARY_provider_reason",
				error: "SECRET_CANARY_provider_error",
				output: "SECRET_CANARY_provider_output",
				partialDiffPath: "/Users/dave/project/.partial-diffs/1.1.diff",
			},
			tmpDir,
		);

		const [entry] = await readLedgerFromStore(tmpDir);
		strictEqual(entry.errorKind, "execution_failed");
		strictEqual(entry.reasonCode, "execution_failed");
		strictEqual(
			entry.reason,
			"Provider execution failed before a reviewed integration.",
		);
		strictEqual(entry.artifactRef, undefined);
		for (const key of ["error", "output", "partialDiffPath"]) {
			ok(
				!(key in entry),
				`raw field ${key} must not cross the ledger boundary`,
			);
		}
		ok(!JSON.stringify(entry).includes("SECRET_CANARY"));
	});

	it("preserves integration failure diagnostics without gate content", async () => {
		tmpDir = tempDir("switchyard-provenance-integration-");
		await recordDispatchToStore(
			{
				provider: "claude",
				model: "fixture-claude-standard",
				taskId: "1.1",
				result: "integration_failed",
				errorKind: "integration_failed",
				reason: "SECRET_CANARY_gate_message",
				error: "SECRET_CANARY_gate_error",
				output: "SECRET_CANARY_gate_output",
				partialDiffPath: "/Users/dave/project/.partial-diffs/1.1.diff",
			},
			tmpDir,
		);

		const [entry] = await readLedgerFromStore(tmpDir);
		strictEqual(entry.errorKind, "integration_failed");
		strictEqual(entry.reasonCode, "integration_failed");
		strictEqual(
			entry.reason,
			"The reviewed integration gate rejected the task result.",
		);
		strictEqual(entry.artifactRef, undefined);
		for (const key of ["error", "output", "partialDiffPath"]) {
			ok(
				!(key in entry),
				`raw field ${key} must not cross the ledger boundary`,
			);
		}
		ok(!JSON.stringify(entry).includes("SECRET_CANARY"));
	});

	it("capstone: verified provider quota classification persists safely", () => {
		// The matcher is provider-scoped and based on the approved sanitized
		// provider-boundary evidence. The transient result may retain the
		// diagnostic phrase, but the persisted projection must remain static.
		const transient = describeExecError(
			{
				message: "provider rejected the request",
				stdout: "Individual quota reached; retry after the reset window",
				stderr: "",
			},
			{ provider: "agy" },
		);
		strictEqual(transient.errorKind, "quota_exhausted");

		const persistent = sanitizeFailureMetadata({
			taskId: "1.1",
			result: "execution_failed",
			errorKind: transient.errorKind,
			partialDiffPath: "1.1.diff",
		});
		strictEqual(persistent.errorKind, "quota_exhausted");
		strictEqual(persistent.reasonCode, "quota_exhausted");
		ok(!JSON.stringify(persistent).includes("Individual quota reached"));
	});
});
