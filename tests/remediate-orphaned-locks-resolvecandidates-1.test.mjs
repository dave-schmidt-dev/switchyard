import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	resolveCandidates,
	run,
} from "../src/switchyard/dispatch/remediate-orphaned-locks.mjs";
import {
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
function cwdDerivedProjectLockFilePath(canonicalProjectPath) {
	const historicalKeyPath = resolve(
		canonicalProjectPath,
		`project:${canonicalProjectPath}`,
	);
	const hash = createHash("sha256").update(historicalKeyPath).digest("hex");
	return resolve(getStateRoot(), "locks", `${hash}.lock`);
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
describe("resolveCandidates", () => {
	it("returns an empty array when the locks directory does not exist", async () => {
		const descriptors = await resolveCandidates();
		strictEqual(descriptors.length, 0);
	});
	it("never touches a lock with an unparseable body, regardless of age", async () => {
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		const p = join(getStateRoot(), "locks", "corrupt.lock");
		writeFileSync(p, "not json {{{");

		const [d] = await resolveCandidates();
		strictEqual(d.category, "unparseable");
		strictEqual(d.isCandidate, false);
	});
	it("flags a post-F.1 project lock on a stale run as a candidate", async () => {
		const opts = await makeStaleRun();
		await acquireProjectLock(opts.projectPath, opts.runId);

		const descriptors = await resolveCandidates();
		const d = descriptors.find((x) => x.runId === opts.runId);
		ok(d, "descriptor for the stale run should be present");
		strictEqual(d.category, "project-lock-stale");
		strictEqual(d.isCandidate, true);
		strictEqual(d.projectPath, opts.projectPath);
	});
	it("treats a deferred terminal run as stale for lock remediation", async () => {
		const opts = await makeStaleRun({});
		const current = await readRun(opts.runId);
		await updateRun(opts.runId, { state: "deferred" }, current.revision);
		await acquireProjectLock(opts.projectPath, opts.runId);

		const [descriptor] = await resolveCandidates();
		strictEqual(descriptor.category, "project-lock-stale");
		strictEqual(descriptor.isCandidate, true);
	});
	it("never flags a post-F.1 project lock on a live run", async () => {
		const opts = await makeLiveRun();
		await acquireProjectLock(opts.projectPath, opts.runId);

		const descriptors = await resolveCandidates();
		const d = descriptors.find((x) => x.runId === opts.runId);
		ok(d);
		strictEqual(d.category, "project-lock-live");
		strictEqual(d.isCandidate, false);
	});
	it("offers a cleanup-failed canonical lock only for a proven dead worker", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await advanceState(opts.runId, "running");
		const current = await readRun(opts.runId);
		await updateRun(
			opts.runId,
			{ state: "recovery_required", cleanupState: "failed" },
			current.revision,
		);
		await acquireProjectLock(opts.projectPath, opts.runId);
		const afterGrace = Date.now() + RUN_STARTUP_GRACE_MS + 1;

		const [descriptor] = await resolveCandidates({ now: afterGrace });
		strictEqual(descriptor.category, "project-lock-cleanup-failed-dead");
		strictEqual(descriptor.isCandidate, true);
		strictEqual(descriptor.requiresInteractiveConfirmation, true);
		strictEqual(descriptor.requiresDeadWorkerRecheck, true);

		const dryRun = await run(["--dry-run"], {
			log: () => {},
			now: afterGrace,
		});
		deepStrictEqual(dryRun.removed, []);
		strictEqual(isProjectLockHeld(opts.projectPath), true);

		let prompts = 0;
		const result = await run(["--confirm"], {
			log: () => {},
			now: afterGrace,
			confirmFn: async () => {
				prompts += 1;
				return true;
			},
		});
		strictEqual(prompts, 1, "cleanup-failed locks cannot bypass confirmation");
		strictEqual(result.removed.length, 1);
		strictEqual(isProjectLockHeld(opts.projectPath), false);
	});
	it("retains a cleanup-failed lock when its worker becomes live during confirmation", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await advanceState(opts.runId, "running");
		const current = await readRun(opts.runId);
		await updateRun(
			opts.runId,
			{ state: "recovery_required", cleanupState: "failed" },
			current.revision,
		);
		await acquireProjectLock(opts.projectPath, opts.runId);
		const afterGrace = Date.now() + RUN_STARTUP_GRACE_MS + 1;
		const logs = [];

		const result = await run([], {
			log: (line) => logs.push(line),
			now: afterGrace,
			confirmFn: async () => {
				const duringConfirmation = await readRun(opts.runId);
				await updateRun(
					opts.runId,
					{ workerPid: process.pid },
					duringConfirmation.revision,
				);
				return true;
			},
		});

		deepStrictEqual(result.removed, []);
		strictEqual(isProjectLockHeld(opts.projectPath), true);
		ok(
			logs.some(
				(line) =>
					line.includes("skipped") && line.includes("no longer proven dead"),
			),
			"the remediation result should report the liveness-race skip",
		);
	});
	it("offers and ownership-safely removes a cleanup-failed cwd-derived lock", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await advanceState(opts.runId, "running");
		const current = await readRun(opts.runId);
		await updateRun(
			opts.runId,
			{ state: "recovery_required", cleanupState: "failed" },
			current.revision,
		);
		const historicalPath = cwdDerivedProjectLockFilePath(opts.projectPath);
		writeRawLockBody(historicalPath, {
			runId: opts.runId,
			projectPath: opts.projectPath,
			createdAt: new Date().toISOString(),
		});
		const afterGrace = Date.now() + RUN_STARTUP_GRACE_MS + 1;

		const [descriptor] = await resolveCandidates({ now: afterGrace });
		strictEqual(descriptor.category, "project-lock-cleanup-failed-dead");
		strictEqual(descriptor.remediationKind, "cwd-derived-project-lock");
		strictEqual(descriptor.requiresInteractiveConfirmation, true);

		const result = await run([], {
			log: () => {},
			now: afterGrace,
			confirmFn: async () => true,
		});
		strictEqual(result.removed.length, 1);
		strictEqual(existsSync(historicalPath), false);
	});
	it("confirms and removes an exact pre-F.1 cwd-derived lock", async () => {
		const opts = await makeStaleRun();
		const historicalPath = cwdDerivedProjectLockFilePath(opts.projectPath);
		writeRawLockBody(historicalPath, {
			runId: opts.runId,
			createdAt: new Date().toISOString(),
		});

		const [descriptor] = await resolveCandidates();
		strictEqual(descriptor.category, "project-lock-stale");
		strictEqual(descriptor.remediationKind, "cwd-derived-project-lock");
		const result = await run(["--confirm"], {
			log: () => {},
			confirmFn: async () => true,
		});
		deepStrictEqual(result.removed, [descriptor.name]);
		strictEqual(existsSync(historicalPath), false);
	});
	it("preserves a replacement owner on the cwd-derived lock path", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await advanceState(opts.runId, "running");
		const current = await readRun(opts.runId);
		await updateRun(
			opts.runId,
			{ state: "recovery_required", cleanupState: "failed" },
			current.revision,
		);
		const historicalPath = cwdDerivedProjectLockFilePath(opts.projectPath);
		writeRawLockBody(historicalPath, {
			runId: opts.runId,
			projectPath: opts.projectPath,
			createdAt: new Date().toISOString(),
		});
		const replacementRunId = uniqueRunId();
		const afterGrace = Date.now() + RUN_STARTUP_GRACE_MS + 1;

		const result = await run([], {
			log: () => {},
			now: afterGrace,
			confirmFn: async () => {
				writeRawLockBody(historicalPath, {
					runId: replacementRunId,
					projectPath: opts.projectPath,
					createdAt: new Date().toISOString(),
				});
				return true;
			},
		});
		deepStrictEqual(result.removed, []);
		strictEqual(existsSync(historicalPath), true);
		const replacement = JSON.parse(await readFile(historicalPath, "utf8"));
		strictEqual(replacement.runId, replacementRunId);
	});
	it("flags a project lock whose runId has no run.json as a run-missing candidate", async () => {
		const path = uniquePath("ghost");
		const ghostRunId = uniqueRunId();
		await acquireProjectLock(path, ghostRunId);

		const descriptors = await resolveCandidates();
		const d = descriptors.find((x) => x.runId === ghostRunId);
		ok(d);
		strictEqual(d.category, "run-missing");
		strictEqual(d.remediationKind, "project-lock");
		strictEqual(d.requiresInteractiveConfirmation, true);
		strictEqual(d.isCandidate, true);
		strictEqual(d.projectPath, path);
	});
	it("retains a pre-F.1 cleanup-failed lock while its worker is live", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await advanceState(opts.runId, "running");
		await updateRun(
			opts.runId,
			{
				state: "recovery_required",
				cleanupState: "failed",
				workerPid: process.pid,
			},
			(await readRun(opts.runId)).revision,
		);
		writeRawLockBody(projectLockFilePath(opts.projectPath), {
			runId: opts.runId,
			createdAt: new Date().toISOString(),
		});

		const descriptor = (await resolveCandidates()).find(
			(candidate) => candidate.runId === opts.runId,
		);
		ok(descriptor);
		strictEqual(descriptor.category, "project-lock-cleanup-failed-retained");
		strictEqual(descriptor.isCandidate, false);
	});
	it("resolves an unadorned pre-F.1 recovery claim through its run record", async () => {
		const opts = await makeStaleRun();
		await updateRun(
			opts.runId,
			{ cleanupState: "complete" },
			(await readRun(opts.runId)).revision,
		);
		const lockPath = projectLockFilePath(opts.projectPath);
		const claimPath = projectLockClaimFilePath(opts.projectPath);
		writeRawLockBody(lockPath, {
			runId: opts.runId,
			createdAt: new Date().toISOString(),
		});
		renameSync(lockPath, claimPath);

		const descriptor = (await resolveCandidates()).find(
			(candidate) => candidate.path === claimPath,
		);
		ok(descriptor);
		strictEqual(descriptor.isCandidate, true);
		const result = await run(["--confirm"], { log: () => {} });
		deepStrictEqual(result.removed, [descriptor.name]);
		strictEqual(existsSync(claimPath), false);
	});
	it("recovers projectPath via run.json for a pre-F.1 (no projectPath in body) stale lock and flags it a candidate", async () => {
		// Simulates the real 6 known orphaned locks: acquireProjectLock always
		// writes projectPath into the body now, so to reproduce the pre-F.1
		// shape we write the raw body ourselves at the same path a real
		// project lock for this run's project would occupy.
		const opts = await makeStaleRun();
		writeRawLockBody(projectLockFilePath(opts.projectPath), {
			runId: opts.runId,
			createdAt: new Date().toISOString(),
		});

		const descriptors = await resolveCandidates();
		strictEqual(descriptors.length, 1);
		const [d] = descriptors;
		strictEqual(d.category, "project-lock-stale");
		strictEqual(d.isCandidate, true);
		strictEqual(d.projectPath, opts.projectPath);
		strictEqual(d.runId, opts.runId);
	});
	it("removes a body-bound noncanonical historical lock only with matching run/project evidence", async () => {
		const opts = await makeStaleRun();
		const historicalPath = noncanonicalProjectLockFilePath(opts.projectPath);
		writeRawLockBody(historicalPath, {
			runId: opts.runId,
			projectPath: opts.projectPath,
			createdAt: new Date().toISOString(),
		});

		const [candidate] = await resolveCandidates();
		strictEqual(candidate.category, "project-lock-stale");
		strictEqual(candidate.remediationKind, "historical-project-lock");
		strictEqual(candidate.isCandidate, true);

		const result = await run(["--confirm"], { log: () => {} });
		deepStrictEqual(result.removed, [candidate.name]);
		strictEqual(existsSync(historicalPath), false);
	});
	it("keeps a body-bound noncanonical historical lock noncandidate when its run project mismatches", async () => {
		const opts = await makeStaleRun();
		const historicalPath = noncanonicalProjectLockFilePath(opts.projectPath);
		writeRawLockBody(historicalPath, {
			runId: opts.runId,
			projectPath: uniquePath("mismatched-historical-project"),
			createdAt: new Date().toISOString(),
		});

		const [descriptor] = await resolveCandidates();
		strictEqual(descriptor.category, "project-owner-mismatch");
		strictEqual(descriptor.isCandidate, false);
		strictEqual(existsSync(historicalPath), true);
	});
	it("recovers projectPath via run.json for a pre-F.1 lock but never flags it a candidate when the run is live", async () => {
		const opts = await makeLiveRun();
		writeRawLockBody(projectLockFilePath(opts.projectPath), {
			runId: opts.runId,
			createdAt: new Date().toISOString(),
		});

		const [d] = await resolveCandidates();
		strictEqual(d.category, "project-lock-live");
		strictEqual(d.isCandidate, false);
	});
});
