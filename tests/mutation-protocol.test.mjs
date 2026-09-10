import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

describe("mutation protocol", () => {
	it("creates stable intent identities and rejects unbounded policies", () => {
		const first = createMutationIntent({
			operation: "lock_release",
			resource: "run-1",
		});
		const second = createMutationIntent({
			operation: "lock_release",
			resource: "run-1",
		});
		strictEqual(first.operationId, second.operationId);
		strictEqual(first.state, "intent");
		ok(validateMutationRecord(first));
		strictEqual(
			mutationBackoffDelay(
				1,
				createMutationPolicy({ backoffBaseMs: 10, backoffMaxMs: 30 }),
			),
			10,
		);
		strictEqual(
			mutationBackoffDelay(
				3,
				createMutationPolicy({ backoffBaseMs: 10, backoffMaxMs: 30 }),
			),
			30,
		);
		for (const value of [0, 4]) {
			try {
				createMutationPolicy({ maxAttempts: value });
				ok(false);
			} catch {
				ok(true);
			}
		}
	});

	it("requires an observed postcondition and preserves the operation id", async () => {
		const states = [];
		let commandCalls = 0;
		const result = await executeMutation({
			operation: "lock_release",
			resource: "project-a",
			command: async ({ operationId, attempt }) => {
				commandCalls += 1;
				strictEqual(typeof operationId, "string");
				strictEqual(attempt, 1);
				return { acknowledged: true };
			},
			observe: async (value) => ({
				status: value.acknowledged ? "confirmed" : "ambiguous",
				ownership: "confirmed",
			}),
			persist: async (state) =>
				states.push({ state: state.state, operationId: state.operationId }),
		});
		strictEqual(result.state, "completed");
		strictEqual(result.outcome, "confirmed");
		strictEqual(commandCalls, 1);
		strictEqual(states.at(-1).state, "completed");
		strictEqual(states.at(-1).operationId, result.operationId);
	});

	it("does not retry ambiguous ownership and records explicit uncertainty", async () => {
		let commandCalls = 0;
		const events = [];
		const result = await executeMutation({
			operation: "lock_release",
			resource: "project-a",
			policy: { maxAttempts: 3 },
			command: async () => {
				commandCalls += 1;
				throw new Error("lost response");
			},
			observe: async () => ({ status: "ambiguous", ownership: "unknown" }),
			onStatus: (event) => events.push(event.event),
		});
		strictEqual(result.state, "uncertain");
		strictEqual(result.outcome, "ambiguous");
		strictEqual(commandCalls, 1);
		ok(events.includes("mutation_postcondition_uncertain"));
		ok(events.includes("mutation_uncertain"));
	});

	it("does not retry a mutation whose adapter cannot prove idempotency", async () => {
		let commandCalls = 0;
		const result = await executeMutation({
			operation: "provider_cleanup",
			resource: "attempt-unknown-idempotency",
			policy: { maxAttempts: 3, idempotency: "unknown" },
			command: async () => {
				commandCalls += 1;
				throw new Error("transient");
			},
			observe: async () => ({ status: "failed", ownership: "confirmed" }),
		});
		strictEqual(commandCalls, 1);
		strictEqual(result.state, "failed");
	});

	it("replays a durable completion without executing the command", async () => {
		const intent = createMutationIntent({
			operation: "provider_cleanup",
			resource: "attempt-1",
		});
		const complete = {
			...intent,
			state: "completed",
			outcome: "confirmed",
			attempt: 1,
		};
		let called = false;
		const result = await executeMutation({
			resume: complete,
			command: async () => {
				called = true;
			},
			observe: async () => ({ status: "confirmed", ownership: "confirmed" }),
		});
		deepStrictEqual(result, complete);
		strictEqual(called, false);
	});

	it("reconciles a commanded resume before issuing another command", async () => {
		const intent = createMutationIntent({
			operation: "provider_cleanup",
			resource: "attempt-reconcile",
		});
		const commanded = { ...intent, state: "commanded", attempt: 1 };
		let commandCalls = 0;
		let reconcileCalls = 0;
		const result = await executeMutation({
			resume: commanded,
			policy: { maxAttempts: 3, reconcile: true },
			command: async () => {
				commandCalls += 1;
				return { shouldNotRun: true };
			},
			observe: async () => {
				throw new Error(
					"normal observation must not run during reconciliation",
				);
			},
			reconcile: async (context) => {
				reconcileCalls += 1;
				strictEqual(context.resumed, true);
				return { status: "confirmed", ownership: "confirmed" };
			},
		});
		strictEqual(commandCalls, 0);
		strictEqual(reconcileCalls, 1);
		strictEqual(result.state, "completed");
		strictEqual(result.reconciled, true);
	});

	it("stops a resumed mutation when reconciliation is ambiguous", async () => {
		const intent = createMutationIntent({
			operation: "orphan_termination",
			resource: "container-reconcile",
		});
		const commanded = { ...intent, state: "commanded", attempt: 1 };
		let commandCalls = 0;
		const result = await executeMutation({
			resume: commanded,
			policy: { maxAttempts: 3, reconcile: true },
			command: async () => {
				commandCalls += 1;
			},
			observe: async () => ({ status: "confirmed", ownership: "confirmed" }),
			reconcile: async () => ({ status: "ambiguous", ownership: "unknown" }),
		});
		strictEqual(commandCalls, 0);
		strictEqual(result.state, "uncertain");
		strictEqual(result.outcome, "ambiguous");
		strictEqual(result.reconciled, true);
	});

	it("fails closed for a resumed record when reconciliation is disabled", async () => {
		const intent = createMutationIntent({
			operation: "lock_release",
			resource: "project-no-reconcile",
		});
		const commanded = { ...intent, state: "commanded", attempt: 1 };
		let commandCalls = 0;
		const result = await executeMutation({
			resume: commanded,
			policy: { reconcile: false },
			command: async () => {
				commandCalls += 1;
			},
			observe: async () => ({ status: "confirmed", ownership: "confirmed" }),
		});
		strictEqual(commandCalls, 0);
		strictEqual(result.state, "uncertain");
		strictEqual(result.outcome, "ambiguous");
	});

	it("keeps command and observation within independent bounds", async () => {
		const started = Date.now();
		const result = await executeMutation({
			operation: "orphan_termination",
			resource: "container-a",
			policy: {
				maxAttempts: 1,
				commandTimeoutMs: 10,
				observationTimeoutMs: 10,
			},
			command: () => new Promise(() => {}),
			observe: () => new Promise(() => {}),
		});
		ok(Date.now() - started < 150, "bounded calls must not hang the protocol");
		strictEqual(result.state, "uncertain");
	});

	it("durably completes the synchronous adapter path", () => {
		const records = [];
		const result = executeMutationSync({
			operation: "orphan_termination",
			resource: "container-sync",
			command: () => ({ acknowledged: true }),
			observe: (value) =>
				value?.acknowledged
					? { status: "confirmed", ownership: "confirmed" }
					: { status: "ambiguous", ownership: "unknown" },
			persist: (record) => records.push(record),
		});
		strictEqual(result.state, "completed");
		strictEqual(records.at(-1).state, "completed");
		strictEqual(records.at(-1).operationId, result.operationId);
		strictEqual(Object.hasOwn(records.at(-1), "commandResult"), false);
	});

	it("binds synchronous resume to operation identity before replay", () => {
		const requested = createMutationIntent({
			operation: "provider_cleanup",
			resource: "attempt-requested",
		});
		const mismatched = {
			...createMutationIntent({
				operation: "provider_cleanup",
				resource: requested.resource,
				operationId: "operation-other",
			}),
			state: "completed",
			outcome: "confirmed",
			attempt: 1,
		};
		let commandCalls = 0;
		throws(
			() =>
				executeMutationSync({
					operation: requested.operation,
					resource: requested.resource,
					operationId: requested.operationId,
					resume: mismatched,
					command: () => {
						commandCalls += 1;
					},
					observe: () => ({ status: "confirmed", ownership: "confirmed" }),
				}),
			(error) => error?.code === "mutation_identity_mismatch",
		);
		strictEqual(commandCalls, 0);
	});

	it("routes orphan termination through the same durable protocol", async () => {
		const events = [];
		const result = await killOrphanedProcesses("unsafe;name", {
			executionBackend: { cleanupProviderProcess() {} },
			command: "prlctl",
			args: ["exec", "guest"],
			mutationProtocol: {
				operationId: "operation-orphan-termination",
				resource: "container-unsafe",
				policy: {
					maxAttempts: 1,
					commandTimeoutMs: 100,
					observationTimeoutMs: 100,
				},
				persist: async (record) => events.push(record.state),
			},
		});
		strictEqual(result.state, "completed");
		strictEqual(result.operationId, "operation-orphan-termination");
		ok(events.includes("intent"));
		ok(events.includes("completed"));
	});

	it("routes the default orphan adapter path through mutation progress", () => {
		const storeRoot = mkdtempSync(join(tmpdir(), "switchyard-orphan-"));
		const previousRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = storeRoot;
		const events = [];
		let backendCalls = 0;
		try {
			const result = killOrphanedProcesses(
				`container-default-${randomUUID()}`,
				{
					cleanupContext: {
						runId: `run-default-${randomUUID()}`,
						attemptId: "attempt-default-orphan",
					},
					executionBackend: {
						cleanupProviderProcess() {
							backendCalls += 1;
						},
					},
					onStatus: (event) => events.push(event.event),
				},
			);
			strictEqual(backendCalls, 1);
			strictEqual(result.cleanupFailed, false);
			ok(events.includes("mutation_intent_durable"));
			ok(events.includes("mutation_completed"));
		} finally {
			if (previousRoot === undefined)
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRoot;
			rmSync(storeRoot, { recursive: true, force: true });
		}
	});

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
		const storeRoot = mkdtempSync(join(tmpdir(), "switchyard-mutation-"));
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
		const storeRoot = mkdtempSync(join(tmpdir(), "switchyard-orphan-"));
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
		const storeRoot = mkdtempSync(join(tmpdir(), "switchyard-orphan-"));
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
		const storeRoot = mkdtempSync(join(tmpdir(), "switchyard-orphan-"));
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
		const storeRoot = mkdtempSync(join(tmpdir(), "switchyard-orphan-"));
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
		const storeRoot = mkdtempSync(join(tmpdir(), "switchyard-orphan-"));
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

	it("binds scoped orphan completion to the retained attempt identity", () => {
		const storeRoot = mkdtempSync(join(tmpdir(), "switchyard-orphan-"));
		const previousRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = storeRoot;
		const containerName = `container-scoped-${randomUUID()}`;
		const runId = `run-scoped-${randomUUID()}`;
		let backendCalls = 0;
		const cleanup = (attemptId) =>
			killOrphanedProcesses(containerName, {
				cleanupContext: { runId, attemptId },
				executionBackend: {
					cleanupProviderProcess() {
						backendCalls += 1;
					},
				},
			});
		try {
			strictEqual(cleanup("attempt-one").cleanupFailed, false);
			strictEqual(cleanup("attempt-one").cleanupFailed, false);
			strictEqual(cleanup("attempt-two").cleanupFailed, false);
			strictEqual(backendCalls, 2);
			strictEqual(
				readdirSync(
					join(storeRoot, "runs", runId, "mutations", "orphan-termination"),
				).filter((name) => name.endsWith(".json")).length,
				2,
			);
		} finally {
			if (previousRoot === undefined)
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRoot;
			rmSync(storeRoot, { recursive: true, force: true });
		}
	});

	it("reconciles a crashed scoped attempt without reissuing cleanup", () => {
		const storeRoot = mkdtempSync(join(tmpdir(), "switchyard-orphan-"));
		const previousRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = storeRoot;
		const containerName = `container-scoped-crash-${randomUUID()}`;
		const runId = `run-scoped-crash-${randomUUID()}`;
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
			JSON.stringify({ ...intent, state: "commanded", attempt: 1 }),
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
				reconcile: () => {
					reconcileCalls += 1;
					return { status: "confirmed", ownership: "confirmed" };
				},
			});
			strictEqual(result.cleanupFailed, false);
			strictEqual(reconcileCalls, 1);
			strictEqual(backendCalls, 0);
		} finally {
			if (previousRoot === undefined)
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRoot;
			rmSync(storeRoot, { recursive: true, force: true });
		}
	});

	it("keeps unrelated run-scoped cleanup available when legacy sidecars are full", () => {
		const storeRoot = mkdtempSync(join(tmpdir(), "switchyard-orphan-"));
		const previousRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = storeRoot;
		const globalDirectory = join(storeRoot, "mutations", "orphan-termination");
		mkdirSync(globalDirectory, { recursive: true });
		for (let index = 0; index < 64; index += 1) {
			const record = createMutationIntent({
				operation: "orphan_termination",
				resource: `container-global-${index}`,
				operationId: `global-${index}`,
				policy: { maxAttempts: 1, idempotency: "conditional", reconcile: true },
			});
			writeFileSync(
				join(globalDirectory, `${record.operationId}.json`),
				JSON.stringify({
					...record,
					state: "uncertain",
					outcome: "ambiguous",
					attempt: 1,
				}),
			);
		}
		let backendCalls = 0;
		try {
			const result = killOrphanedProcesses(
				`container-scoped-new-${randomUUID()}`,
				{
					cleanupContext: {
						runId: `run-independent-${randomUUID()}`,
						attemptId: "attempt-independent",
					},
					executionBackend: {
						cleanupProviderProcess() {
							backendCalls += 1;
						},
					},
				},
			);
			strictEqual(result.cleanupFailed, false);
			strictEqual(backendCalls, 1);
		} finally {
			if (previousRoot === undefined)
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRoot;
			rmSync(storeRoot, { recursive: true, force: true });
		}
	});

	it("keeps no-context compatibility cleanup independent of sidecars", () => {
		const storeRoot = mkdtempSync(join(tmpdir(), "switchyard-orphan-"));
		const previousRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = storeRoot;
		const globalDirectory = join(storeRoot, "mutations", "orphan-termination");
		mkdirSync(globalDirectory, { recursive: true });
		for (let index = 0; index < 64; index += 1)
			writeFileSync(join(globalDirectory, `legacy-${index}.json`), "malformed");
		let backendCalls = 0;
		try {
			const result = killOrphanedProcesses(`container-legacy-${randomUUID()}`, {
				executionBackend: {
					cleanupProviderProcess() {
						backendCalls += 1;
					},
				},
			});
			strictEqual(result.cleanupFailed, false);
			strictEqual(backendCalls, 1);
			strictEqual(readdirSync(globalDirectory).length, 64);
		} finally {
			if (previousRoot === undefined)
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRoot;
			rmSync(storeRoot, { recursive: true, force: true });
		}
	});

	it("forwards cleanup identity at every synchronous production adapter call site", () => {
		for (const adapter of [
			"agy",
			"claude",
			"codex",
			"copilot",
			"cursor",
			"opencode",
			"vibe",
		]) {
			const source = readFileSync(
				new URL(`../src/switchyard/adapter/${adapter}.mjs`, import.meta.url),
				"utf8",
			);
			ok(
				source.includes("cleanupContext: options.cleanupContext"),
				`${adapter} must forward cleanupContext`,
			);
		}
	});
});
