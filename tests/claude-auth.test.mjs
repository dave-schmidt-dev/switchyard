import { ok, strictEqual } from "node:assert";
import { existsSync, rmSync } from "node:fs";

import { join } from "node:path";
import { describe, it } from "node:test";
import {
	captureDiff,
	executeClaude,
	isClaudeAuthenticated,
} from "../src/switchyard/adapter/claude.mjs";
import { createFakeExecutionBackend } from "./helpers/fake-execution-backend.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

describe("claude adapter shell injection guard", () => {
	it("rejects workingContainerName with shell metacharacters", () => {
		const result = executeClaude("do something", "bad container; rm -rf /", {});
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("rejects model name with shell metacharacters", () => {
		const result = executeClaude("do something", "valid-container", {
			model: "opus; echo INJECTED",
			resolvedTargetId: "claude-target",
			descriptorHarness: "claude",
			invocationDescriptor: {
				target_id: "claude-target",
				model_ref: "opus; echo INJECTED",
				selector: "opus; echo INJECTED",
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

	it("accepts a valid container name", () => {
		const result = executeClaude("do something", "switchyard-work-1", {
			model: "claude-sonnet-5",
		});
		ok(
			!result.error?.includes("unsafe characters"),
			"valid identifier should not be rejected by validation",
		);
	});

	it("captureDiff rejects unsafe container names", () => {
		const diff = captureDiff("bad container; rm -rf /");
		strictEqual(diff, null, "captureDiff should return null for unsafe names");
	});

	it("does not execute shell metacharacters embedded in the prompt on the host", () => {
		// Same class of bug fixed in the Codex adapter: the prompt must never be
		// shell-interpolated. Delivered over stdin, so a single quote in a task
		// description can't break out into host shell syntax.
		const markerDir = tempDir("switchyard-prompt-injection-");
		const markerPath = join(markerDir, "marker");
		const evilPrompt = `wrap up'; touch ${markerPath}; echo '`;

		try {
			const result = executeClaude(
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

describe("isClaudeAuthenticated auth-status check (fake guest)", () => {
	function createClaudeStatusBackend(state = {}) {
		return createFakeExecutionBackend({
			version:
				state.version !== undefined ? state.version : "Claude Code 1.0.0",
			respond(command, args) {
				if (
					command === "claude" &&
					args[0] === "auth" &&
					args[1] === "status"
				) {
					if (state.statusError) {
						throw state.statusError;
					}
					if (state.exitCode && state.exitCode !== 0) {
						const err = new Error(
							`Command failed: claude auth status (exit status ${state.exitCode})`,
						);
						err.status = state.exitCode;
						throw err;
					}
					return Buffer.from("");
				}
				throw new Error(
					`unexpected claude command: ${command} ${args.join(" ")}`,
				);
			},
		});
	}

	it("returns true when claude auth status exits with status 0 (authenticated)", () => {
		const backend = createClaudeStatusBackend({ exitCode: 0 });
		strictEqual(
			isClaudeAuthenticated("fake-workspace", backend),
			true,
			"exit status 0 from claude auth status should read as authenticated",
		);
	});

	it("regression: returns false when claude auth status exits with non-zero status (logged out)", () => {
		const backend = createClaudeStatusBackend({ exitCode: 1 });
		strictEqual(
			isClaudeAuthenticated("fake-workspace", backend),
			false,
			"non-zero exit status from claude auth status must fail closed",
		);
	});

	it("returns false on status command failure (e.g. execution error or timeout)", () => {
		const backend = createClaudeStatusBackend({
			statusError: new Error("ETIMEDOUT: status probe timed out"),
		});
		strictEqual(
			isClaudeAuthenticated("fake-workspace", backend),
			false,
			"status command execution failure must fail closed",
		);
	});

	it("returns false when the binary is missing or does not respond to --version", () => {
		const backend = createClaudeStatusBackend({ version: null });
		strictEqual(
			isClaudeAuthenticated("fake-workspace", backend),
			false,
			"missing binary must not read as authenticated",
		);
	});

	it("returns false when the binary --version output does not identify as Claude", () => {
		const backend = createClaudeStatusBackend({
			version: "some-other-tool 1.0.0",
		});
		strictEqual(
			isClaudeAuthenticated("fake-workspace", backend),
			false,
			"binary that does not output Claude in --version must not read as authenticated",
		);
	});
});
