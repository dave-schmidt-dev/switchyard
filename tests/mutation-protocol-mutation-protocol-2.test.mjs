import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { killOrphanedProcesses } from "../src/switchyard/adapter/orphan-kill.mjs";
import { executeProviderInvocation } from "../src/switchyard/adapter/provider-lifecycle.mjs";
import {
	createMutationIntent,
	createMutationPolicy,
	executeMutation,
	executeMutationSync,
	mutationBackoffDelay,
	validateMutationRecord,
} from "../src/switchyard/lifecycle/mutation-protocol.mjs";
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

	it("reconciles a commanded orphan sidecar before reissuing cleanup", () => {
		const storeRoot = tempDir("switchyard-orphan-");
		const previousRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = storeRoot;
		const containerName = `container-crashed-${randomUUID()}`;
		const runId = `run-crashed-${randomUUID()}`;
		const attemptId = "attempt-crashed";
		const resource = `container-${createHash("sha256")
			.update(`${runId}:${attemptId}:${containerName}`, "utf8")
			.digest("hex")
			.slice(0, 32)}`;
		const intent = createMutationIntent({
			operation: "orphan_termination",
			resource,
			policy: { maxAttempts: 1, idempotency: "conditional", reconcile: true },
		});
		const commanded = { ...intent, state: "commanded", attempt: 1 };
		const sidecarDirectory = join(
			storeRoot,
			"runs",
			runId,
			"mutations",
			"orphan-termination",
		);
		mkdirSync(sidecarDirectory, { recursive: true });
		writeFileSync(
			join(sidecarDirectory, `${intent.operationId}.json`),
			JSON.stringify(commanded),
		);
		let backendCalls = 0;
		let reconcileCalls = 0;
		try {
			const result = killOrphanedProcesses(containerName, {
				cleanupContext: { runId, attemptId },
				executionBackend: {
					cleanupProviderProcess() {
						backendCalls += 1;
					},
				},
				command: "sensitive-provider-command",
				args: ["secret-argument-must-not-persist"],
				reconcile: () => {
					reconcileCalls += 1;
					return { status: "confirmed", ownership: "confirmed" };
				},
			});
			strictEqual(result.cleanupFailed, false);
			strictEqual(reconcileCalls, 1);
			strictEqual(backendCalls, 0);
			const persisted = readFileSync(
				join(sidecarDirectory, `${intent.operationId}.json`),
				"utf8",
			);
			strictEqual(persisted.includes("sensitive-provider-command"), false);
			strictEqual(
				persisted.includes("secret-argument-must-not-persist"),
				false,
			);
		} finally {
			if (previousRoot === undefined)
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRoot;
			rmSync(storeRoot, { recursive: true, force: true });
		}
	});

	it("replays an ambiguous orphan crash without retrying cleanup", () => {
		const storeRoot = tempDir("switchyard-orphan-");
		const previousRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = storeRoot;
		const containerName = `container-crash-${randomUUID()}`;
		const cleanupContext = {
			runId: `run-crash-${randomUUID()}`,
			attemptId: "attempt-crash",
		};
		let backendCalls = 0;
		try {
			const failed = killOrphanedProcesses(containerName, {
				cleanupContext,
				executionBackend: {
					cleanupProviderProcess() {
						backendCalls += 1;
						throw new Error("cleanup response lost");
					},
				},
			});
			strictEqual(failed.cleanupFailed, true);
			const replay = killOrphanedProcesses(containerName, {
				cleanupContext,
				executionBackend: {
					cleanupProviderProcess() {
						backendCalls += 1;
					},
				},
			});
			strictEqual(replay.cleanupFailed, true);
			strictEqual(backendCalls, 1);
		} finally {
			if (previousRoot === undefined)
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRoot;
			rmSync(storeRoot, { recursive: true, force: true });
		}
	});

	it("fails closed when a valid sidecar record does not match its filename", () => {
		const storeRoot = tempDir("switchyard-orphan-");
		const previousRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = storeRoot;
		const containerName = `container-mismatch-${randomUUID()}`;
		const cleanupContext = {
			runId: `run-mismatch-${randomUUID()}`,
			attemptId: "attempt-mismatch",
		};
		const resource = `container-${createHash("sha256")
			.update(
				`${cleanupContext.runId}:${cleanupContext.attemptId}:${containerName}`,
				"utf8",
			)
			.digest("hex")
			.slice(0, 32)}`;
		const expected = createMutationIntent({
			operation: "orphan_termination",
			resource,
			policy: { maxAttempts: 1, idempotency: "conditional", reconcile: true },
		});
		const mismatched = createMutationIntent({
			operation: "orphan_termination",
			resource: "container-other-resource",
			policy: { maxAttempts: 1, idempotency: "conditional", reconcile: true },
		});
		const sidecarDirectory = join(
			storeRoot,
			"runs",
			cleanupContext.runId,
			"mutations",
			"orphan-termination",
		);
		mkdirSync(sidecarDirectory, { recursive: true });
		writeFileSync(
			join(sidecarDirectory, `${expected.operationId}.json`),
			JSON.stringify({ ...mismatched, state: "commanded", attempt: 1 }),
		);
		let backendCalls = 0;
		try {
			const result = killOrphanedProcesses(containerName, {
				cleanupContext,
				executionBackend: {
					cleanupProviderProcess() {
						backendCalls += 1;
					},
				},
			});
			strictEqual(result.cleanupFailed, true);
			strictEqual(backendCalls, 0);
		} finally {
			if (previousRoot === undefined)
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRoot;
			rmSync(storeRoot, { recursive: true, force: true });
		}
	});

	it("bounds unresolved orphan sidecars and blocks mutation at capacity", () => {
		const storeRoot = tempDir("switchyard-orphan-");
		const previousRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = storeRoot;
		const runId = `run-overflow-${randomUUID()}`;
		const sidecarDirectory = join(
			storeRoot,
			"runs",
			runId,
			"mutations",
			"orphan-termination",
		);
		mkdirSync(sidecarDirectory, { recursive: true });
		for (let index = 0; index < 64; index += 1) {
			const record = createMutationIntent({
				operation: "orphan_termination",
				resource: `container-overflow-${index}`,
				operationId: `overflow-${index}`,
				policy: { maxAttempts: 1, idempotency: "conditional", reconcile: true },
			});
			writeFileSync(
				join(sidecarDirectory, `${record.operationId}.json`),
				JSON.stringify({
					...record,
					state: "uncertain",
					outcome: "ambiguous",
					attempt: 1,
				}),
			);
		}
		let backendCalls = 0;
		const containerName = `container-overflow-new-${randomUUID()}`;
		try {
			const result = killOrphanedProcesses(containerName, {
				cleanupContext: { runId, attemptId: "attempt-overflow" },
				executionBackend: {
					cleanupProviderProcess() {
						backendCalls += 1;
					},
				},
			});
			strictEqual(result.cleanupFailed, true);
			strictEqual(backendCalls, 0);
			strictEqual(
				readdirSync(sidecarDirectory).filter((name) => name.endsWith(".json"))
					.length,
				64,
			);
		} finally {
			if (previousRoot === undefined)
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRoot;
			rmSync(storeRoot, { recursive: true, force: true });
		}
	});

	it("reclaims completed sidecars before admitting a bounded replacement", () => {
		const storeRoot = tempDir("switchyard-orphan-");
		const previousRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = storeRoot;
		const runId = `run-complete-${randomUUID()}`;
		const sidecarDirectory = join(
			storeRoot,
			"runs",
			runId,
			"mutations",
			"orphan-termination",
		);
		mkdirSync(sidecarDirectory, { recursive: true });
		for (let index = 0; index < 64; index += 1) {
			const record = createMutationIntent({
				operation: "orphan_termination",
				resource: `container-complete-${index}`,
				operationId: `complete-${index}`,
				policy: { maxAttempts: 1, idempotency: "conditional", reconcile: true },
			});
			writeFileSync(
				join(sidecarDirectory, `${record.operationId}.json`),
				JSON.stringify({
					...record,
					state: "completed",
					outcome: "confirmed",
					attempt: 1,
				}),
			);
		}
		let backendCalls = 0;
		try {
			const result = killOrphanedProcesses(
				`container-reclaim-${randomUUID()}`,
				{
					cleanupContext: { runId, attemptId: "attempt-reclaim" },
					executionBackend: {
						cleanupProviderProcess() {
							backendCalls += 1;
						},
					},
				},
			);
			strictEqual(result.cleanupFailed, false);
			strictEqual(backendCalls, 1);
			strictEqual(
				readdirSync(sidecarDirectory).filter((name) => name.endsWith(".json"))
					.length,
				64,
			);
		} finally {
			if (previousRoot === undefined)
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRoot;
			rmSync(storeRoot, { recursive: true, force: true });
		}
	});
});
