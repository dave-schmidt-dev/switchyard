// Bounded, host-safe review result contract. Provider text is never persisted;
// only this closed projection may cross the run-store boundary.

export const REVIEW_RESULT_SCHEMA_VERSION = 1;
export const REVIEW_RESULT_MAX_FINDINGS = 50;
export const REVIEW_RESULT_MAX_COMMENTS = 20;
export const REVIEW_RESULT_MAX_TEXT = 512;
export const REVIEW_RESULT_MAX_COMMENT = 1_024;

const VERDICTS = new Set(["clean", "findings", "unavailable"]);
const SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const AVAILABLE_RESULT_KEYS = new Set([
	"schemaVersion",
	"status",
	"verdict",
	"summary",
	"findings",
	"comments",
	"findingCount",
	"commentCount",
	"sourceMutationCount",
]);
const UNAVAILABLE_RESULT_KEYS = new Set([
	"schemaVersion",
	"status",
	"verdict",
	"reason",
	"findings",
	"comments",
	"findingCount",
	"commentCount",
	"sourceMutationCount",
]);
const PERSISTED_FINDING_KEYS = new Set([
	"severity",
	"summary",
	"path",
	"line",
	"endLine",
	"detail",
]);
const UNAVAILABLE_REASONS = new Set([
	"missing",
	"malformed",
	"unsupported",
	"provider_failed",
	"timeout",
]);

function boundedText(value, max) {
	if (typeof value !== "string") return null;
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint <= 0x1f ||
			(codePoint >= 0x7f && codePoint <= 0x9f) ||
			codePoint === 0x2028 ||
			codePoint === 0x2029
		)
			return null;
	}
	const text = value.trim();
	return text.length > 0 && text.length <= max ? text : null;
}

function safePath(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 512)
		return null;
	const path = value.replaceAll("\\", "/");
	for (const character of path) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint <= 0x1f ||
			(codePoint >= 0x7f && codePoint <= 0x9f) ||
			codePoint === 0x2028 ||
			codePoint === 0x2029
		)
			return null;
	}
	if (
		path.startsWith("/") ||
		path.includes("\0") ||
		path
			.split("/")
			.some((part) => part === "" || part === "." || part === "..") ||
		/^[A-Za-z]:\//u.test(path)
	)
		return null;
	return path;
}

function safeLine(value) {
	return Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000
		? value
		: null;
}

function normalizeVerdict(value) {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	const aliases = {
		pass: "clean",
		passed: "clean",
		approved: "clean",
		ok: "clean",
		fail: "findings",
		failed: "findings",
		changes_requested: "findings",
		needs_review: "findings",
		unknown: "unavailable",
		malformed: "unavailable",
	};
	const verdict = aliases[normalized] ?? normalized;
	return VERDICTS.has(verdict) ? verdict : null;
}

function unavailable(reason = "unavailable") {
	return {
		schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
		status: "unavailable",
		verdict: "unavailable",
		reason: UNAVAILABLE_REASONS.has(reason) ? reason : "unavailable",
		findings: [],
		comments: [],
		findingCount: 0,
		commentCount: 0,
		sourceMutationCount: 0,
	};
}

function normalizeFinding(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const summary = boundedText(
		value.summary ?? value.title ?? value.message,
		REVIEW_RESULT_MAX_TEXT,
	);
	const path = safePath(value.path ?? value.file);
	if (!summary || !path) return null;
	if (
		value.severity !== undefined &&
		(typeof value.severity !== "string" ||
			!SEVERITIES.has(value.severity.toLowerCase()))
	)
		return null;
	const severity = value.severity?.toLowerCase() ?? "info";
	if (
		(value.line !== undefined && safeLine(value.line) === null) ||
		(value.startLine !== undefined && safeLine(value.startLine) === null) ||
		(value.endLine !== undefined && safeLine(value.endLine) === null)
	)
		return null;
	const line = safeLine(value.line ?? value.startLine);
	const endLine = safeLine(value.endLine ?? value.line);
	if (value.endLine !== undefined && (line === null || endLine < line))
		return null;
	const finding = { severity, summary, path };
	if (line !== null) finding.line = line;
	if (endLine !== null) finding.endLine = endLine;
	const detail = boundedText(
		value.detail ?? value.comment,
		REVIEW_RESULT_MAX_COMMENT,
	);
	if (
		(value.detail !== undefined || value.comment !== undefined) &&
		detail === null
	)
		return null;
	if (detail) finding.detail = detail;
	return finding;
}

/**
 * Project untrusted provider data into the bounded review-result schema.
 * Invalid or absent data becomes an explicit unavailable result and never
 * carries the original provider text.
 *
 * @param {unknown} input provider-produced structured data
 * @returns {object} sanitized review result
 */
