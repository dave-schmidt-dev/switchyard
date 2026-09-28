import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createExecutionOutcome } from "../src/switchyard/broker/outcome.mjs";
import {
	compareShadowParity,
	mergeOutcomeShadow,
	projectOutcomeShadow,
	shadowDigest,
	validateExpectedDifference,
	validateShadowEnvelope,
} from "../src/switchyard/outcome/shadow.mjs";
import { createStageOutcome } from "../src/switchyard/run-store/index.mjs";
import { HISTORICAL_CLEANUP_SNAPSHOT } from "./helpers/outcome-shadow-historical-snapshot.mjs";

const committedCorpus = JSON.parse(
	readFileSync("tests/fixtures/outcome-replay.json", "utf8"),
);
const COMMITTED_CORPUS_DIGEST =
	"sha256:aaf2a905522ac8526d521bf616fe8a88c551957d6ea21d5a0ff31b7c9e2111ea";

const HISTORICAL_CLEANUP_SNAPSHOT_DIGEST =
	"sha256:a047bfec118921fba948e37460b41fd24b9709082091002bf9567fc020b97ee9";

const HISTORICAL_EXPECTED_DIFFERENCES = Object.freeze([
	{
		version: 1,
		fixture:
			"sha256:319d07e30b03926d53cbd4cf7d4b396328b69e9782c7d50c74a258bbc7069b2b",
		fixtureDigest: HISTORICAL_CLEANUP_SNAPSHOT_DIGEST,
		field: "finalStatus",
		legacyValue: "failed",
		reducerValue: "succeeded",
		evidenceBasis: "historical_record",
		reviewerDisposition: "accepted",
	},
	{
		version: 1,
		fixture:
			"sha256:7a81052bf14d2bb7375f53aa96f9b284d851280d78f09e87815ce99e4628a155",
		fixtureDigest: HISTORICAL_CLEANUP_SNAPSHOT_DIGEST,
		field: "finalStatus",
		legacyValue: "failed",
		reducerValue: "uncertain",
		evidenceBasis: "historical_record",
		reviewerDisposition: "accepted",
	},
]);
function stage(runId, stageName, status, code, taskId = null) {
	return createStageOutcome({
		runId,
		taskId,
		stage: stageName,
		status,
		producer: stageName === "recovery" ? "recovery" : "runner",
		code,
		detail:
			stageName === "run"
				? { code }
				: stageName === "recovery"
					? {
							code,
							reasonCode: code,
							operatorCommand: "switchyard-dispatch recover",
						}
					: { code, artifactKind: "diff", captured: status === "succeeded" },
	});
}

