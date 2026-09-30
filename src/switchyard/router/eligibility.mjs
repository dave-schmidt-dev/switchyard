import { readFileSync, statSync } from "node:fs";

import { homedir } from "node:os";

import { join } from "node:path";

import {
	CAPABILITY_CLASS,
	describeDescriptorGap,
	getImplementorPriority,
	getRightSizedModel,
	hasAutomaticInvocationDescriptor,
	normalizeProviderName,
	PROVIDER_CAPABILITIES,
	passesCapabilityFilter,
	resolveTargetId,
	resolveTargetIdentity,
} from "../roster/index.mjs";

function providerMatches(identifier, name) {
	const identifierResolution = resolveTargetIdentity(identifier);
	const nameResolution = resolveTargetIdentity(name);
	if (identifierResolution.ambiguous || nameResolution.ambiguous) return false;
	const identifierTargetId = identifierResolution.targetId;
	const nameTargetId = nameResolution.targetId;
	if (identifierTargetId && nameTargetId) {
		return identifierTargetId === nameTargetId;
	}
	return normalizeProviderName(identifier) === normalizeProviderName(name);
}

export const SNAPSHOT_PATH = join(
	homedir(),
	"Library/Application Support/Gradus/Installed/snapshot-v2.json",
);

export function resolveSnapshotPath() {
	return process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE || SNAPSHOT_PATH;
}

const EXPECTED_SCHEMA_VERSION = 2;

export const DEFAULT_FLOOR = 5.0;

const SNAPSHOT_STALE_THRESHOLD_MS = 5 * 60 * 1000;

export function readSnapshotAtRoute(nowMs, sourcePath) {
	const path = sourcePath ?? resolveSnapshotPath();
	let snapshotMtime = null;
	let raw;
	try {
		const stat = statSync(path);
		snapshotMtime = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return {
			snapshot: null,
			snapshotStatus: error?.code === "ENOENT" ? "missing" : "malformed",
			snapshotMtime,
			snapshotAgeMsAtRoute: null,
		};
	}

	let snapshot;
	try {
		snapshot = JSON.parse(raw);
	} catch {
		return {
			snapshot: null,
			snapshotStatus: "malformed",
			snapshotMtime,
			snapshotAgeMsAtRoute: null,
		};
	}

	if (!isValidSnapshot(snapshot)) {
		return {
			snapshot: null,
			snapshotStatus: "malformed",
			snapshotMtime,
			snapshotAgeMsAtRoute: null,
		};
	}

	const updatedAtMs = Date.parse(snapshot.updated_at);
	if (!Number.isFinite(updatedAtMs)) {
		return {
			snapshot,
			snapshotStatus: "malformed",
			snapshotMtime,
			snapshotAgeMsAtRoute: null,
		};
	}

	const snapshotAgeMsAtRoute = nowMs - updatedAtMs;
	const snapshotStatus =
		snapshotAgeMsAtRoute < 0
			? "future"
			: snapshotAgeMsAtRoute >= SNAPSHOT_STALE_THRESHOLD_MS
				? "stale"
				: "fresh";
	return {
		snapshot,
		snapshotStatus,
		snapshotMtime,
		snapshotAgeMsAtRoute,
	};
}

function isValidSnapshot(snapshot) {
	if (!snapshot || typeof snapshot !== "object") return false;
	if (snapshot.schema_version !== EXPECTED_SCHEMA_VERSION) return false;
	return Array.isArray(snapshot.providers);
}

export function indexProviders(snapshot) {
	const map = new Map();
	for (const provider of snapshot.providers ?? []) {
		map.set(provider.name, provider);
	}
	return map;
}

export function readRosterTargetOrder() {
	const rosterPath =
		process.env.SWITCHYARD_ROSTER_PATH ||
		join(homedir(), ".agent", "roster.json");
	try {
		const roster = JSON.parse(readFileSync(rosterPath, "utf8"));
		return new Map(
			Object.keys(roster?.targets ?? {}).map((targetId, index) => [
				targetId,
				index,
			]),
		);
	} catch {
		return new Map();
	}
}

export const TERMINAL_PREFLIGHT_STATUSES = new Set([
	"done",
	"succeeded",
	"failed",
	"cancelled",
	"canceled",
	"skipped",
]);

export const GOLDEN_IMAGE_VERIFIED_PROVIDERS = Object.freeze([
	"codex",
	"antigravity",
	"antigravity-claude",
	"claude-code",
	"copilot-student",
	"cursor-pro",
	"opencode-go",
	"opencode-mistral",
	"vibe",
	"vibe-code",
]);

function goldenImageProviderMatches(verified, snapshotName) {
	const verifiedIdentity = resolveTargetIdentity(verified);
	const snapshotIdentity = resolveTargetIdentity(snapshotName);
	if (verifiedIdentity.targetId && snapshotIdentity.targetId) {
		return verifiedIdentity.targetId === snapshotIdentity.targetId;
	}
	return (
		normalizeProviderName(verified) === normalizeProviderName(snapshotName)
	);
}

