import { slotInvocationIsSupported } from "./capabilities.mjs";
import { validateInvocationDescriptor } from "./descriptor-identity.mjs";
import { QUALIFICATION_STATUS, STALE_MAX_AGE_SECONDS } from "./schema.mjs";

function parseQualificationTimestamp(value) {
	if (typeof value !== "string" || value.length === 0) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}
export function computeQualificationStatus(
	existingRecord,
	currentSignature = {},
	nowIso = new Date().toISOString(),
	maxAgeSeconds = STALE_MAX_AGE_SECONDS,
) {
	if (!existingRecord || typeof existingRecord !== "object") {
		return QUALIFICATION_STATUS.UNTESTED;
	}
	const status = existingRecord.status ?? QUALIFICATION_STATUS.UNTESTED;
	const qualifiedStatuses = new Set([
		QUALIFICATION_STATUS.PROBE_QUALIFIED,
		QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
		// `qualified` is retained here solely for the compatibility helper. It
		// can never authorize getInvocationDescriptor below.
		"qualified",
	]);
	if (!qualifiedStatuses.has(status)) return status;

	for (const field of [
		"selector",
		"cli_version",
		"wrapper_version",
		"credential_profile",
	]) {
		if (
			Object.hasOwn(currentSignature, field) &&
			existingRecord[field] !== currentSignature[field]
		) {
			return QUALIFICATION_STATUS.STALE;
		}
	}

	// Dispatch receipts require an observation time. Probe records preserve the
	// Python helper's permissive legacy behavior, but an unparsable timestamp is
	// always stale when one is supplied.
	const testedAt =
		existingRecord.tested_at ??
		existingRecord.qualified_at ??
		existingRecord.observed_at;
	if (testedAt !== undefined && testedAt !== null) {
		const testedMs = parseQualificationTimestamp(testedAt);
		const nowMs = parseQualificationTimestamp(nowIso);
		if (testedMs === null || nowMs === null) return QUALIFICATION_STATUS.STALE;
		const ageSeconds = (nowMs - testedMs) / 1000;
		if (ageSeconds < 0 || ageSeconds > maxAgeSeconds) {
			return QUALIFICATION_STATUS.STALE;
		}
	}
	return status;
}
const evaluateQualificationFreshness = computeQualificationStatus;
function currentQualificationSignature(target, slot, model, descriptor) {
	const contexts = [
		slot?.qualification_signature,
		slot?.current_signature,
		target?.qualification_signature,
		target?.current_signature,
		target?.runtime_signature,
		target?.runtime,
		target,
	];
	const signature = { selector: descriptor.selector };
	for (const field of [
		"cli_version",
		"wrapper_version",
		"credential_profile",
	]) {
		for (const context of contexts) {
			if (!context || typeof context !== "object") continue;
			const aliases = {
				cli_version: ["cli_version", "current_cli_version"],
				wrapper_version: [
					"wrapper_version",
					"current_wrapper_version",
					"adapter_version",
				],
				credential_profile: [
					"credential_profile",
					"current_credential_profile",
				],
			}[field];
			const value = aliases
				.map((key) => context[key])
				.find((item) => typeof item === "string");
			if (value !== undefined) {
				signature[field] = value;
				break;
			}
		}
	}
	void model;
	return signature;
}
function descriptorReceiptMatches(
	record,
	descriptor,
	{ complete = false } = {},
) {
	if (!record || typeof record !== "object") return false;
	const identity = descriptor.descriptor_identity;
	if (complete && record.descriptor_identity !== identity) return false;
	if (
		!complete &&
		record.descriptor_identity !== undefined &&
		record.descriptor_identity !== identity
	) {
		return false;
	}
	if (complete) {
		for (const field of [
			"target_id",
			"model_ref",
			"selector",
			"effort",
			"variant",
		]) {
			if (!Object.hasOwn(record, field)) return false;
		}
		if (
			record.target_id !== descriptor.target_id ||
			record.model_ref !== descriptor.model_ref ||
			record.selector !== descriptor.selector ||
			(record.effort ?? null) !== (descriptor.effort ?? null) ||
			(record.variant ?? null) !== (descriptor.variant ?? null)
		) {
			return false;
		}
	}
	if (
		record.target_id !== undefined &&
		record.target_id !== descriptor.target_id
	)
		return false;
	if (
		record.model_ref !== undefined &&
		record.model_ref !== descriptor.model_ref
	)
		return false;
	if (record.selector !== undefined && record.selector !== descriptor.selector)
		return false;
	const argvFields = [
		"invocation_args",
		"argv",
		"validated_invocation_args",
	].filter((field) => Object.hasOwn(record, field));
	if (complete && argvFields.length === 0) return false;
	for (const field of argvFields) {
		const recordArgs = record[field];
		if (
			!Array.isArray(recordArgs) ||
			recordArgs.length !== descriptor.invocation_args.length ||
			recordArgs.some((arg, index) => arg !== descriptor.invocation_args[index])
		) {
			return false;
		}
	}
	return true;
}
function atomicPromotionReceiptIsValid(record, descriptor) {
	// A direct descriptor-keyed record is itself the atomic promotion receipt
	// in roster v1.  Newer writers may additionally include a nested receipt;
	// validate it whenever present rather than trusting a partially-written
	// promotion marker.
	const receipt =
		record.promotion_receipt ??
		record.promotionReceipt ??
		record.atomic_promotion_receipt;
	if (receipt === undefined) return true;
	if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
		return false;
	}
	if (!descriptorReceiptMatches(receipt, descriptor, { complete: true })) {
		return false;
	}
	if (receipt.atomic !== true) return false;
	if (!new Set(["promoted", "committed", "atomic"]).has(receipt.status)) {
		return false;
	}
	const receiptTime =
		receipt.committed_at ?? receipt.promoted_at ?? receipt.created_at;
	if (parseQualificationTimestamp(receiptTime) === null) return false;
	if (
		typeof receipt.receipt_id !== "string" ||
		receipt.receipt_id.length === 0
	) {
		return false;
	}
	return true;
}
function qualificationAuthorizesDescriptor(
	target,
	descriptor,
	slot,
	model,
	{
		nowIso = new Date().toISOString(),
		maxAgeSeconds = STALE_MAX_AGE_SECONDS,
	} = {},
) {
	const qualifications =
		target?.qualifications && typeof target.qualifications === "object"
			? target.qualifications
			: {};
	const identity = descriptor.descriptor_identity;
	const candidates = [];
	if (qualifications[identity]) candidates.push(qualifications[identity]);
	for (const record of Object.values(qualifications)) {
		if (
			record &&
			typeof record === "object" &&
			record.descriptor_identity === identity &&
			!candidates.includes(record)
		) {
			candidates.push(record);
		}
	}
	const currentSignature = currentQualificationSignature(
		target,
		slot,
		model,
		descriptor,
	);
	return candidates.some((record) => {
		if (!record || typeof record !== "object") return false;
		// Selector-only legacy keys and probe-only evidence are readable but can
		// never grant an automatic write-path descriptor.
		if (record.status !== QUALIFICATION_STATUS.DISPATCH_QUALIFIED) return false;
		if (
			record.tested_at === undefined &&
			record.qualified_at === undefined &&
			record.observed_at === undefined
		) {
			return false;
		}
		if (!descriptorReceiptMatches(record, descriptor)) return false;
		if (!atomicPromotionReceiptIsValid(record, descriptor)) return false;
		if (
			computeQualificationStatus(
				record,
				currentSignature,
				nowIso,
				maxAgeSeconds,
			) !== QUALIFICATION_STATUS.DISPATCH_QUALIFIED
		) {
			return false;
		}
		if (record.freshness === "stale" || record.freshness?.status === "stale")
			return false;
		if (
			record.availability === "temporarily_unavailable" ||
			record.temporary_availability === true ||
			record.transmittable === false ||
			record.evidence_type === QUALIFICATION_STATUS.NOT_TRANSMITTABLE
		) {
			return false;
		}
		return true;
	});
}
function resolveCurrentDispatchDescriptor(
	targetId,
	target,
	models,
	slot,
	options = {},
) {
	const descriptor = resolveConfiguredDispatchDescriptor(
		targetId,
		target,
		models,
		slot,
	);
	if (!descriptor) return null;
	return qualificationAuthorizesDescriptor(
		target,
		descriptor,
		slot,
		models?.[slot?.model_ref],
		options,
	)
		? descriptor
		: null;
}
function resolveConfiguredDispatchDescriptor(targetId, target, models, slot) {
	if (
		!targetId ||
		!target?.harness ||
		!slotInvocationIsSupported(target.harness, slot)
	) {
		return null;
	}
	const model = models?.[slot?.model_ref];
	if (model?.status !== "active") return null;
	let descriptor;
	try {
		descriptor = validateInvocationDescriptor(
			{
				target_id: targetId,
				model_ref: slot.model_ref,
				selector: model.selector,
				effort: slot.effort ?? null,
				variant: slot.variant ?? null,
				invocation_args: slot.invocation_args ?? [],
			},
			target.harness,
		);
	} catch {
		return null;
	}
	return descriptor;
}

export {
	currentQualificationSignature,
	resolveConfiguredDispatchDescriptor,
	resolveCurrentDispatchDescriptor,
};
