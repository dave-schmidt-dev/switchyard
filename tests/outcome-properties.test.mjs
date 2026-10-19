// @test-phase: properties
import { strictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import fc from "fast-check";
import { isOutcomeEvent } from "../src/switchyard/outcome/schema.mjs";

const RUN_ID = "property-run";
const HASH = `sha256:${"a".repeat(64)}`;
const DIAGNOSTIC = `diagnostic:${"b".repeat(32)}`;

// The runner supplies a candidate-derived seed. A fixed fallback keeps direct
// `node --test` runs reproducible without ever generating user content.
const PROPERTY_SEED =
	Number.parseInt(process.env.SWITCHYARD_PROPERTY_SEED ?? "1333406745", 10) >>>
	0;

function idArbitrary(prefix = "id") {
	return fc
		.stringMatching(/^[a-z][a-z0-9:-]{0,11}$/u)
		.map((value) => `${prefix}-${value}`);
}

function event({ id, sequence, stage, status, taskId = "task-1", detail }) {
	return {
		schemaVersion: 1,
		minimumReaderVersion: 1,
		writerEpoch: "epoch-1",
		outcomeId: id,
		sequence,
		runId: RUN_ID,
		scope: "task",
		taskId,
		attemptId: "attempt-1",
		resumesOutcomeId: null,
		stage,
		legacyPhase: null,
		legacyEvent: null,
		dispatchCausality: HASH,
		attempt: 1,
		recordedAt: `2026-09-09T12:00:${String((sequence % 59) + 1).padStart(2, "0")}.000Z`,
		producer: stage === "provider" ? "provider-lifecycle" : "runner",
		causedBy: null,
		operationId: `${stage}-operation`,
		status,
		detail,
	};
}

const terminalStatus = fc.constantFrom(
	"succeeded",
	"failed",
	"uncertain",
	"skipped",
);
const stage = fc.constantFrom(
	"run",
	"preflight",
	"worker",
	"provider",
	"artifact",
	"integration",
	"cleanup",
	"recovery",
	"postcondition",
);
const detailFor = (selectedStage, selectedStatus) => {
	if (selectedStage === "provider") {
		return selectedStatus === "failed" || selectedStatus === "uncertain"
			? fc.constant({
					code: "execution_failed",
					reasonCode: "execution_failed",
					evidenceAvailable: true,
					diagnosticRef: DIAGNOSTIC,
					diagnosticOrigin: "adapter",
				})
			: fc.constant({
					code: "provider_complete",
					servedModelVerified: true,
					completionContinuationProof: true,
					targetId: "provider",
				});
	}
	if (selectedStage === "artifact")
		return fc.constant({
			code:
				selectedStatus === "failed"
					? "diff_capture_failed"
					: "artifact_complete",
			captured: selectedStatus === "succeeded",
		});
	if (selectedStage === "integration")
		return fc.constant({
			code:
				selectedStatus === "failed"
					? "integration_failed"
					: "integration_complete",
			accepted: selectedStatus === "succeeded",
		});
	if (selectedStage === "cleanup")
		return fc.constant({
			code: selectedStatus === "failed" ? "cleanup_failed" : "cleanup_complete",
			mutationState: selectedStatus === "succeeded" ? "completed" : "uncertain",
			mutationOutcome:
				selectedStatus === "succeeded" ? "confirmed" : "ambiguous",
			postcondition: selectedStatus === "succeeded",
			ownership: selectedStatus === "succeeded" ? "confirmed" : "unknown",
			reconciled: false,
			idempotency: "conditional",
		});
	if (selectedStage === "recovery")
		return fc.constant({
			code: "recovery_required",
			reasonCode: "orphan_attempt",
		});
	if (selectedStage === "run")
		return fc.constant({
			code: selectedStatus === "succeeded" ? "complete" : "run_failed",
		});
	return fc.constant({ code: `${selectedStage}_state` });
};

const eventArbitrary = fc
	.tuple(
		stage,
		terminalStatus,
		idArbitrary("event"),
		fc.integer({ min: 1, max: 40 }),
	)
	.chain(([selectedStage, status, id, sequence]) =>
		detailFor(selectedStage, status).map((detail) =>
			event({ id, sequence, stage: selectedStage, status, detail }),
		),
	);

function assertProperty(name, property) {
	try {
		fc.assert(property, {
			numRuns: 1000,
			seed: PROPERTY_SEED,
			endOnFailure: true,
		});
	} catch (error) {
		const output = `${error?.message ?? ""}\n${error?.cause?.message ?? ""}`;
		const path =
			error?.path ??
			error?.cause?.path ??
			output.match(/path:\s*"([^"]+)"/u)?.[1] ??
			"unknown";
		const reportedSeed = output.match(/seed:\s*(-?\d+)/u)?.[1];
		const failureSeed =
			reportedSeed === undefined
				? PROPERTY_SEED
				: Number.parseInt(reportedSeed, 10);
		const digest = createHash("sha256")
			.update(`${failureSeed}:${name}:${path}`)
			.digest("hex")
			.slice(0, 16);
		const record = {
			schemaVersion: 1,
			property: name,
			seed: failureSeed,
			path,
			replay: `SWITCHYARD_PROPERTY_SEED=${failureSeed} npm run test:properties -- --test-name-pattern='${name}'`,
			candidateDigest: process.env.SWITCHYARD_CANDIDATE_DIGEST ?? "unknown",
			attribution: "candidate-versus-parent-pending",
			failureRecord: `property-failure:${digest}`,
		};
		const diagnosticFile = process.env.SWITCHYARD_PROPERTY_DIAGNOSTIC_FILE;
		if (diagnosticFile) writeFileSync(diagnosticFile, JSON.stringify(record));
		console.error(JSON.stringify(record));
		throw error;
	}
}

describe("outcome contract properties", () => {
	it("schema rejection property (1000 cases)", () => {
		assertProperty(
			"schema-rejection",
			fc.property(eventArbitrary, (candidate) => {
				const invalid = {
					...candidate,
					detail: { ...candidate.detail, unexpected: "synthetic" },
				};
				strictEqual(isOutcomeEvent(invalid), false);
			}),
		);
	});
});
