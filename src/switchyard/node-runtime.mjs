import { accessSync, constants, realpathSync, statSync } from "node:fs";

/** Stable Homebrew links that survive a `brew upgrade node`. */
const STABLE_NODE_LINKS = Object.freeze([
	"/opt/homebrew/opt/node/bin/node",
	"/opt/homebrew/bin/node",
]);
const HOMEBREW_NODE_CELLAR = "/opt/homebrew/Cellar/node/";

function executableFile(path) {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve a Node executable that exists now.
 *
 * `process.execPath` names the versioned Cellar binary the process started
 * from. An unattended `brew upgrade node` deletes that binary while a
 * long-running routing invocation is still alive, so every later child spawn
 * or sandbox read of it fails with ENOENT. This returns `execPath` while it
 * is an executable file. Otherwise it falls back only to a fixed stable
 * Homebrew link whose canonical target is a Homebrew Cellar node, never to a
 * PATH lookup, so a hostile PATH cannot choose the runtime.
 *
 * @param {object} [options]
 * @param {string} [options.execPath] - Executable the process started from.
 * @param {readonly string[]} [options.links] - Fallback links, in order.
 * @param {string} [options.cellar] - Required canonical prefix of a fallback.
 * @returns {string} Canonical path to an existing Node executable.
 * @throws {Error} ENOENT with `checkSetupExecutable: "node"` when none exists.
 */
export function currentNodeExecutable({
	execPath = process.execPath,
	links = STABLE_NODE_LINKS,
	cellar = HOMEBREW_NODE_CELLAR,
} = {}) {
	if (executableFile(execPath)) return execPath;
	for (const link of links) {
		let target;
		try {
			target = realpathSync(link);
		} catch {
			continue;
		}
		if (target.startsWith(cellar) && executableFile(target)) return target;
	}
	throw Object.assign(new Error("node_executable_missing"), {
		code: "ENOENT",
		checkSetupExecutable: "node",
	});
}
