import { sep } from "node:path";

// macOS lsof stats every mounted filesystem before it lists anything. A network
// mount it cannot stat (the Time Machine SMB share while a backup runs, for
// example) prints exactly this three-line block. Listings on every other
// filesystem stay complete: a process whose cwd is a local scratch dir is still
// reported while the warning prints (measured 2026-10-19 during a backup).
const UNSTATTABLE_MOUNT =
	/^lsof: WARNING: can't stat\(\) [A-Za-z0-9_-]+ file system (\/.*)$/u;
const INCOMPLETE = "      Output information may be incomplete.";
const ASSUMED_DEV = /^ {6}assuming "dev=[0-9a-f]+" from mount table$/u;

/**
 * Mount points named by lsof's "can't stat() file system" warnings, or null
 * when stderr holds any other text.
 *
 * @param {string} stderr
 * @returns {string[] | null}
 */
function unstattableMounts(stderr) {
	const lines = stderr.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const mounts = [];
	for (let index = 0; index < lines.length; index += 3) {
		const mount = UNSTATTABLE_MOUNT.exec(lines[index])?.[1];
		if (
			mount === undefined ||
			lines[index + 1] !== INCOMPLETE ||
			!ASSUMED_DEV.test(lines[index + 2] ?? "")
		)
			return null;
		mounts.push(mount);
	}
	return mounts;
}

const within = (path, root) =>
	path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * Whether lsof's listing is complete for every path under `scopeRoots`
 * (realpaths). True for empty stderr. Otherwise stderr must hold only
 * unstattable-mount blocks whose mount is neither a scope root, an ancestor of
 * one, nor inside one. Any other warning, or no scope at all, reads as
 * incomplete.
 *
 * @param {unknown} stderr
 * @param {readonly string[]} scopeRoots
 * @returns {boolean}
 */
export function lsofListingComplete(stderr, scopeRoots) {
	if (stderr === undefined || stderr === null || stderr === "") return true;
	if (typeof stderr !== "string") return false;
	const mounts = unstattableMounts(stderr);
	if (mounts === null || scopeRoots.length === 0) return false;
	return mounts.every((mount) =>
		scopeRoots.every((root) => !within(mount, root) && !within(root, mount)),
	);
}
