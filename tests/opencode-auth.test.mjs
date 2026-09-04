import { ok, strictEqual } from "node:assert";
import { existsSync, rmSync } from "node:fs";

import { join } from "node:path";
import { describe, it } from "node:test";
import {
	captureDiff,
	execute as executeOpencode,
	isOpencodeAuthenticated,
} from "../src/switchyard/adapter/opencode.mjs";
import { createFakeExecutionBackend } from "./helpers/fake-execution-backend.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

describe("opencode adapter shell injection guard", () => {
	it("rejects workingContainerName with shell metacharacters", () => {
		const result = executeOpencode(
			"do something",
			"bad container; rm -rf /",
			{},
		);
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("rejects model name with shell metacharacters", () => {
		const result = executeOpencode("do something", "valid-container", {
			model: "opus; echo INJECTED",
			resolvedTargetId: "opencode-target",
			descriptorHarness: "opencode",
			invocationDescriptor: {
				target_id: "opencode-target",
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
		const result = executeOpencode("do something", "switchyard-work-1", {
			model: "opencode-model-1",
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
		const markerDir = tempDir("switchyard-prompt-injection-");
		const markerPath = join(markerDir, "marker");
		const evilPrompt = `wrap up'; touch ${markerPath}; echo '`;

		try {
			const result = executeOpencode(
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

describe("isOpencodeAuthenticated credential-validity check (fake guest)", () => {
	it("returns false when the binary is absent even with nontrivial auth.json present", () => {
		const backend = createFakeExecutionBackend({
			version: null,
			files: {
				".local/share/opencode/auth.json":
					'{"accessToken":"fake-oauth-token-value-1234567890"}',
			},
		});

		strictEqual(
			isOpencodeAuthenticated("fake-workspace", backend),
			false,
			"missing binary must not read as authenticated even with a nontrivial credential present",
		);
	});

	it("returns false when the credential is withheld/corrupt even though the binary responds", () => {
		const credPath = ".local/share/opencode/auth.json";
		const files = {};
		const backend = createFakeExecutionBackend({
			version: "Opencode stub",
			files,
		});

		strictEqual(
			isOpencodeAuthenticated("fake-workspace", backend),
			false,
			"withheld credential must not read as authenticated",
		);

		files[credPath] = "";
		strictEqual(
			isOpencodeAuthenticated("fake-workspace", backend),
			false,
			"empty credential file must not read as authenticated",
		);

		files[credPath] = "{}";
		strictEqual(
			isOpencodeAuthenticated("fake-workspace", backend),
			false,
			"trivial {} stub must not read as authenticated",
		);

		files[credPath] = '{"accessToken":"fake-oauth-token-value-1234567890"}';
		strictEqual(
			isOpencodeAuthenticated("fake-workspace", backend),
			true,
			"a non-trivial persisted credential must read as authenticated",
		);
	});
});
