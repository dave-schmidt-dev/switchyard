import { spawnSync } from "node:child_process";

import { resolve, sep } from "node:path";

export const APPLY_CHECK_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Fixed production timeout for one `git apply` metadata command (`--numstat`
 * or `--summary`), in milliseconds. A command that exceeds it is killed with
 * SIGKILL — a child that ignores SIGTERM cannot outlive it — and its partial
 * output is discarded. The exact declared integration path makes at most four
 * metadata calls (two per command), so the nominal cumulative bound is 120
 * seconds; this bounds each metadata command only, not the whole integration
 * or any caller deadline.
 */
export const METADATA_COMMAND_TIMEOUT_MS = 30000;

// Trusted test-only seam: shortens the metadata command timeout so tests can
// exercise the SIGKILL path without waiting 30 seconds. Only values strictly
// shorter than the production bound are accepted, so the seam can never relax
// the bound; the production value is never read from the environment or from
// provider input.
let metadataCommandTimeoutForTests = null;

export function setMetadataCommandTimeoutForTests(timeoutMs) {
	if (timeoutMs === null) {
		metadataCommandTimeoutForTests = null;
		return;
	}
	if (
		typeof timeoutMs !== "number" ||
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs >= METADATA_COMMAND_TIMEOUT_MS
	) {
		throw new Error(
			"metadata command timeout seam accepts only timeouts shorter than the production bound",
		);
	}
	metadataCommandTimeoutForTests = timeoutMs;
}

const SENSITIVE_PATH_PATTERNS = [
	/(^|\/)\.env(\.|$)/i,
	/(^|\/)\.npmrc$/i,
	/(^|\/)\.netrc$/i,
	/(^|\/)\.ssh\//i,
	/(^|\/)id_rsa/i,
	/(^|\/)id_ed25519/i,
	/\.pem$/i,
	/\.key$/i,
	/(^|\/)credentials(\.|$)/i,
	/(^|\/)secrets?\.(json|ya?ml|yml|toml)$/i,
	/(^|\/)\.aws\/credentials$/i,
	/(^|\/)\.docker\/config\.json$/i,
];

const MANIFEST_REVIEW_PATTERNS = [
	/(^|\/)package\.json$/i,
	/(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lock(?:b)?)$/i,
	/(^|\/)Makefile$/i,
	/(^|\/)Dockerfile/i,
	/\.(sh|bash)$/i,
	/(^|\/)\.github\/workflows\//i,
	/(^|\/)\.gitlab-ci\.ya?ml$/i,
];

export function manifestReviewPaths(paths) {
	return paths.filter((path) =>
		MANIFEST_REVIEW_PATTERNS.some((pattern) => pattern.test(path)),
	);
}

export function normalizePatch(diff) {
	if (typeof diff !== "string" || diff.length === 0 || diff.endsWith("\n")) {
		return diff;
	}
	return `${diff}\n`;
}

function escapesProjectRoot(projectRoot, relativePath) {
	const root = resolve(projectRoot);
	const target = resolve(root, relativePath);
	return target !== root && !target.startsWith(root + sep);
}

export function dequoteGitPath(path) {
	if (path.length < 2 || path[0] !== '"' || path[path.length - 1] !== '"') {
		return path;
	}

	const simpleEscapes = {
		a: 0x07,
		b: 0x08,
		f: 0x0c,
		n: 0x0a,
		r: 0x0d,
		t: 0x09,
		v: 0x0b,
		'"': 0x22,
		"\\": 0x5c,
	};

	const inner = path.slice(1, -1);
	const bytes = [];
	for (let i = 0; i < inner.length; i++) {
		if (inner[i] !== "\\") {
			bytes.push(inner.charCodeAt(i));
			continue;
		}

		const next = inner[i + 1];
		if (next === undefined) {
			// Dangling backslash (not valid git output) — keep it literally.
			bytes.push(0x5c);
			continue;
		}
		if (next >= "0" && next <= "7") {
			// `\NNN`: exactly three octal digits => one raw byte.
			bytes.push(Number.parseInt(inner.slice(i + 1, i + 4), 8) & 0xff);
			i += 3;
			continue;
		}
		const mapped = simpleEscapes[next];
		if (mapped !== undefined) {
			bytes.push(mapped);
			i += 1;
			continue;
		}
		// Unknown escape (not valid git output) — keep the escaped char.
		bytes.push(inner.charCodeAt(i + 1));
		i += 1;
	}

	return Buffer.from(bytes).toString("utf8");
}

