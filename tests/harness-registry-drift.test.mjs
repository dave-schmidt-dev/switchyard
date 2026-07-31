// Task 1.6b (roster-unification plan): harness-registry source-of-truth +
// drift test.
//
// The Task 1.2 validator (`~/.agent/rosterlib/validate.py`) checks every
// roster.json target names a "registered harness adapter", but until now it
// did so against a hand-maintained, cross-repo-independent constant
// (`KNOWN_HARNESSES`) with no automated check that the constant actually
// matches reality. This file supplies that check from the switchyard side,
// where the real source of truth lives: one adapter module per live,
// dispatchable harness under `src/switchyard/adapter/*.mjs`, and the
// `context.adapters` map `runQueue` builds from them by default
// (`src/switchyard/runner/index.mjs` ~1190-1215: keys `claude`, `codex`,
// `agy`, `cursor`, `copilot`, `opencode` -- one entry per adapter file that
// implements dispatch, i.e. exports both an `execute*` function and a
// `captureDiff` function). `constants.mjs`, `orphan-kill.mjs`, and
// `shell-safety.mjs` live in the same directory but are shared helpers, not
// adapters -- they export neither shape, so the structural filter below
// naturally excludes them without a hardcoded filename list.
//
// Scope (locked, PM-3/PM-11 -- do not widen): iterate ONLY *enabled*
// switchyard-dispatch targets from ~/.agent/roster.json.
//   - Catalog-only entries (`claude-fable-5`, `kimi-k2.7-code`) are never
//     targets at all -- nothing to iterate.
//   - `vibe` is a target but `enabled: false` by design (no ZDR, no
//     vibe.mjs -- see roster-unification-2026-07-30-tasks.md Task 1.1) and
//     is deliberately excluded from the enabled-target filter below.
//   - `pi` is not a switchyard-dispatch target (review-wrapper only,
//     decision #6) and has no roster.json target entry to iterate.
//
// ~/.agent/roster.json is read directly (same live-ground-truth pattern as
// tests/router-usage-provider.test.mjs, Task 1.5b) rather than via a
// fixture: the whole point is checking the real file, not a copy.

import { ok, strictEqual } from "node:assert";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const REPO_ROOT = join(import.meta.dirname, "..");
const ADAPTER_DIR = join(REPO_ROOT, "src", "switchyard", "adapter");
const ROSTER_PATH = join(homedir(), ".agent", "roster.json");

/**
 * Discover the live, dispatchable harness ids from the switchyard adapter
 * directory: one id per `.mjs` file that exports both a `captureDiff`
 * function and an `execute*`-named function (the shape
 * `src/switchyard/runner/index.mjs`'s default `context.adapters` map is
 * built from -- see the file header). The harness id is the filename minus
 * `.mjs`, which is also exactly the key `context.adapters` and
 * roster.json's `harness` field use (verified against
 * runner/index.mjs's default adapters object: `claude`, `codex`, `agy`,
 * `cursor`, `copilot`, `opencode`).
 *
 * This is a structural (export-shape) filter, not a hardcoded filename
 * list, so it stays correct as adapters are added/removed -- exactly the
 * "define the authoritative source" gap this task closes.
 */
async function discoverLiveAdapterHarnesses(adapterDir) {
	const files = readdirSync(adapterDir).filter((name) => name.endsWith(".mjs"));
	const harnesses = new Set();
	for (const file of files) {
		const mod = await import(pathToFileURL(join(adapterDir, file)).href);
		const exportNames = Object.keys(mod);
		const hasCaptureDiff = typeof mod.captureDiff === "function";
		const hasExecute = exportNames.some(
			(name) => name === "execute" || name.startsWith("execute"),
		);
		if (hasCaptureDiff && hasExecute) {
			harnesses.add(file.slice(0, -".mjs".length));
		}
	}
	return harnesses;
}

/**
 * The drift predicate itself, factored out so both the real-roster
 * assertions below and the mutation check exercise the exact same logic:
 * every enabled target's `harness` must be a live adapter harness id.
 * Returns a list of violation messages (empty = no drift).
 */
function findHarnessDriftViolations(targets, liveAdapterHarnesses) {
	const violations = [];
	for (const [targetId, target] of Object.entries(targets)) {
		if (target?.enabled !== true) continue;
		const harness = target.harness;
		if (typeof harness !== "string" || !liveAdapterHarnesses.has(harness)) {
			violations.push(
				`targets['${targetId}'].harness '${harness}' has no live adapter entry ` +
					`(known live adapters: ${[...liveAdapterHarnesses].sort().join(", ")})`,
			);
		}
	}
	return violations;
}

