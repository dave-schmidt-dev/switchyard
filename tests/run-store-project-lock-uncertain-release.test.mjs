import { ok, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { run as remediateOrphanedLocks } from "../src/switchyard/dispatch/remediate-orphaned-locks.mjs";
import { createMutationIntent } from "../src/switchyard/lifecycle/mutation-protocol.mjs";
import {
	acquireProjectLock,
	advanceState,
	getStateRoot,
	initializeRun,
	isProjectLockHeld,
	isProjectLockOwnedBy,
	readMutationOperation,
	recordMutationOperation,
	releaseProjectLockIfOwnedBy,
} from "../src/switchyard/run-store/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const TEST_ROOT = tempDir("switchyard-uncertain-release-");
const VM_ADMISSION_ROOT = join(TEST_ROOT, "vm-admission");

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

function uniqueRunId() {
	return randomUUID();
}

function uniquePath(label) {
	return join(TEST_ROOT, `path-${label || uniqueRunId()}`);
}

async function getDeadPid() {
	const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
		stdio: "ignore",
	});
	await once(child, "exit");
	return child.pid;
}

function spawnBoundedHelper() {
	return spawn(
		process.execPath,
		[
			"-e",
			"const t = setTimeout(() => {}, 60000); process.on('SIGTERM', () => { clearTimeout(t); process.exit(0); });",
		],
		{ stdio: "ignore" },
	);
}

async function terminateHelper(proc) {
	if (!proc || proc.exitCode !== null) return;
	proc.kill("SIGTERM");
	const timer = setTimeout(() => {
		try {
			proc.kill("SIGKILL");
		} catch {
			// no-op
		}
	}, 1000);
	await once(proc, "exit");
	clearTimeout(timer);
}

function makeReleaseOperation(projectPath, runId) {
	const resource = `lock-${createHash("sha256")
		.update(`${resolve(projectPath)}:${runId}`, "utf8")
		.digest("hex")
		.slice(0, 32)}`;
	const policy = {
		maxAttempts: 2,
		idempotency: "idempotent",
		reconcile: true,
	};
	return createMutationIntent({
		operation: "project_lock_release",
		resource,
		policy,
	});
}

