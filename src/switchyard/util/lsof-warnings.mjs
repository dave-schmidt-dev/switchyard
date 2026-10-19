import { statSync } from "node:fs";
import { sep } from "node:path";

// macOS lsof stats every mounted filesystem before it lists anything. A network
// mount it cannot stat (the Time Machine SMB share while a backup runs, for
// example) prints exactly this three-line block, takes the device number from
// the mount table and continues; cwd paths come from each process directly. A
// process whose cwd is a local scratch dir is still reported while the warning
// prints (measured 2026-10-19 during a backup).
const UNSTATTABLE_MOUNT =
	/^lsof: WARNING: can't stat\(\) [A-Za-z0-9_-]+ file system (\/.*)$/u;
const INCOMPLETE = "      Output information may be incomplete.";
const ASSUMED_DEV = /^ {6}assuming "dev=([0-9a-f]{1,8})" from mount table$/u;

/**
 * Mounts named by lsof's "can't stat() file system" warnings, with the device
 * number lsof assumed for each, or null when stderr holds any other text.
 *
 * @param {string} stderr
 * @returns {{path: string, dev: number}[] | null}
 */
function unstattableMounts(stderr) {
	const lines = stderr.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const mounts = [];
	for (let index = 0; index < lines.length; index += 3) {
		const path = UNSTATTABLE_MOUNT.exec(lines[index])?.[1];
		const dev = ASSUMED_DEV.exec(lines[index + 2] ?? "")?.[1];
		if (path === undefined || dev === undefined) return null;
		if (lines[index + 1] !== INCOMPLETE) return null;
		mounts.push({ path, dev: Number.parseInt(dev, 16) });
	}
	return mounts;
}

const within = (path, root) =>
	path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * A device number as the unsigned 32-bit value lsof prints. libuv widens a
 * negative `st_dev` to 64 bits, which a Number cannot hold exactly, so this
 * takes the bigint form.
 *
 * @param {bigint} dev
 * @returns {number}
 */
export const unsignedDevice = (dev) => Number(BigInt.asUintN(32, dev));

/** Device number of `path` as an unsigned 32-bit value, or null. */
function deviceOfPath(path) {
	try {
		return unsignedDevice(statSync(path, { bigint: true }).dev);
	} catch {
		return null;
	}
}

/**
 * Whether lsof's listing is complete for every path under `scopeRoots`
 * (realpaths). True for empty stderr. Otherwise stderr must hold only
 * unstattable-mount blocks whose mount is neither a scope root, an ancestor of
 * one, nor inside one, and whose device is not a scope root's device (a
 * firmlink gives one volume two spellings, such as `/System/Volumes/Data` and
 * `/private/var`). Any other warning, a scope root that cannot be stat'ed, or
 * no scope at all reads as incomplete.
 *
 * @param {unknown} stderr
 * @param {readonly string[]} scopeRoots
 * @param {{deviceOf?: (path: string) => number | null}} [options]
 * @returns {boolean}
 */
export function lsofListingComplete(
	stderr,
	scopeRoots,
	{ deviceOf = deviceOfPath } = {},
) {
	if (stderr === undefined || stderr === null || stderr === "") return true;
	if (typeof stderr !== "string") return false;
	const mounts = unstattableMounts(stderr);
	if (mounts === null || scopeRoots.length === 0) return false;
	const scopeDevices = scopeRoots.map((root) => deviceOf(root));
	if (scopeDevices.some((dev) => !Number.isInteger(dev))) return false;
	return mounts.every(
		({ path, dev }) =>
			!scopeDevices.includes(dev) &&
			scopeRoots.every((root) => !within(path, root) && !within(root, path)),
	);
}
