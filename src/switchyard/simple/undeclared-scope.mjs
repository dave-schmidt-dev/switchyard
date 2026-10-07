import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

import { manifestReviewPaths, validateDiff } from "../integrate/index.mjs";
import { headAdvanceSafe } from "./head-advance.mjs";
import { declaredPathsAreClean } from "./overlay.mjs";

/** Upper bound on undeclared paths a run may keep for captain review. */
export const MAX_UNDECLARED_PATHS = 16;

const UNDECLARED_GIT_TIMEOUT_MS = 10_000;

/**
 * Split a binary git diff into per-file blocks keyed by their exact
 * `diff --git` header. Quoted (escaped) headers are kept verbatim so they never
 * match an unquoted path and therefore stay ineligible.
 */
function diffBlocks(diff) {
	const blocks = [];
	if (typeof diff !== "string") return blocks;
	let current = null;
	for (const line of diff.split(/(?<=\n)/)) {
		if (line.startsWith("diff --git ")) {
			current = { header: line.replace(/\n$/, ""), lines: [line] };
			blocks.push(current);
		} else if (current) current.lines.push(line);
	}
	return blocks.map(({ header, lines }) => ({ header, text: lines.join("") }));
}

/** The block that adds or modifies `path` in place, or null. */
function inPlaceBlock(blocks, path) {
	const matches = blocks.filter(
		(block) => block.header === `diff --git a/${path} b/${path}`,
	);
	if (matches.length !== 1) return null;
	const [block] = matches;
	const headerLines = block.text.split("\n").slice(1);
	for (const line of headerLines) {
		if (line.startsWith("@@") || line.startsWith("GIT binary patch")) break;
		if (
			/^(deleted file mode|rename from|rename to|copy from|copy to|old mode|new mode)\b/.test(
				line,
			)
		)
			return null;
	}
	return block;
}

function pathInsideProject(path) {
	return (
		typeof path === "string" &&
		path.length > 0 &&
		!isAbsolute(path) &&
		!path.includes("\\") &&
		!path.split("/").some((part) => part === "" || part === "..")
	);
}

function projectHead(projectPath) {
	const result = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: projectPath,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: UNDECLARED_GIT_TIMEOUT_MS,
	});
	return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Partition undeclared changed paths into those a run may keep and those that
 * must fail closed. A path is eligible only when it is added or modified in
 * place, inside the project, outside `.git`, not a read-only input, not a
 * manifest or credential path (an undeclared manifest is never reviewed,
 * because `--allow-manifest` requires a declared file), clean in the project checkout, and unchanged
 * between `baseRevision` and the current project HEAD.
 *
 * @param {object} input
 * @param {string[]} input.undeclared Changed paths outside the declared files.
 * @param {string} input.diff The full captured worktree diff.
 * @param {string} input.projectPath Host project checkout.
 * @param {string[]} [input.readOnlyInputs] Declared read-only inputs.
 * @param {string} input.baseRevision The run's base revision.
 * @param {string} [input.headRevision] Current project HEAD; probed if absent.
 * @returns {{eligible: string[], ineligible: string[], patch: string}}
 *   `patch` holds only the eligible paths' diff blocks.
 */
export function partitionUndeclared({
	undeclared,
	diff,
	projectPath,
	readOnlyInputs = [],
	baseRevision,
	headRevision,
} = {}) {
	const paths = Array.isArray(undeclared) ? [...new Set(undeclared)] : [];
	const blocks = diffBlocks(diff);
	const candidates = [];
	const ineligible = [];
	const blockText = new Map();
	for (const path of paths) {
		const block = pathInsideProject(path) ? inPlaceBlock(blocks, path) : null;
		if (
			!block ||
			path.split("/").includes(".git") ||
			readOnlyInputs.includes(path) ||
			manifestReviewPaths([path]).length > 0
		) {
			ineligible.push(path);
			continue;
		}
		candidates.push(path);
		blockText.set(path, block.text);
	}
	let eligible = candidates;
	if (eligible.length > 0) {
		const patch = eligible.map((path) => blockText.get(path)).join("");
		const validated = validateDiff(patch, projectPath);
		const head = headRevision ?? projectHead(projectPath);
		const safe =
			validated.safe === true &&
			(validated.sensitivePaths ?? []).length === 0 &&
			typeof head === "string" &&
			declaredPathsAreClean(projectPath, eligible) &&
			headAdvanceSafe({
				projectPath,
				base: baseRevision,
				head,
				paths: eligible,
			});
		if (!safe) {
			ineligible.push(...eligible);
			eligible = [];
		}
	}
	if (eligible.length > MAX_UNDECLARED_PATHS) {
		ineligible.push(...eligible);
		eligible = [];
	}
	return {
		eligible,
		ineligible,
		patch: eligible.map((path) => blockText.get(path)).join(""),
	};
}

/**
 * Decide the undeclared-path gate for one captured diff. Returns the kept
 * paths when every undeclared path is eligible, otherwise the exact rejection
 * rule the run used before undeclared edits could be kept.
 */
export function evaluateUndeclaredScope({
	changedFiles,
	files,
	diff,
	projectPath,
	readOnlyInputs = [],
	baseRevision,
	enabled = true,
}) {
	const undeclared = changedFiles.filter((path) => !files.includes(path));
	if (undeclared.length === 0)
		return { ok: true, undeclared, eligible: [], patch: "" };
	const rule = readOnlyInputs.some((path) => undeclared.includes(path))
		? "read_only_input_changed"
		: "undeclared_paths_changed";
	if (!enabled || rule !== "undeclared_paths_changed")
		return { ok: false, rule, undeclared };
	const partition = partitionUndeclared({
		undeclared,
		diff,
		projectPath,
		readOnlyInputs,
		baseRevision,
	});
	if (partition.ineligible.length > 0 || partition.eligible.length === 0)
		return { ok: false, rule, undeclared };
	return {
		ok: true,
		undeclared,
		eligible: partition.eligible,
		patch: partition.patch,
	};
}

/** One human-readable warning for kept undeclared edits. */
export function undeclaredWarning(paths, patchPath) {
	return `dispatch: kept ${paths.length} undeclared path(s) for captain review: ${paths.join(", ")}; reverse with git apply -R ${patchPath}`;
}
