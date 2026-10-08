import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	isPersistentFailureMetadata,
	sanitizeFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";
import {
	createEvent,
	getRunRoot,
	initializeRun,
	readEvents,
	readRun,
	runStoreTesting,
	SchemaError,
	updateRun,
	updateRunWithRetry,
	VALID_WORKTREE_STATES,
} from "../src/switchyard/run-store/index.mjs";
import {
	makeOptions,
	TEST_ROOT,
	VM_ADMISSION_ROOT,
} from "./helpers/run-store-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_ROOT, "store");
process.env.SWITCHYARD_VM_ADMISSION_ROOT = VM_ADMISSION_ROOT;
process.env.SWITCHYARD_ROSTER_PATH = resolve(
	"tests/fixtures/roster.fixture.json",
);
after(() => {
	try {
		rmSync(TEST_ROOT, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
afterEach(() => {
	try {
		rmSync(join(TEST_ROOT, "store"), { recursive: true, force: true });
		rmSync(VM_ADMISSION_ROOT, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("prlctl failure metadata survives the persistence boundary", () => {
	it("rejects a persisted diagnostic whose origin cannot mint its code", async () => {
		for (const provenance of [
			{
				diagnosticCode: "cli_usage_error",
				diagnosticOrigin: "adapter",
				failurePhase: "provider_execution",
			},
			{
				diagnosticCode: "quota_exhausted",
				diagnosticOrigin: "worker_boot",
			},
			{
				diagnosticCode: "worker_boot_exception",
				diagnosticOrigin: "worker_boot",
			},
		]) {
			const opts = makeOptions();
			const snapshot = await initializeRun(opts);
			await rejects(
				updateRun(
					opts.runId,
					{
						state: "failed",
						lastFailure: {
							errorKind: "execution_failed",
							reasonCode: "execution_failed",
							reason:
								"Provider execution failed before a reviewed integration.",
							diagnosticEvidenceAvailable: true,
							...provenance,
						},
					},
					snapshot.revision,
				),
				SchemaError,
			);
		}
	});

	// The whole point of classifying a prlctl misfire is that a reader of the
	// FILE, not just the in-process object, can tell it apart from an ordinary
	// provisioning failure. A wrapper that built the right object in memory but
	// lost exitCode/signal on the way through validateRun's allowlist would
	// still read as "no metadata recorded" to anyone who only reads run.json.
	it("round-trips a prlctl_job_misfire lastFailure with its exit code through disk", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		const misfireFailure = sanitizeFailureMetadata({
			result: "launch_failed",
			errorKind: "launch_failed",
			diagnosticCode: "prlctl_job_misfire",
			failurePhase: "worker_boot",
			exitCode: 255,
		});

		const updated = await updateRun(
			opts.runId,
			{ state: "failed", lastFailure: misfireFailure },
			snapshot.revision,
		);
		strictEqual(updated.lastFailure.diagnosticCode, "prlctl_job_misfire");
		strictEqual(updated.lastFailure.exitCode, 255);

		const onDisk = await readRun(opts.runId);
		strictEqual(onDisk.state, "failed");
		strictEqual(onDisk.lastFailure?.diagnosticCode, "prlctl_job_misfire");
		strictEqual(
			onDisk.lastFailure?.exitCode,
			255,
			"the exit code must still be readable from the file, not just the in-memory return value",
		);
		ok(isPersistentFailureMetadata(onDisk.lastFailure));
	});

	it("round-trips a prlctl_call_timed_out lastFailure with its signal through disk", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		const timeoutFailure = sanitizeFailureMetadata({
			result: "launch_failed",
			errorKind: "launch_failed",
			diagnosticCode: "prlctl_call_timed_out",
			failurePhase: "worker_boot",
			signal: "SIGTERM",
		});

		await updateRun(
			opts.runId,
			{ state: "failed", lastFailure: timeoutFailure },
			snapshot.revision,
		);

		const onDisk = await readRun(opts.runId);
		strictEqual(onDisk.lastFailure?.diagnosticCode, "prlctl_call_timed_out");
		strictEqual(onDisk.lastFailure?.signal, "SIGTERM");
		ok(isPersistentFailureMetadata(onDisk.lastFailure));
	});

	describe("simple dispatch durable evidence and milestones", () => {
		it("stores valid workerPid in initializeRun and round-trips to disk", async () => {
			const opts = makeOptions({ workerPid: 12345 });
			const snapshot = await initializeRun(opts);
			strictEqual(snapshot.workerPid, 12345);

			const onDisk = await readRun(opts.runId);
			strictEqual(onDisk.workerPid, 12345);
		});

		it("defaults workerPid to null when omitted or undefined", async () => {
			const opts = makeOptions();
			const snapshot = await initializeRun(opts);
			strictEqual(snapshot.workerPid, null);

			const onDisk = await readRun(opts.runId);
			strictEqual(onDisk.workerPid, null);
		});

		it("rejects invalid workerPid values in initializeRun", async () => {
			for (const badPid of [-1, 0, 1.5, "12345", {}, []]) {
				await rejects(
					initializeRun(makeOptions({ workerPid: badPid })),
					SchemaError,
				);
			}
		});

		it("persists named milestone events with approved milestone keys and elapsedMs", async () => {
			const opts = makeOptions();
			await initializeRun(opts);

			await createEvent(opts.runId, {
				phase: "route",
				event: "milestone",
				status: "route_completed",
				milestone: "route_selected",
				elapsedMs: 250,
				checkIndex: 1,
				checkIdentity: "preflight-check",
				checkStatus: "passed",
				firstChangeObserved: true,
				elapsedSinceLastMilestoneMs: 150,
			});

			const events = await readEvents(opts.runId);
			strictEqual(events.length, 1);
			const ev = events[0];
			strictEqual(ev.event, "milestone");
			strictEqual(ev.milestone, "route_selected");
			strictEqual(ev.elapsedMs, 250);
			strictEqual(ev.checkIndex, 1);
			strictEqual(ev.checkIdentity, "preflight-check");
			strictEqual(ev.checkStatus, "passed");
			strictEqual(ev.firstChangeObserved, true);
			strictEqual(ev.elapsedSinceLastMilestoneMs, 150);
		});

		it("does not persist elapsedMs for generic unapproved events", async () => {
			const opts = makeOptions();
			await initializeRun(opts);

			await createEvent(opts.runId, {
				phase: "execute",
				event: "heartbeat",
				status: "running",
				elapsedMs: 500,
			});

			const events = await readEvents(opts.runId);
			strictEqual(events.length, 1);
			strictEqual(events[0].event, "heartbeat");
			strictEqual(events[0].elapsedMs, undefined);
		});

		it("syncs run bytes before rename and the containing directory before completion", async () => {
			const root = tempDir("switchyard-run-sync-");
			const path = join(root, "run.json");
			const order = [];
			await runStoreTesting.writeRunAtomically(
				path,
				{ intent: "allocating" },
				{
					unlink,
					rename: async (...args) => {
						order.push("rename");
						await rename(...args);
					},
					open: async (openedPath, flags, mode) => {
						const handle = await open(openedPath, flags, mode);
						const kind = flags === "r" ? "directory" : "file";
						return {
							writeFile: async (...args) => {
								order.push("write");
								await handle.writeFile(...args);
							},
							sync: async () => {
								order.push(`sync-${kind}`);
								await handle.sync();
							},
							close: async () => {
								order.push(`close-${kind}`);
								await handle.close();
							},
						};
					},
				},
			);
			deepStrictEqual(order, [
				"write",
				"sync-file",
				"close-file",
				"rename",
				"sync-directory",
				"close-directory",
			]);
			deepStrictEqual(JSON.parse(readFileSync(path, "utf8")), {
				intent: "allocating",
			});
		});

		for (const fault of ["file", "directory"]) {
			it(`propagates ${fault} sync failures and closes handles without leaving temporary files`, async () => {
				const root = tempDir("switchyard-run-sync-failure-");
				const path = join(root, "run.json");
				writeFileSync(path, JSON.stringify({ intent: "old" }));
				const closed = [];
				await rejects(
					runStoreTesting.writeRunAtomically(
						path,
						{ intent: "allocating" },
						{
							rename,
							unlink,
							open: async (openedPath, flags, mode) => {
								const handle = await open(openedPath, flags, mode);
								const kind = flags === "r" ? "directory" : "file";
								return {
									writeFile: (...args) => handle.writeFile(...args),
									sync: async () => {
										if (kind === fault)
											throw new Error("injected sync failure");
										await handle.sync();
									},
									close: async () => {
										closed.push(kind);
										await handle.close();
									},
								};
							},
						},
					),
					/injected sync failure/,
				);
				deepStrictEqual(
					closed,
					fault === "file" ? ["file"] : ["file", "directory"],
				);
				deepStrictEqual(readdirSync(root), ["run.json"]);
				strictEqual(
					JSON.parse(readFileSync(path, "utf8")).intent,
					fault === "file" ? "old" : "allocating",
				);
			});
		}

		it("accepts only bounded cleanup result codes and preserves generic historical metadata", async () => {
			const opts = makeOptions();
			await initializeRun(opts);
			const metadata = sanitizeFailureMetadata({
				result: "failed",
				errorKind: "cleanup_failed",
			});
			await updateRunWithRetry(opts.runId, { cleanupFailure: metadata });
			for (const result of [
				"deadline_expired",
				"project_lock_release_unconfirmed",
				"worktree_cleanup_failed",
			]) {
				await updateRunWithRetry(opts.runId, {
					cleanupFailure: { ...metadata, result },
				});
				strictEqual((await readRun(opts.runId)).cleanupFailure.result, result);
			}
			await rejects(
				updateRunWithRetry(opts.runId, {
					cleanupFailure: { ...metadata, result: "untrusted detail" },
				}),
				SchemaError,
			);
			await rejects(
				updateRunWithRetry(opts.runId, {
					cleanupFailure: {
						...metadata,
						result: "worktree_cleanup_failed",
						extra: "untrusted detail",
					},
				}),
				SchemaError,
			);
		});

		it("accepts valid allocating, active, removed, and retained worktree records", async () => {
			const canonicalParent = resolve("/tmp");
			const candidateChild = "switchyard-simple-active-1";
			const candidatePath = resolve(canonicalParent, candidateChild);

			const activeOpts = makeOptions({
				worktree: {
					canonicalParent,
					candidateChild,
					path: candidatePath,
					state: "allocating",
					reason: null,
					retainedAt: null,
				},
			});
			const activeSnapshot = await initializeRun(activeOpts);
			deepStrictEqual(activeSnapshot.worktree, {
				canonicalParent,
				candidateChild,
				path: candidatePath,
				state: "allocating",
				reason: null,
				retainedAt: null,
			});

			const onDiskActive = await readRun(activeOpts.runId);
			deepStrictEqual(onDiskActive.worktree, activeSnapshot.worktree);

			const active = await updateRun(
				activeOpts.runId,
				{
					worktree: { ...activeSnapshot.worktree, state: "active" },
				},
				activeSnapshot.revision,
			);
			strictEqual(active.worktree.state, "active");

			// Transition to removed
			const removed = await updateRun(
				activeOpts.runId,
				{
					worktree: {
						canonicalParent,
						candidateChild,
						path: candidatePath,
						state: "removed",
						reason: null,
						retainedAt: null,
					},
				},
				active.revision,
			);
			strictEqual(removed.worktree.state, "removed");

			// Transition to retained
			const retainedTime = new Date().toISOString();
			const retained = await updateRun(
				activeOpts.runId,
				{
					worktree: {
						canonicalParent,
						candidateChild,
						path: candidatePath,
						state: "retained",
						reason: "salvage_retained",
						retainedAt: retainedTime,
					},
				},
				removed.revision,
			);
			strictEqual(retained.worktree.state, "retained");
			strictEqual(retained.worktree.reason, "salvage_retained");
			strictEqual(retained.worktree.retainedAt, retainedTime);
		});

		it("preserves historical schema compatibility when worktree is null or omitted", async () => {
			const opts = makeOptions();
			const snapshot = await initializeRun(opts);
			strictEqual(snapshot.worktree, null);

			const onDisk = await readRun(opts.runId);
			strictEqual(onDisk.worktree, null);

			// Historical update omitting worktree passes validation cleanly
			const updated = await updateRun(
				opts.runId,
				{ state: "running" },
				snapshot.revision,
			);
			strictEqual(updated.state, "running");
			strictEqual(updated.worktree, null);
		});

		it("rejects invalid worktree record shapes and states", async () => {
			const canonicalParent = resolve("/tmp");
			const candidateChild = "switchyard-simple-test";
			const candidatePath = resolve(canonicalParent, candidateChild);

			const validWorktree = {
				canonicalParent,
				candidateChild,
				path: candidatePath,
				state: "active",
				reason: null,
				retainedAt: null,
			};

			const invalidShapes = [
				"not-an-object",
				123,
				[],
				{ ...validWorktree, state: "unknown_state" },
				{ ...validWorktree, state: "pending" },
				{ ...validWorktree, canonicalParent: "relative/path" },
				{ ...validWorktree, canonicalParent: 123 },
				{ ...validWorktree, candidateChild: "nested/path" },
				{ ...validWorktree, candidateChild: "../parent" },
				{ ...validWorktree, candidateChild: "." },
				{ ...validWorktree, candidateChild: ".." },
				{ ...validWorktree, candidateChild: "" },
				{ ...validWorktree, path: "/mismatched/path" },
				{ ...validWorktree, reason: 123 },
				{ ...validWorktree, retainedAt: "not-a-valid-date" },
				{ ...validWorktree, unexpectedKey: true },
			];

			for (const badWorktree of invalidShapes) {
				const opts = makeOptions({ worktree: badWorktree });
				await rejects(initializeRun(opts), SchemaError);
			}
		});

		it("validates persisted retainedAt timestamps across historical and current schemas", async () => {
			const schemaCases = [
				{ version: 1, options: {} },
				{
					version: 2,
					options: {
						projectRevision: "test-revision",
						queueIdentity: "a".repeat(64),
						runOptions: {
							version: 1,
							maxTasks: null,
							stopOnFailure: false,
							checkpointPath: null,
							onlyProviders: [],
							excludeProviders: [],
							taskIds: [],
						},
					},
				},
			];
			const validDates = [
				"2024-02-29T12:34:56.123456Z",
				"2024-02-29t12:34:56.123456z",
				"2024-02-29T12:34:56+05:30",
			];
			const invalidDates = [
				"2025-02-29T00:00:00.000Z",
				"2026-10-08T24:00:00.000Z",
			];
			const worktree = (retainedAt) => ({
				canonicalParent: resolve("/tmp"),
				candidateChild: "switchyard-simple-test",
				path: resolve("/tmp", "switchyard-simple-test"),
				state: "retained",
				reason: "salvage_retained",
				...(retainedAt !== undefined ? { retainedAt } : {}),
			});

			for (const schema of schemaCases) {
				for (const retainedAt of validDates) {
					const opts = makeOptions({
						...schema.options,
						worktree: worktree(retainedAt),
					});
					const snapshot = await initializeRun(opts);
					strictEqual(snapshot.schemaVersion, schema.version);
					strictEqual(
						(await readRun(opts.runId)).worktree.retainedAt,
						retainedAt,
					);
				}

				for (const retainedAt of [null, undefined]) {
					const opts = makeOptions({
						...schema.options,
						worktree: worktree(retainedAt),
					});
					await initializeRun(opts);
					const persisted = (await readRun(opts.runId)).worktree;
					if (retainedAt === null) strictEqual(persisted.retainedAt, null);
					else strictEqual(Object.hasOwn(persisted, "retainedAt"), false);
				}

				const opts = makeOptions({
					...schema.options,
					worktree: worktree(validDates[0]),
				});
				await initializeRun(opts);
				const path = join(getRunRoot(opts.runId), "run.json");
				const persisted = JSON.parse(readFileSync(path, "utf8"));
				for (const retainedAt of invalidDates) {
					persisted.worktree.retainedAt = retainedAt;
					writeFileSync(path, JSON.stringify(persisted));
					await rejects(readRun(opts.runId), SchemaError);
				}
			}
		});

		it("exports all four worktree lifecycle states", () => {
			ok(VALID_WORKTREE_STATES.has("allocating"));
			ok(VALID_WORKTREE_STATES.has("active"));
			ok(VALID_WORKTREE_STATES.has("removed"));
			ok(VALID_WORKTREE_STATES.has("retained"));
			strictEqual(VALID_WORKTREE_STATES.size, 4);
		});
	});
});
