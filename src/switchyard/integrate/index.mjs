// Integration module - reviewed integration gate
// INV-2: Code returns to Mac only through explicit reviewed gate
// Implements git apply of approved diffs
//
// Validation is structural (parsed from git's own understanding of the diff
// via `git apply --numstat`/`--summary`), not a content substring blocklist.
// A substring scan over diff *text* is both easy to evade (rename the file;
// nothing forces the word "password" to appear near the actual secret) and
// prone to false positives (a comment or identifier merely containing the
// word "token" has nothing to do with a credential file).

import { spawnSync } from "node:child_process";
import { resolve, sep } from "node:path";

// Known secret/credential storage conventions, matched against the actual
// file paths a diff touches (not diff body content).
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

// Manifest/build files that can execute code merely by existing (npm/yarn
// lifecycle scripts, Makefiles, CI configs, Dockerfiles, shell scripts).
// Diffs touching these are not blocked outright — legitimate task work often
// needs to touch package.json — but are not auto-applied either: the gate
// requires an explicit opt-in (`allowSensitiveManifests`) rather than
// silently running whatever a diff puts in a `preinstall` script.
const MANIFEST_REVIEW_PATTERNS = [
	/(^|\/)package\.json$/i,
	/(^|\/)Makefile$/i,
	/(^|\/)Dockerfile/i,
	/\.(sh|bash)$/i,
	/(^|\/)\.github\/workflows\//i,
	/(^|\/)\.gitlab-ci\.ya?ml$/i,
];

/**
 * Resolve a diff-relative path against the project root and report whether
 * it escapes that root. Enforced by switchyard itself rather than relying
 * solely on `git apply`'s own (version-dependent) path rejection.
 * @param {string} projectRoot
 * @param {string} relativePath
 * @returns {boolean} true if the resolved path escapes projectRoot
 */
function escapesProjectRoot(projectRoot, relativePath) {
	const root = resolve(projectRoot);
	const target = resolve(root, relativePath);
	return target !== root && !target.startsWith(root + sep);
}

/**
 * Decode a git C-quoted path back to its real characters.
 *
 * Git wraps a path in double-quotes and C-escapes its contents whenever it
 * contains a byte that would otherwise corrupt the tab-delimited
 * `--numstat`/`--summary` output. Double-quote, backslash and control
 * characters (tab, newline, ...) are ALWAYS escaped regardless of
 * `core.quotePath`; bytes >= 0x80 (non-ASCII UTF-8) are escaped only while
 * `core.quotePath` is on. A quoted path is therefore pure ASCII on the wire:
 * `\\` = backslash, `\"` = double-quote, `\a \b \f \n \r \t \v` = the matching
 * control byte, and `\NNN` (exactly three octal digits) = one raw byte.
 * Multi-byte UTF-8 characters arrive as consecutive `\NNN` escapes (one per
 * byte, e.g. `é` -> `\303\251`), so escapes are collected into a raw byte
 * buffer and UTF-8-decoded as a whole at the end — never byte-by-byte.
 *
 * Without this, a path like `café/.env` reaches the sensitive-path and
 * manifest-review checks as the literal string `"caf\303\251/.env"` (quotes
 * and octal escapes included), whose trailing `"` defeats every pattern
 * anchored with `(\.|$)` / `$` after the filename — a real INV-2 bypass.
 *
 * @param {string} path A path field from git output, possibly C-quoted.
 * @returns {string} The real path (returned unchanged if it was never quoted).
 */
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

/**
 * Extract the file paths a diff touches via `git apply --numstat` (git's own
 * diff parser, not a hand-rolled regex over diff text).
 *
 * `-c core.quotePath=false` keeps the common non-ASCII path (e.g. `café/.env`)
 * un-quoted so it round-trips as-is; paths git still quotes unconditionally
 * (double-quote/backslash/control chars) are decoded by `dequoteGitPath`.
 * @param {string} diff
 * @param {string} projectPath
 * @returns {string[]|null} paths, or null if git could not parse the diff
 */
function extractTouchedPaths(diff, projectPath) {
	const result = spawnSync(
		"git",
		["-c", "core.quotePath=false", "apply", "--numstat"],
		{
			cwd: projectPath,
			input: diff,
			encoding: "utf8",
		},
	);
	if (result.status !== 0 || typeof result.stdout !== "string") return null;

	return result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t")[2])
		.filter(Boolean)
		.map(dequoteGitPath);
}

