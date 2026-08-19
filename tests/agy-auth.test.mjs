import { ok, strictEqual } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	captureDiff,
	executeAgy,
	isAgyAuthenticated,
} from "../src/switchyard/adapter/agy.mjs";
import { createFakeExecutionBackend } from "./helpers/fake-execution-backend.mjs";

describe("agy adapter shell injection guard", () => {
	it("rejects workingContainerName with shell metacharacters", () => {
		const result = executeAgy("do something", "bad container; rm -rf /", {});
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("rejects model name with shell metacharacters", () => {
		const result = executeAgy("do something", "valid-container", {
			model: "Gemini 3.6 Flash; echo INJECTED",
			resolvedTargetId: "agy-target",
			descriptorHarness: "agy",
			invocationDescriptor: {
				target_id: "agy-target",
				model_ref: "Gemini 3.6 Flash; echo INJECTED",
				selector: "Gemini 3.6 Flash; echo INJECTED",
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

	it("accepts a valid container name and a display-name model with spaces/parens", () => {
		const result = executeAgy("do something", "switchyard-work-1", {
			model: "Gemini 3.6 Flash (High)",
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
		// agy's prompt is delivered as a single execFileSync argv element (a
		// --print flag value), never through a shell — this guards against a
		// future refactor accidentally reintroducing shell interpolation, the
		// exact bug class already found and fixed in the claude/codex adapters.
		const markerDir = mkdtempSync(
			join(tmpdir(), "switchyard-prompt-injection-"),
		);
		const markerPath = join(markerDir, "marker");
		const evilPrompt = `wrap up'; touch ${markerPath}; echo '`;

		try {
			const result = executeAgy(
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

describe("isAgyAuthenticated credential-validity check (fake guest)", () => {
	it("returns false when the credential is withheld/corrupt even though the binary responds", () => {
		// TASKS.md Task 15 "done when": with the CLI installed and answering
		// `--version` (liveness passes — agy has no vendor keyword, so any
		// non-empty output counts), a withheld or trivial credentials file must
		// make isAgyAuthenticated() return false. A real completed OAuth login
		// persists ~/.gemini/antigravity-cli/antigravity-oauth-token — live-
		// verified against a real login (TASKS.md Task 24), replacing an earlier
		// assumed path that never actually existed under a real login.
		const credPath = ".gemini/antigravity-cli/antigravity-oauth-token";
		const files = {};
		const backend = createFakeExecutionBackend({
			version: "agy 1.0.0",
			files,
		});

		// Credential withheld entirely.
		strictEqual(
			isAgyAuthenticated("fake-workspace", backend),
			false,
			"withheld credential must not read as authenticated",
		);

		// Credential present but empty (the empty-file bug shape).
		files[credPath] = "";
		strictEqual(
			isAgyAuthenticated("fake-workspace", backend),
			false,
			"empty credential file must not read as authenticated",
		);

		// Credential present but a trivial JSON stub.
		files[credPath] = "{}";
		strictEqual(
			isAgyAuthenticated("fake-workspace", backend),
			false,
			"trivial {} stub must not read as authenticated",
		);

		// Positive control: a non-trivial credential reads as authenticated
		// (pre-fix liveness-only logic returned true for all four states).
		files[credPath] = '{"refresh_token":"fake-gemini-token-1234567890"}';
		strictEqual(
			isAgyAuthenticated("fake-workspace", backend),
			true,
			"a non-trivial persisted credential must read as authenticated",
		);
	});

	it("returns false when the binary doesn't respond to --version at all", () => {
		const backend = createFakeExecutionBackend({
			version: null,
			files: {
				".gemini/antigravity-cli/antigravity-oauth-token":
					'{"refresh_token":"fake-gemini-token-1234567890"}',
			},
		});
		strictEqual(
			isAgyAuthenticated("fake-workspace", backend),
			false,
			"missing binary must not read as authenticated even with credentials present",
		);
	});
});
