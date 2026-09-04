import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created = new Set();

/**
 * Remove every directory this module handed out.
 *
 * The suite creates thousands of these across a full run, and macOS only purges
 * `$TMPDIR` for entries untouched three days, at boot - so on a machine that
 * runs for weeks nothing collects them. An exit handler is the only cleanup
 * that survives all three ways the suite was leaking: a test that throws, a
 * failed assertion before an inline `rmSync`, and a nested `beforeEach` that
 * replaced a tracked path before either `afterEach` could see it. It does not
 * survive SIGKILL; nothing in-process does.
 */
process.on("exit", () => {
	for (const path of created) {
		try {
			rmSync(path, { recursive: true, force: true });
		} catch {
			// A directory a still-running child still holds is that test's to
			// wait on. Failing here would replace a leak with a crash at exit.
		}
	}
});

function track(path) {
	created.add(path);
	return path;
}

/**
 * `mkdtempSync` under `$TMPDIR`, tracked for removal at process exit.
 * @param {string} prefix
 * @returns {string}
 */
export function tempDir(prefix) {
	return track(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * `mkdtemp` under `$TMPDIR`, tracked for removal at process exit.
 * @param {string} prefix
 * @returns {Promise<string>}
 */
export async function tempDirAsync(prefix) {
	return track(await mkdtemp(join(tmpdir(), prefix)));
}

/**
 * `mkdtempSync` under an explicit parent, tracked for removal at process exit.
 *
 * Tracked even though the parent is usually itself tracked: a test that removes
 * the parent early would otherwise leave this one unaccounted for.
 * @param {string} parent
 * @param {string} prefix
 * @returns {string}
 */
export function tempDirIn(parent, prefix) {
	return track(mkdtempSync(join(parent, prefix)));
}
