// @test-phase: other
import { ok, strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";
import { executeProviderInvocation } from "../src/switchyard/adapter/provider-lifecycle.mjs";
import { initializeRun, readRun } from "../src/switchyard/run-store/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

describe("mutation protocol", () => {
	it("routes default provider cleanup through mutation progress", async () => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = { end() {} };
		child.kill = (signal) => {
			if (signal === "SIGKILL")
				queueMicrotask(() => child.emit("close", null, signal));
		};
		const events = [];
		let backendCalls = 0;
		const result = await executeProviderInvocation("fake", [], {
			spawnFn: () => child,
			timeoutMs: 1,
			termGraceMs: 1,
			executionBackend: {
				cleanupProviderProcess() {
					backendCalls += 1;
				},
			},
			cleanupContext: { attemptId: "attempt-default" },
			onStatus: (event) => events.push(event.event),
		});
		strictEqual(result.timedOut, true);
		strictEqual(result.cleanupFailed, false);
		strictEqual(backendCalls, 1);
		ok(events.includes("mutation_intent_durable"));
		ok(events.includes("mutation_completed"));
	});

	it("persists and replays default provider cleanup by operation id", async () => {
		const storeRoot = tempDir("switchyard-mutation-");
		const previousRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = storeRoot;
		const runId = "provider-cleanup-replay";
		try {
			await initializeRun({
				runId,
				tasksFilePath: "/tmp/tasks.md",
				projectPath: "/tmp/project",
				orderedTaskIds: [],
				initialHostFingerprint: "test-host",
			});
			const makeChild = () => {
				const child = new EventEmitter();
				child.stdout = new EventEmitter();
				child.stderr = new EventEmitter();
				child.stdin = { end() {} };
				child.kill = (signal) => {
					if (signal === "SIGKILL")
						queueMicrotask(() => child.emit("close", null, signal));
				};
				return child;
			};
			let backendCalls = 0;
			const invoke = () =>
				executeProviderInvocation("fake", [], {
					spawnFn: () => makeChild(),
					timeoutMs: 1,
					termGraceMs: 1,
					executionBackend: {
						cleanupProviderProcess() {
							backendCalls += 1;
						},
					},
					cleanupContext: { runId, attemptId: "attempt-replay" },
				});

			const first = await invoke();
			strictEqual(first.cleanupFailed, false);
			const run = await readRun(runId);
			strictEqual(run.mutationOperations.length, 1);
			strictEqual(run.mutationOperations[0].state, "completed");
			strictEqual(await invoke().then((value) => value.cleanupFailed), false);
			strictEqual(backendCalls, 1);
		} finally {
			if (previousRoot === undefined)
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRoot;
			rmSync(storeRoot, { recursive: true, force: true });
		}
	});
});
