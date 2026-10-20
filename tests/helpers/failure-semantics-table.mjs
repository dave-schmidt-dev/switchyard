/** Enumerate the pre-consolidation decision surface; expected bytes are frozen separately. */
import { FAILURE_ROWS } from "../../src/switchyard/diagnostics/failure-registry.mjs";
import { createProviderReliabilityDiagnostic as diagnostic } from "../../src/switchyard/diagnostics/provider-reliability.mjs";

const PHASES = [
	null,
	"preflight",
	"route",
	"prepare",
	"baseline",
	"execute",
	"provider",
	"diff",
	"checks",
	"check",
	"repair",
	"integrate",
	"cleanup",
	"input_validation",
	"unknown",
];
const SIGNALS = [
	{},
	{ timedOut: true },
	{ cancelled: true },
	...[
		"signal_sigterm",
		"signal_sigint",
		"internal_deadline",
		"unspecified",
	].map((cancelSource) => ({ cancelled: true, cancelSource })),
];
const PROVENANCES = [
	{},
	...["adapter", "launcher"].flatMap((diagnosticOrigin) =>
		[false, true].map((diagnosticEvidenceAvailable) => ({
			diagnosticOrigin,
			diagnosticEvidenceAvailable,
			failurePhase: "provider_execution",
		})),
	),
];

