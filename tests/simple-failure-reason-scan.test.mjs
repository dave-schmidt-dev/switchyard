import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	FAILURE_REGISTRY,
	resolveFailure,
} from "../src/switchyard/diagnostics/failure-registry.mjs";

// ── Static reason scan ──────────────────────────────────────────────────────

const SIMPLE_SOURCE_DIR = fileURLToPath(
	new URL("../src/switchyard/simple/", import.meta.url),
);

// The dynamic `error?.code` at the index.mjs catch cannot be scanned as a
// literal; every other reason emitted by a simple source must be registered.
const DYNAMIC_REASON_ALLOWLIST = new Set(["error?.code"]);
const ROUTING_TASK_FAILURE_REASONS = [
	"invalid_task_id",
	"routing_lock_claim_recovery_failed",
	"routing_lock_malformed",
	"routing_run_lock_contention",
	"routing_task_binding_malformed",
	"routing_task_binding_missing",
	"routing_task_binding_source_mismatch",
	"routing_task_binding_source_unavailable",
	"routing_task_binding_write_failed",
	"routing_task_identity_lock_changed",
	"routing_task_identity_lock_contention",
	"routing_task_identity_source_unavailable",
	"task_identity_invalid",
	"task_identity_lock_contention",
	"task_identity_state_invalid",
	"task_identity_state_release_failed",
	"task_identity_state_unavailable",
	"task_identity_state_write_failed",
	"task_retry_linked_to_previous_run",
];

test("every literal simple failure reason is registered or explicitly allowlisted", () => {
	const patterns = [
		/fail\(\s*"([a-z][a-z0-9_]*)"/gu,
		/refused\(\s*"([a-z][a-z0-9_]*)"/gu,
		/failureReason:\s*"([a-z][a-z0-9_]*)"/gu,
		/stopReason:\s*"([a-z][a-z0-9_]*)"/gu,
	];
	const found = new Map();
	for (const file of readdirSync(SIMPLE_SOURCE_DIR)) {
		if (!file.endsWith(".mjs")) continue;
		const text = readFileSync(join(SIMPLE_SOURCE_DIR, file), "utf8");
		for (const pattern of patterns) {
			pattern.lastIndex = 0;
			for (const match of text.matchAll(pattern)) {
				if (!found.has(match[1])) found.set(match[1], new Set());
				found.get(match[1]).add(file);
			}
		}
	}
	ok(found.size >= 50, `scan found ${found.size} literal reasons`);
	for (const [reason, files] of found) {
		ok(
			FAILURE_REGISTRY.has(reason) || DYNAMIC_REASON_ALLOWLIST.has(reason),
			`unregistered literal reason "${reason}" in ${[...files].join(", ")}`,
		);
	}
	const staticReasons = [...found.keys()].filter(
		(reason) => !DYNAMIC_REASON_ALLOWLIST.has(reason),
	);
	strictEqual(staticReasons.length, found.size);
});

test("routing task and storage reason rows preserve the unclassified defaults", () => {
	const expected = {
		causeCode: "unknown",
		causeCategory: "unknown",
		errorKind: "unclassified_failure",
		severity: "soft",
		diffCategory: null,
		providerCaused: false,
		detailFields: ["failureReason"],
	};
	for (const reason of ROUTING_TASK_FAILURE_REASONS) {
		const row = FAILURE_REGISTRY.get(reason);
		ok(row, `${reason} has a registry row`);
		deepStrictEqual(
			{
				causeCode: row.causeCode,
				causeCategory: row.causeCategory,
				errorKind: row.errorKind,
				severity: row.severity,
				diffCategory: row.diffCategory,
				providerCaused: row.providerCaused,
				detailFields: row.detailFields,
			},
			expected,
			reason,
		);
		const resolved = resolveFailure({ reason, phase: "route" });
		strictEqual(resolved.causeCode, "unknown", reason);
		strictEqual(resolved.errorKind, "unclassified_failure", reason);
	}
});
