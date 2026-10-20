import { resolveTargetId } from "../roster/index.mjs";

const LIMIT = 64;
const REASONS = new Set([
	"invalid_platform",
	"invalid_usage_mode",
	"ambiguous_target",
	"quarantine_unresolvable",
	"priority_fill",
	"spread",
	"last_resort_fallback",
	"blind_fallback",
	"no_eligible",
	"no_eligible_blind",
	"no_eligible_capability_ceiling",
	"no_eligible_upstream_unavailable",
	"target_identity_unavailable",
	"adapter_unavailable",
	"explicitly_excluded",
	"not_in_only_allowlist",
	"below_required_capability",
	"no_invocation_descriptor",
	"not_configured",
	"qualification_missing",
	"qualification_superseded",
	"qualification_expired",
	"qualification_invalid",
	"provider_unavailable",
	"no_quota_headroom",
	"budget_pace_unavailable",
	"budget_pace_exceeded",
	"route_health_suppressed",
	"deadline_fit_excluded",
	"deadline_fit_overridden",
	"no_valid_windows",
	"quota_exhausted",
	"accounting_bucket_unavailable",
	"local_adapter_unavailable",
	"local_descriptor_model_unavailable",
	"local_descriptor_args_unsafe",
	"invocation_descriptor_unavailable",
	"no_compatible_adapter",
	"paid_overage_not_allowed",
	"included_usage_unverified",
	"funding_unavailable",
	"funding_exhausted",
	"tier_excluded",
	"failed_this_task",
	"failed_in_routing_run",
	"pin_required",
	"not_in_usage_snapshot",
	"not_evaluated",
	"unknown",
]);
const STATUSES = new Set([
	"fresh",
	"stale",
	"future",
	"missing",
	"malformed",
	"not_checked",
]);
const finite = (value) => (Number.isFinite(value) ? value : null);
export const closedReason = (value) =>
	typeof value === "string" &&
	value.startsWith("no_eligible_upstream_unavailable:")
		? "no_eligible_upstream_unavailable"
		: REASONS.has(value)
			? value
			: "unknown";
const target = (name) => {
	const id = resolveTargetId(name);
	return typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(id)
		? id
		: null;
};

/** Capture only numeric policy keys and closed identifiers from the actual pass. */
export function createRouteEvidenceCapture(snapshot = {}) {
	const candidates = [];
	const excluded = [];
	const seenExcluded = new Set();
	return {
		candidate(name, windows = [], priority = null) {
			const targetId = target(name);
			if (!targetId || candidates.length >= LIMIT) return;
			const paces = windows
				.map((window) => window?.pace_delta)
				.filter(Number.isFinite);
			candidates.push({
				targetId,
				...(windows.length === 1 && ["ac", "ap"].includes(windows[0]?.id)
					? { bucket: windows[0].id }
					: {}),
				priority: finite(priority),
				paceStatus: paces.length ? "measured" : "unknown",
				paceKey: paces.length
					? paces.reduce((min, pace) => Math.min(min, pace), Infinity)
					: null,
			});
		},
		exclude(name, reason, bucket = null) {
			const targetId = target(name);
			const validBucket = bucket === "ac" || bucket === "ap" ? bucket : null;
			const key = `${targetId}:${validBucket ?? ""}:${closedReason(reason)}`;
			if (targetId && excluded.length < LIMIT && !seenExcluded.has(key)) {
				seenExcluded.add(key);
				excluded.push({
					targetId,
					reason: closedReason(reason),
					...(bucket === "ac" || bucket === "ap" ? { bucket } : {}),
				});
			}
		},
		finish(result) {
			return {
				...result,
				routeEvidence: {
					schemaVersion: 1,
					snapshotStatus: STATUSES.has(snapshot.snapshotStatus)
						? snapshot.snapshotStatus
						: "not_checked",
					snapshotMtime: finite(snapshot.snapshotMtime),
					snapshotAgeMsAtRoute: finite(snapshot.snapshotAgeMsAtRoute),
					selectionReason: closedReason(result.reason),
					selectedTargetId: target(result.provider),
					candidates,
					excluded,
				},
			};
		},
	};
}

/** Legacy injected routers remain usable; evidence is diagnostic, never a gate. */
export function routeDiagnosticPatch(routed) {
	const evidence = routed?.routeEvidence;
	if (evidence?.schemaVersion !== 1) return {};
	const capture = createRouteEvidenceCapture(evidence);
	for (const candidate of (Array.isArray(evidence.candidates)
		? evidence.candidates
		: []
	).slice(0, LIMIT)) {
		capture.candidate(
			candidate?.targetId,
			[
				{
					id: candidate?.bucket,
					pace_delta:
						candidate?.paceStatus === "measured" ? candidate.paceKey : null,
				},
			],
			candidate?.priority,
		);
	}
	for (const entry of (Array.isArray(evidence.excluded)
		? evidence.excluded
		: []
	).slice(0, LIMIT)) {
		capture.exclude(entry?.targetId, entry?.reason, entry?.bucket);
	}
	const bounded = capture.finish({
		provider: evidence.selectedTargetId,
		reason: evidence.selectionReason,
	}).routeEvidence;
	return {
		routeEvidence: bounded,
		snapshotStatus: bounded.snapshotStatus,
		snapshotMtime: bounded.snapshotMtime,
		snapshotAgeMsAtRoute: bounded.snapshotAgeMsAtRoute,
	};
}
