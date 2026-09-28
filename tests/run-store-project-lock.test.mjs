import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	acquireProjectLock,
	advanceState,
	getStateRoot,
	initializeRun,
	isProjectLockHeld,
	isProjectLockOwnedBy,
	LockError,
	readMutationOperation,
	readRun,
	reconcileProjectLockClaims,
	releaseProjectLock,
	releaseProjectLockIfOwnedBy,
	runStoreTesting,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import {
	makeOptions,
	RUN_STORE_MODULE_URL,
	TEST_ROOT,
	uniquePath,
	uniqueRunId,
	VM_ADMISSION_ROOT,
} from "./helpers/run-store-fixtures.mjs";

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
function projectLockFilePath(canonicalProjectPath) {
	const identity = `project:${resolve(canonicalProjectPath)}`;
	const hash = createHash("sha256").update(identity).digest("hex");
	return resolve(getStateRoot(), "locks", `${hash}.lock`);
}
function projectLockClaimFilePath(canonicalProjectPath) {
	return `${projectLockFilePath(canonicalProjectPath)}.recovery-claim`;
}
function cwdDerivedProjectLockFilePath(canonicalProjectPath) {
	const historicalKeyPath = resolve(
		canonicalProjectPath,
		`project:${canonicalProjectPath}`,
	);
	const hash = createHash("sha256").update(historicalKeyPath).digest("hex");
	return resolve(getStateRoot(), "locks", `${hash}.lock`);
}
describe("project lock", () => {
	it("two acquires on different project paths succeed", async () => {
		const path1 = uniquePath("proj-a");
		const path2 = uniquePath("proj-b");
		const runId1 = uniqueRunId();
		const runId2 = uniqueRunId();

		await acquireProjectLock(path1, runId1);
		await acquireProjectLock(path2, runId2);

		ok(true);
	});

	it("two acquires on the same project path fails", async () => {
		const path = uniquePath("project");
		const runId1 = uniqueRunId();
		const runId2 = uniqueRunId();

		await acquireProjectLock(path, runId1);
		await rejects(acquireProjectLock(path, runId2), LockError);
	});

	it("uses one canonical identity across child-process working directories", async () => {
		const projectPath = uniquePath("cross-cwd-project");
		const cwdA = uniquePath("cross-cwd-a");
		const cwdB = uniquePath("cross-cwd-b");
		mkdirSync(cwdA, { recursive: true });
		mkdirSync(cwdB, { recursive: true });
		const firstRunId = uniqueRunId();
		const secondRunId = uniqueRunId();
		const childSource = (runId) => `
			import { acquireProjectLock } from ${JSON.stringify(RUN_STORE_MODULE_URL)};
			try {
				await acquireProjectLock(${JSON.stringify(projectPath)}, ${JSON.stringify(runId)});
				console.log("acquired");
			} catch (error) {
				console.log(error.code ?? "unknown");
				process.exitCode = 1;
			}`;
		const invoke = (cwd, runId) =>
			new Promise((resolveChild, reject) => {
				const child = spawn(
					process.execPath,
					["--input-type=module", "-e", childSource(runId)],
					{
						cwd,
						env: {
							...process.env,
							SWITCHYARD_RUN_STORE_ROOT: getStateRoot(),
						},
					},
				);
				let output = "";
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (chunk) => {
					output += chunk;
				});
				child.once("error", reject);
				child.once("exit", (code) => resolveChild({ code, output }));
			});

		const first = await invoke(cwdA, firstRunId);
		const second = await invoke(cwdB, secondRunId);
		strictEqual(first.code, 0);
		strictEqual(first.output.trim(), "acquired");
		strictEqual(second.code, 1);
		strictEqual(second.output.trim(), "PROJECT_LOCK_HELD");
		await releaseProjectLock(projectPath, firstRunId);
	});

	it("isProjectLockHeld reflects lock state", async () => {
		const path = uniquePath("project");
		const runId = uniqueRunId();
		strictEqual(isProjectLockHeld(path), false);

		await acquireProjectLock(path, runId);
		strictEqual(isProjectLockHeld(path), true);

		await releaseProjectLock(path, runId);
		strictEqual(isProjectLockHeld(path), false);
	});

	it("release then re-acquire with a different runId succeeds", async () => {
		const path = uniquePath("project");
		const runId = uniqueRunId();
		await acquireProjectLock(path, runId);
		await releaseProjectLock(path, runId);
		await acquireProjectLock(path, uniqueRunId());
		ok(true);
	});

	it("release on non-existent lock does not throw", async () => {
		await releaseProjectLock(uniquePath("nonexistent"), uniqueRunId());
		ok(true);
	});

	it("lock body includes projectPath alongside runId and createdAt", async () => {
		const path = uniquePath("project");
		const runId = uniqueRunId();

		await acquireProjectLock(path, runId);

		const raw = await readFile(projectLockFilePath(path), "utf8");
		const body = JSON.parse(raw);
		strictEqual(body.projectPath, path);
		strictEqual(body.runId, runId);
		ok(typeof body.createdAt === "string");
	});

	it("checks project-lock ownership instead of path-wide lock presence", async () => {
		const path = uniquePath("project-owner");
		const ownerRunId = uniqueRunId();
		const staleRunId = uniqueRunId();

		await acquireProjectLock(path, ownerRunId);

		strictEqual(await isProjectLockOwnedBy(path, ownerRunId), true);
		strictEqual(await isProjectLockOwnedBy(path, staleRunId), false);
		strictEqual(isProjectLockHeld(path), true);
	});

	it("keeps legacy project-lock ownership and release compatible", async () => {
		const path = uniquePath("legacy-project-owner");
		const runId = uniqueRunId();
		await acquireProjectLock(path, runId);
		writeFileSync(
			projectLockFilePath(path),
			JSON.stringify({ runId, createdAt: new Date().toISOString() }),
			"utf8",
		);

		strictEqual(await isProjectLockOwnedBy(path, runId), true);
		strictEqual(await releaseProjectLockIfOwnedBy(path, runId), true);
		strictEqual(isProjectLockHeld(path), false);
	});

	it("persists the default ownership-checked release mutation", async () => {
		const projectPath = uniquePath("durable-project-owner");
		const runId = uniqueRunId();
		await initializeRun({
			runId,
			tasksFilePath: uniquePath("durable-tasks"),
			projectPath,
			orderedTaskIds: [],
			initialHostFingerprint: "test-host",
		});
		await acquireProjectLock(projectPath, runId);

		let firstRemovals = 0;
		strictEqual(
			await releaseProjectLockIfOwnedBy(projectPath, runId, {
				onRemoved: () => {
					firstRemovals += 1;
				},
			}),
			true,
		);
		strictEqual(await isProjectLockOwnedBy(projectPath, runId), false);
		strictEqual(firstRemovals, 1);
		let replayRemovals = 0;
		strictEqual(
			await releaseProjectLockIfOwnedBy(projectPath, runId, {
				onRemoved: () => {
					replayRemovals += 1;
				},
			}),
			false,
		);
		strictEqual(replayRemovals, 0);
		const run = await readRun(runId);
		strictEqual(run.mutationOperations.length, 1);
		const [operation] = run.mutationOperations;
		strictEqual(operation.operation, "project_lock_release");
		strictEqual(operation.state, "completed");
		strictEqual(operation.outcome, "confirmed");
		strictEqual(
			(await readMutationOperation(runId, operation.operationId)).state,
			"completed",
		);
	});

	it("matches an equivalent trailing-slash project path in a stored lock body", async () => {
		const path = uniquePath("equivalent-project-path");
		const runId = uniqueRunId();
		await acquireProjectLock(path, runId);
		const lockPath = projectLockFilePath(path);
		writeFileSync(
			lockPath,
			JSON.stringify({
				runId,
				projectPath: `${path}/`,
				createdAt: new Date().toISOString(),
			}),
		);

		strictEqual(await isProjectLockOwnedBy(path, runId), true);
		strictEqual(await releaseProjectLockIfOwnedBy(path, runId), true);
	});

	it("blocks and releases a body-validated historical filename", async () => {
		const projectPath = uniquePath("historical-project");
		const ownerRunId = uniqueRunId();
		const historicalPath = join(
			getStateRoot(),
			"locks",
			`${createHash("sha256").update(uniqueRunId()).digest("hex")}.lock`,
		);
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(
			historicalPath,
			JSON.stringify({
				runId: ownerRunId,
				projectPath,
				createdAt: new Date().toISOString(),
			}),
		);

		await rejects(
			acquireProjectLock(projectPath, uniqueRunId()),
			(error) =>
				error instanceof LockError &&
				error.code === "PROJECT_LOCK_RECOVERY_IN_PROGRESS",
		);
		strictEqual(
			await releaseProjectLockIfOwnedBy(projectPath, ownerRunId),
			true,
		);
		strictEqual(existsSync(historicalPath), false);
	});

	it("fails closed when the canonical recovery claim is malformed", async () => {
		const projectPath = uniquePath("malformed-canonical-claim");
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(projectLockClaimFilePath(projectPath), "not-json", "utf8");

		await rejects(
			acquireProjectLock(projectPath, uniqueRunId()),
			(error) =>
				error instanceof LockError &&
				error.code === "PROJECT_LOCK_RECOVERY_IN_PROGRESS",
		);
		strictEqual(existsSync(projectLockFilePath(projectPath)), false);
		strictEqual(existsSync(projectLockClaimFilePath(projectPath)), true);
	});

	it("blocks pre-projectPath cwd-derived locks and claims", async () => {
		const projectPath = uniquePath("pre-project-path-historical");
		const ownerRunId = uniqueRunId();
		const historicalLockPath = cwdDerivedProjectLockFilePath(projectPath);
		const ownerRaw = JSON.stringify({
			runId: ownerRunId,
			createdAt: new Date().toISOString(),
		});
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(historicalLockPath, ownerRaw);
		strictEqual(isProjectLockHeld(projectPath), true);

		await rejects(
			acquireProjectLock(projectPath, uniqueRunId()),
			(error) =>
				error instanceof LockError &&
				error.code === "PROJECT_LOCK_RECOVERY_IN_PROGRESS",
		);
		strictEqual(await releaseProjectLock(projectPath, ownerRunId), true);
		strictEqual(isProjectLockHeld(projectPath), false);

		writeFileSync(`${historicalLockPath}.recovery-claim`, ownerRaw);
		strictEqual(isProjectLockHeld(projectPath), true);
		await rejects(
			acquireProjectLock(projectPath, uniqueRunId()),
			(error) =>
				error instanceof LockError &&
				error.code === "PROJECT_LOCK_RECOVERY_IN_PROGRESS",
		);
		strictEqual(await releaseProjectLock(projectPath, ownerRunId), true);
		strictEqual(isProjectLockHeld(projectPath), false);
	});

	it("never deletes a replacement published after an atomic body take", async () => {
		const opts = makeOptions({ projectPath: uniquePath("atomic-take") });
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		const current = await readRun(opts.runId);
		await updateRun(opts.runId, { cleanupState: "complete" }, current.revision);
		const lockPath = join(
			getStateRoot(),
			"locks",
			`${createHash("sha256").update(uniqueRunId()).digest("hex")}.lock`,
		);
		const expectedRaw = JSON.stringify({
			runId: opts.runId,
			projectPath: opts.projectPath,
			createdAt: new Date().toISOString(),
		});
		const replacementRaw = JSON.stringify({ runId: uniqueRunId() });
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(lockPath, expectedRaw);

		strictEqual(
			await runStoreTesting.unlinkBodyMatched(lockPath, expectedRaw, {
				afterRename: async (proofPath) => {
					deepStrictEqual(await reconcileProjectLockClaims(), []);
					strictEqual(existsSync(proofPath), true);
					writeFileSync(lockPath, replacementRaw);
				},
			}),
			true,
		);
		strictEqual(readFileSync(lockPath, "utf8"), replacementRaw);
	});

	it("blocks and reconciles a crashed pre-projectPath claim proof", async () => {
		const opts = makeOptions({ projectPath: uniquePath("legacy-proof") });
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		const current = await readRun(opts.runId);
		await updateRun(opts.runId, { cleanupState: "complete" }, current.revision);
		const historicalClaimPath = `${cwdDerivedProjectLockFilePath(opts.projectPath)}.recovery-claim`;
		const ownerRaw = JSON.stringify({
			runId: opts.runId,
			createdAt: new Date().toISOString(),
		});
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(historicalClaimPath, ownerRaw);
		let liveProofPath;

		await rejects(
			runStoreTesting.unlinkBodyMatched(historicalClaimPath, ownerRaw, {
				afterRename: async (proofPath) => {
					liveProofPath = proofPath;
					throw new Error("simulated crash");
				},
			}),
			/simulated crash/,
		);
		strictEqual(isProjectLockHeld(opts.projectPath), true);
		await rejects(
			acquireProjectLock(opts.projectPath, uniqueRunId()),
			(error) =>
				error instanceof LockError &&
				error.code === "PROJECT_LOCK_RECOVERY_IN_PROGRESS",
		);

		const deadProofPath = `${historicalClaimPath}.99999999.${randomUUID()}.lock.recovery-claim`;
		renameSync(liveProofPath, deadProofPath);
		let repeatedProofPath;
		await rejects(
			runStoreTesting.unlinkBodyMatched(deadProofPath, ownerRaw, {
				afterRename: async (proofPath) => {
					repeatedProofPath = proofPath;
					throw new Error("simulated reconciliation crash");
				},
			}),
			/simulated reconciliation crash/,
		);
		strictEqual(isProjectLockHeld(opts.projectPath), true);
		const retryableDeadProofPath = `${historicalClaimPath}.99999998.${randomUUID()}.lock.recovery-claim`;
		renameSync(repeatedProofPath, retryableDeadProofPath);
		deepStrictEqual(await reconcileProjectLockClaims(), [opts.runId]);
		strictEqual(existsSync(retryableDeadProofPath), false);
		strictEqual(isProjectLockHeld(opts.projectPath), false);
	});

	it("uses the injected PID probe to retain a live recovery proof", async () => {
		const opts = makeOptions({
			projectPath: uniquePath("injected-live-proof"),
		});
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		await updateRun(
			opts.runId,
			{ cleanupState: "complete" },
			(await readRun(opts.runId)).revision,
		);
		const claimPath = projectLockClaimFilePath(opts.projectPath);
		const proofOwnerPid = 99999999;
		const proofPath = `${claimPath}.${proofOwnerPid}.${randomUUID()}.lock.recovery-claim`;
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(
			proofPath,
			JSON.stringify({
				runId: opts.runId,
				projectPath: opts.projectPath,
				createdAt: new Date().toISOString(),
			}),
		);

		deepStrictEqual(
			await reconcileProjectLockClaims({
				probePid: (pid) => (pid === proofOwnerPid ? "live" : "dead"),
			}),
			[],
		);
		strictEqual(existsSync(proofPath), true);
	});
});
