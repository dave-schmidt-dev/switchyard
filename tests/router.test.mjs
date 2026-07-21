// INV-4 gate test: router dispatches only to funded providers, spreading load
// Tests: Claude is routable (CR-2), exhausted providers skipped, absent providers skipped (CR-3)
// INV-5: capability filter + model right-sizing

import { notStrictEqual, strictEqual } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { route, routeBlind } from "../src/switchyard/router/index.mjs";

const SNAPSHOT_DIR = join(homedir(), "Documents/Projects/ai_monitor/.state");
const SNAPSHOT_PATH = join(SNAPSHOT_DIR, "snapshot-v2.json");

// Backup original snapshot if it exists
let originalSnapshot = null;

before(() => {
	try {
		originalSnapshot = readFileSync(SNAPSHOT_PATH, "utf8");
	} catch {
		// No original snapshot
	}
});

after(() => {
	// Restore original snapshot
	if (originalSnapshot !== null) {
		try {
			mkdirSync(SNAPSHOT_DIR, { recursive: true });
			writeFileSync(SNAPSHOT_PATH, originalSnapshot, "utf8");
		} catch {
			// Ignore
		}
	} else {
		// Clean up test snapshot
		try {
			rmSync(SNAPSHOT_PATH);
		} catch {
			// Ignore
		}
	}
});

// Helper to create a test snapshot
function createTestSnapshot(providers) {
	mkdirSync(SNAPSHOT_DIR, { recursive: true });
	writeFileSync(
		SNAPSHOT_PATH,
		JSON.stringify({
			schema_version: 2,
			providers,
		}),
		"utf8",
	);
}

