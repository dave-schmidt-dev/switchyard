import {
	existsSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { computeRosterSha } from "../roster/index.mjs";
import { resolveConfiguredDispatchDescriptor } from "../roster/qualification.mjs";
import {
	loadRosterData,
	ROSTER_CAPABILITY_CLASSES,
} from "../roster/schema.mjs";
import { simpleProviderCompatibility } from "../simple/provider-invocation.mjs";
import {
	createQualificationFixture,
	fixtureDigest,
	QUALIFICATION_FIXTURE_VERSION,
	qualificationPrompt,
} from "./provider-qualification-fixture.mjs";
import {
	hasProvenWorkerCleanup,
	verifyRepresentativeReceipt,
} from "./provider-qualification-verification.mjs";

function activeSlot(slot, models) {
	return Boolean(
		slot &&
			typeof slot === "object" &&
			!slot.manual_only &&
			models?.[slot.model_ref]?.status === "active",
	);
}
function sanitizeSlot(targetId, target, slot, capability, models) {
	const model = models?.[slot.model_ref];
	const descriptor = resolveConfiguredDispatchDescriptor(
		targetId,
		target,
		models,
		slot,
	);
	const compatibility = descriptor
		? simpleProviderCompatibility({
				targetId,
				harness: target.harness,
				descriptor,
				capability,
			})
		: { compatible: false, reason: "configured_descriptor_unavailable" };
	return {
		targetId,
		harness: target.harness,
		capability,
		modelRef: slot.model_ref,
		selector: model?.selector ?? null,
		effort: slot.effort ?? null,
		variant: slot.variant ?? null,
		descriptor: descriptor ?? null,
		descriptorIdentity: descriptor?.descriptor_identity ?? null,
		lane: compatibility.compatible ? "simple" : "vm",
		laneReadiness: compatibility.compatible
			? "configured_exact_local_adapter"
			: descriptor
				? "vm_availability_checked_on_execute"
				: "descriptor_unavailable",
		adapterReason: compatibility.compatible ? null : compatibility.reason,
	};
}

/** Enumerate every active descriptor on enabled roster targets without execution. */
export function enumerateQualificationTargets(rosterData = loadRosterData()) {
	const models = rosterData.models ?? {};
	const targets = rosterData.targets ?? {};
	const enabledTargets = [];
	const slots = [];
	for (const [targetId, target] of Object.entries(targets).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		if (!target || typeof target !== "object" || target.enabled !== true)
			continue;
		enabledTargets.push({ targetId, harness: target.harness ?? null });
		for (const capability of ROSTER_CAPABILITY_CLASSES) {
			for (const slot of Array.isArray(target.slots?.[capability])
				? target.slots[capability]
				: []) {
				if (activeSlot(slot, models)) {
					slots.push(sanitizeSlot(targetId, target, slot, capability, models));
				}
			}
		}
	}
	return {
		schemaVersion: 1,
		mode: "offline_inventory",
		rosterSchemaVersion: rosterData.schema_version ?? null,
		rosterSha256: computeRosterSha(rosterData),
		enabledTargetCount: enabledTargets.length,
		configuredSlotCount: slots.length,
		enabledTargets,
		slots,
		automaticPromotion: false,
	};
}
export function planRepresentativeQualification({
	targetId,
	capability,
	descriptorIdentity = null,
	lane = undefined,
	rosterData = loadRosterData(),
}) {
	if (
		typeof targetId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(targetId) ||
		!ROSTER_CAPABILITY_CLASSES.includes(capability)
	) {
		return {
			schemaVersion: 1,
			status: "invalid_request",
			reason: "target_and_capability_required",
		};
	}
	if (lane !== undefined && lane !== null && !["simple", "vm"].includes(lane)) {
		return {
			schemaVersion: 1,
			status: "invalid_request",
			reason: "invalid_lane",
		};
	}
	const inventory = enumerateQualificationTargets(rosterData);
	const matches = inventory.slots.filter(
		(slot) =>
			slot.targetId === targetId &&
			slot.capability === capability &&
			(!descriptorIdentity || slot.descriptorIdentity === descriptorIdentity),
	);
	if (!matches.length) {
		return {
			schemaVersion: 1,
			status: "unavailable",
			reason: "no_enabled_exact_slot",
			targetId,
			capability,
			automaticPromotion: false,
		};
	}
	if (matches.length !== 1) {
		return {
			schemaVersion: 1,
			status: "ambiguous",
			reason: "multiple_exact_slots",
			targetId,
			capability,
			descriptorIdentities: matches.map((slot) => slot.descriptorIdentity),
			automaticPromotion: false,
		};
	}
	const slot = matches[0];
	if (lane === "simple" && slot.lane !== "simple") {
		return {
			schemaVersion: 1,
			status: "unavailable",
			reason: "simple_lane_unavailable",
			targetId,
			capability,
			automaticPromotion: false,
		};
	}
	const forcedVmLane = lane === "vm" && slot.descriptor;
	return {
		schemaVersion: 1,
		status: slot.descriptor ? "ready" : "unavailable",
		reason: slot.descriptor ? null : "configured_descriptor_unavailable",
		rosterSha256: inventory.rosterSha256,
		fixtureVersion: QUALIFICATION_FIXTURE_VERSION,
		fixtureSha256: fixtureDigest(),
		targetId,
		harness: slot.harness,
		capability,
		modelRef: slot.modelRef,
		selector: slot.selector,
		effort: slot.effort,
		variant: slot.variant,
		descriptorIdentity: slot.descriptorIdentity,
		descriptor: slot.descriptor,
		lane: forcedVmLane ? "vm" : slot.lane,
		laneReadiness: forcedVmLane
			? "vm_availability_checked_on_execute"
			: slot.laneReadiness,
		automaticPromotion: false,
	};
}

/** Run exactly one explicitly selected target using an injected fixed dispatcher. */
export async function runRepresentativeQualification({
	targetId,
	capability,
	descriptorIdentity = null,
	lane = undefined,
	rosterData = loadRosterData(),
	dispatch,
	deadlineAt = new Date(Date.now() + 25 * 60_000).toISOString(),
	tmpdirPath = tmpdir(),
	onProgress = () => {},
}) {
	if (typeof dispatch !== "function")
		throw new TypeError("dispatcher_required");
	const plan = planRepresentativeQualification({
		targetId,
		capability,
		descriptorIdentity,
		lane,
		rosterData,
	});
	if (plan.status !== "ready") {
		return {
			schemaVersion: 1,
			status: plan.status,
			reason: plan.reason,
			plan,
			promotion: "none",
		};
	}
	const deadlineMs = Date.parse(deadlineAt);
	if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) {
		return {
			schemaVersion: 1,
			status: "failed",
			reason: "deadline_expired",
			plan,
			promotion: "none",
		};
	}
	let scratchRoot;
	let scratchParent;
	try {
		scratchParent = realpathSync(resolve(tmpdirPath));
		scratchRoot = realpathSync(
			mkdtempSync(join(scratchParent, "switchyard-provider-qualification-")),
		);
	} catch {
		return {
			schemaVersion: 1,
			status: "failed",
			reason: "scratch_setup_failed",
			plan,
			promotion: "none",
		};
	}
	const relativeScratch = relative(scratchParent, scratchRoot);
	if (
		relativeScratch.startsWith("..") ||
		relativeScratch.includes(`${sep}..${sep}`)
	) {
		rmSync(scratchRoot, { recursive: true, force: true });
		return {
			schemaVersion: 1,
			status: "failed",
			reason: "unsafe_scratch_root",
			plan,
			promotion: "none",
		};
	}
	let result;
	let scratchCleanupVerified = false;
	let mayRemoveScratch = false;
	try {
		const fixture = createQualificationFixture(scratchRoot);
		writeFileSync(fixture.promptPath, qualificationPrompt(), {
			mode: 0o600,
			flag: "wx",
		});
		onProgress({ event: "fixture_ready", targetId, capability });
		const receipt = await dispatch({
			plan,
			fixture,
			allowedFiles: ["src/summary.mjs", "tests/summary.test.mjs"],
			deadlineAt,
			onProgress,
		});
		const verification = verifyRepresentativeReceipt(plan, receipt, fixture);
		mayRemoveScratch =
			hasProvenWorkerCleanup(receipt) &&
			(!verification.containedChecksStarted || verification.cleanupVerified);
		result = {
			schemaVersion: 1,
			status: verification.passed ? "representative_passed" : "failed",
			reason: verification.failures[0] ?? null,
			verification,
			plan: {
				targetId: plan.targetId,
				harness: plan.harness,
				capability: plan.capability,
				selector: plan.selector,
				descriptorIdentity: plan.descriptorIdentity,
				lane: plan.lane,
			},
			promotion: "none",
		};
	} catch (error) {
		mayRemoveScratch = error?.providerNeverStarted === true;
		const reasons = new Set([
			"fixture_git_setup_failed",
			"provider_lane_unavailable",
			"vm_lane_unavailable",
			"dispatch_failed",
			"dispatch_cleanup_unconfirmed",
			"dispatch_output_invalid",
			"deadline_expired",
			"execution_cancelled",
		]);
		result = {
			schemaVersion: 1,
			status: "failed",
			reason: reasons.has(error?.code)
				? error.code
				: "qualification_execution_failed",
			plan: {
				targetId: plan.targetId,
				harness: plan.harness,
				capability: plan.capability,
				descriptorIdentity: plan.descriptorIdentity,
				lane: plan.lane,
			},
			promotion: "none",
		};
	} finally {
		if (mayRemoveScratch) {
			try {
				rmSync(scratchRoot, { recursive: true, force: true });
				scratchCleanupVerified = !existsSync(scratchRoot);
			} catch {
				scratchCleanupVerified = false;
			}
		}
	}
	if (!scratchCleanupVerified) {
		return {
			...(result ?? {}),
			status: "failed",
			reason: "scratch_cleanup_unconfirmed",
			scratchPath: scratchRoot,
			scratchCleanupVerified: false,
			promotion: "none",
		};
	}
	return { ...(result ?? {}), scratchCleanupVerified: true };
}
