#!/usr/bin/env node

/**
 * Remove the `switchyard-*` directories this project's test suite left in
 * `$TMPDIR`.
 *
 * The suite no longer leaks - every `mkdtemp` call site runs through
 * `tests/helpers/tempdir.mjs`, and `tests/tempdir-hygiene.test.mjs` fails if
 * that regresses - so this is a one-shot collector for the backlog that
 * accumulated before the fix, not a gate. It is deliberately not wired into
 * `test` or `validate`: a check that deletes machine state has no business
 * running as part of a build.
 *
 * Two properties matter more than the sweeping:
 *
 * 1. **It only ever touches `switchyard-` prefixed direct children of
 *    `$TMPDIR`.** That directory also holds other projects' state and tens of
 *    thousands of unattributed entries; nothing else is in scope. The prefix
 *    and parent are re-checked against the *canonical* path immediately before
 *    each removal, not only when candidates are collected.
 * 2. **It refuses to run rather than skip its own safety check.** The first
 *    version of this sweep grepped `lsof` output for paths under the raw
 *    `$TMPDIR` value (`/var/folders/...`) while macOS `lsof` reports
 *    canonicalized paths (`/private/var/folders/...`), so its open-handle
 *    check matched nothing and reported `0 skipped` truthfully but vacuously.
 *    Candidates are canonicalized before comparison now, and if `lsof` cannot
 *    be run at all the sweep exits non-zero instead of deleting unchecked.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The only prefix this sweep is authorized to remove. Not a parameter. */
export const SWEEP_PREFIX = "switchyard-";

/** macOS purges `$TMPDIR` at boot for entries untouched this long. */
export const DEFAULT_MAX_AGE_DAYS = 3;

const MS_PER_DAY = 86_400_000;

/**
 * Absolute paths from an `lsof -Fn` result, or `null` if the listing cannot be
 * trusted to be complete.
 *
 * `null` means "unknown", never "none held". An empty result and an absent
 * check are otherwise the same value, and that conflation is what made the
 * original sweep's guard vacuous. A *partial* listing is the same defect one
 * step further in: `lsof` exits non-zero and warns on stderr when it could not
 * inspect every process, and accepting that output as complete would let the
 * sweep delete a directory an uninspected process still holds. Measured on
 * this host, an unprivileged `lsof -Fn` exits 0 with empty stderr, so the
 * strict reading costs nothing here and fails closed where it would not.
 * @param {{error?: unknown, status?: number|null, stdout?: unknown, stderr?: unknown}} result
 * @returns {string[] | null}
 */
export function parseLsofResult(result) {
	if (result.error || typeof result.stdout !== "string" || !result.stdout) {
		return null;
	}
	if (result.status !== 0) {
		return null;
	}
	const stderr = typeof result.stderr === "string" ? result.stderr : "";
	if (/incomplete|WARNING/i.test(stderr)) {
		return null;
	}
	const held = [];
	for (const line of result.stdout.split("\n")) {
		// `-Fn` prefixes name fields with `n`; sockets and pipes appear as
		// `n->0x...` or `n*:*`, so require an absolute path.
		if (line.startsWith("n/")) {
			held.push(line.slice(1));
		}
	}
	return held;
}

/**
 * Every absolute path some live process currently holds open, or `null` when
 * that cannot be established completely.
 * @returns {string[] | null}
 */
export function listHeldPathsViaLsof() {
	// Deliberately no `-w`: suppressing lsof's warnings would suppress the
	// evidence that its listing is incomplete.
	return parseLsofResult(
		spawnSync("lsof", ["-Fn"], {
			encoding: "utf8",
			maxBuffer: 512 * 1024 * 1024,
		}),
	);
}

/**
 * Newest mtime and apparent size across a directory tree, root included.
 *
 * Symlinks are measured but never followed, so a link inside a candidate
 * cannot pull an unrelated tree into either number.
 * @param {string} root
 * @returns {{ newestMs: number, bytes: number } | null} `null` if unreadable.
 */
export function inspectTree(root) {
	let newestMs = 0;
	let bytes = 0;
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop();
		let stat;
		try {
			stat = lstatSync(current);
		} catch {
			// The tree changed under us. We cannot prove it is stale, so the
			// caller must retain it rather than guess.
			return null;
		}
		newestMs = Math.max(newestMs, stat.mtimeMs);
		bytes += stat.size;
		if (!stat.isDirectory()) {
			continue;
		}
		let entries;
		try {
			entries = readdirSync(current);
		} catch {
			return null;
		}
		for (const entry of entries) {
			pending.push(join(current, entry));
		}
	}
	return { newestMs, bytes };
}

/**
 * Whether a canonical path is one this sweep is authorized to remove.
 *
 * Authorization is the prefix and the parent, never the age: `$TMPDIR` holds
 * other projects' state and tens of thousands of unattributed entries, and an
 * ancient one of those is still not ours. Re-derived from the canonical path
 * rather than from the name `readdir` produced, so a link or a swapped entry
 * cannot smuggle a target in. Redundant with the prefix filter applied when
 * candidates are collected - deliberately, since it is the last check before
 * an `rm -rf`.
 * @param {string} canonicalPath
 * @param {string} canonicalTmpDir
 * @returns {boolean}
 */
export function isSweepAuthorized(canonicalPath, canonicalTmpDir) {
	return (
		dirname(canonicalPath) === canonicalTmpDir &&
		basename(canonicalPath).startsWith(SWEEP_PREFIX)
	);
}

