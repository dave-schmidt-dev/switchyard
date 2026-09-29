import {
	normalizeProviderName,
	validateInvocationDescriptor,
} from "../roster/index.mjs";
import { parseJsonPayload, runCliCommand } from "./checkpoint-errors.mjs";
import { DISPATCH_DESCRIPTOR_CONTRACT_VERSION } from "./constants.mjs";

function parseArgsJson(rawArgsJson) {
	if (!rawArgsJson) return [];
	let parsed;
	try {
		parsed = JSON.parse(rawArgsJson);
	} catch {
		throw new Error("SWITCHYARD_ORCHESTRATOR_ARGS_JSON must be valid JSON");
	}

	if (
		!Array.isArray(parsed) ||
		!parsed.every((arg) => typeof arg === "string")
	) {
		throw new Error(
			"SWITCHYARD_ORCHESTRATOR_ARGS_JSON must be a JSON string array",
		);
	}
	return parsed;
}
function descriptorFromRoute(
	routeResult,
	requiredCapability,
	resolveDescriptor,
) {
	if (!routeResult?.provider) return null;
	const routeTarget = routeResult.resolvedTargetId ?? null;
	const descriptorLookupTarget = routeTarget ?? routeResult.provider;
	const harness = routeResult.resolved_harness ?? routeResult.provider;
	const suppliedKey = [
		"invocationDescriptor",
		"invocation_descriptor",
		"dispatchDescriptor",
		"dispatch_descriptor",
	].find((key) => Object.hasOwn(routeResult, key));
	const supplied = suppliedKey ? routeResult[suppliedKey] : undefined;
	const current = resolveDescriptor(descriptorLookupTarget, requiredCapability);
	if (!current) {
		throw new Error(
			`missing dispatch descriptor receipt for ${descriptorLookupTarget ?? "unknown target"}`,
		);
	}
	const validatedCurrent = validateInvocationDescriptor(current, harness);
	if (routeTarget && validatedCurrent.target_id !== routeTarget) {
		throw new Error("dispatch descriptor target does not match routed target");
	}
	if (routeResult.model && routeResult.model !== validatedCurrent.selector) {
		throw new Error("dispatch descriptor selector does not match routed model");
	}
	if (supplied !== undefined && supplied !== null) {
		const validatedSupplied = validateInvocationDescriptor(supplied, harness);
		if (
			validatedSupplied.descriptor_identity !==
			validatedCurrent.descriptor_identity
		) {
			throw new Error("dispatch descriptor receipt changed or is stale");
		}
		if (routeTarget && validatedSupplied.target_id !== routeTarget) {
			throw new Error(
				"dispatch descriptor target does not match routed target",
			);
		}
		descriptorHarnesses.set(validatedSupplied, normalizeProviderName(harness));
		return validatedSupplied;
	}
	if (supplied === null) {
		throw new Error("missing dispatch descriptor receipt");
	}
	descriptorHarnesses.set(validatedCurrent, normalizeProviderName(harness));
	return validatedCurrent;
}
const descriptorHarnesses = new WeakMap();
function descriptorReceiptFields(descriptor, harness = null) {
	return descriptor
		? {
				dispatchContractVersion: DISPATCH_DESCRIPTOR_CONTRACT_VERSION,
				invocationDescriptor: descriptor,
				descriptorIdentity: descriptor.descriptor_identity,
				descriptorHarness:
					harness ?? descriptorHarnesses.get(descriptor) ?? null,
			}
		: {
				dispatchContractVersion: DISPATCH_DESCRIPTOR_CONTRACT_VERSION,
				invocationDescriptor: null,
				descriptorIdentity: null,
				descriptorHarness: null,
			};
}
const SAFE_LEDGER_ERROR_CODES = new Set([
	"EACCES",
	"EPERM",
	"EROFS",
	"ENOSPC",
	"EIO",
	"EMFILE",
	"ENFILE",
]);
const SAFE_ROUTE_REASON_CODES = new Set([
	"ambiguous_target",
	"blind_fallback",
	"no_eligible",
	"no_eligible_blind",
	"no_eligible_capability_ceiling",
	"no_eligible_upstream_unavailable",
	"quarantine_unresolvable",
	"spread",
	"priority_fill",
	"last_resort_fallback",
]);
function safeNoProviderReason(reason) {
	// Route diagnostics may contain upstream error text. Only the closed route
	// code crosses the result/status/ledger boundary; unknown text is generic.
	if (typeof reason !== "string") return "no_eligible";
	const code = reason.split(":", 1)[0];
	return SAFE_ROUTE_REASON_CODES.has(code) ? code : "no_eligible";
}
function safeSuccessfulRouteReason(reason) {
	if (typeof reason !== "string") return "spread";
	const code = reason.split(":", 1)[0];
	return SAFE_ROUTE_REASON_CODES.has(code) ? code : "spread";
}
function safeLedgerFailure(error, phase) {
	const code = SAFE_LEDGER_ERROR_CODES.has(error?.code)
		? error.code
		: "unknown";
	return {
		ledgerFailure: true,
		ledgerFailurePhase: phase,
		ledgerFailureCode: code,
	};
}
function classifiedIntentFailure(context, payload, metadata) {
	context.onStatus?.({
		phase: "ledger",
		event: "intent_receipt_failed",
		status: "Authoritative dispatch intent could not be recorded",
		...metadata,
		taskId: payload?.taskId,
		provider: payload?.provider,
	});
	context.onIntentReceiptFailure?.(metadata);
	return metadata;
}
function reportLegacyProjectionFailure(context, error) {
	const metadata = safeLedgerFailure(error, "legacy_projection");
	if (context.onStatus) {
		context.onStatus({
			phase: "ledger",
			event: "legacy_projection_failed",
			status: "Legacy dispatch projection failed",
			...metadata,
		});
	} else {
		console.warn(
			`${context.ledgerSource ?? "runner"}: legacy dispatch projection failed (${metadata.ledgerFailureCode})`,
		);
	}
	context.onLedgerProjectionFailure?.(metadata);
	return metadata;
}
function reportOutcomeProjectionFailure(context, error) {
	const metadata = safeLedgerFailure(error, "outcome_projection");
	if (context.onStatus) {
		context.onStatus({
			phase: "ledger",
			event: "outcome_projection_failed",
			status: "Project-local dispatch outcome projection failed",
			...metadata,
		});
	} else {
		console.warn(
			`${context.ledgerSource ?? "runner"}: project-local dispatch outcome projection failed (${metadata.ledgerFailureCode})`,
		);
	}
	context.onLedgerProjectionFailure?.(metadata);
	return metadata;
}
function ledgerReportingContext(
	onStatus,
	dependencies = {},
	source = "runner",
) {
	return {
		onStatus: onStatus ?? null,
		onLedgerProjectionFailure: dependencies.onLedgerProjectionFailure,
		// Only reaches the console fallback. The entry point is worth keeping in
		// that one line because it is all an operator gets when no status
		// surface is wired; the structured event carries the phase instead.
		ledgerSource: source,
	};
}
function dispatchIntentPayload(
	taskId,
	routeResult,
	requiredCapability,
	provenance,
	invocationDescriptor,
) {
	return {
		taskId,
		provider: routeResult.provider ?? null,
		model: invocationDescriptor?.selector ?? routeResult.model ?? null,
		requiredCapability,
		resolvedTargetId: routeResult.resolvedTargetId ?? null,
		descriptorIdentity: invocationDescriptor?.descriptor_identity ?? null,
		descriptorHarness: routeResult.resolved_harness ?? null,
		...provenance,
	};
}
const DESCRIPTOR_RECEIPT_INVALID_REASON =
	"The dispatch descriptor receipt was invalid.";
