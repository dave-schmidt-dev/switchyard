import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import {
	captureDiffAsync,
	execute,
	isVibeAuthenticated,
} from "../src/switchyard/adapter/vibe.mjs";
import { validateInvocationDescriptor } from "../src/switchyard/roster/index.mjs";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const DESCRIPTOR = validateInvocationDescriptor(
	{
		target_id: "vibe",
		model_ref: "mistral/zai-glm-5-2",
		selector: "glm-5.2",
		effort: null,
		variant: null,
		invocation_args: [],
	},
	"vibe",
);

function options(executionBackend) {
	return {
		model: DESCRIPTOR.selector,
		resolvedTargetId: DESCRIPTOR.target_id,
		descriptorHarness: "vibe",
		invocationDescriptor: DESCRIPTOR,
		descriptorIdentity: DESCRIPTOR.descriptor_identity,
		executionBackend,
	};
}

describe("Vibe adapter", () => {
	it("runs the OAuth-backed CLI with a fixed model and noninteractive implementor flags", () => {
		let request;
		const executionBackend = {
			execArgv(workspaceId, candidate) {
				request = { workspaceId, ...candidate };
				return {
					command: process.execPath,
					args: ["-e", 'process.stdout.write("vibe-ran")'],
				};
			},
		};
		const result = execute(
			"change one file",
			WORKSPACE,
			options(executionBackend),
		);
		strictEqual(result.success, true);
		strictEqual(result.output, "vibe-ran");
		strictEqual(request.workspaceId, WORKSPACE);
		deepStrictEqual(request.env, ["VIBE_ACTIVE_MODEL=glm-5.2"]);
		deepStrictEqual(request.argv.slice(0, 2), ["vibe", "-p"]);
		ok(request.argv[2].includes("change one file"));
		deepStrictEqual(request.argv.slice(-6), [
			"--auto-approve",
			"--output",
			"streaming",
			"--trust",
			"--max-turns",
			"12",
		]);
		ok(request.argv.includes("--auto-approve"));
		ok(request.argv.includes("--trust"));
	});

	it("requires both the CLI and its Vibe Keychain credential", () => {
		const calls = [];
		const executionBackend = {
			execGuest(_workspaceId, command, args) {
				calls.push([command, args]);
				return Buffer.from("ok");
			},
		};
		strictEqual(isVibeAuthenticated(WORKSPACE, executionBackend), true);
		deepStrictEqual(calls[1], [
			"/usr/bin/security",
			[
				"find-generic-password",
				"-s",
				"ai.mistral.vibe",
				"-a",
				"MISTRAL_API_KEY",
			],
		]);
	});

	it("fails closed when the Keychain item is absent", () => {
		let count = 0;
		const executionBackend = {
			execGuest() {
				count += 1;
				if (count === 2) throw new Error("not found");
				return Buffer.from("vibe 2.24.5");
			},
		};
		strictEqual(isVibeAuthenticated(WORKSPACE, executionBackend), false);
	});

	it("rejects unsafe workspace identifiers before diff capture", async () => {
		strictEqual(await captureDiffAsync("unsafe;workspace", {}), null);
	});
});
