import { ok, strictEqual } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	captureDiff,
	executeCursor,
	isCursorAuthenticated,
} from "../src/switchyard/adapter/cursor.mjs";
import { createFakeExecutionBackend } from "./helpers/fake-execution-backend.mjs";

describe("cursor adapter shell injection guard", () => {
	it("rejects workingContainerName with shell metacharacters", () => {
		const result = executeCursor("do something", "bad container; rm -rf /", {});
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("rejects model name with shell metacharacters", () => {
		const result = executeCursor("do something", "valid-container", {
			model: "composer-2.5; echo INJECTED",
			resolvedTargetId: "cursor-target",
			descriptorHarness: "cursor",
			invocationDescriptor: {
				target_id: "cursor-target",
				model_ref: "composer-2.5; echo INJECTED",
				selector: "composer-2.5; echo INJECTED",
				effort: null,
				variant: null,
				invocation_args: [],
			},
			descriptorIdentity: `sha256:${"0".repeat(64)}`,
		});
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("accepts a valid container name and model", () => {
		const result = executeCursor("do something", "switchyard-work-1", {
			model: "composer-2.5",
		});
		ok(
			!result.error?.includes("unsafe characters"),
			"valid identifier/model should not be rejected by validation",
		);
	});

	it("captureDiff rejects unsafe container names", () => {
		const diff = captureDiff("bad container; rm -rf /");
		strictEqual(diff, null, "captureDiff should return null for unsafe names");
	});

	it("does not execute shell metacharacters embedded in the prompt on the host", () => {
		// cursor-agent cannot read stdin — the prompt is delivered as the final
		// execFileSync argv element, never through a shell. This guards against
		// a future refactor accidentally reintroducing shell interpolation, the
		// exact bug class already found and fixed in the claude/codex adapters.
		const markerDir = mkdtempSync(
			join(tmpdir(), "switchyard-prompt-injection-"),
		);
		const markerPath = join(markerDir, "marker");
		const evilPrompt = `wrap up'; touch ${markerPath}; echo '`;

		try {
			const result = executeCursor(
				evilPrompt,
				"switchyard-nonexistent-container",
				{},
			);
			strictEqual(result.success, false, "nonexistent container should fail");
			strictEqual(
				existsSync(markerPath),
				false,
				"prompt content must never be interpreted as host shell syntax",
			);
		} finally {
			rmSync(markerDir, { recursive: true, force: true });
		}
	});
});

describe("isCursorAuthenticated credential-validity check (fake guest)", () => {
	// TASKS.md Task 24: unlike claude/codex/agy, `cursor-agent status`'s exit
	// code does NOT distinguish logged-in from logged-out (confirmed live:
	// exit 0 either way), so the check reads `cursor-agent status --format
	// json`'s structured `isAuthenticated` boolean instead (live-verified
	// against a real completed OAuth session: `{"status":"authenticated",
	// "isAuthenticated":true,...}`).
	function createStatusBackend(state) {
		return createFakeExecutionBackend({
			version: state.version ?? "cursor-agent 1.0.0",
			respond(command, args) {
				if (args[0] === "status") {
					if (state.statusJson == null) {
						throw new Error("status unavailable");
					}
					return Buffer.from(state.statusJson);
				}
				throw new Error(
					`unexpected cursor command: ${command} ${args.join(" ")}`,
				);
			},
		});
	}

	it("returns false when `status --format json` reports isAuthenticated:false, even though the binary responds", () => {
		const backend = createStatusBackend({
			statusJson: '{"isAuthenticated":false}',
		});
		strictEqual(
			isCursorAuthenticated("fake-workspace", backend),
			false,
			"isAuthenticated:false must not read as authenticated",
		);
	});

	it("returns false when the binary doesn't respond to --version at all", () => {
		const backend = createStatusBackend({ version: null });
		strictEqual(
			isCursorAuthenticated("fake-workspace", backend),
			false,
			"a missing binary must not read as authenticated",
		);
	});

	it("returns false when status output is empty, malformed, or missing the field (fails CLOSED, not open)", () => {
		// The class of bug caught in review: an earlier text-matching version
		// of this check (`!/not logged in/i.test(statusResult)`) defaulted to
		// "authenticated" for any of these shapes. The JSON-boolean check must
		// default to false instead.
		const state = {};
		const backend = createStatusBackend(state);
		for (const badJson of ["", "{}", "not json at all", '{"status":"error"}']) {
			state.statusJson = badJson;
			strictEqual(
				isCursorAuthenticated("fake-workspace", backend),
				false,
				`status output ${JSON.stringify(badJson)} must not read as authenticated`,
			);
		}
	});

	it("returns true when `status --format json` reports isAuthenticated:true (positive control)", () => {
		// Proves the negative cases above aren't vacuous, and matches the real
		// shape live-verified against a completed OAuth session:
		// {"status":"authenticated","isAuthenticated":true,"hasAccessToken":true,...}
		const backend = createStatusBackend({
			statusJson:
				'{"status":"authenticated","isAuthenticated":true,"hasAccessToken":true,"hasRefreshToken":true}',
		});
		strictEqual(
			isCursorAuthenticated("fake-workspace", backend),
			true,
			"isAuthenticated:true should read as authenticated",
		);
	});
});
