import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	PRE_PROVIDER_FAILURE_TRIPLES,
	sanitizeFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";
import { finalizeRun } from "../src/switchyard/dispatch/run-finalization.mjs";

function revisionError() {
	const error = new Error("run lock changed while releasing");
	error.name = "RevisionError";
	return error;
}

describe("run finalization", () => {
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
