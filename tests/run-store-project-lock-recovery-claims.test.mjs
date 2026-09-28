import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
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
	isProjectLockHeld,
	isProjectLockOwnedBy,
	LockError,
	readRun,
	reconcileProjectLockClaims,
	releaseOrphanedProjectLocks,
	releaseProjectLockIfOwnedBy,
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
	it("allows at most one concurrent recoverer to release a terminal-clean owner", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		const current = await readRun(opts.runId);
		await updateRun(opts.runId, { cleanupState: "complete" }, current.revision);
		await acquireProjectLock(opts.projectPath, opts.runId);

		const outcomes = await Promise.all([
			releaseProjectLockIfOwnedBy(opts.projectPath, opts.runId),
			releaseProjectLockIfOwnedBy(opts.projectPath, opts.runId),
		]);
		strictEqual(outcomes.filter(Boolean).length, 1);
		strictEqual(isProjectLockHeld(opts.projectPath), false);
	});
	it("keeps live/startup/unknown claims and removes terminal/dead claims once", async () => {
		const live = makeOptions({ projectPath: uniquePath("claim-live") });
		await initializeRun(live);
		let current = await readRun(live.runId);
		await updateRun(
			live.runId,
			{ state: "running", workerPid: process.pid },
			current.revision,
		);
		await acquireProjectLock(live.projectPath, live.runId);
		renameSync(
			projectLockFilePath(live.projectPath),
			projectLockClaimFilePath(live.projectPath),
		);
		strictEqual(await isProjectLockOwnedBy(live.projectPath, live.runId), true);

		const startup = makeOptions({ projectPath: uniquePath("claim-startup") });
		await initializeRun(startup);
		await acquireProjectLock(startup.projectPath, startup.runId);
		renameSync(
			projectLockFilePath(startup.projectPath),
			projectLockClaimFilePath(startup.projectPath),
		);

		const terminal = makeOptions({ projectPath: uniquePath("claim-terminal") });
		await initializeRun(terminal);
		await advanceState(terminal.runId, "failed");
		current = await readRun(terminal.runId);
		await updateRun(
			terminal.runId,
			{ cleanupState: "complete" },
			current.revision,
		);
		await acquireProjectLock(terminal.projectPath, terminal.runId);
		renameSync(
			projectLockFilePath(terminal.projectPath),
			projectLockClaimFilePath(terminal.projectPath),
		);

		const dead = makeOptions({ projectPath: uniquePath("claim-dead") });
		await initializeRun(dead);
		current = await readRun(dead.runId);
		await updateRun(
			dead.runId,
			{ state: "running", workerPid: 999999 },
			current.revision,
		);
		await acquireProjectLock(dead.projectPath, dead.runId);
		renameSync(
			projectLockFilePath(dead.projectPath),
			projectLockClaimFilePath(dead.projectPath),
		);

		const missingPath = uniquePath("claim-missing");
		await acquireProjectLock(missingPath, uniqueRunId());
		renameSync(
			projectLockFilePath(missingPath),
			projectLockClaimFilePath(missingPath),
		);
		const malformedPath = uniquePath("claim-malformed");
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(projectLockClaimFilePath(malformedPath), "not-json");

		const reclaimed = await reconcileProjectLockClaims();
		deepStrictEqual(new Set(reclaimed), new Set([terminal.runId, dead.runId]));
		strictEqual(existsSync(projectLockClaimFilePath(live.projectPath)), true);
		strictEqual(
			existsSync(projectLockClaimFilePath(startup.projectPath)),
			true,
		);
		strictEqual(existsSync(projectLockClaimFilePath(missingPath)), true);
		strictEqual(existsSync(projectLockClaimFilePath(malformedPath)), true);
		strictEqual(
			await reconcileProjectLockClaims().then((ids) => ids.length),
			0,
		);
	});
	it("reconciles only a byte-bound reservation for a terminal owner", async () => {
		const opts = makeOptions({
			projectPath: uniquePath("reservation-terminal"),
		});
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		const current = await readRun(opts.runId);
		await updateRun(opts.runId, { cleanupState: "complete" }, current.revision);
		await acquireProjectLock(opts.projectPath, opts.runId);
		const expectedRaw = readFileSync(
			projectLockFilePath(opts.projectPath),
			"utf8",
		);
		writeFileSync(
			projectLockClaimFilePath(opts.projectPath),
			JSON.stringify({ claimState: "reservation", expectedRaw }),
			{ flag: "wx", mode: 0o600 },
		);

		deepStrictEqual(await reconcileProjectLockClaims(), [opts.runId]);
		strictEqual(existsSync(projectLockClaimFilePath(opts.projectPath)), false);
		strictEqual(
			readFileSync(projectLockFilePath(opts.projectPath), "utf8"),
			expectedRaw,
		);
	});
	it("reconciles a dead reservation proof after its lock bytes changed", async () => {
		const opts = makeOptions({ projectPath: uniquePath("reservation-proof") });
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		const current = await readRun(opts.runId);
		await updateRun(opts.runId, { cleanupState: "complete" }, current.revision);
		const expectedRaw = JSON.stringify({
			runId: opts.runId,
			projectPath: opts.projectPath,
			createdAt: new Date().toISOString(),
		});
		const replacementRaw = JSON.stringify({
			runId: uniqueRunId(),
			projectPath: opts.projectPath,
			createdAt: new Date().toISOString(),
		});
		const lockPath = projectLockFilePath(opts.projectPath);
		const proofPath = `${projectLockClaimFilePath(opts.projectPath)}.99999999.${randomUUID()}.lock.recovery-claim`;
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(lockPath, replacementRaw);
		writeFileSync(
			proofPath,
			JSON.stringify({ claimState: "reservation", expectedRaw }),
		);

		deepStrictEqual(await reconcileProjectLockClaims(), [opts.runId]);
		strictEqual(existsSync(proofPath), false);
		strictEqual(readFileSync(lockPath, "utf8"), replacementRaw);
	});
	it("reconciles historical reservation and post-rename interruption claims", async () => {
		const opts = makeOptions({ projectPath: uniquePath("historical-claim") });
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		await updateRun(
			opts.runId,
			{ cleanupState: "complete" },
			(await readRun(opts.runId)).revision,
		);
		const historicalLockPath = join(
			getStateRoot(),
			"locks",
			`${createHash("sha256").update(uniqueRunId()).digest("hex")}.lock`,
		);
		const ownerRaw = JSON.stringify({
			runId: opts.runId,
			projectPath: opts.projectPath,
			createdAt: new Date().toISOString(),
		});
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(historicalLockPath, ownerRaw);
		writeFileSync(
			`${historicalLockPath}.recovery-claim`,
			JSON.stringify({ claimState: "reservation", expectedRaw: ownerRaw }),
		);

		deepStrictEqual(await reconcileProjectLockClaims(), [opts.runId]);
		strictEqual(existsSync(`${historicalLockPath}.recovery-claim`), false);
		strictEqual(readFileSync(historicalLockPath, "utf8"), ownerRaw);

		renameSync(historicalLockPath, `${historicalLockPath}.recovery-claim`);
		deepStrictEqual(await reconcileProjectLockClaims(), [opts.runId]);
		strictEqual(existsSync(`${historicalLockPath}.recovery-claim`), false);
	});
	it("retains a claim whose project path disagrees with its run record", async () => {
		const opts = makeOptions({
			projectPath: uniquePath("claim-owner-project"),
		});
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		await updateRun(
			opts.runId,
			{ cleanupState: "complete" },
			(await readRun(opts.runId)).revision,
		);
		const mismatchedProjectPath = uniquePath("claim-mismatched-project");
		const historicalClaimPath = join(
			getStateRoot(),
			"locks",
			`${createHash("sha256").update(uniqueRunId()).digest("hex")}.lock.recovery-claim`,
		);
		const claimRaw = JSON.stringify({
			runId: opts.runId,
			projectPath: mismatchedProjectPath,
			createdAt: new Date().toISOString(),
		});
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(historicalClaimPath, claimRaw);

		deepStrictEqual(await reconcileProjectLockClaims(), []);
		strictEqual(readFileSync(historicalClaimPath, "utf8"), claimRaw);
	});
	it("retains reservations when canonical bytes change or owner is live", async () => {
		const changed = makeOptions({
			projectPath: uniquePath("reservation-changed"),
		});
		await initializeRun(changed);
		await advanceState(changed.runId, "failed");
		await acquireProjectLock(changed.projectPath, changed.runId);
		const expectedRaw = readFileSync(
			projectLockFilePath(changed.projectPath),
			"utf8",
		);
		writeFileSync(
			projectLockClaimFilePath(changed.projectPath),
			JSON.stringify({ claimState: "reservation", expectedRaw }),
		);
		writeFileSync(
			projectLockFilePath(changed.projectPath),
			JSON.stringify({
				runId: uniqueRunId(),
				projectPath: changed.projectPath,
				createdAt: new Date().toISOString(),
				holderPid: process.pid,
			}),
		);

		const live = makeOptions({ projectPath: uniquePath("reservation-live") });
		await initializeRun(live);
		await updateRun(
			live.runId,
			{ state: "running", workerPid: process.pid },
			(await readRun(live.runId)).revision,
		);
		await acquireProjectLock(live.projectPath, live.runId);
		const liveRaw = readFileSync(projectLockFilePath(live.projectPath), "utf8");
		writeFileSync(
			projectLockClaimFilePath(live.projectPath),
			JSON.stringify({ claimState: "reservation", expectedRaw: liveRaw }),
		);

		deepStrictEqual(await reconcileProjectLockClaims(), []);
		strictEqual(
			existsSync(projectLockClaimFilePath(changed.projectPath)),
			true,
		);
		strictEqual(existsSync(projectLockClaimFilePath(live.projectPath)), true);
	});
	it("rejects a displaced holder and removes only its body-matched claim", async () => {
		const owner = makeOptions({ projectPath: uniquePath("three-party") });
		await initializeRun(owner);
		await acquireProjectLock(owner.projectPath, owner.runId);
		renameSync(
			projectLockFilePath(owner.projectPath),
			projectLockClaimFilePath(owner.projectPath),
		);
		const replacementRunId = uniqueRunId();
		writeFileSync(
			projectLockFilePath(owner.projectPath),
			JSON.stringify({
				runId: replacementRunId,
				projectPath: owner.projectPath,
				createdAt: new Date().toISOString(),
				holderPid: process.pid,
			}),
			{ flag: "wx", mode: 0o600 },
		);

		await rejects(
			assertProjectLockOwnership(owner.projectPath, owner.runId),
			(error) =>
				error instanceof LockError &&
				error.code === "PROJECT_LOCK_OWNERSHIP_DISPLACED",
		);
		strictEqual(existsSync(projectLockClaimFilePath(owner.projectPath)), false);
		const canonical = JSON.parse(
			readFileSync(projectLockFilePath(owner.projectPath), "utf8"),
		);
		strictEqual(canonical.runId, replacementRunId);
	});
	it("reconciles failed displaced cleanup through both scanners without touching the replacement", async () => {
		const scanners = [
			["claim reconciler", reconcileProjectLockClaims],
			["orphan-lock scanner", releaseOrphanedProjectLocks],
		];

		for (const [scannerName, scan] of scanners) {
			const projectPath = uniquePath(`claim-cleanup-fail-${scannerName}`);
			const owner = makeOptions({ projectPath });
			await initializeRun(owner);
			await acquireProjectLock(projectPath, owner.runId);
			renameSync(
				projectLockFilePath(projectPath),
				projectLockClaimFilePath(projectPath),
			);

			const replacement = makeOptions({ projectPath });
			await initializeRun(replacement);
			let replacementRun = await readRun(replacement.runId);
			await updateRun(
				replacement.runId,
				{ state: "running", workerPid: process.pid },
				replacementRun.revision,
			);
			const replacementRaw = JSON.stringify({
				runId: replacement.runId,
				projectPath,
				createdAt: new Date().toISOString(),
				holderPid: process.pid,
			});
			writeFileSync(projectLockFilePath(projectPath), replacementRaw, {
				flag: "wx",
				mode: 0o600,
			});

			await rejects(
				assertProjectLockOwnership(projectPath, owner.runId, {
					unlinkBodyMatched: async () => false,
				}),
				(error) =>
					error instanceof LockError &&
					error.code === "PROJECT_LOCK_CLAIM_CLEANUP_FAILED",
			);
			const failed = await readRun(owner.runId);
			strictEqual(failed.state, "recovery_required", scannerName);
			strictEqual(failed.cleanupState, "failed", scannerName);
			strictEqual(
				existsSync(projectLockClaimFilePath(projectPath)),
				true,
				scannerName,
			);

			const reclaimed = await scan();
			deepStrictEqual(reclaimed, [owner.runId], scannerName);
			strictEqual(
				existsSync(projectLockClaimFilePath(projectPath)),
				false,
				scannerName,
			);
			strictEqual(
				readFileSync(projectLockFilePath(projectPath), "utf8"),
				replacementRaw,
				scannerName,
			);

			replacementRun = await readRun(replacement.runId);
			await updateRun(
				replacement.runId,
				{ workerPid: 999999 },
				replacementRun.revision,
			);
			const laterReclaimed = await releaseOrphanedProjectLocks();
			deepStrictEqual(laterReclaimed, [replacement.runId], scannerName);
			strictEqual(isProjectLockHeld(projectPath), false, scannerName);
		}
	});
});
