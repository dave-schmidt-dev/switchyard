/**
 * Closed provider failure signature classifier.
 *
 * Patterns are matched purely in memory to prevent raw provider streams
 * (which may contain credentials or sensitive data) from persisting to disk.
 */

export const PROVIDER_SIGNATURES = Object.freeze([
	"approval_denied",
	"auth_failed",
	"rate_limited",
	"network_error",
	"model_unavailable",
	"tool_error",
	"context_overflow",
	"unrecognized",
]);

const APPROVAL_DENIED_PATTERNS = [
	/approval[_\s-]+denied/i,
	/permission[_\s-]+denied/i,
	/user[_\s-]+(?:rejected|declined|denied|cancelled|canceled)/i,
	/(?:rejected|declined|denied|cancelled|canceled)[_\s-]+by[_\s-]+user/i,
	/(?:action|operation|tool|command)[_\s-]+(?:not[_\s-]+approved|denied|rejected)/i,
	/confirmation[_\s-]+(?:declined|denied|rejected)/i,
	/approval_policy/i,
	/\bdenied\s+by\s+policy\b/i,
];

const CONTEXT_OVERFLOW_PATTERNS = [
	/context[_\s-]+overflow/i,
	/context[_\s-]+(?:length|window|size)[_\s-]+(?:exceeded|overflow|limit)/i,
	/maximum[_\s-]+context[_\s-]+length/i,
	/max[_\s-]+context[_\s-]+length/i,
	/prompt[_\s-]+too[_\s-]+long/i,
	/token[_\s-]+limit[_\s-]+exceeded/i,
	/too[_\s-]+many[_\s-]+tokens/i,
	/input[_\s-]+too[_\s-]+large/i,
	/exceeds[_\s-]+(?:maximum[_\s-]+context|context[_\s-]+window)/i,
];

const AUTH_FAILED_PATTERNS = [
	/auth(?:entication)?[_\s-]+(?:failed|error|required|invalid|expired)/i,
	/failed[_\s-]+to[_\s-]+authenticate/i,
	/not[_\s-]+authenticated/i,
	/not[_\s-]+logged[_\s-]+in/i,
	/login[_\s-]+expired/i,
	/session[_\s-]+expired/i,
	/token[_\s-]+expired/i,
	/credentials[_\s-]+expired/i,
	/oauth[_\s-]+session[_\s-]+expired/i,
	/refresh[_\s-]+token.*already[_\s-]+used/i,
	/re-authenticate/i,
	/please[_\s-]+log\s*in/i,
	/invalid[_\s-]+(?:api[_\s-]*key|auth|token|credentials)/i,
	/api[_\s-]*key[_\s-]+invalid/i,
	/unauthorized/i,
	/\b(?:status|code)[:=\s]+401\b/i,
	/\b(?:status|code)[:=\s]+403\b/i,
	/\b401\s+unauthorized\b/i,
	/\b403\s+forbidden\b/i,
	/\bapi_status=(?:401|403)\b/i,
];

const RATE_LIMITED_PATTERNS = [
	/rate[_\s-]+limit(?:ed)?/i,
	/too[_\s-]+many[_\s-]+requests/i,
	/quota[_\s-]+(?:exhausted|exceeded|reached)/i,
	/usage[_\s-]+(?:limit[_\s-]+reached|exhausted)/i,
	/out[_\s-]+of[_\s-]+usage/i,
	/exceeded[_\s-]+.*quota/i,
	/budget[_\s-]+exhausted/i,
	/billing[_\s-]+.*budget[_\s-]+exhausted/i,
	/resource[_\s-]+exhausted/i,
	/\b(?:status|code)[:=\s]+429\b/i,
	/\b(?:status|code)[:=\s]+402\b/i,
	/\b429\s+too\s+many\s+requests\b/i,
	/\bapi_status=429\b/i,
	/\bupstream_status=429\b/i,
	/tokens?[_\s-]+per[_\s-]+minute/i,
	/requests?[_\s-]+per[_\s-]+minute/i,
	/\b(?:tpm|rpm)[_\s-]+limit\b/i,
];

const MODEL_UNAVAILABLE_PATTERNS = [
	/model[_\s-]+unavailable/i,
	/model[_\s-]+(?:not[_\s-]+found|unsupported|does[_\s-]+not[_\s-]+exist|not[_\s-]+accessible|overloaded|capacity[_\s-]+exceeded)/i,
	/unsupported[_\s-]+model/i,
	/unknown[_\s-]+model/i,
	/no[_\s-]+such[_\s-]+model/i,
	/not[_\s-]+recognized[_\s-]+as[_\s-]+a[_\s-]+known[_\s-]+model/i,
	/\b(?:status|code)[:=\s]+404\b/i,
	/\bapi_status=404\b/i,
];

const TOOL_ERROR_PATTERNS = [
	/tool[_\s-]+error/i,
	/tool[_\s-]+(?:call[_\s-]+failed|execution[_\s-]+failed|invocation[_\s-]+failed|failed|returned[_\s-]+error|crash(?:ed)?)/i,
	/failed[_\s-]+to[_\s-]+execute[_\s-]+tool/i,
	/error[_\s-]+executing[_\s-]+tool/i,
];