const liveAdapterHarnesses = await discoverLiveAdapterHarnesses(ADAPTER_DIR);
const roster = JSON.parse(readFileSync(ROSTER_PATH, "utf8"));
const targets = roster.targets ?? {};
const enabledTargetIds = Object.keys(targets).filter(
	(id) => targets[id]?.enabled === true,
);

describe("harness registry drift (Task 1.6b)", () => {
	it("discovered at least one live adapter from the adapter directory", () => {
		ok(
			liveAdapterHarnesses.size > 0,
			`expected at least one live adapter under ${ADAPTER_DIR}`,
		);
	});

	it("roster.json has at least one enabled target to check", () => {
		ok(
			enabledTargetIds.length > 0,
			"expected at least one enabled target in ~/.agent/roster.json",
		);
	});

	for (const targetId of enabledTargetIds) {
		it(`${targetId}: harness resolves to a live adapter entry`, () => {
			const harness = targets[targetId].harness;
			ok(
				typeof harness === "string" && liveAdapterHarnesses.has(harness),
				`targets['${targetId}'].harness '${harness}' is not among the live switchyard ` +
					`adapters (${[...liveAdapterHarnesses].sort().join(", ")})`,
			);
		});
	}

	// Explicit exclusion checks (PM-3/PM-11, locked scope) -- these document
	// *why* fable/kimi/vibe/pi don't need a live-adapter entry, rather than
	// silently relying on the `enabled === true` filter above to skip them.
	it("catalog-only entries (fable, kimi) are not targets at all", () => {
		ok(
			!("claude-fable-5" in targets),
			"claude-fable-5 should not be a roster target",
		);
		ok(
			!("kimi-k2.7-code" in targets),
			"kimi-k2.7-code should not be a roster target",
		);
	});

	it("vibe is present but disabled, so it's excluded from the drift check", () => {
		ok("vibe" in targets, "expected a vibe target entry (enabled: false)");
		strictEqual(targets.vibe?.enabled, false);
	});

	it("pi is not a switchyard-dispatch target", () => {
		ok(
			!("pi" in targets),
			"pi should not be a roster target (review-wrapper only, decision #6)",
		);
	});

	describe("mutation check: an enabled target with a bogus harness is caught", () => {
		it("findHarnessDriftViolations flags an injected unknown harness", () => {
			const mutated = structuredClone(targets);
			mutated["__mutation-check-target__"] = {
				enabled: true,
				harness: "totally-bogus-harness-xyz",
			};
			const violations = findHarnessDriftViolations(
				mutated,
				liveAdapterHarnesses,
			);
			ok(
				violations.some((v) => v.includes("__mutation-check-target__")),
				"expected a violation for the injected bogus-harness target",
			);
		});

		// Stronger end-to-end variant of the same check: writes a real temp
		// roster file (never touches the shared ~/.agent/roster.json) with an
		// enabled target's harness corrupted, re-parses it exactly like the
		// live-roster assertions above do, and confirms the violation survives
		// a full JSON round-trip, not just an in-memory mutation.
		it("a corrupted on-disk roster fails the same check the live roster passes", () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "harness-drift-mutation-"));
			try {
				const corrupted = JSON.parse(JSON.stringify(roster));
				const firstEnabledId = enabledTargetIds[0];
				corrupted.targets[firstEnabledId].harness = "totally-bogus-harness-xyz";
				const corruptedPath = join(tmpDir, "roster.corrupted.json");
				writeFileSync(corruptedPath, JSON.stringify(corrupted));

				const reparsed = JSON.parse(readFileSync(corruptedPath, "utf8"));
				const violations = findHarnessDriftViolations(
					reparsed.targets,
					liveAdapterHarnesses,
				);
				ok(
					violations.some((v) => v.includes(`targets['${firstEnabledId}']`)),
					`expected a violation for the corrupted '${firstEnabledId}' target`,
				);

				// And the uncorrupted live roster must NOT trip the same check --
				// proves this isn't a check that fails everything indiscriminately.
				const cleanViolations = findHarnessDriftViolations(
					targets,
					liveAdapterHarnesses,
				);
				strictEqual(cleanViolations.length, 0);
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});
});
