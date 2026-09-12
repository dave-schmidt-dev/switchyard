// Single point at which a workspace execution substrate is chosen.
//
// Four production sites build a backend — the queue runner, the detached
// status/result/recover reconstruction, its execFn-injected variant, and the
// login path — and until now each named `ParallelsExecutionBackend` directly
// and rebuilt the same environment-derived options by hand. Any second
// substrate would have had to be threaded through all four, and a site that was
// missed would silently keep running the macOS lane. Selection lives here so
// adding a substrate is one edit and omitting a site is impossible.

import { ParallelsExecutionBackend } from "./parallels-execution-backend.mjs";

// Extend only alongside a substrate that has passed its own qualification.
// `runner/index.mjs`'s QUEUE_PLATFORMS is the queue-facing name for the same
// constraint and must move in step.
const SUPPORTED_BACKEND_KINDS = Object.freeze(["macos"]);
const DEFAULT_BACKEND_KIND = "macos";

/**
 * Resolve which substrate a workspace runs on.
 *
 * There is deliberately no environment override: a knob whose only legal value
 * is the default is configuration that cannot be tested, and the first real
 * choice belongs to an owner-gated cutover, not to an env var.
 * @returns {string}
 */
export function resolveExecutionBackendKind() {
	return DEFAULT_BACKEND_KIND;
}

/**
 * The environment-derived options every host-side backend shares. An explicitly
 * supplied value wins; `undefined` falls through to the environment, so a
 * caller may pass its own dependency bag's fields straight in.
 * @param {{goldenImage?: string, aquaUid?: string, providerUser?: string}} [overrides]
 * @returns {{goldenImage: string|undefined, aquaUid: string|undefined, providerUser: string}}
 */
export function hostBackendDefaults(overrides = {}) {
	return {
		goldenImage:
			overrides.goldenImage ?? process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE,
		aquaUid: overrides.aquaUid ?? process.env.SWITCHYARD_PARALLELS_AQUA_UID,
		providerUser:
			overrides.providerUser ??
			process.env.SWITCHYARD_PARALLELS_PROVIDER_USER ??
			"switchyard",
	};
}

/**
 * Build the execution backend for the resolved substrate. Options are passed to
 * the backend unchanged; callers that want the shared host options spread
 * `hostBackendDefaults()` into them, and the one caller that deliberately wants
 * a bare injected-exec backend passes only `execFn`.
 * @param {object} [options]
 * @returns {import("./execution-backend.mjs").ExecutionBackend}
 */
export function createExecutionBackend(options = {}) {
	const kind = resolveExecutionBackendKind();
	if (!SUPPORTED_BACKEND_KINDS.includes(kind)) {
		throw new Error(
			`unsupported execution backend "${kind}"; expected one of ${SUPPORTED_BACKEND_KINDS.join(", ")}`,
		);
	}
	return new ParallelsExecutionBackend(options);
}
