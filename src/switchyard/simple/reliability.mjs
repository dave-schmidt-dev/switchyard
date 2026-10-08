import { resolveFailure } from "../diagnostics/failure-registry.mjs";
import { createProviderReliabilityDiagnostic } from "../diagnostics/provider-reliability.mjs";
import { extractErrno } from "./overlay.mjs";

function phaseForFailure(phase) {
	if (phase === "execute") return "provider";
	if (phase === "checks") return "check";
	return phase;
}

export function createSimpleProviderReliabilityDiagnostic(input = {}) {
	const reason = input.failureReason ?? null;
	const failurePhase = input.failurePhase ?? "unknown";
	const resolution = resolveFailure({
		reason,
		phase: failurePhase,
		errorKind: input.errorKind,
		providerResult: input.providerResult,
		timedOut: input.timedOut,
		cancelled: input.cancelled,
	});
	const timedOut =
		resolution.timedOut === true
			? true
			: (input.timedOut ?? input.providerResult?.timedOut);
	return createProviderReliabilityDiagnostic({
		causeCode: resolution.causeCode,
		phase: phaseForFailure(failurePhase),
		exitCode: input.exitCode ?? input.providerResult?.code,
		signal: input.signal ?? input.providerResult?.signal,
		timedOut,
		cancelled:
			input.cancelled ??
			(input.providerResult?.cancelled === true ||
			input.providerResult?.cancelled === false
				? input.providerResult.cancelled
				: null),
		checkIndex: input.checkIndex,
		checkIdentity: input.checkIdentity,
		baselineStatus: input.baselineStatus,
		diffRejectionCategory:
			input.diffRejectionCategory ?? resolution.diffCategory,
		diffRejectionCount: input.diffRejectionCount,
		repairCount: input.repairCount,
		repairStatus: input.repairStatus,
	});
}

export function classifySimpleErrorKind(
	failureReason,
	failurePhase,
	error = null,
) {
	const errno =
		extractErrno(error) ??
		(typeof failureReason === "string" && /^[A-Z0-9]+$/u.test(failureReason)
			? failureReason
			: null);
	return resolveFailure({
		reason: failureReason,
		phase: failurePhase,
		errno,
	}).errorKind;
}
