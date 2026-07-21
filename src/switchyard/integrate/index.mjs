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
 * Extract the file paths a diff touches via `git apply --numstat` (git's own
 * diff parser, not a hand-rolled regex over diff text).
 * @param {string} diff
 * @param {string} projectPath
 * @returns {string[]|null} paths, or null if git could not parse the diff
 */
function extractTouchedPaths(diff, projectPath) {
	const result = spawnSync("git", ["apply", "--numstat"], {
		cwd: projectPath,
		input: diff,
		encoding: "utf8",
	});
	if (result.status !== 0 || typeof result.stdout !== "string") return null;

	return result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t")[2])
		.filter(Boolean);
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
	const result = spawnSync("git", ["apply", "--summary"], {
		cwd: projectPath,
		input: diff,
		encoding: "utf8",
	});
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