/** Return interned outputs and ordered row indexes, avoiding repeated golden objects. */
export function failureSemanticsTable(api) {
	const values = [];
	const ids = new Map();
	const groups = {};
	const put = (group, value) => {
		const key = JSON.stringify(value);
		if (!ids.has(key)) {
			ids.set(key, values.length);
			values.push(value);
		}
		groups[group] ??= [];
		groups[group].push(ids.get(key));
	};
	for (const reason of [
		...FAILURE_ROWS.map((row) => row.reason),
		null,
		"unregistered_reason",
	]) {
		for (const phase of PHASES)
			for (const signals of SIGNALS) {
				const resolved = api.resolveFailure({ reason, phase, ...signals });
				put("classify", resolved);
				const pr = diagnostic({
					causeCode: resolved.causeCode,
					phase:
						phase === "execute"
							? "provider"
							: phase === "checks"
								? "check"
								: phase,
					...signals,
				});
				const result = {
					status: "failed",
					failureReason: reason,
					failurePhase: phase,
					errorKind: resolved.errorKind,
					providerReliability: pr,
					...signals,
				};
				const classification = api.classifyAttemptFailure({ result });
				put("retry", classification);
				put(
					"attribute",
					api.deriveFailureAccountability({ providerReliability: pr }),
				);
				put("nonBlaming", api.nonBlamingCause(result));
				put("terminal", [
					api.failureTerminal(result, false),
					api.failureTerminal(result, true),
				]);
				put(
					"log",
					api.loggedFailureReason(
						result,
						api.deriveFailureAccountability({ providerReliability: pr }),
						classification,
					),
				);
				for (const partialWorktree of [null, "/owned/partial"])
					put(
						"salvage",
						api.classifyAttemptFailure({
							result: { ...result, partialWorktree },
						}),
					);
			}
	}
	for (const causeCode of [
		...new Set(FAILURE_ROWS.map((row) => row.causeCode)),
		"unknown",
	]) {
		for (const provenance of PROVENANCES)
			for (const phase of ["provider", "check", "baseline", "unknown"]) {
				const pr = diagnostic({
					causeCode,
					phase,
					exitCode: 3,
					timedOut: causeCode === "provider_deadline_exceeded",
					signal: "SIGTERM",
				});
				const input = {
					...provenance,
					diagnosticCode: causeCode,
					providerReliability: pr,
					exitCode: 3,
					signal: "SIGTERM",
				};
				put(
					"trustedAttribute",
					api.deriveFailureAccountability({
						providerReliability: pr,
						provenance: input,
					}),
				);
				put("healthCooldown", api.confirmedProviderCooldownCode(input));
				put(
					"invocation",
					api.providerInvocationReliability(input, { code: 3 }),
				);
				for (const healthLane of ["simple-direct", "queue-vm"])
					for (const cleanupStatus of ["succeeded", "pending"]) {
						const providerLifecycle = {
							schemaVersion: 1,
							writerLifecycle: "stopped",
							terminalStatus: "exited",
							cleanupStage: null,
							cleanupStatus,
							exitCode: 3,
							signal: "SIGTERM",
						};
						put("lifecycle", [
							api.providerLifecycleClosed({
								...input,
								healthLane,
								providerLifecycle,
							}),
							api.lifecycleBackedEventCode(input),
							api.lifecycleBackedProviderFailure(
								pr,
								providerLifecycle,
								"stopped",
							),
						]);
						put(
							"lifecycleAttribute",
							api.deriveFailureAccountability({
								providerReliability: pr,
								provenance: {
									...input,
									providerLifecycle,
									providerWriterLifecycle: "stopped",
								},
							}),
						);
					}
			}
	}
	for (const reason of [
		"execution_failed",
		"environment_failure",
		"baseline_failed",
		"policy_rejected",
		"check_failed",
		"lifecycle_recovered",
	]) {
		for (const terminal of ["failed", "skipped", "succeeded"])
			for (const nonBlamingCause of [
				undefined,
				"quota_exhausted",
				"caller_cancelled",
			]) {
				const attempts = [
					{
						taskId: "task",
						targetId: "target",
						terminal,
						reason,
						nonBlamingCause,
					},
				];
				put("taskExclusion", [...api.taskExcludedTargets(attempts, "task")]);
			}
	}
	for (const errno of ["EPERM", "ENOSPC", "ECONNREFUSED", "UNKNOWN", null])
		put(
			"errno",
			api.resolveFailure({
				reason: "unregistered_reason",
				phase: "prepare",
				errno,
			}),
		);
	put(
		"executables",
		api.resolveFailure({
			reason: "check_environment_failed",
			phase: "baseline",
			checkExecutable: "/clone/node",
			hostExecutable: "/host/node",
		}),
	);
	for (const providerReliability of [
		undefined,
		null,
		{},
		{ causeCode: "quota_exhausted" },
	]) {
		put("malformed", [
			api.deriveFailureAccountability({ providerReliability }),
			api.nonBlamingCause({ providerReliability }),
			api.confirmedProviderCooldownCode({ providerReliability }),
		]);
	}

	for (const causeCode of [
		...new Set(FAILURE_ROWS.map((row) => row.causeCode)),
	]) {
		const providerReliability = diagnostic({ causeCode, phase: "prepare" });
		const raw = api.projectRunFailureForDisk({
			lastFailure: { providerReliability },
			failureDetails: { causeCode },
		});
		put("diskProjection", raw);
		put("diskUpgrade", api.upgradeRunFailureFromDisk(structuredClone(raw)));
		for (const provenance of PROVENANCES) {
			const result = { status: "failed", providerReliability, ...provenance };
			put("quotaMarker", api.shouldRecordRouteExhaustion(result));
		}
	}
	for (const errorKind of [
		...FAILURE_ROWS.map((row) => row.errorKind),
		"unregistered_kind",
	]) {
		for (const failurePhase of [
			"provider_execution",
			"provider_cleanup",
			"checks",
			"prepare",
		]) {
			for (const success of [true, false]) {
				put(
					"queueBlame",
					api.isTargetFailure({ errorKind, failurePhase, success }, "results"),
				);
				put(
					"queueEventBlame",
					api.isTargetFailure(
						{
							errorKind,
							failurePhase,
							phase: "execution",
							event: "task_failed",
						},
						"event",
					),
				);
			}
		}
	}
	return {
		version: 1,
		base: "0a71c51cf946a4608795a8ab662cdd6c94bd162f",
		values,
		groups,
	};
}