export function writeDispatchIntent(context, payload) {
	if (typeof context?.recordDispatchIntent !== "function") {
		return classifiedIntentFailure(context ?? {}, payload, {
			ledgerFailure: true,
			ledgerFailurePhase: "authoritative_intent",
			ledgerFailureCode: "missing_writer",
		});
	}
	try {
		const receipt = context.recordDispatchIntent(payload);
		if (
			receipt !== null &&
			receipt !== undefined &&
			(typeof receipt === "object" || typeof receipt === "function") &&
			typeof receipt.then === "function"
		) {
			// Prevent a rejecting thenable from becoming an unhandled rejection;
			// the synchronous contract has already failed closed.
			Promise.resolve(receipt).catch(() => {});
			return classifiedIntentFailure(context, payload, {
				ledgerFailure: true,
				ledgerFailurePhase: "authoritative_intent",
				ledgerFailureCode: "async_writer",
			});
		}
		return null;
	} catch (error) {
		const metadata = safeLedgerFailure(error, "authoritative_intent");
		return classifiedIntentFailure(context, payload, metadata);
	}
}
export async function writeDispatchIntentAsync(context, payload) {
	if (typeof context?.recordDispatchIntent !== "function") {
		return classifiedIntentFailure(context ?? {}, payload, {
			ledgerFailure: true,
			ledgerFailurePhase: "authoritative_intent",
			ledgerFailureCode: "missing_writer",
		});
	}
	try {
		await context.recordDispatchIntent(payload);
		return null;
	} catch (error) {
		const metadata = safeLedgerFailure(error, "authoritative_intent");
		return classifiedIntentFailure(context, payload, metadata);
	}
}
export function createCliOrchestrator(options) {
	const { command, baseArgs = [], execFn = runCliCommand } = options;
	if (!command || typeof command !== "string") {
		throw new Error("createCliOrchestrator requires a command");
	}

	return {
		async launch(payload) {
			const raw = execFn(command, [
				...baseArgs,
				"launch",
				"--json",
				JSON.stringify(payload),
			]);
			const parsed = parseJsonPayload(raw);
			if (typeof parsed === "string") return parsed;
			if (parsed?.job_id) return parsed.job_id;
			if (parsed?.jobId) return parsed.jobId;
			if (parsed?.id) return parsed.id;
			if (raw) return raw;
			throw new Error("orchestrator launch returned no job id");
		},

		async status(jobId) {
			const raw = execFn(command, [...baseArgs, "status", String(jobId)]);
			const parsed = parseJsonPayload(raw);
			if (!parsed || typeof parsed !== "object") {
				throw new Error("orchestrator status returned non-JSON payload");
			}
			return parsed;
		},

		async result(jobId) {
			const raw = execFn(command, [...baseArgs, "result", String(jobId)]);
			const parsed = parseJsonPayload(raw);
			if (!parsed || typeof parsed !== "object") {
				throw new Error("orchestrator result returned non-JSON payload");
			}
			return parsed;
		},
	};
}
export function resolveOrchestrator(dependencies = {}) {
	if (dependencies.orchestrator) {
		return dependencies.orchestrator;
	}

	const command = process.env.SWITCHYARD_ORCHESTRATOR_CMD;
	if (!command) {
		throw new Error(
			"runQueueWithOrchestrator requires dependencies.orchestrator or SWITCHYARD_ORCHESTRATOR_CMD",
		);
	}

	const baseArgs = parseArgsJson(process.env.SWITCHYARD_ORCHESTRATOR_ARGS_JSON);
	return createCliOrchestrator({ command, baseArgs });
}
export {
	DESCRIPTOR_RECEIPT_INVALID_REASON,
	descriptorFromRoute,
	descriptorReceiptFields,
	dispatchIntentPayload,
	ledgerReportingContext,
	reportLegacyProjectionFailure,
	reportOutcomeProjectionFailure,
	safeNoProviderReason,
	safeSuccessfulRouteReason,
};
