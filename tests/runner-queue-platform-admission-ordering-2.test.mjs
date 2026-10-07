import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	CHECKPOINT_IDENTITY_CODES,
	CheckpointIdentityError,
	QueueCleanupError,
	runQueueAsync as runQueueAsyncImpl,
} from "../src/switchyard/runner/index.mjs";
import {
	runnerTestDir,
	withExplicitSwitchyardExecutor,
} from "./helpers/async-runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
const UNVERIFIED_PROVIDER = "unverified-provider-fixture";
function writeTasksFile(content) {
	mkdirSync(TEST_DIR, { recursive: true });
	const tasksPath = join(TEST_DIR, "tasks.md");
	writeFileSync(tasksPath, withExplicitSwitchyardExecutor(content), "utf8");
	return tasksPath;
}
// Stub macOS queue backend for the async admission suites, kept inline so this
// file depends only on async-runner-fixtures.mjs.
function macosBackend(
	events,
	{ failCreate = false, failDestroy = false } = {},
) {
	return {
		platform: "macos",
		preflight: () => events.push("preflight"),
		readiness: () => {
			events.push("readiness");
			return { inventoryCount: 0 };
		},
		acquireSlot: () => {
			events.push("acquire");
			return { token: "test-slot" };
		},
		releaseSlot: () => events.push("release"),
		ensureAgentContainer: () => events.push("ensure"),
		create: () => {
			events.push("create");
			if (failCreate) throw new Error("create failed");
			return "test-vm";
		},
		provision: () => events.push("provision"),
		seed: () => events.push("seed"),
		commit: () => {},
		reset: () => {},
		destroy: () => {
			events.push("destroy");
			if (failDestroy) {
				throw new Error("SECRET_CANARY synthetic backend teardown failure");
			}
		},
	};
}
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("queue platform admission ordering (Tasks 6.1-6.2)", () => {
	function writeTerminalQueue() {
		return writeTasksFile(`## Phase 1

### Task 1.1: Already complete
- **Status:** done
- **Type:** review
- **Description:** no provider work
- **Executor:** switchyard
`);
	}
	it("does not retry unrelated VM-admission failures", async () => {
		const events = [];
		const statuses = [];
		const tasksPath = writeTerminalQueue();
		const backend = macosBackend(events);
		const storageFailure = new Error("admission storage failed");
		let attempts = 0;
		backend.acquireSlot = () => {
			events.push("acquire");
			attempts += 1;
			throw storageFailure;
		};

		await rejects(
			runQueueAsyncImpl({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				platform: "macos",
				checkpointPath: `${tasksPath}.wait-unrelated.checkpoint.json`,
				dependencies: {
					backendFactory: () => backend,
					onStatus: (event) => statuses.push(event),
					vmSlotWaitTimeoutMs: 100,
					vmSlotWaitIntervalMs: 10,
					sleepFn: async () => {},
				},
			}),
			(error) => error === storageFailure,
		);
		strictEqual(attempts, 1);
		strictEqual(
			statuses.some((event) => event.event === "vm_slot_wait"),
			false,
		);
		strictEqual(events.includes("create"), false);
	});
	it("awaits cleanup-state persistence before destroying an owned workspace", async () => {
		const events = [];
		let releaseCleanup;
		let signalCleanupEntered;
		const cleanupGate = new Promise((resolve) => {
			releaseCleanup = resolve;
		});
		const cleanupEntered = new Promise((resolve) => {
			signalCleanupEntered = resolve;
		});
		const tasksPath = writeTerminalQueue();
		const queuePromise = runQueueAsyncImpl({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			platform: "macos",
			checkpointPath: `${tasksPath}.cleanup-order.checkpoint.json`,
			dependencies: {
				backendFactory: () => macosBackend(events),
				onCleanupStarted: async () => {
					events.push("cleanup-started");
					signalCleanupEntered();
					await cleanupGate;
					events.push("cleanup-resolved");
				},
			},
		});
		await cleanupEntered;
		strictEqual(events.at(-1), "cleanup-started");
		strictEqual(events.includes("destroy"), false);
		releaseCleanup();
		await queuePromise;
		ok(events.indexOf("cleanup-resolved") < events.indexOf("destroy"));
	});
	it("destroys the workspace and releases the slot when cleanup-state persistence rejects", async () => {
		const events = [];
		const tasksPath = writeTerminalQueue();
		await runQueueAsyncImpl({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			platform: "macos",
			checkpointPath: `${tasksPath}.cleanup-rejection.checkpoint.json`,
			dependencies: {
				backendFactory: () => macosBackend(events),
				onCleanupStarted: async () => {
					throw new Error("synthetic cleanup persistence failure");
				},
			},
		});
		ok(events.indexOf("destroy") >= 0);
		ok(events.indexOf("release") > events.indexOf("destroy"));
	});
	it("rejects with closed recovery evidence when async backend teardown fails", async () => {
		const events = [];
		const statuses = [];
		const tasksPath = writeTerminalQueue();
		await rejects(
			runQueueAsyncImpl({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				platform: "macos",
				checkpointPath: `${tasksPath}.cleanup-failure.checkpoint.json`,
				dependencies: {
					backendFactory: () => macosBackend(events, { failDestroy: true }),
					onStatus: (event) => statuses.push(event),
				},
			}),
			(error) => {
				strictEqual(error.name, "QueueCleanupError");
				strictEqual(error.code, "recovery_incomplete");
				deepStrictEqual(error.failure, {
					errorKind: "unknown_failure",
					reasonCode: "unknown_failure",
					reason: "The task failed for an unclassified reason.",
					diagnosticCode: "recovery_incomplete",
					failurePhase: "terminal_reconciliation",
				});
				strictEqual(error.terminalSummary.failedCount, 0);
				strictEqual(JSON.stringify(error).includes("SECRET_CANARY"), false);
				return true;
			},
		);
		ok(events.indexOf("release") > events.indexOf("destroy"));
		const cleanupFailed = statuses.find(
			(event) => event.event === "cleanup_failed",
		);
		ok(cleanupFailed, "cleanup_failed progress is preserved");
		strictEqual(cleanupFailed.status, "Cleanup failed; recovery required");
		strictEqual(JSON.stringify(cleanupFailed).includes("SECRET_CANARY"), false);
	});
	it("carries a displaced closed failure code onto the cleanup error", () => {
		const displaced = new CheckpointIdentityError(
			CHECKPOINT_IDENTITY_CODES.QUEUE_IDENTITY_MISMATCH,
		);
		const error = new QueueCleanupError(null, displaced);
		// Cleanup still wins: the code and the recovery reason are unchanged, so
		// the caller disposition still reads recovery-required. Only the reported
		// cause sharpens, from "something failed" to the contract that broke.
		strictEqual(error.code, "recovery_incomplete");
		deepStrictEqual(error.failure, {
			errorKind: "unknown_failure",
			reasonCode: "unknown_failure",
			reason: "The task failed for an unclassified reason.",
			diagnosticCode: "checkpoint_queue_identity_mismatch",
			failurePhase: "terminal_reconciliation",
		});
		strictEqual(JSON.stringify(error).includes(displaced.message), false);
	});
	it("refuses a displaced code that is outside the persisted vocabulary", () => {
		const displaced = new Error("SECRET_CANARY unclassified host failure");
		displaced.diagnosticCode = "SECRET_CANARY_not_a_closed_code";
		const error = new QueueCleanupError(null, displaced);
		// The in-flight error is not a channel: only a code this project mints
		// itself crosses, so an unrecognized one leaves the fixed code standing.
		strictEqual(error.failure.diagnosticCode, "recovery_incomplete");
		strictEqual(JSON.stringify(error).includes("SECRET_CANARY"), false);
	});
	it("still fails closed on teardown when a queue failure is already in flight", async () => {
		const events = [];
		const tasksPath = writeTerminalQueue();
		await rejects(
			runQueueAsyncImpl({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				platform: "macos",
				taskIds: ["9.9"],
				checkpointPath: `${tasksPath}.displaced-failure.checkpoint.json`,
				dependencies: {
					backendFactory: () => macosBackend(events, { failDestroy: true }),
				},
			}),
			(error) => {
				// Capturing the in-flight failure must not let it win the throw: a
				// caller that saw the selection error alone would finalize without
				// knowing a workspace is still on the host.
				strictEqual(error.name, "QueueCleanupError");
				strictEqual(error.code, "recovery_incomplete");
				// TaskSelectionError carries no closed diagnostic, so the fixed one holds.
				strictEqual(error.failure.diagnosticCode, "recovery_incomplete");
				return true;
			},
		);
		ok(events.indexOf("destroy") >= 0);
		ok(events.indexOf("release") > events.indexOf("destroy"));
	});
	it("releases a slot when workspace creation fails", async () => {
		const events = [];
		const tasksPath = writeTerminalQueue();
		await rejects(
			runQueueAsyncImpl({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				platform: "macos",
				dependencies: {
					backendFactory: () => macosBackend(events, { failCreate: true }),
				},
			}),
			/create failed/,
		);
		deepStrictEqual(events, [
			"preflight",
			"readiness",
			"acquire",
			"ensure",
			"create",
			"release",
		]);
	});
	it("rejects an invalid platform before backend selection or admission", async () => {
		const events = [];
		const tasksPath = writeTerminalQueue();
		await rejects(
			runQueueAsyncImpl({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				platform: "windows",
				dependencies: {
					backendFactory: () => {
						events.push("factory");
						return macosBackend(events);
					},
				},
			}),
			/runOptions\.platform must be one of macos/,
		);
		deepStrictEqual(events, []);
	});
	it("rejects the default macOS preflight before slot acquisition or VM creation", async () => {
		const events = [];
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Native queue gate
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **RequiredCapability:** high
- **RequiredCapabilityJustification:** test gate
- **Description:** fixture
`);
		await rejects(
			runQueueAsyncImpl({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				platform: "macos",
				dependencies: {
					backendFactory: () => ({
						create: () => {
							events.push("create");
							return "vm";
						},
						seed: () => {},
						commit: () => {},
						reset: () => {},
						destroy: () => {},
						acquireSlot: () => events.push("acquire"),
					}),
					// A name no roster resolves, so only the default preflight
					// can reject it, and it must do so before any backend work.
					// This used to be "claude" on the premise that the default
					// allowlist excluded it; claude-code was verified on
					// 2026-09-18 and the premise died. The allowlist gate itself
					// is covered in the split router suites by the case that
					// injects `goldenImageVerifiedProviders`.
					adapters: { [UNVERIFIED_PROVIDER]: {} },
					preflightReadSnapshot: () => ({
						snapshot: {
							schema_version: 2,
							updated_at: new Date().toISOString(),
							providers: [
								{
									name: UNVERIFIED_PROVIDER,
									ok: true,
									windows: [{ percent_left: 80, pace_delta: 1 }],
								},
							],
						},
						snapshotStatus: "fresh",
						snapshotMtime: 1,
						snapshotAgeMsAtRoute: 0,
					}),
				},
			}),
			new RegExp(
				`high: no_golden_image_verified_provider_with_quota_headroom.*${UNVERIFIED_PROVIDER}: target_identity_unavailable`,
			),
		);
		deepStrictEqual(events, []);
	});
});
