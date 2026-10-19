// @test-phase: other
import { notStrictEqual, ok, strictEqual } from "node:assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
	describeExecError,
	sanitizeFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";
import {
	__resetRosterCacheForTests,
	getRosterProvenance,
} from "../src/switchyard/roster/index.mjs";
import {
	FIXTURE_PATH,
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
describe("provider failure metadata persists safely", () => {
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
