// Validate and project an immutable roster invocation descriptor at the
// adapter boundary. The adapter must never infer provider flags from model
// names; it receives the already validated argv fragment and forwards it
// verbatim after checking the descriptor/route binding.

import {
	normalizeProviderName,
	validateInvocationDescriptor,
} from "../roster/index.mjs";

/**
 * Validate the descriptor receipt supplied to an adapter and return its exact
 * argv fragment. No coercion or recomputation of invocation_args occurs.
 *
 * @param {object} options adapter invocation options
 * @param {string} expectedHarness canonical adapter harness
 * @param {string} expectedTargetId routed target id
 * @param {string} expectedModel routed selector
 * @returns {readonly string[]}
 */
export function validateAdapterInvocation(
	options,
	{ expectedHarness, expectedTargetId, expectedModel },
) {
	const descriptor = options?.invocationDescriptor;
	const descriptorHarness = options?.descriptorHarness;
	if (
		!descriptor ||
		typeof descriptor !== "object" ||
		Array.isArray(descriptor)
	) {
		throw new Error("invocationDescriptor is required");
	}
	if (
		typeof descriptorHarness !== "string" ||
		descriptorHarness.trim() === ""
	) {
		throw new Error("descriptorHarness is required");
	}
	if (normalizeProviderName(descriptorHarness) !== expectedHarness) {
		throw new Error("invocationDescriptor harness does not match adapter");
	}
	const validated = validateInvocationDescriptor(descriptor, descriptorHarness);
	if (validated.target_id !== expectedTargetId) {
		throw new Error("invocationDescriptor target does not match routed target");
	}
	if (validated.selector !== expectedModel) {
		throw new Error("invocationDescriptor model does not match routed model");
	}
	if (options.descriptorIdentity !== validated.descriptor_identity) {
		throw new Error("descriptorIdentity does not match invocationDescriptor");
	}
	return validated.invocation_args;
}
