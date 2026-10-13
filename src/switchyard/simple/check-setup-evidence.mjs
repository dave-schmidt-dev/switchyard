import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	classifyFailedCheck,
	EVIDENCE_TAIL_BYTES,
	evidenceTail,
	redactCredentialTokens,
} from "./check-environment.mjs";

// Failed-check tails stay host-side diagnostics: the result carries this path
// and never the bytes themselves.
export function writeCheckEvidence(directory, attempt, index, check) {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, `${attempt}-${index}.log`);
	writeFileSync(
		path,
		Buffer.concat([
			evidenceTail(redactCredentialTokens(check?.output), EVIDENCE_TAIL_BYTES),
			evidenceTail(redactCredentialTokens(check?.stderr), EVIDENCE_TAIL_BYTES),
		]),
		{ mode: 0o600 },
	);
	return path;
}

/**
 * Detail fields for the `check_dependencies_unverified` refusal a failed
 * sandboxed `npm ci` setup throws.
 *
 * The redacted output tail goes to `<evidenceDir>/setup-0.log` when an
 * evidence directory is configured, and only its path travels (`outputPath`);
 * the bytes never enter an error message. A recognised environment signature
 * is named as `checkEnvironmentSignature`. A failure to write the evidence
 * never changes the refusal. A process that succeeded (the refusal then came
 * from an unconfirmed lifecycle) has no failure output to keep or classify.
 *
 * @param {object|null} setup The confined `npm ci` result.
 * @param {string|null} evidenceDir The session's evidence directory, if any.
 * @returns {{dependencyCheck: "npm_ci_failed", outputPath?: string, checkEnvironmentSignature?: string}}
 */
export function npmCiFailureDetails(setup, evidenceDir) {
	const details = { dependencyCheck: "npm_ci_failed" };
	if (setup?.success === true) return details;
	if (evidenceDir) {
		try {
			details.outputPath = writeCheckEvidence(evidenceDir, "setup", 0, setup);
		} catch {
			// Evidence retention must never change the setup refusal.
		}
	}
	const signature = classifyFailedCheck(setup, { preProvider: true });
	if (signature) details.checkEnvironmentSignature = signature;
	return details;
}
