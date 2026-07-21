// Shared shell-interpolation safety helpers for provider adapters.
// Centralized so a validation fix applied to one adapter can't silently miss
// its sibling (this file exists because that happened once already).

// Safe identifier pattern: Docker container names and model names.
// Allows alphanumeric, hyphen, underscore, dot, colon, forward-slash.
// Rejects spaces and shell metacharacters before any shell interpolation.
const SAFE_IDENTIFIER_RE = /^[\w./:@-]+$/;

// Safe env-var-name pattern: BWS secret names doubling as the container env
// var they're forwarded under (project convention: UPPERCASE_SNAKE_CASE
// matching the env var — see ~/.claude/skills/bws).
const SAFE_ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Validate that a string is a safe identifier for shell interpolation.
 * Throws on invalid input — fail closed so no malformed value reaches a shell.
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
 * Validate that a string is safe to use both as a BWS secret name and as a
 * `docker exec -e NAME`-forwarded env var name.
 * @param {string} value
 * @param {string} label
 */
export function validateEnvName(value, label) {
	if (!value || typeof value !== "string") {
		throw new Error(`${label} must be a non-empty string`);
	}
	if (!SAFE_ENV_NAME_RE.test(value)) {
		throw new Error(
			`${label} must be UPPERCASE_SNAKE_CASE: ${JSON.stringify(value)}`,
		);
	}
}
