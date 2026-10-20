import { resolveTargetId } from "../roster/index.mjs";
import {
	boundedExclusions,
	closedReason,
	createRouteEvidenceCapture,
} from "./route-evidence.mjs";

const LIMIT = 64;
const HEALTH = "route_health_suppressed";

/**
 * Deduplicate and bound exclusion entries while preserving precedence.
 * Each closed (targetId, bucket, reason) is retained once.
 */
function deduplicateRefusals(entries = [], limit = LIMIT) {
	if (!Array.isArray(entries)) return [];
	const seen = new Set();
	const result = [];
	for (const entry of entries) {
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
	return boundedExclusions(result, limit);
}

/**
 * Accumulator for route evaluation refusals across pipeline stages.
 */
export function createRefusalAccumulator(initial = []) {
	const map = new Map();
	let healthCount = 0;
	function add(targetIdInput, reason, bucket = null) {
		const targetId = resolveTargetId(targetIdInput);
		if (!targetId || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(targetId)) return;
		const validBucket = bucket === "ac" || bucket === "ap" ? bucket : null;
		const key = `${targetId}:${validBucket ?? ""}:${closedReason(reason)}`;
		const health = closedReason(reason) === HEALTH;
		if (
			map.has(key) ||
			(health ? healthCount : map.size - healthCount) >= LIMIT
		)
			return;
		if (health) healthCount += 1;
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
			return boundedExclusions(Array.from(map.values()), limit);
		},
	};
}

/**
 * Drop the selector's `adapter_unavailable` entries for targets the caller
 * removed from `availableProviders` itself. Those targets already carry their
 * own refusal, so the extra entry was false evidence (stability audit O10,
 * 2026-10-18).
 */
export function withoutRemovalArtifacts(routed, removedByCaller) {
	const evidence = routed?.routeEvidence;
	if (!Array.isArray(evidence?.excluded)) return routed;
	const excluded = evidence.excluded.filter(
		(entry) =>
			!(
				closedReason(entry?.reason) === "adapter_unavailable" &&
				removedByCaller(entry?.targetId)
			),
	);
	if (excluded.length === evidence.excluded.length) return routed;
	return { ...routed, routeEvidence: { ...evidence, excluded } };
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
