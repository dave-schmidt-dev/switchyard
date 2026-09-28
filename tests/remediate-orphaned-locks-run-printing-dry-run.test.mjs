import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	resolveCandidates,
	run,
} from "../src/switchyard/dispatch/remediate-orphaned-locks.mjs";
import {
	acquireLaunchLock,
	acquireProjectLock,
	advanceState,
	getStateRoot,
	initializeRun,
	isProjectLockHeld,
	readRun,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import { RUN_STARTUP_GRACE_MS } from "../src/switchyard/run-store/run-liveness.mjs";
import {
	makeOptions,
	projectLockFilePath,
	TEST_ROOT,
	uniquePath,
	uniqueRunId,
} from "./helpers/remediate-orphaned-locks-fixtures.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_ROOT, "store");
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
	} catch {
		// no-op
	}
});
function projectLockClaimFilePath(canonicalProjectPath) {
	return `${projectLockFilePath(canonicalProjectPath)}.recovery-claim`;
}
function noncanonicalProjectLockFilePath(canonicalProjectPath) {
	const hash = createHash("sha256")
		.update(`historical:${resolve(canonicalProjectPath)}`)
		.digest("hex");
	return resolve(getStateRoot(), "locks", `${hash}.lock`);
}
async function makeStaleRun(overrides = {}) {
	const opts = makeOptions(overrides);
	await initializeRun(opts);
	await advanceState(opts.runId, "failed");
	return opts;
}
async function makeLiveRun(overrides = {}) {
	const opts = makeOptions(overrides);
	await initializeRun(opts);
	await advanceState(opts.runId, "running");
	const current = await readRun(opts.runId);
	await updateRun(opts.runId, { workerPid: process.pid }, current.revision);
	return opts;
}
function writeRawLockBody(lockPath, body) {
	mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
	writeFileSync(lockPath, JSON.stringify(body), { mode: 0o600 });
}
describe("run() — printing and dry-run", () => {
	it("prints the candidate set before any destructive action, even in dry-run mode", async () => {
		const opts = await makeStaleRun();
		await acquireProjectLock(opts.projectPath, opts.runId);

		const logs = [];
		const result = await run(["--dry-run"], { log: (m) => logs.push(m) });

		strictEqual(result.exitCode, 0);
		deepStrictEqual(result.removed, []);
		ok(
			logs.some((l) => l.includes(opts.runId)),
			"candidate runId should appear in the printed table",
		);
		ok(
			logs.some((l) => l.includes("DRY RUN")),
			"dry-run banner should be printed",
		);
		strictEqual(
			isProjectLockHeld(opts.projectPath),
			true,
			"dry-run must never remove anything",
		);
	});

	it("dry-run never invokes the release dependency", async () => {
		const opts = await makeStaleRun();
		await acquireProjectLock(opts.projectPath, opts.runId);

		let releaseCalls = 0;
		await run(["--dry-run"], {
			log: () => {},
			releaseProjectLockIfOwnedBy: async () => {
				releaseCalls += 1;
				return true;
			},
		});

		strictEqual(releaseCalls, 0);
		strictEqual(isProjectLockHeld(opts.projectPath), true);
	});

	it("prints 'no candidates' and exits 0 cleanly when nothing is orphaned", async () => {
		const logs = [];
		const result = await run([], { log: (m) => logs.push(m) });
		strictEqual(result.exitCode, 0);
		ok(logs.some((l) => l.includes("no candidates")));
	});
});
describe("run() — confirmation gating", () => {
	it("skips a cleanup-failed claim when the refreshed run lacks project identity", async () => {
		const candidatePath = join(
			getStateRoot(),
			"locks",
			"missing-project.lock.recovery-claim",
		);
		const result = await run(["--confirm"], {
			log: () => {},
			confirmFn: async () => true,
			now: RUN_STARTUP_GRACE_MS + 1,
			resolveCandidates: async () => [
				{
					name: "missing-project.lock.recovery-claim",
					path: candidatePath,
					runId: uniqueRunId(),
					projectPath: uniquePath("expected-project"),
					isCandidate: true,
					remediationKind: "recovery-claim",
					requiresInteractiveConfirmation: true,
					requiresDeadWorkerRecheck: true,
				},
			],
			reconcileProjectLockClaims: async () => [],
			readRun: async () => ({
				state: "recovery_required",
				cleanupState: "failed",
				workerPid: null,
				createdAt: new Date(0).toISOString(),
			}),
		});

		deepStrictEqual(result.removed, []);
	});

	it("removes a cleanup-failed dead-worker claim only after confirmation and fresh proof", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await advanceState(opts.runId, "running");
		await updateRun(
			opts.runId,
			{ state: "recovery_required", cleanupState: "failed" },
			(await readRun(opts.runId)).revision,
		);
		await acquireProjectLock(opts.projectPath, opts.runId);
		const claimPath = projectLockClaimFilePath(opts.projectPath);
		writeFileSync(
			claimPath,
			await readFile(projectLockFilePath(opts.projectPath), "utf8"),
		);
		writeFileSync(projectLockFilePath(opts.projectPath), "");
		const afterGrace = Date.now() + RUN_STARTUP_GRACE_MS + 1;

		const result = await run(["--confirm"], {
			log: () => {},
			now: afterGrace,
			confirmFn: async () => true,
		});

		deepStrictEqual(result.removed, [claimPath.split("/").at(-1)]);
		strictEqual(existsSync(claimPath), false);
	});

	it("retains a cleanup-failed reservation when its worker revives during confirmation", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await advanceState(opts.runId, "running");
		await updateRun(
			opts.runId,
			{ state: "recovery_required", cleanupState: "failed" },
			(await readRun(opts.runId)).revision,
		);
		await acquireProjectLock(opts.projectPath, opts.runId);
		const lockPath = projectLockFilePath(opts.projectPath);
		const claimPath = projectLockClaimFilePath(opts.projectPath);
		writeFileSync(
			claimPath,
			JSON.stringify({
				claimState: "reservation",
				expectedRaw: await readFile(lockPath, "utf8"),
			}),
		);
		const afterGrace = Date.now() + RUN_STARTUP_GRACE_MS + 1;

		const result = await run([], {
			log: () => {},
			now: afterGrace,
			confirmFn: async () => {
				const current = await readRun(opts.runId);
				await updateRun(
					opts.runId,
					{ workerPid: process.pid },
					current.revision,
				);
				return true;
			},
		});

		deepStrictEqual(result.removed, []);
		strictEqual(existsSync(lockPath), true);
		strictEqual(existsSync(claimPath), true);
	});

	it("retains a cleanup-failed claim when its worker revives during confirmation", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await advanceState(opts.runId, "running");
		await updateRun(
			opts.runId,
			{ state: "recovery_required", cleanupState: "failed" },
			(await readRun(opts.runId)).revision,
		);
		await acquireProjectLock(opts.projectPath, opts.runId);
		const claimPath = projectLockClaimFilePath(opts.projectPath);
		writeFileSync(
			claimPath,
			await readFile(projectLockFilePath(opts.projectPath), "utf8"),
		);
		writeFileSync(projectLockFilePath(opts.projectPath), "");
		const afterGrace = Date.now() + RUN_STARTUP_GRACE_MS + 1;

		const result = await run([], {
			log: () => {},
			now: afterGrace,
			confirmFn: async () => {
				const current = await readRun(opts.runId);
				await updateRun(
					opts.runId,
					{ workerPid: process.pid },
					current.revision,
				);
				return true;
			},
		});

		deepStrictEqual(result.removed, []);
		strictEqual(existsSync(claimPath), true);
	});

	it("rechecks an ordinary nonterminal stale owner after confirmation", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await advanceState(opts.runId, "running");
		await acquireProjectLock(opts.projectPath, opts.runId);
		const afterGrace = Date.now() + RUN_STARTUP_GRACE_MS + 1;

		const result = await run([], {
			log: () => {},
			now: afterGrace,
			confirmFn: async () => {
				const current = await readRun(opts.runId);
				await updateRun(
					opts.runId,
					{ workerPid: process.pid },
					current.revision,
				);
				return true;
			},
		});

		deepStrictEqual(result.removed, []);
		strictEqual(isProjectLockHeld(opts.projectPath), true);
	});

	it("reports every matching artifact removed by one release", async () => {
		const opts = await makeStaleRun();
		await acquireProjectLock(opts.projectPath, opts.runId);
		const historicalPath = noncanonicalProjectLockFilePath(opts.projectPath);
		writeRawLockBody(historicalPath, {
			runId: opts.runId,
			projectPath: opts.projectPath,
			createdAt: new Date().toISOString(),
		});
		const logs = [];

		const result = await run(["--confirm"], {
			log: (line) => logs.push(line),
		});

		strictEqual(result.removed.length, 2);
		strictEqual(logs.filter((line) => line.includes("removed ")).length, 3);
		strictEqual(
			logs.some((line) => line.includes("no longer owned")),
			false,
		);
	});

	it("reconciles a valid recovery claim through the run-store ownership check", async () => {
		const opts = await makeStaleRun();
		const current = await readRun(opts.runId);
		await updateRun(opts.runId, { cleanupState: "complete" }, current.revision);
		await acquireProjectLock(opts.projectPath, opts.runId);
		const canonicalPath = projectLockFilePath(opts.projectPath);
		const expectedRaw = await readFile(canonicalPath, "utf8");
		const claimPath = projectLockClaimFilePath(opts.projectPath);
		writeFileSync(
			claimPath,
			JSON.stringify({ claimState: "reservation", expectedRaw }),
		);

		const result = await run(["--confirm"], { log: () => {} });
		strictEqual(result.removed.length, 2);
		strictEqual(existsSync(claimPath), false);
		strictEqual(isProjectLockHeld(opts.projectPath), false);
	});

	it("declining the interactive prompt leaves the fixture lock untouched", async () => {
		const opts = await makeStaleRun();
		await acquireProjectLock(opts.projectPath, opts.runId);

		let confirmCalls = 0;
		const result = await run([], {
			log: () => {},
			confirmFn: async () => {
				confirmCalls += 1;
				return false;
			},
		});

		strictEqual(confirmCalls, 1, "the operator must be prompted");
		deepStrictEqual(result.removed, []);
		strictEqual(isProjectLockHeld(opts.projectPath), true);
	});

	it("a bare invocation with no --confirm flag never removes anything without an explicit yes", async () => {
		const opts = await makeStaleRun();
		await acquireProjectLock(opts.projectPath, opts.runId);

		const result = await run([], {
			log: () => {},
			confirmFn: async () => false,
		});

		deepStrictEqual(result.removed, []);
		strictEqual(isProjectLockHeld(opts.projectPath), true);
	});

	it("accepting the interactive prompt removes the resolved candidate", async () => {
		const opts = await makeStaleRun();
		await acquireProjectLock(opts.projectPath, opts.runId);

		// Capture the expected candidate name before run() acts — resolving
		// again afterward would see an already-empty locks dir.
		const [expected] = await resolveCandidates();

		const result = await run([], {
			log: () => {},
			confirmFn: async () => true,
		});

		deepStrictEqual(result.removed, [expected.name]);
		strictEqual(isProjectLockHeld(opts.projectPath), false);
	});

	it("--confirm skips the prompt entirely and removes resolved candidates", async () => {
		const opts = await makeStaleRun();
		await acquireProjectLock(opts.projectPath, opts.runId);

		let confirmCalls = 0;
		const result = await run(["--confirm"], {
			log: () => {},
			confirmFn: async () => {
				confirmCalls += 1;
				return true;
			},
		});

		strictEqual(confirmCalls, 0, "--confirm must never invoke the prompt");
		strictEqual(result.removed.length, 1);
		strictEqual(isProjectLockHeld(opts.projectPath), false);
	});

	it("with confirmation, only the freshly-resolved candidate set is removed — never a hardcoded list", async () => {
		const stale = await makeStaleRun();
		await acquireProjectLock(stale.projectPath, stale.runId);

		const live = await makeLiveRun();
		await acquireProjectLock(live.projectPath, live.runId);

		const preF1Stale = await makeStaleRun();
		writeRawLockBody(projectLockFilePath(preF1Stale.projectPath), {
			runId: preF1Stale.runId,
			createdAt: new Date().toISOString(),
		});

		const launchRun = await makeStaleRun();
		await acquireLaunchLock(launchRun.tasksFilePath, launchRun.runId);

		const result = await run(["--confirm"], { log: () => {} });

		strictEqual(
			result.removed.length,
			2,
			"exactly the two stale, positively-resolved candidates — not the live one, not the launch lock",
		);
		strictEqual(isProjectLockHeld(stale.projectPath), false);
		strictEqual(isProjectLockHeld(preF1Stale.projectPath), false);
		strictEqual(
			isProjectLockHeld(live.projectPath),
			true,
			"the live run's lock must survive",
		);
		// The launch lock is untouched: still collides on a second acquire.
		const { LockError } = await import("../src/switchyard/run-store/index.mjs");
		let threw = false;
		try {
			await acquireLaunchLock(launchRun.tasksFilePath, uniqueRunId());
		} catch (e) {
			threw = e instanceof LockError;
		}
		ok(threw, "the launch lock must still be held");
	});
});