/**
 * Sweep stale `switchyard-*` directories out of a temp directory.
 *
 * @param {object} [options]
 * @param {string} [options.tmpDir] Directory to sweep. Defaults to `$TMPDIR`.
 * @param {boolean} [options.apply] Remove rather than report. Defaults to false.
 * @param {number} [options.maxAgeDays] Retain anything touched more recently.
 * @param {number} [options.now] Epoch ms to measure age against.
 * @param {() => (string[] | null)} [options.listHeldPaths] Open-handle source.
 * @param {(message: string) => void} [options.log]
 * @returns {{status: number, summary: object}}
 */
export function sweepTempDirs({
	tmpDir = tmpdir(),
	apply = false,
	maxAgeDays = DEFAULT_MAX_AGE_DAYS,
	now = Date.now(),
	listHeldPaths = listHeldPathsViaLsof,
	log = console.log,
} = {}) {
	const summary = {
		tmpDir,
		apply,
		maxAgeDays,
		candidates: 0,
		removed: 0,
		apparentBytes: 0,
		skippedHeld: 0,
		skippedFresh: 0,
		skippedSymlink: 0,
		skippedUnreadable: 0,
		refused: 0,
		failed: 0,
	};

	let canonicalTmp;
	try {
		canonicalTmp = realpathSync(tmpDir);
	} catch {
		log(`sweep: cannot resolve ${tmpDir}`);
		return { status: 1, summary };
	}

	const held = listHeldPaths();
	if (held === null) {
		// Deleting without the open-handle check is exactly the failure this
		// script exists to not repeat.
		log(
			"sweep: lsof unavailable, refusing to sweep without an open-handle check",
		);
		return { status: 1, summary };
	}

	const cutoffMs = now - maxAgeDays * MS_PER_DAY;
	let names;
	try {
		names = readdirSync(canonicalTmp).filter((name) =>
			name.startsWith(SWEEP_PREFIX),
		);
	} catch {
		log(`sweep: cannot read ${canonicalTmp}`);
		return { status: 1, summary };
	}
	summary.candidates = names.length;

	for (const name of names) {
		const path = join(canonicalTmp, name);

		let entryStat;
		try {
			entryStat = lstatSync(path);
		} catch {
			summary.skippedUnreadable += 1;
			continue;
		}
		// The suite never creates a `switchyard-*` symlink, so one here is not
		// ours to resolve or remove.
		if (entryStat.isSymbolicLink()) {
			summary.skippedSymlink += 1;
			continue;
		}

		// Re-derive the authorization from the canonical path rather than
		// trusting the name the listing produced.
		let canonicalPath;
		try {
			canonicalPath = realpathSync(path);
		} catch {
			summary.skippedUnreadable += 1;
			continue;
		}
		if (!isSweepAuthorized(canonicalPath, canonicalTmp)) {
			summary.refused += 1;
			continue;
		}

		// lsof reports canonical paths, so both sides are canonical here. The
		// separator keeps `switchyard-a` from matching `switchyard-abc`.
		const isHeld = held.some(
			(open) => open === canonicalPath || open.startsWith(`${canonicalPath}/`),
		);
		if (isHeld) {
			summary.skippedHeld += 1;
			continue;
		}

		const tree = inspectTree(canonicalPath);
		if (tree === null) {
			summary.skippedUnreadable += 1;
			continue;
		}
		// "Untouched for N days" means the whole tree: a directory whose own
		// mtime is ancient can hold content written minutes ago.
		if (tree.newestMs >= cutoffMs) {
			summary.skippedFresh += 1;
			continue;
		}

		if (apply) {
			try {
				rmSync(canonicalPath, { recursive: true, force: true });
			} catch {
				summary.failed += 1;
				continue;
			}
		}
		summary.removed += 1;
		summary.apparentBytes += tree.bytes;
	}

	// Report what happened, not a fixed message: a cleanup that claims success
	// without saying what it did cannot be distinguished from one that did
	// nothing.
	log(
		`sweep ${apply ? "applied" : "dry-run"}: candidates=${summary.candidates} ` +
			`${apply ? "removed" : "would remove"}=${summary.removed} ` +
			`apparentBytes=${summary.apparentBytes} ` +
			`held=${summary.skippedHeld} fresh=${summary.skippedFresh} ` +
			`symlink=${summary.skippedSymlink} unreadable=${summary.skippedUnreadable} ` +
			`refused=${summary.refused} failed=${summary.failed}`,
	);

	return { status: summary.failed > 0 ? 1 : 0, summary };
}

/**
 * Parse the flags the CLI accepts. Unknown flags are an error rather than a
 * no-op, so a typo cannot silently turn a dry run into a real one.
 * @param {string[]} argv
 * @returns {{apply: boolean, maxAgeDays: number} | {error: string}}
 */
export function parseSweepArgs(argv) {
	let apply = false;
	let maxAgeDays = DEFAULT_MAX_AGE_DAYS;
	for (const arg of argv) {
		if (arg === "--apply") {
			apply = true;
			continue;
		}
		const days = /^--days=(\d+)$/.exec(arg);
		if (days) {
			maxAgeDays = Number(days[1]);
			continue;
		}
		return { error: `unknown argument: ${arg}` };
	}
	return { apply, maxAgeDays };
}

if (
	process.argv[1] &&
	(fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
		(existsSync(process.argv[1]) &&
			import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href))
) {
	const parsed = parseSweepArgs(process.argv.slice(2));
	if ("error" in parsed) {
		console.error(`sweep: ${parsed.error}`);
		console.error(
			"usage: node scripts/sweep-temp-dirs.mjs [--apply] [--days=N]",
		);
		process.exit(2);
	}
	process.exit(sweepTempDirs(parsed).status);
}
