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
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve, sep } from "node:path";

// Bound the captured output of the non-mutating `git apply --check` probes.
// A malformed or oversized patch must not be able to buffer unbounded
// stderr/stdout; 8 MiB is generous for any legitimate patch while keeping
// the probe memory-bounded (the default 1 MiB is too close to pathological
// cases for comfort, but the exact size only needs to be a safe ceiling).
export const APPLY_CHECK_MAX_BUFFER = 8 * 1024 * 1024;

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
// requires an explicit task opt-in (`AllowManifests: true`) *and* an exact
// `Files:` declaration for every touched manifest, rather than silently
// running whatever a diff puts in a `preinstall` script.
const MANIFEST_REVIEW_PATTERNS = [
	/(^|\/)package\.json$/i,
	/(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lock(?:b)?)$/i,
	/(^|\/)Makefile$/i,
	/(^|\/)Dockerfile/i,
	/\.(sh|bash)$/i,
	/(^|\/)\.github\/workflows\//i,
	/(^|\/)\.gitlab-ci\.ya?ml$/i,
];

/**
 * Normalize a patch only when it lacks git's required final line terminator.
 * Already-terminated patches, including those with two trailing newlines,
 * are returned byte-for-byte unchanged. This makes repeated gate calls
 * idempotent and avoids reconstructing bytes lost by an earlier trim().
 * @param {unknown} diff
 * @returns {unknown}
 */
function normalizePatch(diff) {
	if (typeof diff !== "string" || diff.length === 0 || diff.endsWith("\n")) {
		return diff;
	}
	return `${diff}\n`;
}

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
 * Extract rename source and destination paths from a `git apply --summary`
 * rename line. Handles both the plain format (`rename old => new`) and the
 * shared-prefix format (`rename prefix/{old => new} (100%)`).
 * @param {string} line A summary line
 * @returns {{old: string, new: string}|null} Dequoted paths, or null if the
 *   line is not a recognised rename.
 */
