import { createHash, randomUUID } from "node:crypto";

import {
	effective,
	repairTrialAvailable,
	updateScopeSync,
} from "./health-inspect.mjs";

import { updateScope } from "./health-lock.mjs";

import {
	ADAPTER_CONTRACT_VERSION,
	createRouteHealthKey,
	identityFrom,
	REPAIR_KINDS,
	RouteHealthSchemaError,
	safeAttempt,
	safeEpoch,
	safeHash,
	safeId,
	safeTime,
	UUID_RE,
} from "./health-schema.mjs";

export async function attestRouteRepair(input) {
	identityFrom(input);
	safeHash(input.publicConfigurationEpoch, "public configuration epoch");
	if (!REPAIR_KINDS.has(input.repairKind))
		throw new RouteHealthSchemaError("repair kind is invalid");
	const adapterContractId = input.adapterContractId ?? ADAPTER_CONTRACT_VERSION;
	safeId(adapterContractId, "adapter contract id");
	return updateScope(
		input,
		async ({ control }) => {
			if (control.claim)
				return {
					write: false,
					repairEpoch: control.repairEpoch,
					reason: "claim-active",
				};
			control.repairEpoch += 1;
			control.attestations.push({
				publicConfigurationEpoch: input.publicConfigurationEpoch,
				repairEpoch: control.repairEpoch,
				repairKind: input.repairKind,
				adapterContractId,
				at: safeTime(input.nowMs ?? Date.now()),
			});
			return { repairEpoch: control.repairEpoch, state: "repair-hold" };
		},
		{ allowInitialize: true },
	);
}

export function claimIdentity(input) {
	return {
		runId: safeId(input.runId, "run id"),
		taskId: safeId(input.taskId, "task id"),
		attempt: safeAttempt(input.attempt),
	};
}

export async function acquireHalfOpenClaim(input) {
	const claimant = claimIdentity(input);
	safeHash(input.publicConfigurationEpoch, "public configuration epoch");
	safeEpoch(input.repairEpoch);
	const now = safeTime(input.nowMs ?? Date.now());
	return updateScope(input, async ({ control, observations }) => {
		if (control.repairEpoch !== input.repairEpoch)
			return { write: false, claimed: false, reason: "stale-repair-epoch" };
		if (control.claim)
			return { write: false, claimed: false, reason: "claim-active" };
		const state = effective(control, observations, input, now);
		const attested = control.attestations.some(
			(item) =>
				item.publicConfigurationEpoch === input.publicConfigurationEpoch &&
				item.repairEpoch === input.repairEpoch &&
				item.at > Math.max(-1, ...control.holds.map((hold) => hold.at)),
		);
		const eligibleRepair = state.state === "repair-hold" && attested;
		const eligibleCooldown =
			state.state === "cooldown" && state.trialAvailable === true;
		if (!eligibleRepair && !eligibleCooldown)
			return { write: false, claimed: false, state: state.state };
		const revision = control.revision + 1;
		control.claim = {
			token: randomUUID(),
			healthKey: state.key,
			revision,
			...claimant,
			started: false,
			acquiredAt: now,
		};
		return {
			claimed: true,
			state: "half-open",
			lease: { ...control.claim },
		};
	});
}

export function acquireHalfOpenClaimSync(input) {
	const claimant = claimIdentity(input);
	safeHash(input.publicConfigurationEpoch, "public configuration epoch");
	safeEpoch(input.repairEpoch);
	const now = safeTime(input.nowMs ?? Date.now());
	return updateScopeSync(input, ({ control, observations }) => {
		if (control.repairEpoch !== input.repairEpoch)
			return { write: false, claimed: false, reason: "stale-repair-epoch" };
		if (control.claim)
			return { write: false, claimed: false, reason: "claim-active" };
		const state = effective(control, observations, input, now);
		const eligibleRepair =
			state.state === "repair-hold" && repairTrialAvailable(control, input);
		const eligibleCooldown =
			state.state === "cooldown" && state.trialAvailable === true;
		if (!eligibleRepair && !eligibleCooldown)
			return { write: false, claimed: false, state: state.state };
		control.claim = {
			token: randomUUID(),
			healthKey: state.key,
			revision: control.revision + 1,
			...claimant,
			started: false,
			acquiredAt: now,
		};
		return { claimed: true, state: "half-open", lease: { ...control.claim } };
	});
}

export function exactClaim(claim, input) {
	return (
		claim &&
		(input.leaseToken === undefined || claim.token === input.leaseToken) &&
		claim.revision === input.leaseRevision &&
		claim.healthKey === createRouteHealthKey(input) &&
		claim.runId === input.runId &&
		claim.taskId === input.taskId &&
		claim.attempt === input.attempt
	);
}

export async function startHalfOpenClaim(input) {
	claimIdentity(input);
	if (!UUID_RE.test(input.leaseToken ?? ""))
		throw new RouteHealthSchemaError("half-open lease token is invalid");
	return updateScope(input, async ({ control }) => {
		if (!exactClaim(control.claim, input) || control.claim.started)
			return { write: false, started: false, reason: "stale-or-started-claim" };
		control.claim.started = true;
		return { started: true, lease: { ...control.claim } };
	});
}

export function startHalfOpenClaimSync(input) {
	claimIdentity(input);
	if (!UUID_RE.test(input.leaseToken ?? ""))
		throw new RouteHealthSchemaError("half-open lease token is invalid");
	return updateScopeSync(input, ({ control }) => {
		if (!exactClaim(control.claim, input) || control.claim.started)
			return { write: false, started: false, reason: "stale-or-started-claim" };
		control.claim.started = true;
		return { started: true, lease: { ...control.claim } };
	});
}

export async function releaseHalfOpenClaim(input) {
	claimIdentity(input);
	if (!UUID_RE.test(input.leaseToken ?? ""))
		throw new RouteHealthSchemaError("half-open lease token is invalid");
	return updateScope(input, async ({ control }) => {
		if (!exactClaim(control.claim, input))
			return { write: false, released: false, reason: "stale-claim" };
		if (control.claim.started || input.provenNeverStarted !== true)
			return {
				write: false,
				released: false,
				reason: "claim-liveness-unknown",
			};
		control.claim = null;
		return { released: true };
	});
}

export function releaseHalfOpenClaimSync(input) {
	claimIdentity(input);
	if (!UUID_RE.test(input.leaseToken ?? ""))
		throw new RouteHealthSchemaError("half-open lease token is invalid");
	return updateScopeSync(input, ({ control }) => {
		if (!exactClaim(control.claim, input))
			return { write: false, released: false, reason: "stale-claim" };
		if (control.claim.started || input.provenNeverStarted !== true)
			return {
				write: false,
				released: false,
				reason: "claim-liveness-unknown",
			};
		control.claim = null;
		return { released: true };
	});
}
