import { createHash } from "node:crypto";

const MAX_REASON_CHARS = 800;
const STRICT_PROVIDER_LINES = Object.freeze({
	// The last alternative is codex's terminal line when a golden-image-baked
	// OAuth credential has had its refresh token rotated out from under it,
	// measured 2026-09-12 in the guest. Before it was here the whole failure
	// reached the operator as `provider_exit_nonzero`, which says nothing about
	// needing to log in again.
	auth_required:
		/^(?:Error:\s*)?(?:Authentication required|Not logged in|Session expired|Your access token could not be refreshed because your refresh token was already used\. Please log out and sign in again\.)$/iu,
	usage_exhausted:
		/^(?:Error:\s*)?(?:Usage limit reached|Quota exhausted|Rate limit exceeded)$/iu,
	model_unsupported:
		/^(?:Error:\s*)?(?:Model unavailable|Unsupported model|Model not found)$/iu,
	permission_denied: /^(?:Error:\s*)?(?:Permission denied|EACCES)$/iu,
	network_unreachable:
		/^(?:Error:\s*)?(?:Network unreachable|Connection refused|Connection error|ENOTFOUND)$/iu,
});
const PROVIDER_DIAGNOSTIC_KIND_TO_RUNTIME_CODE = Object.freeze({
	auth_required: "auth_expired",
	usage_exhausted: "quota_exhausted",
	model_unsupported: "model_unavailable",
	cli_usage_error: "cli_usage_error",
});
export function providerDiagnosticCodeForKind(kind) {
	return PROVIDER_DIAGNOSTIC_KIND_TO_RUNTIME_CODE[kind] ?? null;
}
const PROVIDER_BINARIES = Object.freeze({
	claude: new Set(["claude"]),
	codex: new Set(["codex"]),
	agy: new Set(["agy"]),
	cursor: new Set(["cursor", "cursor-agent"]),
	copilot: new Set(["copilot"]),
	opencode: new Set(["opencode"]),
	vibe: new Set(["vibe"]),
});
function streamBytes(value) {
	if (Buffer.isBuffer(value)) return value;
	return typeof value === "string"
		? Buffer.from(value, "utf8")
		: Buffer.alloc(0);
}
export function classifyProviderStreams({
	stdout = "",
	stderr = "",
	code = null,
	provider = null,
	command = null,
} = {}) {
	const outBytes = streamBytes(stdout);
	const errBytes = streamBytes(stderr);
	const out = outBytes.toString("utf8");
	const err = errBytes.toString("utf8");
	const digest = (bytes) =>
		`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	const result = {
		stdoutBytes: outBytes.length,
		stderrBytes: errBytes.length,
		stdoutDigest: digest(outBytes),
		stderrDigest: digest(errBytes),
	};
	const lines = (text) =>
		text
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter(Boolean);
	const all = [...lines(out), ...lines(err)];
	if (all.length === 0) return result;
	const binary =
		typeof command === "string" ? command.split(/[\\/]/u).at(-1) : null;
	const providerKey =
		typeof provider === "string" ? provider.toLowerCase() : null;
	const approvedPair =
		providerKey !== null &&
		binary !== null &&
		PROVIDER_BINARIES[providerKey]?.has(binary) === true;
	if (
		code === 2 &&
		all.length > 0 &&
		approvedPair &&
		all[0].startsWith(`Usage: ${binary}`)
	) {
		return { ...result, diagnosticKind: "cli_usage_error" };
	}
	if (approvedPair) {
		// An unrecognized line is not evidence against the lines that were
		// recognized. Requiring every line to match meant a provider that prints
		// its own transport noise around an unmistakable auth failure -- codex
		// interleaves websocket 401s with the re-login line -- classified as
		// nothing at all. Two different recognized kinds still refuse to
		// classify, because that is genuine disagreement rather than noise.
		let matchedKind = null;
		for (const line of all) {
			const lineKind = Object.entries(STRICT_PROVIDER_LINES).find(
				([, pattern]) => pattern.test(line),
			)?.[0];
			if (!lineKind) continue;
			if (matchedKind !== null && lineKind !== matchedKind) return result;
			matchedKind = lineKind;
		}
		if (matchedKind !== null) {
			return { ...result, diagnosticKind: matchedKind };
		}
	}
	return result;
}
const REAUTH_LOGIN = {
	claude: "claude auth login",
	codex: "codex login --device-auth",
	agy: "agy --print hi",
	cursor: "NO_OPEN_BROWSER=1 cursor-agent login",
	copilot: "copilot login",
	opencode: "opencode auth login",
};
export function reauthHintFor(provider) {
	const login = REAUTH_LOGIN[provider];
	if (!login) return null;
	return `${provider} session may have expired — re-auth with \`npm run auth\` (runs \`${login}\` against the golden image)`;
}
function truncate(text) {
	if (text.length <= MAX_REASON_CHARS) return text;
	return `${text.slice(0, MAX_REASON_CHARS)}… (truncated)`;
}
function isQuotaExhausted(text, provider) {
	const providerKey =
		typeof provider === "string" ? provider.toLowerCase() : "";
	if (providerKey === "agy") {
		return QUOTA_FAILURE_SIGNATURES.agy.test(text);
	}
	if (providerKey === "cursor") {
		return (
			QUOTA_FAILURE_SIGNATURES.cursor.usage.test(text) &&
			QUOTA_FAILURE_SIGNATURES.cursor.limit.test(text)
		);
	}
	return false;
}
function isModelUnavailable(text, provider) {
	const providerKey =
		typeof provider === "string" ? provider.toLowerCase() : "";
	const signature = MODEL_UNAVAILABLE_SIGNATURES[providerKey];
	return signature ? signature.test(text) : false;
}
export function describeExecError(error, { provider } = {}) {
	// Decoded rather than type-checked: a Buffer here would empty `combined`,
	// and every classification below is gated on `combined.length > 0`. The
	// failure mode is quiet and expensive -- the reason string still reads
	// correctly, because #detailOf already lifted the text into the message, but
	// `errorKind` comes back null and auth/index.mjs keys its headless re-login
	// on `errorKind`. An expired session would present as an unclassified error
	// and never trigger the re-auth that would have fixed it.
	const stdout = childProcessText(error?.stdout);
	const stderr = childProcessText(error?.stderr);
	const combined = `${stdout}\n${stderr}`.trim();
	const haystack = combined.toLowerCase();
	const authExpired =
		combined.length > 0 &&
		AUTH_FAILURE_SIGNATURES.some((sig) => haystack.includes(sig));
	// Auth takes precedence if a provider emits both an auth and quota phrase;
	// an expired session is not evidence that the account quota is exhausted.
	const quotaExhausted =
		!authExpired && combined.length > 0 && isQuotaExhausted(combined, provider);
	// Last in precedence: an expired session or an exhausted quota can produce
	// odd downstream output, and neither is a catalog problem. Only classify the
	// model as unavailable when nothing better explains the failure.
	const modelUnavailable =
		!authExpired &&
		!quotaExhausted &&
		combined.length > 0 &&
		isModelUnavailable(combined, provider);

	// Prefer the provider's own words; fall back to Node's wrapper only when the
	// provider printed nothing (e.g. it was killed before it could output).
	let reason = truncate(
		combined || error?.message || "unknown execution failure",
	);

	if (authExpired) {
		const hint = provider ? reauthHintFor(provider) : null;
		if (hint) reason = `${hint} | provider output: ${reason}`;
	}

	return {
		output: stdout,
		error: reason,
		errorKind: authExpired
			? "auth_expired"
			: quotaExhausted
				? "quota_exhausted"
				: modelUnavailable
					? "model_unavailable"
					: null,
	};
}