describe("outcome shadow parity", () => {
	it("binds parity evidence to both immutable committed corpora", () => {
		strictEqual(shadowDigest(committedCorpus), COMMITTED_CORPUS_DIGEST);
		strictEqual(committedCorpus.records.length, 16);
		strictEqual(
			committedCorpus.records.filter((record) => record.stage === "cleanup")
				.length,
			1,
		);
		ok(committedCorpus.records.every((record) => record.evidenceStatus));
		strictEqual(
			shadowDigest(HISTORICAL_CLEANUP_SNAPSHOT),
			HISTORICAL_CLEANUP_SNAPSHOT_DIGEST,
		);
		strictEqual(HISTORICAL_CLEANUP_SNAPSHOT.length, 50);
		strictEqual(
			HISTORICAL_CLEANUP_SNAPSHOT.filter(
				(record) => record.legacy.cleanupState === "complete",
			).length,
			49,
		);
		strictEqual(
			HISTORICAL_CLEANUP_SNAPSHOT.filter(
				(record) => record.legacy.cleanupState === "not_started",
			).length,
			1,
		);
		ok(HISTORICAL_EXPECTED_DIFFERENCES.length > 0);
		for (const difference of HISTORICAL_EXPECTED_DIFFERENCES)
			validateExpectedDifference(difference);
	});

	it("replays the immutable sanitized cleanup snapshot through shadow parity", () => {
		strictEqual(
			shadowDigest(HISTORICAL_CLEANUP_SNAPSHOT),
			HISTORICAL_CLEANUP_SNAPSHOT_DIGEST,
		);
		const observedDifferences = [];
		for (const record of HISTORICAL_CLEANUP_SNAPSHOT) {
			strictEqual(/^sha256:[a-f0-9]{64}$/u.test(record.identityHash), true);
			strictEqual(record.evidenceStatus, "historical_sanitized");
			strictEqual(
				Object.keys(record).sort().join(","),
				"events,evidenceStatus,identityHash,legacy,observedReducerStatus",
			);
			strictEqual(
				Object.hasOwn(record, "runId") ||
					Object.hasOwn(record, "path") ||
					Object.hasOwn(record, "diagnostic"),
				false,
			);
			for (const event of record.events) {
				ok(
					["sequence", "phase", "event", "taskId", "reasonCode"].every(
						(key) => !Object.hasOwn(event, key) || event[key] !== undefined,
					),
				);
				strictEqual(Object.hasOwn(event, "state"), false);
				strictEqual(Object.hasOwn(event, "cleanupState"), false);
			}
			const expected = HISTORICAL_EXPECTED_DIFFERENCES.filter(
				(difference) => difference.fixture === record.identityHash,
			);
			const options = {
				run: {
					runId: record.identityHash,
					state: record.legacy.state,
					cleanupState: record.legacy.cleanupState,
				},
				fixture: record.identityHash,
				fixtureDigest: HISTORICAL_CLEANUP_SNAPSHOT_DIGEST,
			};
			const observed = projectOutcomeShadow(record.events, options);
			if (observed.parity.status === "mismatch") {
				observedDifferences.push({
					version: 1,
					fixture: record.identityHash,
					fixtureDigest: HISTORICAL_CLEANUP_SNAPSHOT_DIGEST,
					field: "finalStatus",
					legacyValue: observed.parity.legacyStatus,
					reducerValue: observed.parity.reducerStatus,
					evidenceBasis: "historical_record",
				});
			}
			const shadow = projectOutcomeShadow(record.events, {
				...options,
				expectedHistoricalDifferences: expected,
			});
			strictEqual(shadow.projection.finalStatus, record.observedReducerStatus);
			strictEqual(shadow.parity.status, "match");
			deepStrictEqual(shadow.parity.expectedHistoricalDifferences, expected);
			if (record.legacy.missingFields.includes("diagnosticOrigin"))
				deepStrictEqual(shadow.projection.diagnosticEvidence.origins, []);
			if (record.legacy.missingFields.includes("diagnosticEvidenceAvailable"))
				strictEqual(shadow.projection.diagnosticEvidence.available, false);
		}
		deepStrictEqual(
			observedDifferences,
			HISTORICAL_EXPECTED_DIFFERENCES.map(
				({ reviewerDisposition: _reviewerDisposition, ...difference }) =>
					difference,
			),
		);
	});

	it("replays the real queued-to-resolved recovery matrix", () => {
		const matrix = HISTORICAL_CLEANUP_SNAPSHOT.map((record, index) => ({
			id: `historical-${index}`,
			identityHash: record.identityHash,
			queuedCode: index % 2 === 0 ? "orphan_attempt" : "recovery_required",
			resolvedCode:
				index % 3 === 0 ? "postcondition_observed" : "cleanup_reconciled",
		}));
		strictEqual(matrix.length, 50);
		for (const entry of matrix) {
			strictEqual(entry.identityHash.startsWith("sha256:"), true);
			const queued = projectOutcomeShadow(
				[
					stage(
						`recovery-${entry.id}`,
						"recovery",
						"failed",
						entry.queuedCode,
						"1.1",
					),
				],
				{ run: { runId: `recovery-${entry.id}`, state: "recovery_required" } },
			);
			strictEqual(queued.parity.status, "match");
			strictEqual(queued.recoveryQueue.length, 1);
			strictEqual(queued.recoveryQueue[0].automaticRetry, false);
			strictEqual(queued.recoveryQueue[0].executionSlotConsumed, false);
			const resolved = projectOutcomeShadow(
				[
					stage(
						`recovery-${entry.id}`,
						"recovery",
						"succeeded",
						entry.resolvedCode,
						"1.1",
					),
					stage(`recovery-${entry.id}`, "run", "succeeded", "completed"),
				],
				{
					run: {
						runId: `recovery-${entry.id}`,
						state: "succeeded",
						cleanupState: "complete",
					},
				},
			);
			strictEqual(resolved.parity.status, "match");
			strictEqual(resolved.recoveryQueue.length, 0);
		}
	});

	it("requires exact, versioned historical differences and preserves them", () => {
		const expected = {
			version: 1,
			fixture: "historical-cleanup-snapshot-v1",
			fixtureDigest: HISTORICAL_CLEANUP_SNAPSHOT_DIGEST,
			field: "finalStatus",
			legacyValue: "failed",
			reducerValue: "unknown",
			evidenceBasis: "historical_record",
			reviewerDisposition: "accepted",
		};
		const comparison = compareShadowParity(
			{ status: "failed" },
			{ finalStatus: "unknown" },
			{ fixture: expected.fixture, expectedHistoricalDifferences: [expected] },
		);
		strictEqual(comparison.status, "mismatch");
		const acceptedComparison = compareShadowParity(
			{ status: "failed" },
			{ finalStatus: "unknown" },
			{
				fixture: expected.fixture,
				fixtureDigest: expected.fixtureDigest,
				expectedHistoricalDifferences: [expected],
			},
		);
		strictEqual(acceptedComparison.status, "match");
		deepStrictEqual(acceptedComparison.allowedHistoricalDifferences, [
			expected,
		]);
		validateExpectedDifference(expected);
		throws(
			() => validateExpectedDifference({ ...expected, rawStream: "discard" }),
			/historical parity record/,
		);
		const resolvedComparison = compareShadowParity(
			{ status: "failed" },
			{ finalStatus: "unknown" },
			{
				fixture: expected.fixture,
				fixtureDigest: expected.fixtureDigest,
				expectedHistoricalDifferences: [
					{ ...expected, reviewerDisposition: "resolved" },
				],
			},
		);
		strictEqual(resolvedComparison.status, "mismatch");
	});

	it("latches a mismatch and rejects unsanitized shadow envelopes", () => {
		const mismatch = projectOutcomeShadow(
			[stage("shadow-mismatch", "recovery", "failed", "orphan_attempt", "1.1")],
			{ run: { runId: "shadow-mismatch", state: "failed" } },
		);
		const later = projectOutcomeShadow(
			[stage("shadow-mismatch", "run", "succeeded", "completed")],
			{ run: { runId: "shadow-mismatch", state: "failed" } },
		);
		const latched = mergeOutcomeShadow(mismatch, later);
		strictEqual(latched.parity.status, "mismatch");
		strictEqual(latched.parity.cutoverBlocked, true);
		strictEqual(typeof latched.parity.mismatchDigest, "string");
		strictEqual(shadowDigest({ a: 1 }), shadowDigest({ a: 1 }));
		validateShadowEnvelope(latched);
		throws(
			() => validateShadowEnvelope({ ...latched, secret: "discard" }),
			/shadow envelope is not closed/,
		);
	});

	it("keeps ordinary production dual writes mismatch-free and complete", () => {
		const result = projectOutcomeShadow(
			[
				createExecutionOutcome({
					request: { runId: "ordinary-production", taskId: "1.1" },
					route: { provider: "fixture", resolvedTarget: "fixture-target" },
					launcherResult: {
						success: false,
						errorKind: "execution_failed",
						diagnosticOrigin: "provider",
						diagnosticRef: `diagnostic:${"a".repeat(32)}`,
						diagnosticEvidenceAvailable: true,
						servedModelVerified: true,
						completionContinuationProof: true,
					},
				}),
			],
			{ run: { runId: "ordinary-production", state: "failed" } },
		);
		strictEqual(result.parity.status, "match");
		strictEqual(result.parity.mismatchFields.length, 0);
		ok(Object.hasOwn(result.projection, "diagnosticEvidence"));
		ok(Object.hasOwn(result.projection, "reviewProof"));
		ok(Object.hasOwn(result.projection, "modelProof"));
		strictEqual(result.projection.diagnosticEvidence.available, true);
		strictEqual(result.projection.diagnosticEvidence.origins[0], "provider");
		strictEqual(result.projection.modelProof.servedModelVerified, true);
		validateShadowEnvelope(result);
		const ordinaryWithHistoricalRecord = projectOutcomeShadow(
			[stage("ordinary-production", "run", "succeeded", "completed")],
			{
				run: { runId: "ordinary-production", state: "failed" },
				fixture: "ordinary-production",
				fixtureDigest: COMMITTED_CORPUS_DIGEST,
				expectedHistoricalDifferences: [
					{
						version: 1,
						fixture: "historical-cleanup-snapshot-v1",
						fixtureDigest: HISTORICAL_CLEANUP_SNAPSHOT_DIGEST,
						field: "finalStatus",
						legacyValue: "failed",
						reducerValue: "unknown",
						evidenceBasis: "historical_record",
						reviewerDisposition: "accepted",
					},
				],
			},
		);
		strictEqual(ordinaryWithHistoricalRecord.parity.status, "mismatch");
	});
});
