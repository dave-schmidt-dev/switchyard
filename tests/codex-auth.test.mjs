import { ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { captureDiff, executeCodex } from "../src/switchyard/adapter/codex.mjs";

// Resolve path from project root regardless of cwd — guards Finding H.
const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

describe("codex auth isolation", () => {
	it("does not copy host auth file into container", () => {
		const adapterPath = join(PROJECT_ROOT, "src/switchyard/adapter/codex.mjs");
		const source = readFileSync(adapterPath, "utf8");

		strictEqual(
			source.includes("docker cp ~/.codex/auth.json"),
			false,
			"host auth copy is forbidden",
		);
		ok(
			source.includes("bws-get"),
			"BWS-based auth injection should be present",
		);
	});
});

describe("codex adapter shell injection guard", () => {
	it("rejects workingContainerName with shell metacharacters", () => {
		const result = executeCodex("do something", "bad container; rm -rf /", {});
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("rejects model name with shell metacharacters", () => {
		const result = executeCodex("do something", "valid-container", {
			model: "gpt-4; echo INJECTED",
		});
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("accepts a valid container name", () => {
		// Should not throw on validation — will fail at Docker exec (not available),
		// but the failure comes from Docker, not from input validation.
		const result = executeCodex("do something", "switchyard-work-1", {
			model: "gpt-4o",
		});
		// Either Docker is unavailable (success:false with docker error) or succeeds.
		// Key: no "unsafe characters" error.
		ok(
			!result.error?.includes("unsafe characters"),
			"valid identifier should not be rejected by validation",
		);
	});

	it("captureDiff rejects unsafe container names", () => {
		const diff = captureDiff("bad container; rm -rf /");
		strictEqual(diff, null, "captureDiff should return null for unsafe names");
	});
});
