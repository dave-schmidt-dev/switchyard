// @test-phase: other
import { deepStrictEqual, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	projectRunFailureForDisk,
	upgradeRunFailureFromDisk,
} from "../src/switchyard/adapter/run-failure-disk.mjs";
import * as semantics from "../src/switchyard/diagnostics/failure-semantics.mjs";
import { createProviderReliabilityDiagnostic as diagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import { failedAttemptStop } from "../src/switchyard/simple/routing-attempt-outcome.mjs";

const fixture = JSON.parse(
	readFileSync(
		new URL("./fixtures/failure-semantics.divergences.json", import.meta.url),
		"utf8",
	),
);

test("quota consumers retain their distinct legacy evidence gates pending FAIL-2", () => {
	for (const row of fixture.quota) {
		const providerReliability = diagnostic({
			causeCode: "quota_exhausted",
			phase: "provider",
		});
		const input = {
			status: "failed",
			providerReliability,
			diagnosticCode: "quota_exhausted",
			diagnosticOrigin: row.origin ?? undefined,
			diagnosticEvidenceAvailable: row.evidenceAvailable,
			failurePhase: "provider_execution",
		};
		deepStrictEqual(
			{
				marker: semantics.shouldRecordRouteExhaustion(input),
				nonBlamingCause: semantics.nonBlamingCause(input),
				owner: semantics.deriveFailureAccountability({
					providerReliability,
					provenance: input,
				}).owner,
				cooldown: semantics.confirmedProviderCooldownCode(input),
				invocationCause: semantics.providerInvocationReliability(input, {
					code: 3,
				}).causeCode,
			},
			row.expected,
			row.id,
		);
	}
});

test("task exclusion and ownership retain their distinct legacy rules pending FAIL-3", () => {
	for (const row of fixture.blame) {
		const providerReliability = diagnostic({
			causeCode: row.causeCode,
			phase: "provider",
			timedOut: row.causeCode === "provider_deadline_exceeded",
		});
		const result = { providerReliability };
		const accountability = semantics.deriveFailureAccountability({
			providerReliability,
		});
		const classification = semantics.classifyAttemptFailure({
			result,
			accountability,
		});
		const terminal = semantics.failureTerminal(
			result,
			accountability.providerMemoryEligible,
		);
		const attempts = [
			{
				taskId: "task",
				targetId: "target",
				terminal,
				reason: classification.reason,
			},
		];
		deepStrictEqual(
			{
				owner: accountability.owner,
				reason: classification.reason,
				terminal,
				taskExcluded: semantics
					.taskExcludedTargets(attempts, "task")
					.has("target"),
			},
			row.expected,
			row.causeCode,
		);
	}
});

test("real pre-provider canary keeps the precise setup cause through the rollback disk stand-in", () => {
	const row = fixture.canary;
	const providerReliability = diagnostic({
		causeCode: row.preciseCause,
		phase: row.failurePhase,
	});
	const record = {
		lastFailure: { providerReliability },
		failureDetails: {
			failureReason: row.failureReason,
			causeCode: row.preciseCause,
			checkSetupStep: row.checkSetupStep,
		},
	};
	const raw = projectRunFailureForDisk(record);
	strictEqual(raw.lastFailure.providerReliability.causeCode, row.diskCause);
	strictEqual(raw.failureDetails.causeCode, row.preciseCause);
	const restored = upgradeRunFailureFromDisk(structuredClone(raw));
	strictEqual(
		restored.lastFailure.providerReliability.causeCode,
		row.preciseCause,
	);
	const result = {
		status: "failed",
		failureReason: row.failureReason,
		failurePhase: row.failurePhase,
		providerReliability: restored.lastFailure.providerReliability,
	};
	const accountability = semantics.deriveFailureAccountability({
		providerReliability: result.providerReliability,
	});
	const classification = semantics.classifyAttemptFailure({
		result,
		accountability,
	});
	strictEqual(classification.reason, row.attemptReason);
	strictEqual(
		semantics.loggedFailureReason(result, accountability, classification),
		row.attemptReason,
	);
	const stop = failedAttemptStop({
		result,
		classification,
		accountability,
		refusalCode: row.preciseCause,
	});
	strictEqual(stop.stopReason, row.stopReason);
	// On-disk bytes remain compatible; only the supported read projection restores it.
	strictEqual(raw.lastFailure.providerReliability.causeCode, "unknown");
});