/**
 * Extract structural change summary (new/deleted file modes, symlinks,
 * mode changes, renames) via `git apply --summary`.
 * @param {string} diff
 * @param {string} projectPath
 * @returns {string[]} summary lines (empty array if unparseable or no
 *   special structural changes — a plain content-only diff produces none)
 */
function extractSummaryLines(diff, projectPath) {
	const result = spawnSync(
		"git",
		["-c", "core.quotePath=false", "apply", "--summary"],
		{
			cwd: projectPath,
			input: diff,
			encoding: "utf8",
		},
	);
	if (typeof result.stdout !== "string") return [];
	return result.stdout.split("\n").filter(Boolean);
}

/**
 * Validate that a diff is structurally safe to apply.
 * @param {string} diff The git diff to validate
 * @param {string} projectPath Target project path (paths are resolved against this)
 * @returns {{safe: boolean, reason?: string, requiresReview?: boolean, sensitivePaths?: string[]}}
 */
export function validateDiff(diff, projectPath) {
	if (!diff || typeof diff !== "string" || !diff.trim()) {
		return { safe: false, reason: "empty diff" };
	}

	const touchedPaths = extractTouchedPaths(diff, projectPath);
	if (touchedPaths === null) {
		return { safe: false, reason: "diff could not be parsed by git apply" };
	}

	for (const path of touchedPaths) {
		if (escapesProjectRoot(projectPath, path)) {
			return { safe: false, reason: `path escapes project root: ${path}` };
		}
		if (path.split("/").includes(".git")) {
			return { safe: false, reason: `diff touches .git internals: ${path}` };
		}
		if (SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
			return {
				safe: false,
				reason: `diff touches a credential-convention path: ${path}`,
			};
		}
	}

	const summaryLines = extractSummaryLines(diff, projectPath);
	for (const line of summaryLines) {
		if (/create mode 120000|rename.*120000/.test(line)) {
			return { safe: false, reason: `diff creates a symlink: ${line.trim()}` };
		}
		if (/mode 100755|=> 100755/.test(line)) {
			return {
				safe: false,
				reason: `diff introduces an executable file: ${line.trim()}`,
			};
		}
	}

	const sensitiveManifestPaths = touchedPaths.filter((path) =>
		MANIFEST_REVIEW_PATTERNS.some((pattern) => pattern.test(path)),
	);
	if (sensitiveManifestPaths.length > 0) {
		return {
			safe: true,
			requiresReview: true,
			sensitivePaths: sensitiveManifestPaths,
		};
	}

	return { safe: true };
}

/**
 * Apply a diff to the host after review.
 * INV-2: This is the only path for agent output to reach host files.
 * The diff is piped via stdin — no shared scratch file, no cross-process
 * collision if this is ever called concurrently.
 * @param {string} diff The git diff to apply
 * @param {string} projectPath Target project path
 * @returns {boolean} true if apply succeeded
 */
function applyReviewedDiff(diff, projectPath) {
	try {
		const result = spawnSync("git", ["apply"], {
			cwd: projectPath,
			input: diff,
			stdio: ["pipe", "inherit", "inherit"],
		});
		return result.status === 0;
	} catch (error) {
		console.error("Failed to apply reviewed diff:", error.message);
		return false;
	}
}

/**
 * Full integration gate: validate then apply.
 * INV-2: The single door between sandbox and host.
 * @param {string} diff The git diff from agent
 * @param {string} projectPath Target project path
 * @param {object} [options]
 * @param {boolean} [options.allowSensitiveManifests] Explicitly permit a diff
 *   that touches a build/execution-manifest file (package.json, Makefile,
 *   Dockerfile, shell scripts, CI configs) to auto-apply. Without this, such
 *   a diff is rejected with requiresReview:true instead of silently running.
 * @returns {{success: boolean, message: string, requiresReview?: boolean, sensitivePaths?: string[]}} Result
 */
export function integrationGate(diff, projectPath, options = {}) {
	const validation = validateDiff(diff, projectPath);
	if (!validation.safe) {
		return {
			success: false,
			message: validation.reason ?? "Diff validation failed",
		};
	}

	if (validation.requiresReview && !options.allowSensitiveManifests) {
		return {
			success: false,
			message:
				"diff touches a build/execution manifest file and requires explicit review",
			requiresReview: true,
			sensitivePaths: validation.sensitivePaths,
		};
	}

	if (applyReviewedDiff(diff, projectPath)) {
		return { success: true, message: "Diff applied successfully" };
	}

	return { success: false, message: "Diff apply failed" };
}
