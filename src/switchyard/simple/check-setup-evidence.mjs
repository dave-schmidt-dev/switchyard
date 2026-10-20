import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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

// A denied path is a filesystem reference, bounded like the persisted
// evidence and executable paths (macOS PATH_MAX).
const DENIED_PATH_MAX_CHARS = 1024;
const DENIAL_LINE = /Operation not permitted|\bEPERM\b|\bdeny\(\d+\)/iu;
// `Sandbox: touch(42) deny(1) file-write-create /path`
const SEATBELT_TRACE_PATH = /\bdeny\(\d+\)\s+[a-z][a-z0-9*-]*\s+(\/.*\S)/iu;
// `touch: /path: Operation not permitted`, `fatal: cannot mkdir /path: ...`.
// A macOS name may hold a colon, but `: ` separates the tool's own prefix
// (`/bin/sh: /path: ...`), so the path never spans a colon and a space.
const PATH_BEFORE_DENIAL =
	/(?:^|[\s(=])(\/(?:[^:\r\n]|:(?!\s))*?):\s*Operation not permitted/diu;
const PATH_START = /(?:^|[\s(=])\//u;
// `EPERM: operation not permitted, open '/path'`, Python's `[Errno 1] ... '/path'`
const QUOTED_PATH = /'(\/[^'\r\n]*)'|"(\/[^"\r\n]*)"/u;

// `touch: /a: /b: Operation not permitted` denies either `/b` or `/a: /b`. A
// path right after `: ` is ambiguous when the segment before that separator
// already holds a path and is not the line's leading tool name, so the line
// names nothing rather than the wrong path.
function ambiguousAfterSeparator(line, start) {
	const before = line.slice(0, start);
	const separator = /:\s+$/u.exec(before);
	if (!separator) return false;
	const head = before.slice(0, separator.index);
	const previous = [...head.matchAll(/:\s/gu)].at(-1);
	return previous !== undefined && PATH_START.test(head.slice(previous.index));
}

function deniedPathOnLine(line) {
	if (!DENIAL_LINE.test(line)) return null;
	const trace = SEATBELT_TRACE_PATH.exec(line);
	const named = trace ? null : PATH_BEFORE_DENIAL.exec(line);
	if (named && ambiguousAfterSeparator(line, named.indices[1][0])) return null;
	const match = trace ?? named ?? QUOTED_PATH.exec(line);
	const path = match?.[1] ?? match?.[2];
	return typeof path === "string" &&
		isAbsolute(path) &&
		path.length <= DENIED_PATH_MAX_CHARS &&
		!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path)
		? path
		: null;
}

/**
 * The path a failed check's own output names as denied, or null.
 *
 * Reads the same redacted tails the evidence file keeps (stderr first, then
 * stdout) for a Seatbelt `deny(N)` trace or an `Operation not permitted` /
 * `EPERM` line and returns the first bounded absolute path one names. The
 * first denial is the cause; later ones usually cascade from it. Evidence
 * only: it never classifies the failure.
 *
 * @param {object|null} check A failed check or setup result.
 * @returns {string|null}
 */
export function sandboxDeniedPath(check) {
	if (!check || check.success === true) return null;
	for (const stream of [check.stderr, check.output]) {
		const text = evidenceTail(
			redactCredentialTokens(stream),
			EVIDENCE_TAIL_BYTES,
		).toString("utf8");
		for (const line of text.split(/\r?\n/u)) {
			const path = deniedPathOnLine(line);
			if (path) return path;
		}
	}
	return null;
}

/**
 * Detail fields for the `check_dependencies_unverified` refusal a failed
 * sandboxed `npm ci` setup throws.
 *
 * The redacted output tail goes to `<evidenceDir>/setup-0.log` when an
 * evidence directory is configured, and only its path travels (`outputPath`);
 * the bytes never enter an error message. A recognised environment signature
 * is named as `checkEnvironmentSignature`, and a path the output names as
 * denied as `sandboxDeniedPath`. A failure to write the evidence
 * never changes the refusal. A process that succeeded (the refusal then came
 * from an unconfirmed lifecycle) has no failure output to keep or classify.
 *
 * @param {object|null} setup The confined `npm ci` result.
 * @param {string|null} evidenceDir The session's evidence directory, if any.
 * @returns {{dependencyCheck: "npm_ci_failed", outputPath?: string, checkEnvironmentSignature?: string, sandboxDeniedPath?: string}}
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
	const deniedPath = sandboxDeniedPath(setup);
	if (deniedPath) details.sandboxDeniedPath = deniedPath;
	return details;
}
