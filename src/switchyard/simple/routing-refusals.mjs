import { resolveTargetId } from "../roster/index.mjs";
import { closedReason, createRouteEvidenceCapture } from "./route-evidence.mjs";

const LIMIT = 64;

// Static operator/capability filters and an overridden advisory are not
// operational refusals. Every other closed reason must positively be funding.
const NEUTRAL_REASONS = new Set([
	"explicitly_excluded",
	"not_in_only_allowlist",
	"below_required_capability",
	"tier_excluded",
	"deadline_fit_overridden",
]);

const FUNDING_REASONS = Object.freeze(
	new Set([
		"paid_overage_not_allowed",
		"included_usage_unverified",
		"funding_unavailable",
		"funding_exhausted",
	]),
);

/**
 * Deduplicate and bound exclusion entries while preserving precedence.
 * Each closed (targetId, bucket, reason) is retained once.
 */
function deduplicateRefusals(entries = [], limit = LIMIT) {
	if (!Array.isArray(entries)) return [];
	const seen = new Set();
	const result = [];
	for (const entry of entries) {
		if (result.length >= limit) break;
		if (!entry || typeof entry !== "object") continue;
		const targetId = resolveTargetId(entry.targetId);
		if (!targetId || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(targetId)) continue;
		const bucket =
			entry.bucket === "ac" || entry.bucket === "ap" ? entry.bucket : null;
		const key = `${targetId}:${bucket ?? ""}:${closedReason(entry.reason)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push({
			targetId,
			reason: closedReason(entry.reason),
			...(bucket ? { bucket } : {}),
		});
	}
	return result;
}

/**
 * Check if the exclusions represent funding-only exhaustion.
 * True when taskFailures is false, at least one target was excluded by funding,
 * and every other relevant refusal is also funding.
 */
function isFundingOnlyExhaustion(excludedEntries = [], taskFailures = false) {
	if (taskFailures) return false;
	const entries = Array.isArray(excludedEntries) ? excludedEntries : [];
	let hasFunding = false;
	for (const entry of entries) {
		const reason = closedReason(entry?.reason);
		if (FUNDING_REASONS.has(reason)) hasFunding = true;
		else if (!NEUTRAL_REASONS.has(reason)) return false;
	}
	return hasFunding;
}

/**
 * Classify exhaustion cause into 'task_failures', 'funding', or 'capacity'.
 */
function classifyExhaustionCause({
	excludedEntries = [],
	taskFailures = false,
} = {}) {
	if (taskFailures) return "task_failures";
	if (isFundingOnlyExhaustion(excludedEntries, taskFailures)) return "funding";
	return "capacity";
}

/**
 * Accumulator for route evaluation refusals across pipeline stages.
 */
export function createRefusalAccumulator(initial = []) {
	const map = new Map();
	function add(targetIdInput, reason, bucket = null) {
		const targetId = resolveTargetId(targetIdInput);
		if (!targetId || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(targetId)) return;
		const validBucket = bucket === "ac" || bucket === "ap" ? bucket : null;
		const key = `${targetId}:${validBucket ?? ""}:${closedReason(reason)}`;
		if (map.has(key) || map.size >= LIMIT) return;
		map.set(key, {
			targetId,
			reason: closedReason(reason),
			...(validBucket ? { bucket: validBucket } : {}),
		});
	}
	for (const e of initial) {
		if (e?.targetId && e?.reason) add(e.targetId, e.reason, e.bucket);
	}
	return {
		add,
		entries(limit = LIMIT) {
			return Array.from(map.values()).slice(0, limit);
		},
		isFundingOnly(taskFailures = false) {
			return isFundingOnlyExhaustion(Array.from(map.values()), taskFailures);
		},
		classifyExhaustion(taskFailures = false) {
			return classifyExhaustionCause({
				excludedEntries: Array.from(map.values()),
				taskFailures,
			});
		},
	};
}

/** Merge refusals into sanitized route evidence without affecting selection. */
export function withRefusalEvidence(routed, refusals) {
	const capture = createRouteEvidenceCapture(routed?.routeEvidence ?? {});
	const prior = routed?.routeEvidence;
	for (const item of (Array.isArray(prior?.candidates)
		? prior.candidates
		: []
	).slice(0, LIMIT))
		capture.candidate(
			item?.targetId,
			[
				{
					id: item?.bucket,
					pace_delta: item?.paceStatus === "measured" ? item.paceKey : null,
				},
			],
			item?.priority,
		);
	for (const item of deduplicateRefusals([
		...refusals,
		...(Array.isArray(prior?.excluded) ? prior.excluded : []),
	]))
		capture.exclude(item?.targetId, item.reason, item.bucket);
	return {
		...routed,
		routeEvidence: capture.finish({
			provider: routed?.provider,
			reason:
				routed?.reason === "no_eligible_provider"
					? (prior?.selectionReason ?? routed.reason)
					: routed?.reason,
		}).routeEvidence,
	};
}