export function parseRenamePaths(line) {
	// Shared-prefix format: rename prefix/{old => new} (100%)
	// Try this FIRST — it's more specific than the plain format.
	let match = line.match(/^\s*rename\s+(.+?)\{([^}]+?)\s+=>\s+([^}]+)\}(.*)$/);
	if (match) {
		const prefix = match[1];
		const oldTail = match[2].trim();
		const newTail = match[3].trim();
		return {
			old: dequoteGitPath(`${prefix}${oldTail}`),
			new: dequoteGitPath(`${prefix}${newTail}`),
		};
	}

	// Plain format: rename old/path => new/path
	match = line.match(/^\s*rename\s+(.+?)\s+=>\s+(.+?)(?:\s*\([^)]*\))?\s*$/);
	if (match) {
		return {
			old: dequoteGitPath(match[1].trim()),
			new: dequoteGitPath(match[2].trim()),
		};
	}

	return null;
}

const CORRUPT_PATCH_PATTERN = /corrupt patch|unrecognized input/i;

// git's own applicability diagnostics — the only stderr text besides the
// corrupt-patch text that may keep the historical `conflict` classification.
// Any other nonzero-exit stderr (environment, repository, or garbage text)
// is incomplete metadata, not a diagnosed patch conflict.
const CONFLICT_DIAGNOSTIC_PATTERN = /patch does not apply|patch failed/i;

export function classifyApplyFailure(stderrText) {
	return CORRUPT_PATCH_PATTERN.test(stderrText) ? "corrupt_patch" : "conflict";
}

// Sanitized internal failure representation: which metadata phase failed and
// a closed category. Never carries process error or output text.
function metadataFailure(phase, category, reasonKind) {
	return {
		phase,
		category,
		reasonKind: reasonKind ?? "integration_state_unknown",
	};
}

/**
 * The one checked command execution path for both metadata commands. Bounds
 * each command by the fixed timeout (SIGKILL on expiry) and by the shared
 * 8 MiB output cap, and discards all partial stdout/stderr on spawn error,
 * timeout, overflow, signal, or nonzero exit: only a clean zero exit is
 * confirmed metadata. Stderr is examined here, for classification only, and
 * never leaves this function.
 */
function runCheckedMetadataCommand(phase, metadataArgs, diff, projectPath) {
	const options = {
		cwd: projectPath,
		input: diff,
		encoding: "utf8",
		timeout: metadataCommandTimeoutForTests ?? METADATA_COMMAND_TIMEOUT_MS,
		killSignal: "SIGKILL",
	};
	// The same output bound as the apply probes, applied by assignment so the
	// applyCheckPasses source contract keeps its single literal wiring anchor
	// (tests/integration-gate-integration-gate-1.test.mjs).
	options.maxBuffer = APPLY_CHECK_MAX_BUFFER;
	let result;
	try {
		result = spawnSync(
			"git",
			["-c", "core.quotePath=false", "apply", ...metadataArgs],
			options,
		);
	} catch {
		return { ok: false, failure: metadataFailure(phase, "spawn_error") };
	}
	if (result.error) {
		if (result.error.code === "ENOBUFS") {
			return { ok: false, failure: metadataFailure(phase, "output_overflow") };
		}
		if (result.error.code === "ETIMEDOUT") {
			return { ok: false, failure: metadataFailure(phase, "timeout") };
		}
		return { ok: false, failure: metadataFailure(phase, "spawn_error") };
	}
	if (result.signal) {
		return { ok: false, failure: metadataFailure(phase, "signal") };
	}
	if (result.status !== 0) {
		const stderr = typeof result.stderr === "string" ? result.stderr : "";
		if (
			result.status === 128 &&
			stderr.trim() ===
				'error: No valid patches in input (allow with "--allow-empty")'
		) {
			return {
				ok: false,
				failure: metadataFailure(phase, "exit_nonzero", "corrupt_patch"),
			};
		}
		if (CORRUPT_PATCH_PATTERN.test(stderr)) {
			return {
				ok: false,
				failure: metadataFailure(phase, "exit_nonzero", "corrupt_patch"),
			};
		}
		if (CONFLICT_DIAGNOSTIC_PATTERN.test(stderr)) {
			return {
				ok: false,
				failure: metadataFailure(phase, "exit_nonzero", "conflict"),
			};
		}
		return { ok: false, failure: metadataFailure(phase, "exit_nonzero") };
	}
	if (typeof result.stdout !== "string") {
		return { ok: false, failure: metadataFailure(phase, "spawn_error") };
	}
	return { ok: true, stdout: result.stdout };
}

