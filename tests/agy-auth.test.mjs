import { ok, strictEqual } from "node:assert";
import { existsSync, rmSync } from "node:fs";

import { join } from "node:path";
import { describe, it } from "node:test";
import {
	captureDiff,
	executeAgy,
	isAgyAuthenticated,
} from "../src/switchyard/adapter/agy.mjs";
import { createFakeExecutionBackend } from "./helpers/fake-execution-backend.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

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
		const markerDir = tempDir("switchyard-prompt-injection-");
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

describe("isAgyAuthenticated Keychain-status check (fake guest)", () => {
	function createAgyKeychainBackend(state = {}) {
		return createFakeExecutionBackend({
			version: state.version !== undefined ? state.version : "agy 1.0.0",
			respond(command, args) {
				if (
					command === "/bin/sh" &&
					args[0] === "-c" &&
					args[1] ===
						"/usr/bin/security find-generic-password -s gemini -a antigravity >/dev/null 2>&1"
				) {
					if (state.keychainError) {
						throw state.keychainError;
					}
					if (state.exitCode && state.exitCode !== 0) {
						const error = new Error(
							`Keychain item probe failed with exit status ${state.exitCode}`,
						);
						error.status = state.exitCode;
						throw error;
					}
					return Buffer.from("");
				}
				throw new Error(`unexpected Agy command: ${command} ${args.join(" ")}`);
			},
		});
	}

	it("returns true when the Agy Keychain item is present", () => {
		strictEqual(
			isAgyAuthenticated("fake-workspace", createAgyKeychainBackend()),
			true,
		);
	});

	it("returns false when the Agy Keychain item is absent", () => {
		strictEqual(
			isAgyAuthenticated(
				"fake-workspace",
				createAgyKeychainBackend({ exitCode: 44 }),
			),
			false,
		);
	});

	it("returns false when the Keychain probe fails", () => {
		strictEqual(
			isAgyAuthenticated(
				"fake-workspace",
				createAgyKeychainBackend({
					keychainError: new Error("Keychain unavailable"),
				}),
			),
			false,
		);
	});

	it("returns false when the Agy binary does not respond", () => {
		strictEqual(
			isAgyAuthenticated(
				"fake-workspace",
				createAgyKeychainBackend({ version: null }),
			),
			false,
		);
	});
});
