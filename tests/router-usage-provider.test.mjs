// Task 1.5b (INV-4): target -> usage_provider mapping.
//
// Corrected premise (PM-8, design brief `roster-design-brief-2026-07-30.md`
// + `roster-unification-2026-07-30-tasks.md` Task 1.5b): the router's main
// path iterates the gradus snapshot's provider *names* (indexProviders(),
// router/index.mjs ~148-152) and applies passesCapabilityFilter /
// getRightSizedModel via normalizeProviderName -- Object.keys(
// PROVIDER_CAPABILITIES) is only used in the blind fallback. This test does
// not touch that iteration; it verifies the data side: every enabled
// ~/.agent/roster.json target's `usage_provider` (or its `harness`, the
// documented default when `usage_provider` is omitted) normalizes to a
// provider name gradus actually reports -- so a target can never point at
// usage/billing data gradus doesn't track.
//
// ~/.agent/roster.json is read directly (host-side, same pattern as
// SNAPSHOT_PATH in src/switchyard/router/index.mjs) rather than via a
// fixture: this test's whole point is checking the real file, not a copy.

import { ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { normalizeProviderName } from "../src/switchyard/roster/index.mjs";

const ROSTER_PATH = join(homedir(), ".agent", "roster.json");

// Gradus provider display names -- verified live (M12) against
// ~/Documents/Projects/gradus/.state/snapshot-v2.json on 2026-07-30 (brief
// §5 / tasks.md Task 1.5b). Committed here instead of read live so this
// test is deterministic and doesn't depend on gradus's on-disk snapshot
// mutating between runs (same isolation principle as this suite's sibling
// router.test.mjs, which writes its own temp snapshot rather than reading
// the real one). Re-verify against a live `snapshot.providers[].name` dump
// if gradus adds, renames, or removes a provider.
const GRADUS_PROVIDER_DISPLAY_NAMES = [
	"Codex",
	"Claude",
	"Antigravity",
	"Copilot",
	"Cursor",
	"OpenCode Go",
	"Vibe",
];

const KNOWN_GRADUS_PROVIDERS = new Set(
	GRADUS_PROVIDER_DISPLAY_NAMES.map(normalizeProviderName),
);

const roster = JSON.parse(readFileSync(ROSTER_PATH, "utf8"));
const targets = roster.targets ?? {};
const enabledTargetIds = Object.keys(targets).filter(
	(id) => targets[id]?.enabled === true,
);

describe("target -> usage_provider mapping (INV-4, Task 1.5b)", () => {
	it("roster.json has at least one enabled target to check", () => {
		ok(
			enabledTargetIds.length > 0,
			"expected at least one enabled target in ~/.agent/roster.json",
		);
	});

	for (const targetId of enabledTargetIds) {
		it(`${targetId}: usage_provider resolves to a gradus-known provider`, () => {
			const target = targets[targetId];
			// usage_provider defaults to harness when omitted (brief: "Add a
			// usage_provider field per target (defaults to harness) mapping a
			// target to the gradus provider whose usage/billing governs it").
			const usageProvider = target.usage_provider ?? target.harness;
			ok(
				typeof usageProvider === "string" && usageProvider.length > 0,
				`targets['${targetId}'] has no usage_provider and no harness to fall back to`,
			);

			const normalized = normalizeProviderName(usageProvider);
			ok(
				KNOWN_GRADUS_PROVIDERS.has(normalized),
				`targets['${targetId}'].usage_provider '${usageProvider}' normalizes to ` +
					`'${normalized}', which is not among the gradus-known providers ` +
					`(${[...KNOWN_GRADUS_PROVIDERS].sort().join(", ")})`,
			);
		});
	}

	// opencode-zen shares the "opencode" harness with opencode-go but stays
	// disabled -- gradus reports only one opencode-family provider
	// ("OpenCode Go"), so only opencode-go participates in the spread (brief:
	// "opencode-zen disabled so only opencode-go->opencode participates in
	// spread"). Asserted here so an accidental future re-enable of zen is
	// caught by this suite (it would need its own usage_provider decision,
	// not silently ride opencode-go's single gradus entry) rather than
	// failing silently elsewhere.
	it("opencode-zen stays disabled (excluded from the enabled-target check above)", () => {
		strictEqual(targets["opencode-zen"]?.enabled, false);
	});
});