describe("router", () => {
	it("should route to Claude when available (CR-2 regression)", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 100 }],
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 30, pace_delta: 200 }],
			},
		]);

		const result = route();
		notStrictEqual(result.provider, null, "Should find a provider");
		strictEqual(result.reason, "spread", "Should use spread selection");
	});

	it("should skip exhausted providers below floor (INV-4)", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 3, pace_delta: 100 }], // Below default floor of 5
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 200 }],
			},
		]);

		const result = route();
		strictEqual(
			result.provider,
			"codex",
			"Should skip exhausted Claude and pick Codex",
		);
	});

	it("should tolerate absent providers (CR-3)", () => {
		createTestSnapshot([
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 100 }],
			},
		]);

		const result = route();
		strictEqual(result.provider, "codex", "Should route to available provider");
	});

	it("should handle missing snapshot gracefully (CR-3)", () => {
		// Remove snapshot
		try {
			rmSync(SNAPSHOT_PATH);
		} catch {
			// Ignore
		}

		// A missing/broken snapshot must not silently halt every task behind
		// it — route() now wires the blind fallback into the real path instead
		// of just giving up (a prior version returned provider:null here and
		// the exported routeBlind was never called by anything).
		const result = route();
		strictEqual(result.reason, "blind_fallback");
		strictEqual(
			result.provider,
			"claude",
			"highest-capability roster entry first",
		);
	});

	it("should skip providers unavailable to this dispatcher even in blind mode", () => {
		try {
			rmSync(SNAPSHOT_PATH);
		} catch {
			// Ignore
		}

		const result = route({ availableProviders: ["codex"] });
		strictEqual(result.reason, "blind_fallback");
		strictEqual(result.provider, "codex");
	});

	it("never routes to a provider outside availableProviders", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 30, pace_delta: 100 }],
			},
			{
				name: "vibe",
				ok: true,
				windows: [{ percent_left: 90, pace_delta: 50 }], // most headroom, low tier
			},
		]);

		const result = route({ tier: "low", availableProviders: ["claude"] });
		strictEqual(
			result.provider,
			"claude",
			"vibe has more headroom and passes the low-tier capability filter, " +
				"but has no adapter registered so must never be selected",
		);
	});

	it("should select model based on tier (INV-5)", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 100 }],
			},
		]);

		const result = route({ tier: "high" });
		strictEqual(
			result.model,
			"claude-opus-4-8",
			"Should select high-tier model",
		);

		const standardResult = route({ tier: "standard" });
		strictEqual(
			standardResult.model,
			"claude-sonnet-5",
			"Should select standard-tier model",
		);
	});

	it("should filter by capability (INV-5)", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 100 }],
			},
			{
				name: "vibe",
				ok: true,
				windows: [{ percent_left: 80, pace_delta: 50 }], // More headroom but low capability
			},
		]);

		// High tier should only pick claude (vibe is low capability)
		const result = route({ tier: "high" });
		strictEqual(
			result.provider,
			"claude",
			"Should filter out low-capability vibe",
		);
	});

	it("should spread to provider with most headroom", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 30, pace_delta: 100 }],
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 70, pace_delta: 200 }],
			},
		]);

		const result = route();
		strictEqual(
			result.provider,
			"codex",
			"Should pick provider with most headroom",
		);
	});

	it("blind fallback should work", () => {
		const result = routeBlind(["claude", "codex"], ["claude"]);
		strictEqual(
			result.provider,
			"codex",
			"Should fall back to first non-excluded",
		);
	});

	it("does not blow the call stack on an oversized windows array (Task 10)", () => {
		// A malformed/runaway usage-snapshot writer could emit tens of thousands
		// of windows for one provider. The old `Math.min(...windows.map(...))` and
		// `Math.min(...paces)` spreads threw `RangeError: Maximum call stack size
		// exceeded`; the reduce-based min degrades gracefully instead. Each window
		// carries a finite pace_delta so the paces reduce (line ~184) is exercised
		// too, not just the percent_left reduce (line ~169).
		const bigWindows = Array.from({ length: 200000 }, () => ({
			percent_left: 50,
			pace_delta: 100,
		}));
		createTestSnapshot([{ name: "claude", ok: true, windows: bigWindows }]);

		const result = route();
		strictEqual(
			result.provider,
			"claude",
			"oversized windows must route, not crash the router",
		);
		strictEqual(result.percentLeft, 50, "min headroom computed via reduce");
	});

	it("breaks percent_left ties with the scorer, not roster order (Task 11)", () => {
		// claude is FIRST in snapshot/roster iteration order, so the old
		// array-order tie-break (winner seeded with scored[0]) always picked
		// claude on a headroom tie. codex has the higher pace_delta, so the
		// documented scorer (0.9*normPace + 0.1*jitter) must pick codex instead —
		// proving computeScore, not iteration order, decides the tie.
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 1 }],
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 999 }],
			},
		]);

		const result = route({ seed: 42 });
		strictEqual(result.percentLeft, 50, "tie is at the top headroom");
		strictEqual(
			result.provider,
			"codex",
			"scorer (higher pace) must break the tie, not roster order (claude first)",
		);
	});

	it("excludes a non-finite percent_left window rather than treating it as eligible (Task 13)", () => {
		// A snapshot CAN carry a non-finite percent_left: JSON.parse("1e999") is
		// Infinity (NaN can't survive a JSON round-trip, so it's unreachable here;
		// Number.isFinite guards both). typeof Infinity === "number" passed the
		// old filter, and `Infinity < floor` is false, so the provider evaded the
		// exhausted-skip and won with unbounded headroom — an INV-4 bypass. It must
		// now be excluded, leaving codex the only valid provider. Written as raw
		// JSON because JSON.stringify(Infinity) === "null".
		mkdirSync(SNAPSHOT_DIR, { recursive: true });
		writeFileSync(
			SNAPSHOT_PATH,
			'{"schema_version":2,"providers":[' +
				'{"name":"claude","ok":true,"windows":[{"percent_left":1e999,"pace_delta":100}]},' +
				'{"name":"codex","ok":true,"windows":[{"percent_left":50,"pace_delta":200}]}' +
				"]}",
			"utf8",
		);

		const result = route();
		strictEqual(
			result.provider,
			"codex",
			"claude's non-finite window must be excluded, leaving codex the winner",
		);
	});
});
