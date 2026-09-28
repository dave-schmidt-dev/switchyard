import { createHash, randomUUID } from "node:crypto";
import {
	validateIdentifier,
	validateInvocationArgs,
	validateModelArg,
} from "../adapter/shell-safety.mjs";
import {
	getInvocationDescriptorIdentity,
	normalizeProviderName,
	resolveTargetIdentity,
	validateInvocationDescriptor,
} from "../roster/index.mjs";
import {
	PROCESS_INSTANCE_ID,
	ROUTE_HEALTH_BINDING_KEYS,
	ROUTE_HEALTH_EPOCH_RE,
} from "./constants.mjs";
import { SchemaError, validateRunId } from "./errors.mjs";

function ownerUidMatches(stat) {
	return typeof process.getuid !== "function" || stat.uid === process.getuid();
}
function ownerOnlyDirectoryStat(stat) {
	return (
		stat.isDirectory() &&
		!stat.isSymbolicLink() &&
		ownerUidMatches(stat) &&
		(stat.mode & 0o077) === 0
	);
}
function ownerOnlyRegularFileStat(stat, maxBytes) {
	return (
		stat.isFile() &&
		!stat.isSymbolicLink() &&
		stat.nlink === 1 &&
		ownerUidMatches(stat) &&
		(stat.mode & 0o077) === 0 &&
		stat.size <= maxBytes
	);
}
function validateRouteHealthBinding(binding) {
	if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
		throw new SchemaError("route health binding is invalid");
	}
	if (
		Object.keys(binding).some((key) => !ROUTE_HEALTH_BINDING_KEYS.has(key)) ||
		binding.version !== 1 ||
		binding.producer !== "run-store" ||
		typeof binding.runId !== "string" ||
		!Number.isSafeInteger(binding.runRevision) ||
		binding.runRevision < 1 ||
		typeof binding.adapterContractId !== "string" ||
		binding.adapterContractId.length === 0 ||
		binding.adapterContractId.length > 128 ||
		!ROUTE_HEALTH_EPOCH_RE.test(binding.publicConfigurationEpoch) ||
		!Number.isSafeInteger(binding.repairEpoch) ||
		binding.repairEpoch < 0 ||
		typeof binding.transportVerified !== "boolean" ||
		typeof binding.lifecycleVerified !== "boolean" ||
		(binding.claimRevision !== undefined &&
			binding.lifecycleVerified !== true) ||
		(binding.claimRevision !== undefined &&
			(!Number.isSafeInteger(binding.claimRevision) ||
				binding.claimRevision < 1))
	) {
		throw new SchemaError("route health binding is invalid");
	}
}
export function isSafeTargetId(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 256) {
		return false;
	}
	return ![...value].some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint <= 0x1f || codePoint === 0x7f;
	});
}
export function createFencingIdentity(
	runId,
	processStartIdentity = PROCESS_INSTANCE_ID,
	nonce = randomUUID(),
) {
	validateRunId(runId);
	if (
		typeof processStartIdentity !== "string" ||
		processStartIdentity.length === 0 ||
		typeof nonce !== "string" ||
		nonce.length === 0
	) {
		throw new SchemaError("fencing identity is invalid");
	}
	return { runId, processStartIdentity, nonce };
}
const DESCRIPTOR_IDENTITY_RE = /^sha256:[a-f0-9]{64}$/;
const DESCRIPTOR_CONTROL_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
function legacyDescriptorIdentityForReceipt(value) {
	const canonical = {
		effort: value.effort ?? null,
		invocation_args: [...value.invocation_args],
		model_ref: value.model_ref,
		selector: value.selector,
		target_id: value.target_id,
		variant: value.variant ?? null,
	};
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(canonical), "utf8")
		.digest("hex")}`;
}
function knownTargetHarness(targetId) {
	try {
		const identity = resolveTargetIdentity(targetId);
		return identity?.targetId === targetId ? identity.harnessKey : null;
	} catch {
		return null;
	}
}
function isSafeDescriptorReceipt(value, descriptorHarness = null) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const fields = [
		"target_id",
		"model_ref",
		"selector",
		"effort",
		"variant",
		"invocation_args",
		"descriptor_identity",
	];
	if (Object.keys(value).some((key) => !fields.includes(key))) return false;
	try {
		validateIdentifier(value.target_id, "descriptor target_id");
		validateModelArg(value.model_ref, "descriptor model_ref");
		validateModelArg(value.selector, "descriptor selector");
	} catch {
		return false;
	}
	if (!DESCRIPTOR_IDENTITY_RE.test(value.descriptor_identity)) return false;
	if (
		(value.effort !== null &&
			value.effort !== undefined &&
			(typeof value.effort !== "string" ||
				!["low", "medium", "high", "xhigh", "max"].includes(value.effort))) ||
		(value.variant !== null &&
			value.variant !== undefined &&
			(typeof value.variant !== "string" ||
				![
					"default",
					"none",
					"low",
					"medium",
					"high",
					"xhigh",
					"max",
					"thinking",
				].includes(value.variant))) ||
		(value.effort != null && value.variant != null)
	)
		return false;
	if (!Array.isArray(value.invocation_args)) return false;
	if (
		value.invocation_args.some(
			(arg) => typeof arg !== "string" || DESCRIPTOR_CONTROL_RE.test(arg),
		)
	)
		return false;
	const validArgGrammar = ["claude", "codex", "opencode"].some((harness) => {
		try {
			validateInvocationArgs(value.invocation_args, harness);
			return true;
		} catch {
			return false;
		}
	});
	if (!validArgGrammar) return false;
	if (
		value.invocation_args[0] === "--effort" &&
		value.effort !== value.invocation_args[1]
	) {
		return false;
	}
	if (
		value.invocation_args[0] === "-c" &&
		value.effort !== value.invocation_args[1].split("=", 2)[1]
	) {
		return false;
	}
	if (
		value.invocation_args[0] === "--variant" &&
		value.variant !== value.invocation_args[1]
	) {
		return false;
	}
	if (descriptorHarness !== null && descriptorHarness !== undefined) {
		if (
			typeof descriptorHarness !== "string" ||
			descriptorHarness.trim() === ""
		) {
			return false;
		}
		try {
			validateInvocationDescriptor(value, descriptorHarness);
			if (
				getInvocationDescriptorIdentity(value, descriptorHarness) !==
				value.descriptor_identity
			)
				return false;
		} catch {
			return false;
		}
		if (!normalizeProviderName(descriptorHarness)) return false;
		const rosterHarness = knownTargetHarness(value.target_id);
		if (
			rosterHarness &&
			normalizeProviderName(descriptorHarness) !==
				normalizeProviderName(rosterHarness)
		) {
			return false;
		}
	} else if (
		value.descriptor_identity !== legacyDescriptorIdentityForReceipt(value)
	) {
		// A model-only historical receipt cannot be rebound to a harness safely;
		// accept only the exact legacy digest and keep it out of strict execution.
		return false;
	}
	return true;
}

export {
	DESCRIPTOR_CONTROL_RE,
	DESCRIPTOR_IDENTITY_RE,
	isSafeDescriptorReceipt,
	knownTargetHarness,
	legacyDescriptorIdentityForReceipt,
	ownerOnlyDirectoryStat,
	ownerOnlyRegularFileStat,
	ownerUidMatches,
	validateRouteHealthBinding,
};
