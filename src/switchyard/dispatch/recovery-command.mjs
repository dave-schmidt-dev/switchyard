/**
 * Operator recovery commands quoted into dispatch and simple-lane envelopes.
 *
 * A leaf on purpose: the simple lane's lock disposition needs the recover
 * command, and taking it from the status envelope loaded the legacy queue,
 * broker and backend selection into every simple run.
 */
import { getStateRoot } from "../run-store/project-lock-files.mjs";
import { shellQuote } from "./cli-args.mjs";

/** @param {string} runId @returns {string} The `recover` command for one run. */
export function recoveryCommandFor(runId) {
	return `switchyard-dispatch recover --run ${runId} --state-root ${shellQuote(getStateRoot())}`;
}

/** @returns {string} The orphaned-lock remediation command for this state root. */
export function remediationCommandFor() {
	return `switchyard-dispatch remediate-orphaned-locks --state-root ${shellQuote(getStateRoot())}`;
}
