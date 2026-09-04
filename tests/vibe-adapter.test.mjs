import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import {
	captureDiffAsync,
	execute,
	executeAsync,
	isVibeAuthenticated,
	renderVibeConfig,
	VIBE_ACTIVE_MODEL,
	VIBE_HOME_PATH,
	VIBE_MODELS,
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
	it("runs the keychain-backed CLI with the routed model and noninteractive implementor flags", () => {
		const requests = [];
		const executionBackend = {
			execArgv(workspaceId, candidate) {
				requests.push({ workspaceId, ...candidate });
				const servedProbe = candidate.argv.some(
					(arg) => typeof arg === "string" && arg.includes("logs/session"),
				);
				return {
					command: process.execPath,
					args: [
						"-e",
						servedProbe
							? 'process.stdout.write("mistral-medium-3.5")'
							: 'process.stdout.write("vibe-ran")',
					],
				};
			},
		};
		const result = execute(
			"change one file",
			WORKSPACE,
			options(executionBackend),
		);
		const request = requests.find((entry) => entry.argv[0] === "vibe");
		strictEqual(result.success, true);
		strictEqual(result.output, "vibe-ran");
		strictEqual(request.workspaceId, WORKSPACE);
		strictEqual(VIBE_ACTIVE_MODEL, "mistral-medium-3.5");
		deepStrictEqual(request.env, [
			`VIBE_HOME=${VIBE_HOME_PATH}`,
			"VIBE_ACTIVE_MODEL=mistral-medium-3.5",
		]);
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
		ok(result.error.startsWith("Vibe does not serve model glm-5-2"));
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
		ok(result.error.startsWith("Vibe does not serve model glm-5-2"));
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
		const spawned = [];
		const makeChild = () => {
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
			return child;
		};

		const executionBackend = {
			execArgv(_workspaceId, candidate) {
				return { command: "fake", args: [...candidate.argv] };
			},
		};

		const result = await executeAsync("change one file", WORKSPACE, {
			...options(executionBackend),
			spawnFn: (_command, args) => {
				const child = makeChild();
				spawned.push({ args, child });
				queueMicrotask(() => child.emit("close", 0, null));
				return child;
			},
		});
		resolved = true;

		strictEqual(result.success, true);
		// One config write, one provider run, one served-model probe.
		strictEqual(spawned.length, 3);
		strictEqual(spawned[1].args[0], "vibe");
		deepStrictEqual(stdinEndCalls[1], [""]);
	});

	it("writes a config that declares every routable selector so Vibe cannot substitute", () => {
		const config = renderVibeConfig("glm-5.2-low");
		ok(config.includes('active_model = "glm-5.2-low"'));
		for (const [alias, model] of Object.entries(VIBE_MODELS)) {
			ok(config.includes(`alias = ${JSON.stringify(alias)}`));
			ok(config.includes(`name = ${JSON.stringify(model.name)}`));
			ok(config.includes(`thinking = ${JSON.stringify(model.thinking)}`));
		}
		ok(!/api_key\s*=/.test(config), "the config must carry no key material");
	});

	it("fails the task when Vibe reports having run a different model", () => {
		const executionBackend = {
			execArgv(_workspaceId, candidate) {
				const servedProbe = candidate.argv.some(
					(arg) => typeof arg === "string" && arg.includes("logs/session"),
				);
				return {
					command: process.execPath,
					args: [
						"-e",
						servedProbe
							? 'process.stdout.write("mistral-medium-3.5")'
							: 'process.stdout.write("vibe-ran")',
					],
				};
			},
		};
		const descriptor = validateInvocationDescriptor(
			{
				target_id: "vibe",
				model_ref: "zhipu/glm-5.2-high",
				selector: "glm-5.2-high",
				effort: null,
				variant: null,
				invocation_args: [],
			},
			"vibe",
		);
		const result = execute("change one file", WORKSPACE, {
			...options(executionBackend),
			model: descriptor.selector,
			invocationDescriptor: descriptor,
			descriptorIdentity: descriptor.descriptor_identity,
		});
		strictEqual(result.success, false);
		strictEqual(result.servedModel, "mistral-medium-3.5");
		ok(result.error.includes("silently substituted"));
	});

	it("reports the served model on a matching run", () => {
		const executionBackend = {
			execArgv(_workspaceId, candidate) {
				const servedProbe = candidate.argv.some(
					(arg) => typeof arg === "string" && arg.includes("logs/session"),
				);
				return {
					command: process.execPath,
					args: [
						"-e",
						servedProbe
							? 'process.stdout.write("glm-5.2-low\\n")'
							: 'process.stdout.write("vibe-ran")',
					],
				};
			},
		};
		const descriptor = validateInvocationDescriptor(
			{
				target_id: "vibe",
				model_ref: "zhipu/glm-5.2-low",
				selector: "glm-5.2-low",
				effort: null,
				variant: null,
				invocation_args: [],
			},
			"vibe",
		);
		const result = execute("change one file", WORKSPACE, {
			...options(executionBackend),
			model: descriptor.selector,
			invocationDescriptor: descriptor,
			descriptorIdentity: descriptor.descriptor_identity,
		});
		strictEqual(result.success, true);
		strictEqual(result.servedModel, "glm-5.2-low");
	});
});
