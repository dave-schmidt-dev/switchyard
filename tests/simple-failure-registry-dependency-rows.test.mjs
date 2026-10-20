// @test-phase: other
// Task 2.7 dependency-refusal rows, split from simple-failure-registry.test.mjs:
// these rows are pinned by explicit expectations, not by the frozen oracle.
import { ok, strictEqual } from "node:assert";
import { test } from "node:test";
import {
	FAILURE_REGISTRY,
	resolveFailure,
} from "../src/switchyard/diagnostics/failure-registry.mjs";

// ── Task 2.7: dependency refusal causes and details ─────────────────────────

test("check_manifest_changed_by_diff is a hard check row, never environment", () => {
	const row = FAILURE_REGISTRY.get("check_manifest_changed_by_diff");
	ok(row, "manifest row exists");
	strictEqual(row.causeCode, "check_manifest_changed_by_diff");
	strictEqual(row.causeCategory, "check");
	strictEqual(row.errorKind, "check_failed");
	strictEqual(row.severity, "hard");
	strictEqual(row.providerCaused, false);
	ok(row.detailFields.includes("dependencyCheck"));
	ok(row.detailFields.includes("manifestName"));
	for (const phase of ["diff", "checks", "check", "cleanup", "unknown"]) {
		const resolved = resolveFailure({
			reason: "check_manifest_changed_by_diff",
			phase,
		});
		strictEqual(resolved.causeCode, "check_manifest_changed_by_diff", phase);
		strictEqual(resolved.causeCategory, "check", phase);
		strictEqual(resolved.severity, "hard", phase);
	}
});

test("check_dependencies_unverified is baseline before the provider and hard after", () => {
	const row = FAILURE_REGISTRY.get("check_dependencies_unverified");
	strictEqual(row.providerCaused, false);
	ok(row.detailFields.includes("dependencyCheck"));
	ok(row.detailFields.includes("manifestName"));
	for (const phase of ["preflight", "route", "prepare", "baseline"]) {
		const resolved = resolveFailure({
			reason: "check_dependencies_unverified",
			phase,
		});
		strictEqual(resolved.severity, "baseline", phase);
		strictEqual(resolved.causeCode, "check_dependencies_unverified", phase);
		strictEqual(resolved.causeCategory, "environment", phase);
	}
	for (const phase of ["execute", "provider", "diff", "checks"]) {
		const resolved = resolveFailure({
			reason: "check_dependencies_unverified",
			phase,
		});
		strictEqual(resolved.severity, "hard", phase);
		strictEqual(resolved.causeCode, "check_dependencies_unverified", phase);
	}
});
