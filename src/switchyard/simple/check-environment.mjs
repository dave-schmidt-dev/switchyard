/**
 * Check environment failure classification.
 *
 * Separates "the check could not run here" (a denied exec path, a missing tool,
 * a sandbox denial, a broken Xcode toolchain, a blocked temp directory) from a
 * check that ran and reported a genuine failure. Everything here is pure: it
 * reads only its arguments, so the same evidence always classifies the same.
 *
 * The signature list is deliberately conservative. A bare `No such file` or
 * `No module named x` is what an ordinary regression prints, so neither
 * classifies; an unknown failure stays an ordinary check failure.
 */

/** Bytes of each stream kept in the evidence file and fed to the classifier. */
export const EVIDENCE_TAIL_BYTES = 16 * 1024;

/** Closed set of environment signatures the classifier can return. */
export const CHECK_ENVIRONMENT_SIGNATURES = Object.freeze([
	"exec_denied",
	"tool_missing",
	"sandbox_denial",
	"xcode_toolchain",
	"tmp_write_denied",
]);

const XCODE_MARKERS = [
	"xcode-select: error",
	"xcrun: error",
	"not agreed to the Xcode license",
	"unable to read data link",
];
// Dry-run only: exit 69 (EX_UNAVAILABLE) with any of these markers is the
// unlicensed-Xcode refusal; the message wording varies by tool.
const XCODE_LICENSE_MARKERS = [
	"Xcode license",
	"agreed to the Xcode license",
	"xcodebuild -license",
];
const XCODE_LICENSE_EXIT_CODE = 69;
// A Seatbelt trace line: `deny(1) file-write-create /path`.
const SANDBOX_DENY_LINE = /\bdeny\(\d+\)\s+[a-z][a-z0-9*-]*/iu;

/** Last `maxBytes` of a stream, as a Buffer. */
export function evidenceTail(value, maxBytes = EVIDENCE_TAIL_BYTES) {
	const bytes = Buffer.isBuffer(value)
		? value
		: Buffer.from(typeof value === "string" ? value : "", "utf8");
	return bytes.length <= maxBytes
		? bytes
		: bytes.subarray(bytes.length - maxBytes);
}

/**
 * Classify one failed check into a closed environment signature.
 *
 * `signal` is accepted for call-site symmetry but never classifies: a signal is
 * how a timeout or cancellation ends a process, not an environment fault.
 *
 * @param {object} input
 * @param {number|null} [input.exitCode]
 * @param {string|Buffer|null} [input.output] Evidence text (combined streams).
 * @param {boolean} [input.preProvider] True in the pre-provider dry run, where
 *   the full signature set applies (including the exit-69 Xcode licence rule).
 *   After the provider only exit 126/127 and a Seatbelt `deny(` line classify:
 *   a genuine regression can print `Operation not permitted`, so message text
 *   never proves an environment fault once code has changed.
 * @returns {"exec_denied"|"tool_missing"|"sandbox_denial"|"xcode_toolchain"|"tmp_write_denied"|null}
 */
export function classifyCheckEnvironmentFailure({
	exitCode = null,
	output = "",
	preProvider = true,
} = {}) {
	const code =
		Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255
			? exitCode
			: null;
	if (code === 126) return "exec_denied";
	if (code === 127) return "tool_missing";
	const text =
		typeof output === "string"
			? output
			: Buffer.isBuffer(output)
				? output.toString("utf8")
				: "";
	if (!preProvider)
		return SANDBOX_DENY_LINE.test(text) ? "sandbox_denial" : null;
	if (
		code === XCODE_LICENSE_EXIT_CODE &&
		XCODE_LICENSE_MARKERS.some((marker) => text.includes(marker))
	)
		return "xcode_toolchain";
	if (XCODE_MARKERS.some((marker) => text.includes(marker)))
		return "xcode_toolchain";
	// A blocked temp directory is a sandbox denial too; the specific signature
	// wins so `mkdtemp(...): Operation not permitted` is not reported generically.
	if (
		text.includes("couldNotFindTmpDir") ||
		(text.includes("mkdtemp(") && /not permitted/iu.test(text))
	)
		return "tmp_write_denied";
	if (text.includes("Operation not permitted") || SANDBOX_DENY_LINE.test(text))
		return "sandbox_denial";
	return null;
}

/** Evidence text of a failed check: the tail of each stream, as the evidence file keeps them. */
function checkEvidenceText(check) {
	return Buffer.concat([
		evidenceTail(check?.output),
		evidenceTail(check?.stderr),
	]).toString("utf8");
}

/**
 * Classify a finished check result.
 *
 * A passing check, a timed-out check and a silence-timed-out check never
 * classify: a hang is not proof the environment is broken, and timeouts keep
 * their own failure path.
 *
 * @param {object|null} check A `runCheck` result.
 * @param {object} [options]
 * @param {boolean} [options.preProvider] See `classifyCheckEnvironmentFailure`.
 * @returns {string|null}
 */
export function classifyFailedCheck(check, { preProvider = true } = {}) {
	if (
		!check ||
		check.success === true ||
		check.timedOut === true ||
		check.silenceTimedOut === true
	)
		return null;
	return classifyCheckEnvironmentFailure({
		exitCode: check.code ?? null,
		output: checkEvidenceText(check),
		preProvider,
	});
}
