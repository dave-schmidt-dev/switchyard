// Shared shell-interpolation safety helpers for provider adapters.
// Centralized so a validation fix applied to one adapter can't silently miss
// its sibling (this file exists because that happened once already).

// Safe identifier pattern: Docker container names passed as a single
// execFileSync argv element (never shell-interpolated today). Rejects spaces
// and shell metacharacters as defense-in-depth against a future refactor
// accidentally reintroducing shell interpolation.
const SAFE_IDENTIFIER_RE = /^[\w./:@-]+$/;
const SAFE_PARALLELS_UUID_RE =
	/^\{?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}?$/i;

// Safe model-argument pattern: broader than SAFE_IDENTIFIER_RE because model
// values are only ever delivered as a single execFileSync argv element (never
// interpolated into a shell string), so display-name conventions like
// "Gemini 3.6 Flash (High)" are legitimate. Still rejects shell metacharacters
// as defense-in-depth against a future refactor accidentally adding a shell.
// Rejects any value starting with `-` to prevent flag-like values (defense-in-depth
// against model values becoming attacker-controlled in the future).
const SAFE_MODEL_ARG_RE = /^(?!-)[\w./:@() -]{1,200}$/;

// Invocation descriptors carry argv fragments from the roster.  They are
// never shell-interpolated, but treating them as an unbounded argv transport
// would still let a roster edit silently add provider flags or move values to
// a different position.  Keep the grammar deliberately small and validate
// the complete shape below.
const SAFE_INVOCATION_ARG_RE = /^[^\r\n]{1,200}$/;
const EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max"]);
const VARIANT_VALUES = new Set([
	"default",
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"thinking",
]);

function assertInvocationArgString(value, label) {
	if (
		typeof value !== "string" ||
		value.includes("\u0000") ||
		!SAFE_INVOCATION_ARG_RE.test(value)
	) {
		throw new Error(`${label} must be a non-empty safe argv string`);
	}
}

/**
 * Validate the provider-specific argv fragment carried by an invocation
 * descriptor.  The allowlist is positional: a flag must be followed by its
 * one approved value and no other flags/values are accepted.
 *
 * @param {unknown} args
 * @param {string} harness
 * @returns {readonly string[]}
 */
export function validateInvocationArgs(args, harness) {
	if (!Array.isArray(args)) {
		throw new Error("invocation_args must be an array");
	}
	args.forEach((value, index) => {
		assertInvocationArgString(value, `invocation_args[${index}]`);
	});

	const values = [...args];
	if (harness === "codex") {
		if (values.length === 0) return Object.freeze(values);
		if (
			values.length !== 2 ||
			values[0] !== "-c" ||
			!/^model_reasoning_effort=(low|medium|high|xhigh)$/.test(values[1])
		) {
			throw new Error(
				"codex invocation_args must be [-c, model_reasoning_effort=<low|medium|high|xhigh>]",
			);
		}
		return Object.freeze(values);
	}
	if (harness === "opencode") {
		if (values.length === 0) return Object.freeze(values);
		if (
			values.length !== 2 ||
			values[0] !== "--variant" ||
			!VARIANT_VALUES.has(values[1])
		) {
			throw new Error(
				"opencode invocation_args must be [--variant, default|none|low|medium|high|xhigh|max|thinking]",
			);
		}
		return Object.freeze(values);
	}
	// Claude's effort is an explicit argv pair.  Other adapters currently
	// encode variant/effort in the selector and therefore accept no fragment.
	if (harness === "claude") {
		if (values.length === 0) return Object.freeze(values);
		if (
			values.length !== 2 ||
			values[0] !== "--effort" ||
			!EFFORT_VALUES.has(values[1])
		) {
			throw new Error(
				"claude invocation_args must be [--effort, low|medium|high|xhigh|max]",
			);
		}
		return Object.freeze(values);
	}
	if (values.length > 0) {
		throw new Error(`${harness} does not allow invocation_args`);
	}
	return Object.freeze(values);
}

/**
 * Validate that a string is a safe workspace identifier. Docker names use
 * SAFE_IDENTIFIER_RE; Parallels workspaces use an exact UUID, optionally
 * wrapped in the braces returned by prlctl.
 * Throws on invalid input — fail closed so no malformed value reaches Docker,
 * and as defense-in-depth against a future refactor reintroducing a shell.
 * @param {string} value
 * @param {string} label Human-readable name for error messages.
 */
export function validateIdentifier(value, label) {
	if (!value || typeof value !== "string") {
		throw new Error(`${label} must be a non-empty string`);
	}
	if (!SAFE_IDENTIFIER_RE.test(value) && !SAFE_PARALLELS_UUID_RE.test(value)) {
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