function hasQuotaHeadroom(name, windows, floor) {
	const priority = getImplementorPriority(name);
	const minPercentLeft = windows.reduce(
		(min, window) => Math.min(min, window.percent_left),
		Infinity,
	);
	if (normalizeProviderName(name) === "cursor") {
		const acWindow = windows.find((window) => window.id === "ac");
		if (acWindow && priority !== null && acWindow.percent_left > 0) return true;
		const apWindow = windows.find((window) => window.id === "ap");
		return Boolean(apWindow && apWindow.percent_left >= DEFAULT_FLOOR);
	}
	if (priority !== null) return minPercentLeft > 0;
	return minPercentLeft >= floor;
}

export function evaluateCandidateEligibility(name, provider, options = {}) {
	const {
		requiredCapability = CAPABILITY_CLASS.standard,
		exclude = [],
		only = [],
		availableProviders,
		floor = DEFAULT_FLOOR,
		platform = "direct",
		usageMode = "observed",
		goldenImageVerifiedProviders = GOLDEN_IMAGE_VERIFIED_PROVIDERS,
		hasInvocationDescriptor = hasAutomaticInvocationDescriptor,
	} = options;
	if (!new Set(["direct", "macos"]).has(platform)) {
		return { eligible: false, reason: "invalid_platform" };
	}
	if (!new Set(["observed", "unknown"]).has(usageMode)) {
		return { eligible: false, reason: "invalid_usage_mode" };
	}
	const targetIdentity = resolveTargetIdentity(name);
	if (!targetIdentity.targetId) {
		return { eligible: false, reason: "target_identity_unavailable" };
	}
	const isAvailable = (candidate) => {
		if (!availableProviders) return true;
		const requestedIdentity = resolveTargetIdentity(candidate);
		const requestedHarness = requestedIdentity.targetId
			? requestedIdentity.harnessKey
			: normalizeProviderName(candidate);
		return availableProviders.some((available) => {
			const availableIdentity = resolveTargetIdentity(available);
			const availableHarness = availableIdentity.targetId
				? availableIdentity.harnessKey
				: normalizeProviderName(available);
			return availableHarness === requestedHarness;
		});
	};
	if (!isAvailable(name)) {
		return { eligible: false, reason: "adapter_unavailable" };
	}
	if (exclude.some((excluded) => providerMatches(excluded, name))) {
		return { eligible: false, reason: "explicitly_excluded" };
	}
	if (
		only.length > 0 &&
		!only.some((allowed) => providerMatches(allowed, name))
	) {
		return { eligible: false, reason: "not_in_only_allowlist" };
	}
	if (!passesCapabilityFilter(name, requiredCapability)) {
		return { eligible: false, reason: "below_required_capability" };
	}
	if (!hasInvocationDescriptor(name, requiredCapability)) {
		// Name which of the four descriptor gaps applies, because each has a
		// different remedy and the collapsed reason read as "unsupported here"
		// (see DESCRIPTOR_GAP). Only the roster-backed default predicate can be
		// explained this way: a caller that injected its own predicate — the
		// qualification-attempt path does — is asking a different question, and
		// the classifier's answer would not describe the refusal that happened.
		const gap =
			hasInvocationDescriptor === hasAutomaticInvocationDescriptor
				? describeDescriptorGap(name, requiredCapability)
				: null;
		return { eligible: false, reason: gap ?? "no_invocation_descriptor" };
	}
	if (
		platform === "macos" &&
		!goldenImageVerifiedProviders.some((verified) =>
			goldenImageProviderMatches(verified, name),
		)
	) {
		return { eligible: false, reason: "not_golden_image_verified" };
	}
	// Unknown usage is the blind-fallback case: the absence of a snapshot is
	// not evidence of quota exhaustion. Every non-usage gate above still holds.
	if (usageMode === "unknown") return { eligible: true, reason: "eligible" };
	if (!provider?.ok) {
		return { eligible: false, reason: "provider_unavailable" };
	}
	const windows = (provider.windows ?? []).filter(
		(window) =>
			typeof window?.percent_left === "number" &&
			Number.isFinite(window.percent_left),
	);
	if (windows.length === 0 || !hasQuotaHeadroom(name, windows, floor)) {
		return { eligible: false, reason: "no_quota_headroom" };
	}
	return { eligible: true, reason: "eligible" };
}

export function healthExclusion(name, _provider, options) {
	if (typeof options.healthDecision !== "function") return null;
	try {
		const decision = options.healthDecision({
			provider: name,
			resolvedTargetId: resolveTargetId(name),
			requiredCapability: options.requiredCapability,
			usageMode: options.usageMode,
		});
		if (
			!decision ||
			typeof decision !== "object" ||
			typeof decision.then === "function"
		)
			return null;
		const sanitized = {
			available: decision.available === true,
			state:
				typeof decision.state === "string" && decision.state.length <= 64
					? decision.state
					: "health-unavailable",
			mode: decision.mode === "enforce" ? "enforce" : "shadow",
			suppress: decision.suppress === true,
			trialAvailable: decision.trialAvailable === true,
			initializable: decision.initializable === true,
			resolvedTargetId: resolveTargetId(name),
		};
		options.onHealthDecision?.({ provider: name, ...sanitized });
		return sanitized.suppress ? sanitized : null;
	} catch {
		options.onHealthDecision?.({
			provider: name,
			available: false,
			state: "health-unavailable",
			mode: "shadow",
			suppress: false,
		});
		return null;
	}
}
