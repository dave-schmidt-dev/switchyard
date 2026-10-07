/**
 * Run-scoped memory of acceptance checks that cannot run in this environment.
 *
 * Only the pre-provider dry run (phase baseline) may write memory: a check
 * that cannot run here fails every provider the same way, so the first
 * evidence stops the waterfall and is remembered for later invocations that
 * share the routing run. Post-provider classifications and genuine check
 * failures never write. The classified signature and output path are durable
 * run-record evidence (run.json `failureDetails`), never part of the result
 * envelope.
 */
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { CHECK_ENVIRONMENT_SIGNATURES } from "./check-environment.mjs";
import { MAX_BROKEN_CHECKS } from "./routing-state.mjs";

const CHECK_ENVIRONMENT_CAUSE = "check_environment_failed";
const SIGNATURES = new Set(CHECK_ENVIRONMENT_SIGNATURES);
const hasControls = (value) =>
	[...value].some(
		(char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127,
	);

// Only a durable absolute evidence path is remembered; anything else reads as
// "no evidence file" rather than failing the state write.
function evidencePath(value) {
	if (
		typeof value === "string" &&
		isAbsolute(value) &&
		value.length <= 4096 &&
		!hasControls(value)
	)
		return value;
	return null;
}

// Same identity as the dry run and the baseline: sha256 hex of the command text.
const checkIdentityOf = (command) =>
	createHash("sha256").update(command).digest("hex");

/**
 * The stored evidence for the first check in `checks` this routing run already
 * found environment-broken, or null when no remembered check matches.
 */
export function knownBrokenCheck(state, checks) {
	const remembered = state?.brokenChecks ?? [];
	for (const command of checks ?? []) {
		const entry = remembered.find(
			(item) => item.checkIdentity === checkIdentityOf(command),
		);
		if (entry) return entry;
	}
	return null;
}

/**
 * Commit one broken-check memory entry from an attempt result.
 *
 * Writes only when the result is the pre-provider dry run's
 * `check_environment_failed` and the durable run record carries the classified
 * evidence; a post-provider classification never writes. Returns the committed
 * entry, or null when nothing was committed.
 */
export function rememberBrokenCheck(
	state,
	commit,
	{ result, record, now = Date.now },
) {
	if (result?.failurePhase !== "baseline") return null;
	if (result?.providerReliability?.causeCode !== CHECK_ENVIRONMENT_CAUSE)
		return null;
	const details = record?.failureDetails;
	const checkIdentity = details?.checkIdentity;
	const signature = details?.checkEnvironmentSignature;
	if (
		typeof checkIdentity !== "string" ||
		!/^[a-f0-9]{64}$/u.test(checkIdentity) ||
		typeof signature !== "string" ||
		!SIGNATURES.has(signature)
	)
		return null;
	const outputPath = details?.outputPath;
	const previous = state.brokenChecks ?? [];
	if (previous.length >= MAX_BROKEN_CHECKS) return null;
	const entry = {
		checkIdentity,
		causeCode: CHECK_ENVIRONMENT_CAUSE,
		signature,
		outputPath: evidencePath(outputPath),
		at: new Date(now()).toISOString(),
	};
	commit({ brokenChecks: [...previous, entry] });
	return entry;
}
