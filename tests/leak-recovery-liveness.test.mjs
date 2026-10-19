// @test-phase: other
import { deepStrictEqual } from "node:assert";
import { describe, it } from "node:test";
import { releaseStaleProjectLocks } from "../src/switchyard/dispatch/recover-liveness.mjs";

// Liveness rule that decides whether `recover --run` may release a run's
// project lock. This is the data-loss-critical branch: a false "dead" frees a
// live dispatch's lock and lets a second writer into its project. Fully
// injectable (readRun + isWorkerLive + release), so these run without a real
// run store.

const GRACE_MS = 5 * 60_000;

function runRec(overrides = {}) {
	return {
		state: "running",
		cleanupState: "not_started",
		workerPid: 4242,
		projectPath: "/private/tmp/recovery-project",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

/** Run the release for one run id and return the ids whose lock was freed. */
async function released({ run, live, classifyRunLiveness }) {
	const calls = [];
	const result = await releaseStaleProjectLocks(["r"], {
		readRun: async () => {
			if (run === undefined) throw new Error("run not found");
			return run;
		},
		isWorkerLive: () => live,
		...(classifyRunLiveness ? { classifyRunLiveness } : {}),
		releaseProjectLockIfOwnedBy: async (projectPath, runId) => {
			calls.push([projectPath, runId]);
			return true;
		},
	});
	deepStrictEqual(
		calls.map(([, runId]) => runId),
		result,
		"every reported release must come from an actual release call",
	);
	return result;
}

describe("releaseStaleProjectLocks — liveness gating", () => {
	it("missing run record => no release (no project path to key on)", async () => {
		deepStrictEqual(await released({ run: undefined }), []);
	});

	it("terminal clean state => released (succeeded)", async () => {
		const run = runRec({ state: "succeeded", cleanupState: "complete" });
		deepStrictEqual(await released({ run, live: true }), ["r"]);
	});

	it("terminal clean state => released (failed)", async () => {
		const run = runRec({ state: "failed", cleanupState: "complete" });
		deepStrictEqual(await released({ run, live: true }), ["r"]);
	});

	it("live worker PID => held (protects a long-running task)", async () => {
		deepStrictEqual(await released({ run: runRec(), live: true }), []);
	});

	it("workerPid set but not signalable => released (crashed worker)", async () => {
		deepStrictEqual(await released({ run: runRec(), live: false }), ["r"]);
	});

	it("workerPid null + fresh createdAt => held (startup grace protects launch)", async () => {
		const run = runRec({ state: "created", workerPid: null });
		deepStrictEqual(await released({ run, live: false }), []);
	});

	it("workerPid null + createdAt past the grace => released (abandoned launch)", async () => {
		const old = new Date(Date.now() - GRACE_MS - 60_000).toISOString();
		const run = runRec({ state: "launching", workerPid: null, createdAt: old });
		deepStrictEqual(await released({ run, live: false }), ["r"]);
	});

	it("workerPid null + unparseable createdAt => held (cannot prove staleness)", async () => {
		const run = runRec({
			state: "created",
			workerPid: null,
			createdAt: "nonsense",
		});
		deepStrictEqual(await released({ run, live: false }), []);
	});

	it("terminal finalizer with incomplete cleanup => held", async () => {
		const run = runRec({ state: "failed", cleanupState: "pending" });
		deepStrictEqual(await released({ run, live: true }), []);
	});

	it("failed cleanup => held for attended recovery", async () => {
		const run = runRec({ state: "failed", cleanupState: "failed" });
		deepStrictEqual(await released({ run, live: false }), []);
	});

	it("malformed and PID-ambiguous owners => held", async () => {
		deepStrictEqual(
			await released({ run: runRec({ workerPid: "4242" }), live: false }),
			[],
		);
		deepStrictEqual(
			await released({
				run: runRec(),
				live: false,
				classifyRunLiveness: () => "unknown",
			}),
			[],
		);
	});
});
