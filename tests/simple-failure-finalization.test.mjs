import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	persistFailureDisposition,
	publishFailedTerminal,
} from "../src/switchyard/simple/failure-finalization.mjs";

function disposition(overrides = {}) {
	return {
		runInitialized: true,
		status: "failed",
		terminalDurable: true,
		runId: "simple-failure",
		taskId: "failure",
		keepWorktree: false,
		worktreePath: null,
		cleanupAttempted: false,
		writerLifecycle: "never_started",
		projectLockState: "released",
		now: () => 1_000,
		updateRun: async () => {},
		...overrides,
	};
}
const claim = {
	canonicalParent: "/private/tmp",
	candidateChild: "switchyard-simple-test",
	candidatePath: "/private/tmp/switchyard-simple-test",
};

describe("simple failure finalization", () => {
	it("publishes cleanup intent in the same write as terminal failure", async () => {
		let patch;
		strictEqual(
			await publishFailedTerminal(
				async (_id, value) => {
					patch = value;
				},
				"run",
				{ state: "failed", cleanupState: "complete" },
			),
			true,
		);
		deepStrictEqual(patch, { state: "failed", cleanupState: "pending" });
	});
	it("does not acknowledge an interrupted terminal write", async () => {
		let settle;
		let durable = false;
		const writing = publishFailedTerminal(
			() =>
				new Promise((resolve) => {
					settle = resolve;
				}),
			"run",
			{},
		).then((result) => {
			durable = result;
		});
		await Promise.resolve();
		strictEqual(durable, false);
		settle();
		await writing;
		strictEqual(durable, true);
	});
	for (const synchronous of [true, false]) {
		it(`returns false on ${synchronous ? "synchronous" : "asynchronous"} terminal persistence failure`, async () => {
			strictEqual(
				await publishFailedTerminal(
					() => {
						if (synchronous) throw new Error("write failed");
						return Promise.reject(new Error("write failed"));
					},
					"run",
					{},
				),
				false,
			);
		});
	}
	it("writes complete disposition without inventing a no-clone claim", async () => {
		let patch;
		const result = await persistFailureDisposition(
			disposition({
				updateRun: async (_id, value) => {
					patch = value;
				},
			}),
		);
		deepStrictEqual(patch, { cleanupState: "complete" });
		deepStrictEqual(result, { persisted: true, cleanupState: "complete" });
	});
	it("cannot mark cleanup complete after failed terminal persistence", async () => {
		let patch;
		await persistFailureDisposition(
			disposition({
				terminalDurable: false,
				updateRun: async (_id, value) => {
					patch = value;
				},
			}),
		);
		deepStrictEqual(patch, { cleanupState: "pending" });
	});
	it("records retained useful work independently of completed writer and lock release", async () => {
		let patch;
		await persistFailureDisposition(
			disposition({
				...claim,
				worktreePath: `${claim.candidatePath}/worktree`,
				keepWorktree: true,
				failureReason: "check_failed",
				writerLifecycle: "stopped",
				updateRun: async (_id, value) => {
					patch = value;
				},
			}),
		);
		strictEqual(patch.cleanupState, "pending");
		strictEqual(patch.worktree.state, "retained");
		strictEqual(patch.worktree.reason, "check_failed");
		strictEqual(patch.worktree.writerStopped, true);
		strictEqual(patch.worktree.retainedAt, new Date(1_000).toISOString());
	});
	it("records removed clone disposition with its original claim", async () => {
		let patch;
		await persistFailureDisposition(
			disposition({
				...claim,
				updateRun: async (_id, value) => {
					patch = value;
				},
			}),
		);
		strictEqual(patch.cleanupState, "complete");
		strictEqual(patch.worktree.state, "removed");
		strictEqual(patch.worktree.reason, null);
	});
	for (const override of [
		{ cleanupAttempted: true, keepWorktree: true },
		{ writerLifecycle: "unavailable" },
		{ projectLockState: "unavailable" },
		{ projectLockState: "held" },
	]) {
		it(`keeps failed cleanup separate from task failure: ${JSON.stringify(override)}`, async () => {
			let patch;
			await persistFailureDisposition(
				disposition({
					...claim,
					...override,
					updateRun: async (_id, value) => {
						patch = value;
					},
				}),
			);
			strictEqual(patch.cleanupState, "failed");
			strictEqual(patch.cleanupFailure.errorKind, "cleanup_failed");
		});
	}
	it("returns pending when final cleanup persistence fails", async () => {
		deepStrictEqual(
			await persistFailureDisposition(
				disposition({
					updateRun: async () => {
						throw new Error("write failed");
					},
				}),
			),
			{ persisted: false, cleanupState: "pending" },
		);
	});
	for (const override of [{ runInitialized: false }, { status: "succeeded" }]) {
		it(`leaves nonfailure paths unchanged: ${JSON.stringify(override)}`, async () => {
			let called = false;
			strictEqual(
				await persistFailureDisposition(
					disposition({
						...override,
						updateRun: async () => {
							called = true;
						},
					}),
				),
				null,
			);
			strictEqual(called, false);
		});
	}
});
