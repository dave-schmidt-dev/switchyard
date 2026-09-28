import { createHash } from "node:crypto";
import {
	validateIdentifier,
	validateInvocationArgs,
	validateModelArg,
} from "../adapter/shell-safety.mjs";
import { mapInvocationArgs, normalizeProviderName } from "./capabilities.mjs";
import { EFFORT_VALUES, VARIANT_VALUES } from "./schema.mjs";

function canonicalizeForHash(value) {
	if (Array.isArray(value)) return value.map(canonicalizeForHash);
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort()) {
			out[key] = canonicalizeForHash(value[key]);
		}
		return out;
	}
	return value;
}
const DESCRIPTOR_FIELDS = new Set([
	"target_id",
	"model_ref",
	"selector",
	"effort",
	"variant",
	"invocation_args",
]);
function descriptorCore(descriptor) {
	return {
		target_id: descriptor.target_id,
		model_ref: descriptor.model_ref,
		selector: descriptor.selector,
		effort: descriptor.effort ?? null,
		variant: descriptor.variant ?? null,
		invocation_args: [...descriptor.invocation_args],
	};
}
function requireDescriptorHarness(harness) {
	if (typeof harness !== "string" || harness.trim().length === 0) {
		throw new Error(
			"invocation descriptor harness is required and must be a non-empty string",
		);
	}
	return normalizeProviderName(harness);
}
function assertDescriptorIdentityInput(descriptor, harness) {
	if (!descriptor || typeof descriptor !== "object") {
		throw new Error("invocation descriptor must be an object");
	}
	for (const key of Object.keys(descriptor)) {
		if (key !== "descriptor_identity" && !DESCRIPTOR_FIELDS.has(key)) {
			throw new Error(`invocation descriptor has unapproved field '${key}'`);
		}
	}
	for (const field of ["target_id", "model_ref", "selector"]) {
		if (
			typeof descriptor[field] !== "string" ||
			descriptor[field].length === 0
		) {
			throw new Error(
				`invocation descriptor.${field} must be a non-empty string`,
			);
		}
	}
	validateIdentifier(descriptor.target_id, "invocation descriptor.target_id");
	validateModelArg(descriptor.model_ref, "invocation descriptor.model_ref");
	validateModelArg(descriptor.selector, "invocation descriptor.selector");
	if (!Array.isArray(descriptor.invocation_args)) {
		throw new Error("invocation descriptor.invocation_args must be an array");
	}
	if (descriptor.effort !== undefined && descriptor.effort !== null) {
		if (
			typeof descriptor.effort !== "string" ||
			!EFFORT_VALUES.has(descriptor.effort)
		) {
			throw new Error("invocation descriptor.effort is not an approved value");
		}
	}
	if (descriptor.variant !== undefined && descriptor.variant !== null) {
		if (
			typeof descriptor.variant !== "string" ||
			!VARIANT_VALUES.has(descriptor.variant)
		) {
			throw new Error("invocation descriptor.variant is not an approved value");
		}
	}
	if (descriptor.effort != null && descriptor.variant != null) {
		throw new Error(
			"invocation descriptor must not declare both effort and variant",
		);
	}
	const boundHarness = requireDescriptorHarness(harness);
	const args = validateInvocationArgs(descriptor.invocation_args, boundHarness);
	const expectedArgs = mapInvocationArgs(boundHarness, descriptor);
	if (
		expectedArgs === null ||
		args.length !== expectedArgs.length ||
		args.some((value, index) => value !== expectedArgs[index])
	) {
		throw new Error(
			`invocation descriptor argv does not match the ${boundHarness} provider mapping`,
		);
	}
	if (args[0] === "--effort" && descriptor.effort !== args[1]) {
		throw new Error(
			"invocation descriptor effort does not match invocation_args",
		);
	}
	if (args[0] === "-c" && descriptor.effort !== args[1].split("=", 2)[1]) {
		throw new Error(
			"invocation descriptor effort does not match invocation_args",
		);
	}
	if (args[0] === "--variant" && descriptor.variant !== args[1]) {
		throw new Error(
			"invocation descriptor variant does not match invocation_args",
		);
	}
}
export function validateInvocationDescriptor(value, harness) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("invocation descriptor must be an object");
	}
	for (const key of Object.keys(value)) {
		if (key === "descriptor_identity") continue;
		if (!DESCRIPTOR_FIELDS.has(key)) {
			throw new Error(`invocation descriptor has unapproved field '${key}'`);
		}
	}
	for (const field of ["target_id", "model_ref", "selector"]) {
		if (typeof value[field] !== "string" || value[field].length === 0) {
			throw new Error(
				`invocation descriptor.${field} must be a non-empty string`,
			);
		}
	}
	validateIdentifier(value.target_id, "invocation descriptor.target_id");
	validateModelArg(value.model_ref, "invocation descriptor.model_ref");
	validateModelArg(value.selector, "invocation descriptor.selector");
	if (value.effort !== undefined && value.effort !== null) {
		if (typeof value.effort !== "string" || !EFFORT_VALUES.has(value.effort)) {
			throw new Error("invocation descriptor.effort is not an approved value");
		}
	}
	if (value.variant !== undefined && value.variant !== null) {
		if (
			typeof value.variant !== "string" ||
			!VARIANT_VALUES.has(value.variant)
		) {
			throw new Error("invocation descriptor.variant is not an approved value");
		}
	}
	if (value.effort != null && value.variant != null) {
		throw new Error(
			"invocation descriptor must not declare both effort and variant",
		);
	}
	const rawArgs =
		value.invocation_args === undefined ? [] : value.invocation_args;
	const boundHarness = requireDescriptorHarness(harness);
	const args = validateInvocationArgs(rawArgs, boundHarness);
	const expectedArgs = mapInvocationArgs(boundHarness, value);
	if (
		expectedArgs === null ||
		args.length !== expectedArgs.length ||
		args.some((arg, index) => arg !== expectedArgs[index])
	) {
		throw new Error(
			`invocation descriptor argv does not match the ${boundHarness} provider mapping`,
		);
	}
	if (args[0] === "--effort" && value.effort !== args[1]) {
		throw new Error(
			"invocation descriptor effort does not match invocation_args",
		);
	}
	if (args[0] === "-c" && value.effort !== args[1].split("=", 2)[1]) {
		throw new Error(
			"invocation descriptor effort does not match invocation_args",
		);
	}
	if (args[0] === "--variant" && value.variant !== args[1]) {
		throw new Error(
			"invocation descriptor variant does not match invocation_args",
		);
	}
	const core = descriptorCore({ ...value, invocation_args: args });
	const identity = getInvocationDescriptorIdentity(core, boundHarness);
	if (
		value.descriptor_identity !== undefined &&
		value.descriptor_identity !== identity
	) {
		throw new Error(
			"invocation descriptor_identity does not match the canonical descriptor",
		);
	}
	return Object.freeze({
		...core,
		invocation_args: args,
		descriptor_identity: identity,
	});
}
export function getInvocationDescriptorIdentity(descriptor, harness) {
	const boundHarness = requireDescriptorHarness(harness);
	assertDescriptorIdentityInput(descriptor, boundHarness);
	const core = descriptorCore({
		...descriptor,
		invocation_args: descriptor.invocation_args,
	});
	const canonical = canonicalizeInvocationDescriptor(core, boundHarness);
	return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
export function canonicalizeInvocationDescriptor(descriptor, harness) {
	const boundHarness = requireDescriptorHarness(harness);
	assertDescriptorIdentityInput(descriptor, boundHarness);
	return JSON.stringify(
		canonicalizeForHash({
			...descriptorCore(descriptor),
			harness: normalizeProviderName(boundHarness),
		}),
	);
}
const descriptorIdentity = getInvocationDescriptorIdentity;
const canonicalDescriptorIdentity = getInvocationDescriptorIdentity;
const getDescriptorIdentity = getInvocationDescriptorIdentity;
export function computeRosterSha(rosterData) {
	const models =
		rosterData?.models && typeof rosterData.models === "object"
			? rosterData.models
			: {};
	const targetsIn =
		rosterData?.targets && typeof rosterData.targets === "object"
			? rosterData.targets
			: {};

	const targets = {};
	for (const [id, target] of Object.entries(targetsIn)) {
		if (!target || typeof target !== "object") {
			targets[id] = target;
			continue;
		}
		// Drop the mutable qualifications block; keep everything else.
		const { qualifications, ...rest } = target;
		void qualifications;
		targets[id] = rest;
	}

	const canonical = JSON.stringify(canonicalizeForHash({ models, targets }));
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}
