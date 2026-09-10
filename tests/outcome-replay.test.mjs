import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	assertSafeSourceValue,
	CLASSIFICATION_PRECEDENCE,
	hashSourceIdentity,
	importRunDirectories,
	SORT_PRECEDENCE,
	SOURCE_FIELD_ALLOWLIST,
	serializeOutcomeReplayCorpus,
	validateSanitizedRecord,
} from "../scripts/build-outcome-replay-corpus.mjs";
import { reduceOutcomeEvents } from "../src/switchyard/outcome/reducer.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const TEMP_ROOT = tempDir("switchyard-outcome-replay-");

after(() => rmSync(TEMP_ROOT, { force: true, recursive: true }));

function makeRun(name, rows) {
	const directory = join(TEMP_ROOT, name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "events.jsonl"),
		`${rows.map(JSON.stringify).join("\n")}\n`,
	);
	return directory;
}

describe("outcome replay corpus", () => {
	it("is byte-identical across repeated explicit imports", () => {
		const source = makeRun("source-a", [
			{
				sequence: 2,
				phase: "provider",
				event: "execution_failed",
				status: "failed",
			},
			{
				sequence: 1,
				phase: "artifact",
				event: "diff_capture_failed",
				status: "failed",
			},
		]);
		strictEqual(
			serializeOutcomeReplayCorpus([source]),
			serializeOutcomeReplayCorpus([source]),
		);
	});

	it("requires explicit directories and hashes source identity", () => {
		const source = makeRun("source-identity", []);
		const records = importRunDirectories([source]);
		strictEqual(records.length, 0);
		strictEqual(
			hashSourceIdentity("source-identity"),
			hashSourceIdentity("source-identity"),
		);
		throws(() => importRunDirectories([]), /explicit_run_directories_required/);
	});

	it("rejects sensitive fields and unrestricted absolute paths", () => {
		for (const [index, source] of [
			{ prompt: "never retain" },
			{ rawStream: "never retain" },
			{ patchBytes: "never retain" },
			{ exception: "never retain" },
			{ credentials: "never retain" },
			{ environment: "never retain" },
			{ location: "/unrestricted/path" },
		].entries()) {
			throws(() => assertSafeSourceValue(source), /forbidden_/);
			const directory = makeRun(`sensitive-${index}`, [source]);
			throws(() => importRunDirectories([directory]), /forbidden_/);
		}
	});

	it("sorts and classifies with pinned precedence", () => {
		const source = makeRun("source-precedence", [
			{
				sequence: 3,
				phase: "artifact",
				event: "diff_capture_failed",
				status: "failed",
			},
			{
				sequence: 1,
				phase: "provider",
				event: "execution_failed",
				status: "failed",
			},
			{
				sequence: 2,
				phase: "provider",
				event: "execution_failed",
				status: "failed",
			},
		]);
		const records = importRunDirectories([source]);
		deepStrictEqual(
			records.map((record) => [
				record.stage,
				record.classification,
				record.counter,
			]),
			[
				["provider", "provider_failure", 1],
				["provider", "provider_failure", 2],
				["artifact", "artifact_failure", 1],
			],
		);
		deepStrictEqual(SOURCE_FIELD_ALLOWLIST, [
			"stage",
			"classification",
			"counter",
			"identityHash",
			"evidenceStatus",
		]);
		deepStrictEqual(SORT_PRECEDENCE, [
			"identityHash",
			"classification",
			"stage",
			"counter",
			"evidenceStatus",
		]);
		strictEqual(
			CLASSIFICATION_PRECEDENCE.indexOf("provider_failure") <
				CLASSIFICATION_PRECEDENCE.indexOf("artifact_failure"),
			true,
		);
	});

	it("pins current masking and counting baselines", () => {
		const corpus = JSON.parse(
			readFileSync("tests/fixtures/outcome-replay.json", "utf8"),
		);
		deepStrictEqual(corpus.baselines, {
			maskingPrimary: "provider_failure",
			maskingSecondary: "artifact_failure",
			logicalFailedTasks: 1,
			failureFacts: 2,
		});
		for (const record of corpus.records) validateSanitizedRecord(record);
		strictEqual(
			corpus.records.filter((record) => record.evidenceStatus === "observed")
				.length >= 2,
			true,
		);
	});

	it("replays both masking runs with provider primary and artifact secondary", () => {
		const maskingRuns = [
			[
				{
					sequence: 1,
					phase: "provider",
					event: "execution_failed",
					taskId: "1.1",
					reasonCode: "execution_failed",
					runId: "mask-a",
				},
				{
					sequence: 2,
					phase: "artifact",
					event: "diff_capture_failed",
					taskId: "1.1",
					reasonCode: "diff_capture_failed",
					runId: "mask-a",
				},
			],
			[
				{
					sequence: 4,
					phase: "artifact",
					event: "diff_capture_failed",
					taskId: "1.1",
					reasonCode: "diff_capture_failed",
					runId: "mask-b",
				},
				{
					sequence: 3,
					phase: "provider",
					event: "execution_failed",
					taskId: "1.1",
					reasonCode: "execution_failed",
					runId: "mask-b",
				},
			],
		];
		for (const events of maskingRuns) {
			const projection = reduceOutcomeEvents(events);
			strictEqual(projection.primaryFailure.reasonCode, "execution_failed");
			strictEqual(projection.primaryFailure.stage, "provider");
			strictEqual(projection.secondaryFailures.length, 1);
			strictEqual(
				projection.secondaryFailures[0].reasonCode,
				"diff_capture_failed",
			);
			strictEqual(projection.taskCounters.failed, 1);
		}
	});
});
