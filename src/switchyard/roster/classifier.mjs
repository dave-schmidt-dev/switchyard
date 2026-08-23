// Capability enum validation only. Queue and programmatic task contracts own
// their explicit RequiredCapability; this module never infers it from prose.

import { CAPABILITY_CLASS } from "./index.mjs";

const RETIRED_INFERENCE_MESSAGE =
	"task capability inference is retired; declare RequiredCapability in the task contract";

/**
 * Fail loud for callers of the retired description-based classifier.
 * @returns {never}
 */
export function classifyTask() {
	throw new Error(RETIRED_INFERENCE_MESSAGE);
}

/**
 * Fail loud for callers of the retired batch description classifier.
 * @returns {never}
 */
export function classifyTasks() {
	throw new Error(RETIRED_INFERENCE_MESSAGE);
}

/**
 * Validate that a required capability is one of the known capability classes.
 * @param {string} capabilityClass
 * @returns {boolean}
 */
export function isValidCapabilityClass(capabilityClass) {
	return Object.values(CAPABILITY_CLASS).includes(capabilityClass);
}