import "./exec-error-kinds.mjs";
import "./exec-error-codes.mjs";
import "./exec-error-metadata.mjs";
import "./exec-error-sanitize.mjs";
import {
	AUTH_FAILURE_SIGNATURES,
	childProcessText,
	MODEL_UNAVAILABLE_SIGNATURES,
	QUOTA_FAILURE_SIGNATURES,
} from "./exec-error-kinds.mjs";

export {
	CHECKPOINT_REMEDIATION_MESSAGES,
	checkpointRemediation,
	classifyPreProviderFailure,
	INTEGRATION_REFUSAL_KINDS,
	PERSISTED_DIAGNOSTIC_CODES,
	PRE_PROVIDER_FAILURE_TRIPLES,
} from "./exec-error-codes.mjs";
export {
	CLEANUP_STAGES,
	cleanupDiagnosticCodeFor,
	PERSISTED_ERROR_KINDS,
	PERSISTED_SIGNALS,
	PrlctlCallError,
	prlctlFailureMetadata,
	prlctlTrustedCauseCode,
	WorkerBootStageError,
	workerBootStageDiagnosticCode,
} from "./exec-error-kinds.mjs";
export {
	classifyProviderDiagnostic,
	hasAuthoritativeDiagnosticProvenance,
} from "./exec-error-metadata.mjs";
export {
	isPersistentFailureDetails,
	isPersistentFailureMetadata,
	sanitizeFailureDetails,
	sanitizeFailureMetadata,
} from "./exec-error-sanitize.mjs";
