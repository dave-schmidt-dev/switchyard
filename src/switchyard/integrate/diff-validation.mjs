import { spawnSync } from "node:child_process";

import { resolve, sep } from "node:path";

export const APPLY_CHECK_MAX_BUFFER = 8 * 1024 * 1024;

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

export function classifyApplyFailure(stderrText) {
	return CORRUPT_PATCH_PATTERN.test(stderrText) ? "corrupt_patch" : "conflict";
}

export function extractTouchedPaths(diff, projectPath) {
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

export function extractSummaryLines(diff, projectPath) {
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