// Static refusal text for incomplete/unavailable metadata. Never interpolates
// process error, output, environment, or patch content.
const METADATA_UNAVAILABLE_REASON = "diff metadata could not be confirmed";

/**
 * Sanitized refusal fields for a checked-command failure. `corrupt_patch` and
 * `conflict` survive only where git's own invalid-patch diagnostics established
 * them; every other failure is incomplete metadata and reports the existing
 * `integration_state_unknown` kind, plus the closed metadata step (`numstat`
 * or `summary`) and failure category that left the state unknown.
 */
export function metadataFailureRefusal(failure) {
	if (
		failure.reasonKind === "corrupt_patch" ||
		failure.reasonKind === "conflict"
	) {
		return {
			reason: "diff could not be parsed by git apply",
			reasonKind: failure.reasonKind,
		};
	}
	return {
		reason: METADATA_UNAVAILABLE_REASON,
		reasonKind: "integration_state_unknown",
		metadataStep: failure.phase,
		metadataCause: failure.category,
	};
}

export function extractTouchedPaths(diff, projectPath) {
	const command = runCheckedMetadataCommand(
		"numstat",
		["--numstat"],
		diff,
		projectPath,
	);
	if (!command.ok) {
		return { paths: null, failure: command.failure };
	}
	return {
		paths: command.stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => line.split("\t")[2])
			.filter(Boolean)
			.map(dequoteGitPath),
		failure: null,
	};
}

export function extractSummaryLines(diff, projectPath) {
	const command = runCheckedMetadataCommand(
		"summary",
		["--summary"],
		diff,
		projectPath,
	);
	if (!command.ok) {
		return { lines: null, failure: command.failure };
	}
	return {
		lines: command.stdout.split("\n").filter(Boolean),
		failure: null,
	};
}

// The only two `git apply --summary` forms an executable opt-in can grant:
// creating the exact path as 100755, or changing it from 100644 to 100755.
// A rename or copy is refused before this is consulted, so the pathless
// `mode change` line that can follow one is never granted.
const EXECUTABLE_GRANT_PATTERN =
	/^ (?:create mode 100755|mode change 100644 => 100755) (.+)$/;

// Every extended-header line `git apply` reads as a rename or copy, including
// the legacy `rename old`/`rename new` spelling. Headers C-quote a name that
// holds a newline, so unlike `--summary` output a filename cannot forge one.
// Hunk lines start with a space, `+`, `-` or `\`, so only headers (or text
// git ignores) can match, and a match always refuses. It is tested per `\n`
// line, as git reads them, because `/m` would also break hunk content at a
// CR, U+2028 or U+2029.
const RENAME_OR_COPY_HEADER_PATTERN =
	/^(?:rename (?:from|to|old|new)|copy (?:from|to)) /;

