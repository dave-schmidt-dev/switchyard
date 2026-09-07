import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	assessRecoveryEntry,
	resolveIsRunDead,
} from "../src/switchyard/dispatch/index.mjs";

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
		cleanupState: "not_started",
		workerPid: 4242,
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

describe("resolveIsRunDead — liveness gating", () => {
	it("missing run record => dead (orphaned container)", async () => {
		strictEqual(await resolveIsRunDead("r", deps({ run: undefined })), true);
	});

	it("terminal clean state => dead/reclaimable (succeeded)", async () => {
		const d = deps({
			run: runRec({ state: "succeeded", cleanupState: "complete" }),
			live: true,
		});
		strictEqual(await resolveIsRunDead("r", d), true);
	});

	it("terminal clean state => dead/reclaimable (failed)", async () => {
		const d = deps({
			run: runRec({ state: "failed", cleanupState: "complete" }),
			live: true,
		});
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

	it("workerPid null + unparseable createdAt => held (cannot prove staleness)", async () => {
		const d = deps({
			run: runRec({ state: "created", workerPid: null, createdAt: "nonsense" }),
			live: false,
		});
		strictEqual(await resolveIsRunDead("r", d), false);
	});

	it("terminal finalizer with incomplete cleanup remains live", async () => {
		const d = deps({
			run: runRec({ state: "failed", cleanupState: "pending" }),
			live: true,
		});
		strictEqual(await resolveIsRunDead("r", d), false);
	});

	it("malformed and PID-ambiguous owners remain non-reclaimable", async () => {
		strictEqual(
			await resolveIsRunDead(
				"r",
				deps({ run: runRec({ workerPid: "4242" }), live: false }),
			),
			false,
		);
		const ambiguous = deps({ run: runRec(), live: false });
		ambiguous.classifyRunLiveness = () => "unknown";
		strictEqual(await resolveIsRunDead("r", ambiguous), false);
	});
});

describe("recovery candidate proof", () => {
	const entry = {
		uuid: "fixture-uuid",
		name: "switchyard-work-run-4242",
		runId: "run",
		creatorPid: 4242,
		status: "stopped",
	};
	const projectPath = "/private/tmp/recovery-project";

	it("authorizes only exact dead or terminal-clean run evidence", async () => {
		for (const liveness of ["dead", "terminal_clean"]) {
			const result = await assessRecoveryEntry(
				entry,
				{
					readRun: async () => ({
						runId: "run",
						projectPath,
						cleanupState: "pending",
					}),
					classifyRunLiveness: () => liveness,
				},
				projectPath,
			);
			strictEqual(result.eligible, true, liveness);
			strictEqual(result.reason, "stale_owned_resource", liveness);
		}
	});

	it("preserves live, mismatched, missing, malformed, and unknown evidence", async () => {
		const cases = [
			{
				label: "live",
				dependencies: {
					readRun: async () => ({
						runId: "run",
						projectPath,
						cleanupState: "pending",
					}),
					classifyRunLiveness: () => "live",
				},
				reason: "live_run",
			},
			{
				label: "mismatched",
				dependencies: {
					readRun: async () => ({
						runId: "other",
						projectPath,
						cleanupState: "complete",
					}),
				},
				reason: "run_identity_mismatch",
			},
			{
				label: "missing",
				dependencies: {
					readRun: async () => Promise.reject(new Error("missing")),
				},
				reason: "run_missing",
			},
			{
				label: "unknown",
				dependencies: {
					readRun: async () => ({
						runId: "run",
						projectPath,
						cleanupState: "pending",
					}),
					classifyRunLiveness: () => "unknown",
				},
				reason: "liveness_unknown",
			},
		];
		for (const testCase of cases) {
			const result = await assessRecoveryEntry(
				entry,
				testCase.dependencies,
				projectPath,
			);
			strictEqual(result.eligible, false, testCase.label);
			strictEqual(result.reason, testCase.reason, testCase.label);
		}
		const malformed = await assessRecoveryEntry(
			{ ...entry, creatorPid: "4242" },
			{},
			projectPath,
		);
		strictEqual(malformed.eligible, false);
		strictEqual(malformed.reason, "identity_malformed");
	});
});
