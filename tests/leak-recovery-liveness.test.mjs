import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { resolveIsRunDead } from "../src/switchyard/dispatch/index.mjs";

// Liveness rule that decides whether `recover` may reap a managed container.
// This is the data-loss-critical branch: a false "dead" reaps a live
// dispatch's container. Fully injectable (readRun + isWorkerLive), so these
// run without Docker or a real run store.

const GRACE_MS = 5 * 60_000;

function deps({ run, live }) {
	return {
		readRun: async () => {
			if (run === undefined) throw new Error("run not found");
			return run;
		},
		isWorkerLive: () => live,
	};
}

function runRec(overrides = {}) {
	return {
		state: "running",
		workerPid: 4242,
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

describe("resolveIsRunDead — liveness gating", () => {
	it("missing run record => dead (orphaned container)", async () => {
		strictEqual(await resolveIsRunDead("r", deps({ run: undefined })), true);
	});

	it("terminal state => dead (succeeded)", async () => {
		const d = deps({ run: runRec({ state: "succeeded" }), live: true });
		strictEqual(await resolveIsRunDead("r", d), true);
	});

	it("terminal state => dead (failed)", async () => {
		const d = deps({ run: runRec({ state: "failed" }), live: true });
		strictEqual(await resolveIsRunDead("r", d), true);
	});

	it("live worker PID => alive (protects a long-running task)", async () => {
		const d = deps({ run: runRec({ state: "running" }), live: true });
		strictEqual(await resolveIsRunDead("r", d), false);
	});

	it("workerPid set but not signalable => dead (crashed worker)", async () => {
		const d = deps({ run: runRec({ state: "running" }), live: false });
		strictEqual(await resolveIsRunDead("r", d), true);
	});

	it("workerPid null + fresh createdAt => alive (startup grace protects launch)", async () => {
		const d = deps({
			run: runRec({ state: "created", workerPid: null }),
			live: false,
		});
		strictEqual(await resolveIsRunDead("r", d), false);
	});

	it("workerPid null + createdAt past the grace => dead (stuck/abandoned launch)", async () => {
		const old = new Date(Date.now() - GRACE_MS - 60_000).toISOString();
		const d = deps({
			run: runRec({ state: "launching", workerPid: null, createdAt: old }),
			live: false,
		});
		strictEqual(await resolveIsRunDead("r", d), true);
	});

	it("workerPid null + unparseable createdAt => dead (cannot prove youth)", async () => {
		const d = deps({
			run: runRec({ state: "created", workerPid: null, createdAt: "nonsense" }),
			live: false,
		});
		strictEqual(await resolveIsRunDead("r", d), true);
	});
});