const NETWORK_ERROR_PATTERNS = [
	/network[_\s-]+(?:error|unreachable)/i,
	/connection[_\s-]+(?:refused|reset|error|closed|timeout|timed[_\s-]*out)/i,
	/failed[_\s-]+to[_\s-]+connect/i,
	/could[_\s-]+not[_\s-]+connect/i,
	/socket[_\s-]+hang[_\s-]+up/i,
	/fetch[_\s-]+failed/i,
	/dns[_\s-]+lookup[_\s-]+failed/i,
	/\b(?:econnrefused|enotfound|etimedout|econnreset|enetunreach|enetdown)\b/i,
	/bad[_\s-]+gateway/i,
	/service[_\s-]+unavailable/i,
	/gateway[_\s-]+timeout/i,
	/\b(?:status|code)[:=\s]+(?:502|503|504)\b/i,
];

function matchesAny(patterns, text) {
	return patterns.some((pattern) => pattern.test(text));
}

/**
 * Bound on the buffered tail per stream. A rate-limit marker split across two
 * chunks still matches, while output older than the bound is discarded.
 */
export const RATE_LIMIT_TAIL_BYTES = 8 * 1024;

/**
 * Streaming rate-limit detector over live provider chunks.
 *
 * The provider may echo its own prompt onto either stream, and a task that
 * merely discusses rate limits must not stop its own provider, so the exact
 * prompt text is removed before matching. Each stream keeps at most
 * RATE_LIMIT_TAIL_BYTES of the most recent text.
 *
 * @param {object} [input]
 * @param {string} [input.prompt] exact prompt sent to the provider
 * @returns {{ push(stream: string, chunk: string|Buffer): boolean }}
 */
export function createRateLimitMatcher({ prompt = "" } = {}) {
	const promptText = typeof prompt === "string" ? prompt : "";
	const tails = { stderr: "", stdout: "" };
	return {
		push(stream, chunk) {
			if (stream !== "stderr" && stream !== "stdout") return false;
			const text = Buffer.isBuffer(chunk)
				? chunk.toString("utf8")
				: String(chunk ?? "");
			if (!text) return false;
			const tail = `${tails[stream]}${text}`.slice(-RATE_LIMIT_TAIL_BYTES);
			tails[stream] = tail;
			const visible =
				promptText && tail.includes(promptText)
					? tail.split(promptText).join("")
					: tail;
			return matchesAny(RATE_LIMITED_PATTERNS, visible);
		},
	};
}

/**
 * Pure in-memory classification of provider outputs to a closed signature enum.
 *
 * @param {object} [input]
 * @param {string|Buffer} [input.stderr]
 * @param {string|Buffer} [input.stdout]
 * @param {number|null} [input.exitCode]
 * @param {string|null} [input.signal]
 * @returns {{ providerSignature: string, stderrBytes: number, stdoutBytes: number }}
 */
export function classifyProviderOutput({
	stderr = "",
	stdout = "",
	exitCode = null,
	signal = null,
} = {}) {
	const errText =
		typeof stderr === "string"
			? stderr
			: Buffer.isBuffer(stderr)
				? stderr.toString("utf8")
				: "";
	const outText =
		typeof stdout === "string"
			? stdout
			: Buffer.isBuffer(stdout)
				? stdout.toString("utf8")
				: "";
	const stderrBytes = Buffer.isBuffer(stderr)
		? stderr.length
		: Buffer.byteLength(errText, "utf8");
	const stdoutBytes = Buffer.isBuffer(stdout)
		? stdout.length
		: Buffer.byteLength(outText, "utf8");

	const combined = `${outText}\n${errText}`;

	let providerSignature = "unrecognized";

	if (
		matchesAny(APPROVAL_DENIED_PATTERNS, combined) ||
		signal === "SIGINT" ||
		exitCode === 130
	) {
		providerSignature = "approval_denied";
	} else if (matchesAny(CONTEXT_OVERFLOW_PATTERNS, combined)) {
		providerSignature = "context_overflow";
	} else if (
		matchesAny(AUTH_FAILED_PATTERNS, combined) ||
		exitCode === 401 ||
		exitCode === 403
	) {
		providerSignature = "auth_failed";
	} else if (matchesAny(RATE_LIMITED_PATTERNS, combined) || exitCode === 429) {
		providerSignature = "rate_limited";
	} else if (
		matchesAny(MODEL_UNAVAILABLE_PATTERNS, combined) ||
		exitCode === 404
	) {
		providerSignature = "model_unavailable";
	} else if (matchesAny(TOOL_ERROR_PATTERNS, combined)) {
		providerSignature = "tool_error";
	} else if (
		matchesAny(NETWORK_ERROR_PATTERNS, combined) ||
		exitCode === 502 ||
		exitCode === 503 ||
		exitCode === 504
	) {
		providerSignature = "network_error";
	}

	return Object.freeze({
		providerSignature,
		stderrBytes,
		stdoutBytes,
	});
}
