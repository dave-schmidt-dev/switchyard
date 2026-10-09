import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

/**
 * Resolves the temp base a simple run allocates under: an injected
 * `dependencies.tmpdir` (function or path) or the process temp directory.
 */
export function simpleTempBase(dependencies = {}) {
	return typeof dependencies.tmpdir === "function"
		? dependencies.tmpdir()
		: (dependencies.tmpdir ?? tmpdir());
}

/**
 * Owned parent for simple roots inside the temp base. Roots used to sit
 * directly in the shared $TMPDIR, where any broad sweep or glob of its
 * children (`"$TMPDIR"/*`) reached live checkouts. The name keeps the
 * `switchyard-simple-` prefix so the generic `sweep:temp` never selects the
 * parent itself; the orphan collector scans inside it. It does not survive a
 * delete of the whole temp directory; that case reports `worktree_missing`.
 */
/** Ownership marker written into every simple root at allocation. */
export const OWNER_MARKER = ".switchyard-cleanup-owner.json";

export const SIMPLE_ROOTS_DIRNAME = "switchyard-simple-roots";

/** Matches one disposable root's directory name. */
export const SIMPLE_ROOT_NAME_RE =
	/^switchyard-simple-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Creates (or proves) the owner-only roots parent under a canonical temp base.
 * Refuses a symlink, a foreign owner, group/other permissions, or a parent
 * whose realpath differs, so a planted directory cannot capture checkouts.
 */
export function ensureSimpleRootsParent(tempBase) {
	const parent = join(realpathSync(tempBase), SIMPLE_ROOTS_DIRNAME);
	try {
		mkdirSync(parent, { mode: 0o700 });
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
	}
	const stat = lstatSync(parent);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
		(stat.mode & 0o077) !== 0 ||
		realpathSync(parent) !== parent
	)
		throw new Error("simple roots parent is not an owner-only directory");
	return parent;
}

/**
 * Chooses the disposable root for one simple run.
 * @returns {{canonicalParent: string, candidateChild: string, candidatePath: string}}
 */
export function allocateSimpleRoot(dependencies = {}) {
	const canonicalParent = ensureSimpleRootsParent(simpleTempBase(dependencies));
	const candidateChild = `switchyard-simple-${randomUUID()}`;
	return {
		canonicalParent,
		candidateChild,
		candidatePath: join(canonicalParent, candidateChild),
	};
}

/**
 * Test-seam removal used when a test injects provider or check doubles without
 * a cleanup double. Production never reaches it: `handleSimple` injects none
 * of `rmSync`, `executeProvider`, or `runCheck`. It still removes only the
 * exact root this run allocated: `<canonicalParent>/<switchyard-simple-uuid>`,
 * a real directory (not a symlink) carrying the cleanup owner marker.
 */
export function removeInjectedTestRoot(
	worktreeRoot,
	canonicalParent,
	candidateChild,
	dependencies = {},
) {
	if (
		typeof worktreeRoot !== "string" ||
		typeof canonicalParent !== "string" ||
		typeof candidateChild !== "string" ||
		!SIMPLE_ROOT_NAME_RE.test(candidateChild) ||
		worktreeRoot !== join(canonicalParent, candidateChild) ||
		!worktreeRoot.startsWith(`${canonicalParent}${sep}`)
	)
		throw new Error("unsafe workspace root");
	let stat;
	try {
		stat = lstatSync(worktreeRoot);
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error("unsafe workspace root");
	if (!lstatSync(join(worktreeRoot, OWNER_MARKER)).isFile())
		throw new Error("unsafe workspace root");
	(dependencies.rmSync ?? rmSync)(worktreeRoot, {
		recursive: true,
		force: true,
	});
}

/**
 * True only when the recorded root is provably gone (ENOENT/ENOTDIR), as after
 * an outside `rm -rf` of the shared temp directory. Other lstat errors are
 * not proof of absence and return false.
 */
export function simpleRootMissing(path) {
	if (typeof path !== "string" || path === "") return false;
	try {
		lstatSync(path);
		return false;
	} catch (error) {
		return error?.code === "ENOENT" || error?.code === "ENOTDIR";
	}
}
