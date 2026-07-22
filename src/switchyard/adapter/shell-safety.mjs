// Shared shell-interpolation safety helpers for provider adapters.
// Centralized so a validation fix applied to one adapter can't silently miss
// its sibling (this file exists because that happened once already).

// Safe identifier pattern: Docker container names passed as a single
// execFileSync argv element (never shell-interpolated today). Rejects spaces
// and shell metacharacters as defense-in-depth against a future refactor
// accidentally reintroducing shell interpolation.
const SAFE_IDENTIFIER_RE = /^[\w./:@-]+$/;

// Safe model-argument pattern: broader than SAFE_IDENTIFIER_RE because model
// values are only ever delivered as a single execFileSync argv element (never
// interpolated into a shell string), so display-name conventions like
// "Gemini 3.6 Flash (High)" are legitimate. Still rejects shell metacharacters
// as defense-in-depth against a future refactor accidentally adding a shell.
// Rejects any value starting with `-` to prevent flag-like values (defense-in-depth
// against model values becoming attacker-controlled in the future).
const SAFE_MODEL_ARG_RE = /^(?!-)[\w./:@() -]{1,200}$/;

/**
 * Validate that a string is a safe Docker container-name identifier.
 * Throws on invalid input — fail closed so no malformed value reaches Docker,
 * and as defense-in-depth against a future refactor reintroducing a shell.
 * @param {string} value
 * @param {string} label Human-readable name for error messages.
 */
export function validateIdentifier(value, label) {
	if (!value || typeof value !== "string") {
		throw new Error(`${label} must be a non-empty string`);
	}
	if (!SAFE_IDENTIFIER_RE.test(value)) {
		throw new Error(
			`${label} contains unsafe characters: ${JSON.stringify(value)}`,
		);
	}
}

/**
 * Validate that a string is safe to pass as a single execFileSync argv
 * element for a model name/flag value. Never shell-interpolated — see
 * SAFE_MODEL_ARG_RE for why this is broader than validateIdentifier.
 * @param {string} value
 * @param {string} label
 */
export function validateModelArg(value, label) {
	if (!value || typeof value !== "string") {
		throw new Error(`${label} must be a non-empty string`);
	}
	if (!SAFE_MODEL_ARG_RE.test(value)) {
		throw new Error(
			`${label} contains unsafe characters: ${JSON.stringify(value)}`,
		);
	}
}
