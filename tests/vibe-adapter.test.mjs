import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import {
	captureDiffAsync,
	execute,
	executeAsync,
	isVibeAuthenticated,
	VIBE_ACTIVE_MODEL,
} from "../src/switchyard/adapter/vibe.mjs";
import { validateInvocationDescriptor } from "../src/switchyard/roster/index.mjs";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const DESCRIPTOR = validateInvocationDescriptor(
	{
		target_id: "vibe",
		model_ref: "mistral/mistral-medium-3.5",
		selector: "mistral-medium-3.5",
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
		strictEqual(VIBE_ACTIVE_MODEL, "mistral-medium-3.5");
		deepStrictEqual(request.env, ["VIBE_ACTIVE_MODEL=mistral-medium-3.5"]);
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

	it("rejects a descriptor with a non-active selector before provider execution", () => {
		let execArgvCalled = false;
		const inactiveDescriptor = validateInvocationDescriptor(
			{
				target_id: "vibe",
				model_ref: "mistral/mistral-medium-3.5",
				selector: "glm-5-2",
				effort: null,
				variant: null,
				invocation_args: [],
			},
			"vibe",
		);
		const executionBackend = {
			execArgv() {
				execArgvCalled = true;
				throw new Error("must not run");
			},
		};
		const result = execute("change one file", WORKSPACE, {
			...options(executionBackend),
			model: inactiveDescriptor.selector,
			invocationDescriptor: inactiveDescriptor,
			descriptorIdentity: inactiveDescriptor.descriptor_identity,
		});
		strictEqual(result.success, false);
		strictEqual(execArgvCalled, false);
		strictEqual(result.error, `Vibe requires model ${VIBE_ACTIVE_MODEL}`);
	});

	it("rejects an async descriptor with a non-active selector before provider execution", async () => {
		let execArgvCalled = false;
		const executionBackend = {
			execArgv() {
				execArgvCalled = true;
				throw new Error("must not run");
			},
		};
		const result = await executeAsync("change one file", WORKSPACE, {
			...options(executionBackend),
			model: "glm-5-2",
		});
		strictEqual(result.success, false);
		strictEqual(execArgvCalled, false);
		strictEqual(result.error, `Vibe requires model ${VIBE_ACTIVE_MODEL}`);
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

	it("supplies an empty stdin payload so the process does not stall on stdin", async () => {
		const stdinEndCalls = [];
		let resolved = false;
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = {
			end(...args) {
				strictEqual(
					resolved,
					false,
					"stdin.end must be called before the run resolves",
				);
				stdinEndCalls.push(args);
			},
		};
		child.signals = [];
		child.kill = (signal) => {
			child.signals.push(signal);
			if (signal === "SIGKILL")
				queueMicrotask(() => child.emit("close", null, signal));
			return true;
		};

		const executionBackend = {
			execArgv() {
				return { command: "fake", args: [] };
			},
		};

		const result = await executeAsync("change one file", WORKSPACE, {
			...options(executionBackend),
			spawnFn: () => {
				queueMicrotask(() => child.emit("close", 0, null));
				return child;
			},
		});
		resolved = true;

		strictEqual(result.success, true);
		strictEqual(stdinEndCalls.length, 1);
		deepStrictEqual(stdinEndCalls[0], [""]);
	});
});
