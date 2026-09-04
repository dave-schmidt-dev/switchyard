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
//   - `vibe` is admitted only with its live adapter and exact descriptor-level
//     full-clone/write-canary qualification.
//   - `pi` is not a switchyard-dispatch target (review-wrapper only,
//     decision #6) and has no roster.json target entry to iterate.
//
// ~/.agent/roster.json is read directly (same live-ground-truth pattern as
// tests/router-usage-provider.test.mjs, Task 1.5b) rather than via a
// fixture: the whole point is checking the real file, not a copy.

import { deepStrictEqual, ok, strictEqual } from "node:assert";
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
import { getInvocationDescriptor } from "../src/switchyard/roster/index.mjs";

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
	// why catalog-only and review-wrapper entries do not need a live-adapter
	// target, rather than silently relying on the `enabled === true` filter.
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

	const vibeLowModelRef = "zhipu/glm-5.2-low";
	const vibeModelRef = "zhipu/glm-5.2-high";
	const vibeSelector = "glm-5.2-high";
	// The bare GLM spellings were demoted on 2026-09-01 after every one of them
	// logged vibe's "Active model '<x>' is not in your configured models"
	// fallback. That message comes from vibe's LOCAL config loader
	// (vibe_schema.py `_apply_active_model_fallback`) and fires before any
	// request leaves the machine -- the VM copies it was measured in carry no
	// `~/.vibe/config.toml` at all, so no user alias could resolve there
	// whatever the account is entitled to. Treat those two spellings as dead
	// labels, not as evidence about entitlement. The 2026-09-04 host config
	// defines `glm-5.2-low`/`glm-5.2-high` as explicit `[[models]]` aliases,
	// which is a different identity from either dead spelling.
	const oldVibeSelectors = ["glm-5.2", "glm-5-2"];
	const oldVibeDescriptorHashes = [
		"sha256:fcb8dc17218516f69e8609d61f768106ab301727e2e65af76b0da4285f0895b1",
		"sha256:27fdd3ad8fd8ce6f1eb8478848f09956d84c432787db2c4609fcd9bef74c274b",
	];

	it("vibe is enabled with its VM clone and bounded qualifier policy", () => {
		ok("vibe" in targets, "expected a vibe target entry");
		strictEqual(targets.vibe?.enabled, true);
		strictEqual(targets.vibe?.harness, "vibe");
		strictEqual(targets.vibe?.snapshot_name, "Vibe");
		strictEqual(targets.vibe?.technical_ceiling, "standard");
		deepStrictEqual(targets.vibe?.slots?.low, [
			{ model_ref: vibeLowModelRef, priority: 1 },
		]);
		deepStrictEqual(targets.vibe?.slots?.standard, [
			{ model_ref: vibeModelRef, priority: 1 },
		]);
		ok(
			roster.models?.[vibeLowModelRef],
			"expected the Vibe low-slot model reference to exist",
		);
		ok(
			roster.models?.[vibeModelRef],
			"expected the Vibe model reference to exist",
		);
		strictEqual(roster.models[vibeModelRef]?.selector, vibeSelector);

		const vibeQualifications = targets.vibe?.qualifications ?? {};
		const vibeQualificationEntries = Object.entries(vibeQualifications);

		for (const [entryId, qualification] of vibeQualificationEntries) {
			ok(
				!oldVibeDescriptorHashes.includes(entryId),
				`unexpected legacy vibe descriptor identity ${entryId} was retained`,
			);
			ok(
				!oldVibeSelectors.includes(qualification?.selector),
				`unexpected legacy vibe selector ${qualification?.selector} was retained`,
			);
		}

		const expectedDescriptor = getInvocationDescriptor("vibe", "standard");
		if (expectedDescriptor === null) {
			// The slot selector must still carry an explicit, honest record.
			// Host-side `roster smoke` writes `qualified` (the wrapper ran and
			// produced parseable output); `untested` is the bare intent record.
			// Both are fail-closed -- only `dispatch_qualified`, which a real VM
			// canary writes, authorizes routing.
			ok(
				["untested", "qualified"].includes(
					vibeQualifications[vibeSelector]?.status,
				),
				`pre-promotion Vibe state must retain an explicit non-dispatch record for ${vibeSelector}`,
			);
			// Scoped to the current selector on purpose. A promoted receipt for
			// a selector no slot references (mistral-medium-3.5) is retained
			// history, not an authorization: getInvocationDescriptor resolves
			// the slot first, so a stale receipt cannot route. Deleting it would
			// cost a fresh VM canary to restore that lane.
			strictEqual(
				vibeQualificationEntries.some(
					([, qualification]) =>
						qualification?.status === "dispatch_qualified" &&
						qualification?.selector === vibeSelector,
				),
				false,
				"pre-promotion Vibe state must remain fail-closed for the current selector",
			);
			return;
		}

		const qualification =
			vibeQualifications[expectedDescriptor.descriptor_identity];
		ok(
			qualification,
			"current Vibe descriptor must have a qualification record",
		);
		strictEqual(
			qualification.status,
			"dispatch_qualified",
			"current Vibe qualification must be dispatch-qualified",
		);
		{
			const entryId = expectedDescriptor.descriptor_identity;
			strictEqual(
				qualification.descriptor_identity,
				entryId,
				"vibe qualification key must match descriptor_identity",
			);
			strictEqual(
				qualification.target_id,
				"vibe",
				"vibe qualification target must be vibe",
			);
			strictEqual(qualification.model_ref, vibeModelRef);
			strictEqual(qualification.selector, vibeSelector);
			strictEqual(qualification.effort, null);
			strictEqual(qualification.variant, null);
			deepStrictEqual(
				qualification.invocation_args,
				expectedDescriptor.invocation_args,
			);
			strictEqual(
				qualification.promotion_receipt?.status,
				"promoted",
				"vibe qualification must have promoted receipt",
			);
			strictEqual(
				qualification.promotion_receipt?.descriptor_identity,
				entryId,
				"vibe promotion receipt identity must match descriptor_identity",
			);
			strictEqual(
				qualification.promotion_receipt?.target_id,
				"vibe",
				"vibe promotion receipt target must be vibe",
			);
			strictEqual(
				qualification.promotion_receipt?.model_ref,
				vibeModelRef,
				"vibe promotion receipt model_ref must match slot model_ref",
			);
			strictEqual(
				qualification.promotion_receipt?.selector,
				vibeSelector,
				"vibe promotion receipt selector must match the slot selector",
			);
			strictEqual(
				qualification.promotion_receipt?.effort,
				null,
				"vibe promotion receipt effort must be null",
			);
			strictEqual(
				qualification.promotion_receipt?.variant,
				null,
				"vibe promotion receipt variant must be null",
			);
			deepStrictEqual(
				qualification.promotion_receipt?.invocation_args,
				expectedDescriptor.invocation_args,
				"vibe promotion receipt argv must match current descriptor argv",
			);
			strictEqual(
				qualification.promotion_receipt?.descriptor_identity,
				expectedDescriptor.descriptor_identity,
				"vibe qualification must match current descriptor identity",
			);
			strictEqual(
				qualification.model_ref,
				expectedDescriptor.model_ref,
				"vibe qualification must match current descriptor model_ref",
			);
			strictEqual(
				qualification.selector,
				expectedDescriptor.selector,
				"vibe qualification must match current descriptor selector",
			);
			deepStrictEqual(
				qualification.invocation_args,
				expectedDescriptor.invocation_args,
				"vibe qualification must match current descriptor argv",
			);
		}
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