/**
 * Whether one executable summary line is granted by the caller's opt-in. The
 * summary path is compared raw (never dequoted) against the opted-in paths.
 * `--summary` prints names unquoted, so a newline inside any touched name could
 * forge a summary line, and a name that is not valid UTF-8 decodes lossily to
 * U+FFFD and could equal a different opted-in name; either grants nothing. Any
 * 120000 summary entry that names the same path (a symlink turned into an
 * executable) withholds the grant.
 */
function executableGranted(line, summaryLines, touchedPaths, allowExecutables) {
	const match = EXECUTABLE_GRANT_PATTERN.exec(line);
	if (
		match === null ||
		!allowExecutables.includes(match[1]) ||
		touchedPaths.some((path) => /[\n\uFFFD]/u.test(path))
	)
		return false;
	return !summaryLines.some(
		(other) => other.includes("120000") && other.endsWith(` ${match[1]}`),
	);
}

/**
 * Structural safety validation of one patch.
 *
 * @param {string} diff Patch text.
 * @param {string} projectPath Project root the patch targets.
 * @param {{allowExecutables?: string[]}} [options] `allowExecutables` lists
 *   declared repo-relative paths that may be created as, or changed to, a
 *   regular executable file (100755). Every other executable bit is refused.
 *   Every rename or copy is refused too: a pure rename patch states no mode,
 *   so the destination silently keeps an executable source's bit. Switchyard's
 *   own captures use `--no-renames`, which spells it as a delete plus create.
 */
export function validateDiff(diff, projectPath, options = {}) {
	const allowExecutables = options.allowExecutables ?? [];
	if (!diff || typeof diff !== "string" || !diff.trim()) {
		return { safe: false, reason: "empty diff", reasonKind: "empty_diff" };
	}

	const { paths: touchedPaths, failure: numstatFailure } = extractTouchedPaths(
		diff,
		projectPath,
	);
	if (numstatFailure !== null) {
		return { safe: false, ...metadataFailureRefusal(numstatFailure) };
	}

	for (const path of touchedPaths) {
		if (escapesProjectRoot(projectPath, path)) {
			return {
				safe: false,
				reason: `path escapes project root: ${path}`,
				reasonKind: "path_escapes_project_root",
			};
		}
		if (path.split("/").includes(".git")) {
			return {
				safe: false,
				reason: `diff touches .git internals: ${path}`,
				reasonKind: "git_internals_touched",
			};
		}
		if (SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
			return {
				safe: false,
				reason: `diff touches a credential-convention path: ${path}`,
				reasonKind: "credential_path_touched",
				credentialFlagged: true,
			};
		}
	}

	const { lines: summaryLines, failure: summaryFailure } = extractSummaryLines(
		diff,
		projectPath,
	);
	if (summaryFailure !== null) {
		return { safe: false, ...metadataFailureRefusal(summaryFailure) };
	}
	const renameOrCopy = diff
		.split("\n")
		.find((line) => RENAME_OR_COPY_HEADER_PATTERN.test(line));
	if (renameOrCopy !== undefined) {
		return {
			safe: false,
			reason: `diff renames or copies a file, so an executable bit could carry over unseen: ${renameOrCopy.trim()}`,
			reasonKind: "executable_file_refused",
		};
	}
	for (const line of summaryLines) {
		if (/create mode 120000|rename.*120000/.test(line)) {
			return {
				safe: false,
				reason: `diff creates a symlink: ${line.trim()}`,
				reasonKind: "symlink_creation_refused",
			};
		}
		if (
			/mode 100755|=> 100755/.test(line) &&
			!executableGranted(line, summaryLines, touchedPaths, allowExecutables)
		) {
			return {
				safe: false,
				reason: `diff introduces an executable file: ${line.trim()}`,
				reasonKind: "executable_file_refused",
			};
		}
	}

	const sensitiveManifestPaths = manifestReviewPaths(touchedPaths);
	if (sensitiveManifestPaths.length > 0) {
		return {
			safe: true,
			requiresReview: true,
			sensitivePaths: sensitiveManifestPaths,
			touchedPaths,
		};
	}

	return { safe: true, touchedPaths };
}
