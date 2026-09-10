import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
	PRE_PROVIDER_FAILURE_TRIPLES,
	sanitizeFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";
import { finalizeRun } from "../src/switchyard/dispatch/run-finalization.mjs";
import {
	activateOutcomeWriter,
	initializeRun,
	readEvents,
	readRun,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";

function revisionError() {
	const error = new Error("run lock changed while releasing");
	error.name = "RevisionError";
	return error;
}

describe("run finalization", () => {
	it("records typed cleanup, run, and postcondition facts beside legacy terminalization", async () => {
		const runId = `typed-finalize-${randomUUID()}`;
		await initializeRun({
			runId,
			tasksFilePath: "/tmp/tasks.md",
			projectPath: "/tmp/project",
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "fixture",
			workerPid: process.pid,
			workerNonce: randomUUID(),
		});
		let current = await readRun(runId);
		await activateOutcomeWriter(runId, {
			pid: process.pid,
			startToken: "start-token",
			nonce: current.workerNonce,
			writerEpoch: "epoch-finalize",
		});
		current = await readRun(runId);
		await updateRun(runId, { state: "created" }, current.revision);
		const outcome = await finalizeRun({
			runId,
			state: "succeeded",
			terminalSummary: { processedTasks: 1, failedCount: 0 },
		});
		strictEqual(outcome.terminal, true);
		const persisted = await readRun(runId);
		const events = await readEvents(runId);
		const shadow = persisted.outcomeShadow;
		ok(shadow, "finalization persists a run-store shadow");
		deepStrictEqual(
			events
				.filter((event) => typeof event.stage === "string")
				.map((event) => event.stage),
			["cleanup", "cleanup", "run", "postcondition"],
		);
		strictEqual(shadow.parity.legacyStatus, "succeeded");
		strictEqual(shadow.parity.evidence, "shadow");
	});

	it("records deferred as terminal without failure metadata", async () => {
		const events = [];
		const patches = [];
		const outcome = await finalizeRun(
			{
				runId: "deferred-terminal",
				state: "deferred",
				failure: null,
				terminalSummary: {
					processedTasks: 0,
					completedTaskIds: [],
					deferredTaskIds: ["1.1"],
					failedCount: 0,
				},
			},
			{
				createEvent: async (_runId, event) => events.push(event),
				updateRunWithRetry: async (_runId, patch) => {
					patches.push(patch);
					return patch;
				},
				releaseRunLock: async () => {},
			},
		);
		strictEqual(outcome.terminal, true);
		strictEqual(events[0].event, "run_deferred");
		strictEqual(events[0].lastFailure, undefined);
		strictEqual(patches[0].finishedAt, undefined);
		const terminalPatch = patches.find((patch) => patch.state === "deferred");
		ok(terminalPatch, "deferred terminal patch is present");
		ok(typeof terminalPatch.finishedAt === "string");
		for (const patch of patches) strictEqual(patch.lastFailure, undefined);
	});

	it("accepts every closed pre-provider diagnostic as an event reason", async () => {
		for (const triple of PRE_PROVIDER_FAILURE_TRIPLES) {
			const events = [];
			const failure = sanitizeFailureMetadata({
				result: "launch_failed",
				...triple,
			});
			const outcome = await finalizeRun(
				{
					runId: `closed-${triple.diagnosticCode}`,
					state: "failed",
					failure,
					eventReasonCode: triple.diagnosticCode,
					terminalSummary: { processedTasks: 0, failedCount: 1 },
				},
				{
					createEvent: async (_runId, event) => events.push(event),
					updateRunWithRetry: async (_runId, patch) => patch,
					releaseRunLock: async () => {},
				},
			);
			strictEqual(outcome.terminal, true);
			strictEqual(events[0].reasonCode, triple.diagnosticCode);
		}
	});

	it("never records a failed run without a reason", async () => {
		const events = [];
		const patches = [];
		const outcome = await finalizeRun(
			{
				runId: "failed-without-metadata",
				state: "failed",
				failure: null,
				terminalSummary: { processedTasks: 0, failedCount: 1 },
			},
			{
				createEvent: async (_runId, event) => events.push(event),
				updateRunWithRetry: async (_runId, patch) => {
					patches.push(patch);
					return patch;
				},
				releaseRunLock: async () => {},
			},
		);
		strictEqual(outcome.terminal, true);
		strictEqual(events[0].diagnosticCode, "terminal_without_failure_metadata");
		strictEqual(events[0].reasonCode, "unknown_failure");
		for (const patch of patches) {
			ok(patch.lastFailure, "every terminal patch must carry failure metadata");
		}
	});

	it("leaves a succeeded run's failure metadata absent", async () => {
		const patches = [];
		await finalizeRun(
			{
				runId: "succeeded-clean",
				state: "succeeded",
				failure: null,
				terminalSummary: { processedTasks: 1, failedCount: 0 },
			},
			{
				createEvent: async () => {},
				updateRunWithRetry: async (_runId, patch) => {
					patches.push(patch);
					return patch;
				},
				releaseRunLock: async () => {},
			},
		);
		for (const patch of patches) {
			strictEqual(patch.lastFailure, undefined);
		}
	});

	it("leaves finishedAt null when cleanup requires recovery", async () => {
		const patches = [];
		const persisted = {
			startedAt: new Date().toISOString(),
			finishedAt: null,
		};
		const outcome = await finalizeRun(
			{
				runId: "cleanup-recovery-timestamp",
				state: "failed",
				terminalSummary: { processedTasks: 0, failedCount: 1 },
				cleanup: async () => {
					throw new Error("cleanup unavailable");
				},
			},
			{
				createEvent: async () => {},
				updateRunWithRetry: async (_runId, patch) => {
					patches.push(patch);
					Object.assign(persisted, patch);
					return { ...persisted };
				},
				releaseRunLock: async () => {},
			},
		);

		strictEqual(outcome.terminal, false);
		strictEqual(persisted.finishedAt, null);
		strictEqual(patches.at(-1).state, "recovery_required");
		strictEqual(patches.at(-1).finishedAt, undefined);
	});

	it("preserves the primary task failure when cleanup becomes uncertain", async () => {
		const failure = sanitizeFailureMetadata({
			result: "execution_failed",
			errorKind: "execution_failed",
			diagnosticCode: "provider_failed",
			failurePhase: "provider_execution",
		});
		const patches = [];
		const outcome = await finalizeRun(
			{
				runId: "primary-failure-cleanup-uncertain",
				state: "failed",
				failure,
				terminalSummary: { processedTasks: 1, failedCount: 1 },
				cleanup: async () => {
					throw new Error("cleanup response lost");
				},
			},
			{
				createEvent: async () => {},
				updateRunWithRetry: async (_runId, patch) => {
					patches.push(patch);
					return patch;
				},
				releaseRunLock: async () => {},
			},
		);
		strictEqual(outcome.terminal, false);
		strictEqual(
			patches.at(-1).lastFailure.diagnosticCode,
			failure.diagnosticCode,
		);
		strictEqual(
			patches.at(-1).cleanupFailure.diagnosticCode,
			"recovery_incomplete",
		);
		strictEqual(outcome.primaryFailure.diagnosticCode, failure.diagnosticCode);
	});

	it("rejects an arbitrary event reason before any terminal mutation", async () => {
		let mutations = 0;
		const failure = sanitizeFailureMetadata({
			result: "launch_failed",
			errorKind: "launch_failed",
			diagnosticCode: "worker_boot_exception",
			failurePhase: "worker_boot",
		});
		await rejects(
			finalizeRun(
				{
					runId: "arbitrary-reason",
					state: "failed",
					failure,
					eventReasonCode: "arbitrary/path/canary",
					terminalSummary: { processedTasks: 0, failedCount: 1 },
				},
				{
					createEvent: async () => {
						mutations += 1;
					},
					updateRunWithRetry: async () => {
						mutations += 1;
					},
					releaseRunLock: async () => {
						mutations += 1;
					},
				},
			),
			/closed event reason code/,
		);
		strictEqual(mutations, 0);
	});

	it("preserves a persisted terminal success when run-lock release loses a revision race", async () => {
		const persisted = {};
		const patches = [];
		const outcome = await finalizeRun(
			{
				runId: "release-race-success",
				state: "succeeded",
				terminalSummary: {
					processedTasks: 3,
					completedTaskIds: ["r5-1", "r5-2", "r5-3"],
					failedCount: 0,
				},
			},
			{
				createEvent: async () => {},
				updateRunWithRetry: async (_runId, patch) => {
					patches.push(patch);
					Object.assign(persisted, patch);
					return { ...persisted };
				},
				releaseRunLock: async () => {
					throw revisionError();
				},
			},
		);

		strictEqual(outcome.terminal, true);
		strictEqual(outcome.cleanupComplete, true);
		strictEqual(persisted.state, "succeeded");
		deepStrictEqual(persisted.terminalSummary, {
			processedTasks: 3,
			completedTaskIds: ["r5-1", "r5-2", "r5-3"],
			failedCount: 0,
		});
		strictEqual(patches.length, 2, "no second failed finalization is needed");
		strictEqual(
			patches.some((patch) => patch.state === "failed"),
			false,
		);
	});

	it("does not hide a terminal-patch failure behind a release failure", async () => {
		const terminalPatchError = new Error("terminal patch failed");
		await rejects(
			finalizeRun(
				{
					runId: "terminal-patch-failure",
					state: "succeeded",
					terminalSummary: { processedTasks: 1, failedCount: 0 },
				},
				{
					createEvent: async () => {},
					updateRunWithRetry: async (_runId, patch) => {
						if (patch.state === "succeeded") throw terminalPatchError;
						return patch;
					},
					releaseRunLock: async () => {
						throw revisionError();
					},
				},
			),
			terminalPatchError,
		);
	});
});