describe("uncertain idempotent project lock release", () => {
	it("retries an uncertain release with a dead holder pid and returns true on the next call", async () => {
		const projectPath = uniquePath("dead-holder-retry");
		const runId = uniqueRunId();
		await initializeRun({
			runId,
			tasksFilePath: uniquePath("tasks"),
			projectPath,
			orderedTaskIds: ["task-1"],
			initialHostFingerprint: "test-host",
		});

		const deadPid = await getDeadPid();
		const lockPath = projectLockFilePath(projectPath);
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(
			lockPath,
			JSON.stringify({
				runId,
				projectPath,
				createdAt: new Date().toISOString(),
				holderPid: deadPid,
			}),
		);
		strictEqual(isProjectLockHeld(projectPath), true);
		strictEqual(await isProjectLockOwnedBy(projectPath, runId), true);

		const intent = makeReleaseOperation(projectPath, runId);
		await recordMutationOperation(runId, {
			...intent,
			state: "uncertain",
			outcome: "ambiguous",
			code: "observation_timed_out",
			attempt: 1,
		});

		let removals = 0;
		const released = await releaseProjectLockIfOwnedBy(projectPath, runId, {
			onRemoved: () => {
				removals += 1;
			},
		});
		strictEqual(released, true);
		strictEqual(removals, 1);
		strictEqual(isProjectLockHeld(projectPath), false);
		strictEqual(await isProjectLockOwnedBy(projectPath, runId), false);

		const recorded = await readMutationOperation(runId, intent.operationId);
		strictEqual(recorded.state, "completed");
		strictEqual(recorded.outcome, "confirmed");

		// Replay after completion returns false
		const replayReleased = await releaseProjectLockIfOwnedBy(
			projectPath,
			runId,
		);
		strictEqual(replayReleased, false);
	});

	it("completes an uncertain release when lock is already no longer owned", async () => {
		const projectPath = uniquePath("already-released");
		const runId = uniqueRunId();
		await initializeRun({
			runId,
			tasksFilePath: uniquePath("tasks"),
			projectPath,
			orderedTaskIds: ["task-1"],
			initialHostFingerprint: "test-host",
		});

		const intent = makeReleaseOperation(projectPath, runId);
		await recordMutationOperation(runId, {
			...intent,
			state: "uncertain",
			outcome: "ambiguous",
			code: "observation_timed_out",
			attempt: 1,
		});

		strictEqual(isProjectLockHeld(projectPath), false);

		const released = await releaseProjectLockIfOwnedBy(projectPath, runId);
		strictEqual(released, true);

		const recorded = await readMutationOperation(runId, intent.operationId);
		strictEqual(recorded.state, "completed");
		strictEqual(recorded.outcome, "confirmed");
	});

	it("retains the lock when holder pid is live foreign and not the caller", async () => {
		const projectPath = uniquePath("live-foreign-holder");
		const runId = uniqueRunId();
		await initializeRun({
			runId,
			tasksFilePath: uniquePath("tasks"),
			projectPath,
			orderedTaskIds: ["task-1"],
			initialHostFingerprint: "test-host",
		});

		const liveHelper = spawnBoundedHelper();
		try {
			const lockPath = projectLockFilePath(projectPath);
			mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
			writeFileSync(
				lockPath,
				JSON.stringify({
					runId,
					projectPath,
					createdAt: new Date().toISOString(),
					holderPid: liveHelper.pid,
				}),
			);
			strictEqual(isProjectLockHeld(projectPath), true);

			const intent = makeReleaseOperation(projectPath, runId);
			await recordMutationOperation(runId, {
				...intent,
				state: "uncertain",
				outcome: "ambiguous",
				code: "observation_timed_out",
				attempt: 1,
			});

			let removals = 0;
			const released = await releaseProjectLockIfOwnedBy(projectPath, runId, {
				onRemoved: () => {
					removals += 1;
				},
			});
			strictEqual(released, false);
			strictEqual(removals, 0);
			strictEqual(isProjectLockHeld(projectPath), true);
			strictEqual(await isProjectLockOwnedBy(projectPath, runId), true);
			strictEqual(existsSync(lockPath), true);

			const recorded = await readMutationOperation(runId, intent.operationId);
			strictEqual(recorded.state, "uncertain");
		} finally {
			await terminateHelper(liveHelper);
		}
	});

	it("remediation output contains release_uncertain when lock release remains uncertain", async () => {
		const projectPath = uniquePath("remediate-uncertain");
		const runId = uniqueRunId();
		await initializeRun({
			runId,
			tasksFilePath: uniquePath("tasks"),
			projectPath,
			orderedTaskIds: ["task-1"],
			initialHostFingerprint: "test-host",
		});
		await advanceState(runId, "failed");

		const liveHelper = spawnBoundedHelper();
		try {
			const lockPath = projectLockFilePath(projectPath);
			mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
			writeFileSync(
				lockPath,
				JSON.stringify({
					runId,
					projectPath,
					createdAt: new Date().toISOString(),
					holderPid: liveHelper.pid,
				}),
			);
			strictEqual(isProjectLockHeld(projectPath), true);

			const intent = makeReleaseOperation(projectPath, runId);
			await recordMutationOperation(runId, {
				...intent,
				state: "uncertain",
				outcome: "ambiguous",
				code: "observation_timed_out",
				attempt: 1,
			});

			const logs = [];
			const result = await remediateOrphanedLocks(["--confirm"], {
				log: (msg) => logs.push(msg),
			});

			strictEqual(result.exitCode, 0);
			strictEqual(isProjectLockHeld(projectPath), true);
			strictEqual(existsSync(lockPath), true);

			const uncertainLogged = logs.some((msg) =>
				msg.includes("release_uncertain"),
			);
			ok(
				uncertainLogged,
				`Expected logs to contain release_uncertain. Logs:\n${logs.join("\n")}`,
			);
		} finally {
			await terminateHelper(liveHelper);
		}
	});

	it("releases lock when holder pid is current process", async () => {
		const projectPath = uniquePath("current-process-holder");
		const runId = uniqueRunId();
		await initializeRun({
			runId,
			tasksFilePath: uniquePath("tasks"),
			projectPath,
			orderedTaskIds: ["task-1"],
			initialHostFingerprint: "test-host",
		});

		await acquireProjectLock(projectPath, runId);
		strictEqual(isProjectLockHeld(projectPath), true);

		const intent = makeReleaseOperation(projectPath, runId);
		await recordMutationOperation(runId, {
			...intent,
			state: "uncertain",
			outcome: "ambiguous",
			code: "observation_timed_out",
			attempt: 1,
		});

		const released = await releaseProjectLockIfOwnedBy(projectPath, runId);
		strictEqual(released, true);
		strictEqual(isProjectLockHeld(projectPath), false);

		const recorded = await readMutationOperation(runId, intent.operationId);
		strictEqual(recorded.state, "completed");
		strictEqual(recorded.outcome, "confirmed");
	});
});
