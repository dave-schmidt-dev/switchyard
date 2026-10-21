// @test-phase: other
import { deepStrictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import * as disk from "../src/switchyard/adapter/run-failure-disk.mjs";
import * as semantics from "../src/switchyard/diagnostics/failure-semantics.mjs";
import { failureSemanticsTable } from "./helpers/failure-semantics-table.mjs";

// Captured from the unmodified 0a71c51 implementations, before moving decisions.
// Never regenerate this fixture from the consolidated implementation.
test("failure decisions reproduce the pre-consolidation golden table", () => {
	const expected = JSON.parse(
		gunzipSync(
			readFileSync(
				new URL("./fixtures/failure-semantics.golden.json.gz", import.meta.url),
			),
		).toString("utf8"),
	);
	// Quota trust is the approved divergence. Keep the frozen table's old
	// cause-only projection here; strict quota behavior has focused tests.
	const historicalSemantics = {
		...semantics,
		...disk,
		shouldRecordRouteExhaustion(result) {
			if (result?.providerReliability?.causeCode === "quota_exhausted")
				return true;
			return semantics.shouldRecordRouteExhaustion(result);
		},
		nonBlamingCause(result) {
			if (result?.providerReliability?.causeCode === "quota_exhausted")
				return "quota_exhausted";
			return semantics.nonBlamingCause(result);
		},
	};
	deepStrictEqual(failureSemanticsTable(historicalSemantics), expected);
});