export function sanitizeReviewResult(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return unavailable("missing");
	}
	if (
		input.schemaVersion !== undefined &&
		input.schemaVersion !== REVIEW_RESULT_SCHEMA_VERSION
	) {
		return unavailable("malformed");
	}
	if (
		input.sourceMutationCount !== undefined &&
		input.sourceMutationCount !== 0
	) {
		return unavailable("malformed");
	}
	const verdict = normalizeVerdict(input.verdict ?? input.status);
	if (!verdict) return unavailable("malformed");
	if (verdict === "unavailable") {
		return unavailable(
			input.reason === "malformed" ? "malformed" : "provider_failed",
		);
	}
	if (input.findings !== undefined && !Array.isArray(input.findings)) {
		return unavailable("malformed");
	}
	const rawFindings = input.findings ?? [];
	if (rawFindings.length > REVIEW_RESULT_MAX_FINDINGS) {
		return unavailable("malformed");
	}
	const findings = rawFindings.map(normalizeFinding);
	if (findings.some((finding) => finding === null)) {
		return unavailable("malformed");
	}
	if (input.comments !== undefined && !Array.isArray(input.comments)) {
		return unavailable("malformed");
	}
	const rawComments = input.comments ?? [];
	if (rawComments.length > REVIEW_RESULT_MAX_COMMENTS) {
		return unavailable("malformed");
	}
	const comments = rawComments.map((comment) =>
		boundedText(comment, REVIEW_RESULT_MAX_COMMENT),
	);
	if (comments.some((comment) => comment === null)) {
		return unavailable("malformed");
	}
	const summary =
		input.summary === undefined
			? null
			: boundedText(input.summary, REVIEW_RESULT_MAX_TEXT);
	if (input.summary !== undefined && summary === null) {
		return unavailable("malformed");
	}
	return {
		schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
		status: "available",
		verdict: findings.length > 0 ? "findings" : verdict,
		...(summary ? { summary } : {}),
		findings,
		comments,
		findingCount: findings.length,
		commentCount: comments.length,
		// Review work is observational. Provider edits are discarded and may
		// never be represented as a source mutation or sent to integration.
		sourceMutationCount: 0,
	};
}

/** Validate an already-projected result without accepting extra fields. */
export function isReviewResult(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (
		value.schemaVersion !== REVIEW_RESULT_SCHEMA_VERSION ||
		value.sourceMutationCount !== 0
	)
		return false;
	if (value.status === "unavailable") {
		return (
			Object.keys(value).every((key) => UNAVAILABLE_RESULT_KEYS.has(key)) &&
			Object.keys(value).length === UNAVAILABLE_RESULT_KEYS.size &&
			value.verdict === "unavailable" &&
			UNAVAILABLE_REASONS.has(value.reason) &&
			Array.isArray(value.findings) &&
			value.findings.length === 0 &&
			Array.isArray(value.comments) &&
			value.comments.length === 0 &&
			value.findingCount === 0 &&
			value.commentCount === 0
		);
	}
	return (
		Object.keys(value).every((key) => AVAILABLE_RESULT_KEYS.has(key)) &&
		Object.keys(value).length ===
			AVAILABLE_RESULT_KEYS.size - (value.summary === undefined ? 1 : 0) &&
		value.schemaVersion === REVIEW_RESULT_SCHEMA_VERSION &&
		value.status === "available" &&
		Array.isArray(value.findings) &&
		Array.isArray(value.comments) &&
		value.verdict === (value.findings.length > 0 ? "findings" : "clean") &&
		value.findings.length <= REVIEW_RESULT_MAX_FINDINGS &&
		value.comments.length <= REVIEW_RESULT_MAX_COMMENTS &&
		value.findingCount === value.findings.length &&
		value.commentCount === value.comments.length &&
		value.sourceMutationCount === 0 &&
		(value.summary === undefined ||
			value.summary === boundedText(value.summary, REVIEW_RESULT_MAX_TEXT)) &&
		value.findings.every((finding) => {
			if (!finding || typeof finding !== "object" || Array.isArray(finding))
				return false;
			const keys = Object.keys(finding);
			if (
				!Object.hasOwn(finding, "severity") ||
				!Object.hasOwn(finding, "summary") ||
				!Object.hasOwn(finding, "path") ||
				keys.some((key) => !PERSISTED_FINDING_KEYS.has(key))
			)
				return false;
			const normalized = normalizeFinding(finding);
			if (!normalized || keys.length !== Object.keys(normalized).length)
				return false;
			return keys.every((key) => finding[key] === normalized[key]);
		}) &&
		value.comments.every(
			(comment) => comment === boundedText(comment, REVIEW_RESULT_MAX_COMMENT),
		)
	);
}

/** Find a structured review result without retaining arbitrary provider text. */
export function reviewResultFromExecution(execution) {
	if (!execution || typeof execution !== "object")
		return unavailable("missing");
	if (execution.reviewResult && typeof execution.reviewResult === "object") {
		return sanitizeReviewResult(execution.reviewResult);
	}
	if (typeof execution.output !== "string") return unavailable("missing");
	const text = execution.output.trim();
	if (!text.startsWith("{") || !text.endsWith("}"))
		return unavailable("malformed");
	try {
		return sanitizeReviewResult(JSON.parse(text));
	} catch {
		return unavailable("malformed");
	}
}

export function unavailableReviewResult(reason = "unavailable") {
	return unavailable(reason);
}