function parseRenamePaths(line) {
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

// Git reports a genuinely malformed/truncated diff (a transport or
// generation problem — e.g. a provider's output got cut off mid-hunk, or
// arrived with no trailing newline after its last hunk) differently from a
// diff that is well-formed but fails to apply because the tree has diverged
// from both its before- and after-state (a real conflict). A caller needs to
// tell these apart: a truncated diff calls for a retry/re-generation, while
// a real conflict calls for a different diff entirely — treating both as
// one generic "apply failed" loses that distinction.
const CORRUPT_PATCH_PATTERN = /corrupt patch|unrecognized input/i;

function classifyApplyFailure(stderrText) {
	return CORRUPT_PATCH_PATTERN.test(stderrText) ? "corrupt_patch" : "conflict";
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
 * @returns {{paths: string[]|null, stderr: string}} `paths` is null if git
 *   could not parse the diff at all (e.g. truncated/corrupt); `stderr` is
 *   git's captured diagnostic, meaningful only when `paths` is null.
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
	const stderr = typeof result.stderr === "string" ? result.stderr : "";
	if (result.status !== 0 || typeof result.stdout !== "string") {
		return { paths: null, stderr };
	}

	return {
		paths: result.stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => line.split("\t")[2])
			.filter(Boolean)
			.map(dequoteGitPath),
		stderr,
	};
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
 * @returns {{safe: boolean, reason?: string, reasonKind?: IntegrationRefusalKind, requiresReview?: boolean, sensitivePaths?: string[], touchedPaths?: string[]}}
 */
export function validateDiff(diff, projectPath) {
	if (!diff || typeof diff !== "string" || !diff.trim()) {
		return { safe: false, reason: "empty diff", reasonKind: "empty_diff" };
	}

	const { paths: touchedPaths, stderr: numstatStderr } = extractTouchedPaths(
		diff,
		projectPath,
	);
	if (touchedPaths === null) {
		return {
			safe: false,
			reason: "diff could not be parsed by git apply",
			reasonKind: classifyApplyFailure(numstatStderr),
		};
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

	const summaryLines = extractSummaryLines(diff, projectPath);
	for (const line of summaryLines) {
		if (/create mode 120000|rename.*120000/.test(line)) {
			return {
				safe: false,
				reason: `diff creates a symlink: ${line.trim()}`,
				reasonKind: "symlink_creation_refused",
			};
		}
		if (/mode 100755|=> 100755/.test(line)) {
			return {
				safe: false,
				reason: `diff introduces an executable file: ${line.trim()}`,
				reasonKind: "executable_file_refused",
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
			touchedPaths,
		};
	}

	return { safe: true, touchedPaths };
}

function gitReadOnly(projectPath, args) {
	const result = spawnSync("git", args, {
		cwd: projectPath,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		status: result.status,
		stdout: typeof result.stdout === "string" ? result.stdout : "",
		stderr: typeof result.stderr === "string" ? result.stderr : "",
	};
}

function normalizedPathSet(paths) {
	if (
		!Array.isArray(paths) ||
		paths.some((path) => typeof path !== "string" || path.length === 0)
	)
		return null;
	return [...new Set(Array.isArray(paths) ? paths : [])].sort();
}

/**
 * Compare two path declarations without consulting mutable project state.
 * This is shared by external-completion reconciliation and the integration
 * gate so both paths use the same exact-set semantics.
 */
export function validateExactPathSet(actual, expected) {
	const actualPaths = normalizedPathSet(actual);
	const expectedPaths = normalizedPathSet(expected);
	return {
		ok:
			actualPaths !== null &&
			expectedPaths !== null &&
			JSON.stringify(actualPaths) === JSON.stringify(expectedPaths),
		actualPaths,
		expectedPaths,
	};
}

/**
 * Verify that an integrated commit belongs to the current project history.
 * This performs only read-only git queries and never changes the worktree.
 */
export function validateIntegratedCommitAncestry(
	projectPath,
	integratedCommit,
	currentHead = null,
) {
	if (
		typeof integratedCommit !== "string" ||
		!/^[a-f0-9]{40,64}$/i.test(integratedCommit)
	)
		return { ok: false, reasonCode: "integrated_commit_invalid" };
	const head =
		typeof currentHead === "string" && currentHead.length > 0
			? currentHead
			: gitReadOnly(projectPath, ["rev-parse", "HEAD"]).stdout.trim();
	if (!/^[a-f0-9]{40,64}$/i.test(head))
		return { ok: false, reasonCode: "project_revision_unreadable" };
	const result = gitReadOnly(projectPath, [
		"merge-base",
		"--is-ancestor",
		integratedCommit,
		head,
	]);
	return result.status === 0
		? { ok: true, currentHead: head }
		: {
				ok: false,
				reasonCode: "integrated_commit_not_ancestor",
				currentHead: head,
			};
}

/**
 * Return the exact files changed by an integrated commit and compare them to
 * the declared changed paths. Renames are represented by both git path names
 * by design; callers must declare the complete immutable set.
 */
export function validateIntegratedCommitPaths(
	projectPath,
	integratedCommit,
	declaredPaths,
) {
	const parents = gitReadOnly(projectPath, [
		"rev-list",
		"--parents",
		"-n",
		"1",
		integratedCommit,
	]);
	const parentTokens = parents.stdout.trim().split(/\s+/).filter(Boolean);
	if (
		parents.status !== 0 ||
		parentTokens.length === 0 ||
		parentTokens.length > 2
	) {
		return {
			ok: false,
			reasonCode:
				parentTokens.length > 2
					? "integrated_commit_merge_unsupported"
					: "integrated_commit_paths_unreadable",
			actualPaths: [],
			expectedPaths: normalizedPathSet(declaredPaths),
		};
	}
	const result = gitReadOnly(projectPath, [
		"diff-tree",
		"--no-commit-id",
		"--name-only",
		"-r",
		"--root",
		"--find-renames",
		integratedCommit,
	]);
	if (result.status !== 0) {
		return {
			ok: false,
			reasonCode: "integrated_commit_paths_unreadable",
			actualPaths: [],
			expectedPaths: normalizedPathSet(declaredPaths),
		};
	}
	const actualPaths = result.stdout.split("\n").filter(Boolean);
	if (actualPaths.length === 0) {
		return {
			ok: false,
			reasonCode: "integrated_commit_paths_empty",
			actualPaths,
			expectedPaths: normalizedPathSet(declaredPaths),
		};
	}
	const comparison = validateExactPathSet(actualPaths, declaredPaths);
	return {
		...comparison,
		ok: comparison.ok,
		reasonCode: comparison.ok ? undefined : "path_scope_mismatch",
	};
}

/**
 * Reject tracked modifications overlapping the declared task paths while
 * tolerating unrelated untracked files. This is a read-only worktree probe.
 */
export function validateNoTrackedPathOverlap(projectPath, paths) {
	const declared = normalizedPathSet(paths);
	if (declared === null)
		return {
			ok: false,
			reasonCode: "path_scope_malformed",
			overlappingPaths: [],
		};
	if (declared.length === 0) return { ok: true, overlappingPaths: [] };
	const result = gitReadOnly(projectPath, [
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
		"--",
		...declared,
	]);
	if (result.status !== 0)
		return {
			ok: false,
			reasonCode: "worktree_status_unreadable",
			overlappingPaths: [],
		};
	const overlappingPaths = result.stdout
		.split("\n")
		.filter(Boolean)
		.filter((line) => line.slice(0, 2) !== "??" && line.slice(0, 2) !== "!!")
		.map((line) => line.slice(3).trim());
	return overlappingPaths.length === 0
		? { ok: true, overlappingPaths: [] }
		: {
				ok: false,
				reasonCode: "tracked_modification_overlaps_task_paths",
				overlappingPaths,
			};
}

/**
 * Run a non-mutating `git apply` probe against the current tree. Captured
 * UTF-8 output, per this file's convention for non-mutating git checks.
 * `git apply` is the authority on whether a diff applies cleanly, so any
 * non-zero exit (including a failed spawn) means the probe did not pass —
 * nothing on the host is ever modified by this call.
 * @param {string[]} args `git apply` arguments (e.g. `["--check"]`,
 *   `["--reverse", "--check"]`)
 * @param {string} diff
 * @param {string} projectPath
 * @returns {{ok: boolean, stderr: string}} `ok` true when git reports the
 *   diff applies cleanly; `stderr` is git's captured UTF-8 diagnostic,
 *   meaningful only when `ok` is false.
 */
function applyCheckPasses(args, diff, projectPath) {
	const result = spawnSync("git", ["apply", ...args], {
		cwd: projectPath,
		input: diff,
		encoding: "utf8",
		maxBuffer: APPLY_CHECK_MAX_BUFFER,
	});
	return {
		ok: result.status === 0,
		stderr: typeof result.stderr === "string" ? result.stderr : "",
	};
}

/**
 * Apply a diff to the host after review.
 * INV-2: This is the only path for agent output to reach host files.
 * The diff is piped via stdin — no shared scratch file, no cross-process
 * collision if this is ever called concurrently.
 *
 * The mutating apply runs exactly once, and only after a non-mutating
 * `git apply --check` confirms the diff still applies to the current tree.
 * Idempotent success requires a gate-produced completed proof bound to the
 * operation and an exact match with the current scoped after-state. A failed
 * forward check without that proof is conflict or unknown state; a reverse
 * apply probe never establishes success.
 * @param {string} diff The git diff to apply
 * @param {string} projectPath Target project path
 * @returns {boolean|{alreadyApplied: boolean}|{applied: false, reason: string}}
 *   true if apply succeeded; `{alreadyApplied: true}` if the diff was already
 *   in the tree; `{applied: false, reason}` carrying git's diagnostic (or the
 *   spawn error) when the diff could not be applied.
 */
function proofEqual(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function scopedStateHash(projectPath, touchedPaths) {
	return createHash("sha256")
		.update(getScopedFingerprint(projectPath, touchedPaths), "utf8")
		.digest("hex");
}

function applyReviewedDiff(diff, projectPath, intent, touchedPaths) {
	let lease = null;
	let released = false;
	const finish = (result) => {
		if (!intent || !lease || released) return result;
		released = true;
		try {
			intent.release(lease);
			return result;
		} catch (error) {
			return {
				applied: false,
				reason: `integration_state_unknown: ${error.message}`,
				reasonKind: "integration_state_unknown",
			};
		}
	};
	try {
		if (intent) {
			lease = intent.acquire(intent.operation);
			if (!lease)
				return finish({
					applied: false,
					reason: "integration lease unavailable",
					reasonKind: "integration_state_unknown",
				});
			const currentProof = intent.read(intent.operation, lease);
			if (currentProof) {
				if (!proofEqual(currentProof.operation, intent.operation))
					return finish({
						applied: false,
						reason: "integration intent displaced",
						reasonKind: "integration_state_unknown",
					});
				if (currentProof.status !== "completed")
					return finish({
						applied: false,
						reason: "integration_state_unknown",
						reasonKind: "integration_state_unknown",
					});
				if (
					currentProof.afterState !== scopedStateHash(projectPath, touchedPaths)
				)
					return finish({
						applied: false,
						reason: "completed integration state changed",
						reasonKind: "integration_state_unknown",
					});
				return finish({ alreadyApplied: true });
			}
		}
		// Non-mutating forward check: nothing touches the host until git
		// confirms the diff applies cleanly to the current tree.
		const forward = applyCheckPasses(["--check"], diff, projectPath);
		if (forward.ok) {
			if (intent) {
				const pending = {
					operation: structuredClone(intent.operation),
					status: "pending",
					beforeState: scopedStateHash(projectPath, touchedPaths),
				};
				if (
					!proofEqual(intent.persist(pending, lease), pending) ||
					!proofEqual(intent.read(intent.operation, lease), pending)
				) {
					return finish({
						applied: false,
						reason: "integration intent could not be durably persisted",
						reasonKind: "integration_state_unknown",
					});
				}
			}
			// Mutating apply runs exactly once, and only after the forward
			// check passed. stdio is captured (not inherited) so git's own
			// diagnostic on an unexpected failure is returned as `reason`
			// instead of leaking onto the caller's terminal.
			const result = spawnSync("git", ["apply"], {
				cwd: projectPath,
				input: diff,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			if (result.status === 0) {
				if (intent) {
					const existing = intent.read(intent.operation, lease);
					const completed = {
						...existing,
						status: "completed",
						afterState: scopedStateHash(projectPath, touchedPaths),
					};
					if (
						!proofEqual(intent.complete(completed, lease), completed) ||
						!proofEqual(intent.read(intent.operation, lease), completed)
					) {
						return finish({
							applied: false,
							reason: "integration_state_unknown",
							reasonKind: "integration_state_unknown",
						});
					}
				}
				return finish(true);
			}
			const stderr =
				typeof result.stderr === "string" ? result.stderr.trim() : "";
			return finish({
				applied: false,
				reason:
					stderr ||
					(result.error
						? `git apply failed to spawn: ${result.error.message}`
						: `git apply exited with status ${result.status}`),
			});
		}

		// A matching after-state cannot prove this operation applied: unrelated
		// edits can produce the same bytes. Only an exact, durable completion
		// record bound to this operation may make a retry idempotent.
		// A failed forward check usually means a genuine conflict, but git also
		// reports a truncated or malformed diff through this path. Surface which
		// one it was: classifyApplyFailure() only ever reports
		// "corrupt_patch" on git's own "corrupt patch"/"unrecognized input"
		// diagnostic text, not on any other failure. Surface git's own
		// `--check` diagnostic (e.g. "error: ... patch does not apply") as
		// `reason` so the caller gets actionable text, not just a bare
		// "Diff apply failed".
		return finish({
			applied: false,
			reason: forward.stderr.trim() || "git apply --check rejected the diff",
			reasonKind: classifyApplyFailure(forward.stderr),
		});
	} catch (error) {
		return finish({
			applied: false,
			reason: error.message,
			reasonKind: intent ? "integration_state_unknown" : undefined,
		});
	}
}

/**
 * Fingerprint the current content and file state of each touched path. Used
 * for no-op detection: pre-existing unrelated dirty state is excluded, while
 * edits to an already-dirty touched path remain visible.
 * @param {string} projectPath
 * @param {string[]} touchedPaths
 * @returns {string}
 */
function getScopedFingerprint(projectPath, touchedPaths) {
	return touchedPaths
		.map((relativePath) => {
			const fullPath = resolve(projectPath, relativePath);
			try {
				const stats = lstatSync(fullPath);
				const mode = (stats.mode & 0o7777).toString(8);
				if (stats.isSymbolicLink()) {
					return `${relativePath}\0symlink:${mode}:${readlinkSync(fullPath)}`;
				}
				if (stats.isFile()) {
					const digest = createHash("sha256")
						.update(readFileSync(fullPath))
						.digest("hex");
					return `${relativePath}\0file:${mode}:${digest}`;
				}
				return `${relativePath}\0other:${mode}:${stats.size}`;
			} catch (error) {
				if (error?.code === "ENOENT") {
					return `${relativePath}\0missing`;
				}
				return `${relativePath}\0unreadable:${error?.code ?? "unknown"}`;
			}
		})
		.join("\n");
}

/**
 * Full integration gate: validate then apply.
 * INV-2: The single door between sandbox and host.
 * @param {string} diff The git diff from agent
 * @param {string} projectPath Target project path
 * @param {object} [options]
 * @param {boolean} [options.allowSensitiveManifests] The parsed
 *   `AllowManifests: true` task opt-in. It permits a manifest diff only when
 *   `requiredPaths` also explicitly declares every touched manifest path.
 * @param {string[]|null} [options.requiredPaths] When non-null, enforce exact
 *   Files allowlist: every declared path must be touched and every touched
 *   path must be declared. Composes with (does not replace) structural checks.
 * @returns {{success: boolean, message: string, requiresReview?: boolean,
 *   sensitivePaths?: string[], missingPaths?: string[], extraPaths?: string[],
 *   structural_error?: string, alreadyApplied?: boolean, reason?: string,
 *   reasonKind?: "corrupt_patch"|"conflict"}} Result
 */
export function integrationGate(diff, projectPath, options = {}) {
	const { requiredPaths = null } = options;

	// Required-paths: empty diff check runs BEFORE patch normalization so we
	// don't accidentally re-terminate an empty string into "\n" and treat it
	// as a (weird) non-empty patch.
	if (
		requiredPaths !== null &&
		(!diff || typeof diff !== "string" || !diff.trim())
	) {
		return { success: false, message: "empty_required_diff" };
	}

	// `git apply` requires a newline-terminated patch. Adapter capture keeps
	// the provider's bytes intact; this compatibility normalizer only repairs
	// sources that arrive without a terminator. It is idempotent and preserves
	// valid one- and two-newline endings.
	const patch = normalizePatch(diff);

	// Files enforcement: check declared vs touched paths.
	// Runs BEFORE the structural checks in validateDiff; still calls
	// validateDiff afterward so structural errors compose (both sets of
	// errors are reported).
	if (requiredPaths !== null) {
		const { paths: touchedPaths, stderr: numstatStderr } = extractTouchedPaths(
			patch,
			projectPath,
		);
		if (touchedPaths === null) {
			return {
				success: false,
				message: "diff could not be parsed by git apply",
				reasonKind: classifyApplyFailure(numstatStderr),
			};
		}

		const summaryLines = extractSummaryLines(patch, projectPath);
		const touchedForDeclaration = new Set(touchedPaths);
		for (const line of summaryLines) {
			const paths = parseRenamePaths(line);
			if (paths) {
				touchedForDeclaration.add(paths.old);
				touchedForDeclaration.add(paths.new);
			}
		}

		const requiredSet = new Set(requiredPaths);
		const missingPaths = requiredPaths.filter(
			(p) => !touchedForDeclaration.has(p),
		);
		const extraPaths = touchedPaths.filter((p) => !requiredSet.has(p));

		if (missingPaths.length > 0) {
			const validation = validateDiff(patch, projectPath);
			const result = {
				success: false,
				message: "required_paths_missing",
				missingPaths,
			};
			if (!validation.safe) {
				result.structural_error = validation.reason;
			}
			return result;
		}

		if (extraPaths.length > 0) {
			const validation = validateDiff(patch, projectPath);
			const result = {
				success: false,
				message: "undeclared_paths_touched",
				extraPaths,
			};
			if (!validation.safe) {
				result.structural_error = validation.reason;
			}
			return result;
		}

		// Exact match — fall through to structural validation.
	}

	const validation = validateDiff(patch, projectPath);
	if (!validation.safe) {
		const result = {
			success: false,
			message: validation.reason ?? "Diff validation failed",
			credentialFlagged: validation.credentialFlagged === true,
		};
		if (typeof validation.reasonKind === "string") {
			result.reasonKind = validation.reasonKind;
		}
		return result;
	}

	const manifestsAreDeclared =
		requiredPaths !== null &&
		(validation.sensitivePaths ?? []).every((path) =>
			requiredPaths.includes(path),
		);
	if (
		validation.requiresReview &&
		!(options.allowSensitiveManifests === true && manifestsAreDeclared)
	) {
		return {
			success: false,
			message:
				"diff touches a build/execution manifest file and requires AllowManifests: true plus an explicit Files: declaration",
			reasonKind: "manifest_review_required",
			requiresReview: true,
			sensitivePaths: validation.sensitivePaths,
		};
	}

	// No-op detection: only for the common path (requiredPaths === null),
	// where touchedPaths isn't computed independently elsewhere in this
	// function. Scoped to touched-path content/state so pre-existing unrelated
	// dirty state in other files never triggers a false no-op report.
	let preFingerprint = "";
	if (requiredPaths === null) {
		preFingerprint = getScopedFingerprint(projectPath, validation.touchedPaths);
	}

	let intent = null;
	if (options.integrationIntent !== undefined) {
		const candidate = options.integrationIntent;
		if (
			!candidate ||
			typeof candidate !== "object" ||
			typeof candidate.acquire !== "function" ||
			typeof candidate.release !== "function" ||
			typeof candidate.persist !== "function" ||
			typeof candidate.complete !== "function" ||
			typeof candidate.read !== "function" ||
			!candidate.operation ||
			typeof candidate.operation.patchHash !== "string" ||
			candidate.operation.patchHash !==
				createHash("sha256").update(patch, "utf8").digest("hex") ||
			JSON.stringify(candidate.operation.paths) !==
				JSON.stringify(requiredPaths ?? [])
		) {
			return { success: false, message: "invalid_integration_intent" };
		}
		intent = candidate;
	}

	let applyResult;
	try {
		applyResult = applyReviewedDiff(
			patch,
			projectPath,
			intent,
			validation.touchedPaths,
		);
	} catch (error) {
		applyResult = {
			applied: false,
			reason: error.message,
			reasonKind: "integration_state_unknown",
		};
	}
	if (applyResult === true) {
		if (requiredPaths === null) {
			const postFingerprint = getScopedFingerprint(
				projectPath,
				validation.touchedPaths,
			);
			if (preFingerprint === postFingerprint) {
				return { success: false, message: "no_op_diff" };
			}
		}
		return { success: true, message: "Diff applied successfully" };
	}

	if (applyResult?.alreadyApplied) {
		return {
			success: true,
			message: "Diff already applied",
			alreadyApplied: true,
		};
	}

	const result = { success: false, message: "Diff apply failed" };
	if (applyResult && typeof applyResult.reason === "string") {
		result.reason = applyResult.reason;
	}
	if (applyResult && typeof applyResult.reasonKind === "string") {
		result.reasonKind = applyResult.reasonKind;
	}
	return result;
}
