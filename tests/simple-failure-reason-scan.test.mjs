import { ok, strictEqual } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FAILURE_REGISTRY } from "../src/switchyard/diagnostics/failure-registry.mjs";

// ── Static reason scan ──────────────────────────────────────────────────────

const SIMPLE_SOURCE_DIR = fileURLToPath(
	new URL("../src/switchyard/simple/", import.meta.url),
);

// The dynamic `error?.code` at the index.mjs catch cannot be scanned as a
// literal; every other reason emitted by a simple source must be registered.
const DYNAMIC_REASON_ALLOWLIST = new Set(["error?.code"]);

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
