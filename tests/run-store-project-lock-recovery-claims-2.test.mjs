import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { createHash } from "node:crypto";
import {
	existsSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	acquireProjectLock,
	advanceState,
	assertProjectLockOwnership,
	getStateRoot,
	initializeRun,
	LockError,
	readRun,
	reconcileProjectLockClaims,
	releaseOrphanedProjectLocks,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import {
	makeOptions,
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
describe("project lock recovery claims", () => {
	it("retains cleanup-failed claims without a different valid canonical owner", async () => {
		const cases = ["absent", "malformed", "same-owner"];
		const owners = [];

		for (const scenario of cases) {
			const owner = makeOptions({
				projectPath: uniquePath(`claim-cleanup-${scenario}`),
			});
			await initializeRun(owner);
			await acquireProjectLock(owner.projectPath, owner.runId);
			const canonicalRaw = readFileSync(
				projectLockFilePath(owner.projectPath),
				"utf8",
			);
			renameSync(
				projectLockFilePath(owner.projectPath),
				projectLockClaimFilePath(owner.projectPath),
			);
			const current = await readRun(owner.runId);
			await updateRun(
				owner.runId,
				{ state: "recovery_required", cleanupState: "failed" },
				current.revision,
			);
			if (scenario === "malformed") {
				writeFileSync(projectLockFilePath(owner.projectPath), "not-json");
			} else if (scenario === "same-owner") {
				writeFileSync(projectLockFilePath(owner.projectPath), canonicalRaw);
			}
			owners.push(owner);
		}

		deepStrictEqual(await reconcileProjectLockClaims(), []);
		deepStrictEqual(await releaseOrphanedProjectLocks(), []);
		for (const owner of owners) {
			strictEqual(
				existsSync(projectLockClaimFilePath(owner.projectPath)),
				true,
				owner.projectPath,
			);
		}
	});
	it("retains cleanup-failed reservations during automatic reconciliation", async () => {
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
				expectedRaw: readFileSync(lockPath, "utf8"),
			}),
		);

		deepStrictEqual(await reconcileProjectLockClaims(), []);
		strictEqual(existsSync(lockPath), true);
		strictEqual(existsSync(claimPath), true);
	});
	it("reconciles an unadorned pre-F.1 claim through exact run/path evidence", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		await updateRun(
			opts.runId,
			{ cleanupState: "complete" },
			(await readRun(opts.runId)).revision,
		);
		await acquireProjectLock(opts.projectPath, opts.runId);
		const lockPath = projectLockFilePath(opts.projectPath);
		const claimPath = projectLockClaimFilePath(opts.projectPath);
		writeFileSync(
			lockPath,
			JSON.stringify({
				runId: opts.runId,
				createdAt: new Date().toISOString(),
			}),
		);
		renameSync(lockPath, claimPath);

		deepStrictEqual(await reconcileProjectLockClaims(), [opts.runId]);
		strictEqual(existsSync(claimPath), false);
	});
	it("uses closed codes for blocked and missing project ownership", async () => {
		const missing = makeOptions({
			projectPath: uniquePath("ownership-missing"),
		});
		await rejects(
			assertProjectLockOwnership(missing.projectPath, missing.runId),
			(error) =>
				error instanceof LockError &&
				error.code === "PROJECT_LOCK_OWNERSHIP_FAILED",
		);

		const owner = makeOptions({ projectPath: uniquePath("claim-blocked") });
		await initializeRun(owner);
		await acquireProjectLock(owner.projectPath, owner.runId);
		renameSync(
			projectLockFilePath(owner.projectPath),
			projectLockClaimFilePath(owner.projectPath),
		);
		await rejects(
			assertProjectLockOwnership(owner.projectPath, uniqueRunId()),
			(error) =>
				error instanceof LockError &&
				error.code === "PROJECT_LOCK_RECOVERY_CLAIM_BLOCKS_EXECUTION",
		);
	});
});
