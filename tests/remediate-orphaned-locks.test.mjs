// Tests for the F.3 human-confirmed remediation CLI
// (src/switchyard/dispatch/remediate-orphaned-locks.mjs). Exercised entirely
// against synthetic fixture lock/run files under a temp
// SWITCHYARD_RUN_STORE_ROOT override — the same pattern
// tests/run-store.test.mjs already uses for lock tests. Never touches the
// real .logs/switchyard state directory.

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
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
	acquireLaunchLock,
	acquireProjectLock,
	advanceState,
	getStateRoot,
	initializeRun,
	isProjectLockHeld,
	readRun,
	releaseProjectLockIfOwnedBy,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import { RUN_STARTUP_GRACE_MS } from "../src/switchyard/run-store/run-liveness.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const TEST_ROOT = tempDir("switchyard-remediate-locks-");
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

function uniqueRunId() {
	return randomUUID();
}

function uniquePath(label) {
	return join(TEST_ROOT, `path-${label || uniqueRunId()}`);
}

function makeOptions(overrides = {}) {
	// uniquePath() with no label falls back to a fresh uuid per call — unlike
	// a fixed literal label, which would hand every unlabeled makeOptions()
	// call in a test the same path and collide on acquireProjectLock.
	return {
		runId: uniqueRunId(),
		tasksFilePath: uniquePath(),
		projectPath: uniquePath(),
		orderedTaskIds: ["task-1"],
		initialHostFingerprint: { git: "abc123", worktree: "clean" },
		launchArgs: [],
		...overrides,
	};
}

// Mirrors the private lockFilePath() hashing scheme in run-store/index.mjs
// (same mirror tests/run-store.test.mjs uses) so fixtures can write a raw
// pre-F.1-shape lock body ({runId, createdAt}, no projectPath) directly at
// the exact path a real project lock for that path would occupy.
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

	it("never flags a pre-F.1-shape lock as a candidate when projectPath cannot be recovered at all", async () => {
		// No run.json anywhere for this runId, and no projectPath in the body:
		// truly unrecoverable, must never be offered for removal.
		const locksDir = join(getStateRoot(), "locks");
		mkdirSync(locksDir, { recursive: true });
		writeFileSync(
			join(locksDir, "unrecoverable.lock"),
			JSON.stringify({
				runId: uniqueRunId(),
				createdAt: new Date().toISOString(),
			}),
		);

		const [d] = await resolveCandidates();
		strictEqual(d.category, "unrecoverable");
		strictEqual(d.isCandidate, false);
	});

	it("never flags a real launch lock as a candidate (hash mismatch against the run's project lock path)", async () => {
		// A launch lock has the exact same ambiguous {runId, createdAt} body
		// shape as a pre-F.1 project lock. The scan must disambiguate by
		// filename hash, not just body shape.
		const opts = await makeStaleRun();
		await acquireLaunchLock(opts.tasksFilePath, opts.runId);

		const [d] = await resolveCandidates();
		strictEqual(d.category, "not-a-project-lock");
		strictEqual(d.isCandidate, false);
	});

	it("resolves a mixed batch to exactly the expected candidate set, never more, never less", async () => {
		const stale = await makeStaleRun();
		await acquireProjectLock(stale.projectPath, stale.runId);

		const live = await makeLiveRun();
		await acquireProjectLock(live.projectPath, live.runId);

		const ghost = { runId: uniqueRunId(), projectPath: uniquePath("ghost2") };
		await acquireProjectLock(ghost.projectPath, ghost.runId);

		const preF1Stale = await makeStaleRun();
		writeRawLockBody(projectLockFilePath(preF1Stale.projectPath), {
			runId: preF1Stale.runId,
			createdAt: new Date().toISOString(),
		});

		const launchRun = await makeStaleRun();
		await acquireLaunchLock(launchRun.tasksFilePath, launchRun.runId);

		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(join(getStateRoot(), "locks", "garbage.lock"), "{{{not json");

		const descriptors = await resolveCandidates();
		const candidateRunIds = descriptors
			.filter((d) => d.isCandidate)
			.map((d) => d.runId)
			.sort();

		deepStrictEqual(
			candidateRunIds,
			[stale.runId, ghost.runId, preF1Stale.runId].sort(),
		);
	});

	it("enumerates a valid stale recovery reservation as an ownership-safe candidate", async () => {
		const opts = await makeStaleRun();
		const current = await readRun(opts.runId);
		await updateRun(opts.runId, { cleanupState: "complete" }, current.revision);
		await acquireProjectLock(opts.projectPath, opts.runId);
		const canonicalPath = projectLockFilePath(opts.projectPath);
		const expectedRaw = await readFile(canonicalPath, "utf8");
		writeFileSync(
			projectLockClaimFilePath(opts.projectPath),
			JSON.stringify({ claimState: "reservation", expectedRaw }),
		);

		const [descriptor] = (await resolveCandidates()).filter(
			(candidate) => candidate.remediationKind === "recovery-claim",
		);
		ok(descriptor);
		strictEqual(descriptor.category, "recovery-claim-reservation-stale");
		strictEqual(descriptor.isCandidate, true);
		strictEqual(descriptor.claimState, "reservation");
	});

	it("surfaces malformed and unbound recovery claims without making them candidates", async () => {
		const locksDir = join(getStateRoot(), "locks");
		mkdirSync(locksDir, { recursive: true });
		writeFileSync(join(locksDir, "malformed.lock.recovery-claim"), "not json");
		writeFileSync(
			join(locksDir, "unbound.lock.recovery-claim"),
			JSON.stringify({
				claimState: "reservation",
				expectedRaw: JSON.stringify({
					runId: uniqueRunId(),
					projectPath: uniquePath("wrong-claim-binding"),
				}),
			}),
		);

		const claims = (await resolveCandidates()).filter(
			(candidate) => candidate.remediationKind === "recovery-claim",
		);
		strictEqual(claims.length, 2);
		for (const claim of claims) strictEqual(claim.isCandidate, false);
	});

	it("parses a dead recovery-proof filename as its original claim identity", async () => {
		const opts = await makeStaleRun();
		await updateRun(
			opts.runId,
			{ cleanupState: "complete" },
			(await readRun(opts.runId)).revision,
		);
		const claimPath = projectLockClaimFilePath(opts.projectPath);
		const proofPath = `${claimPath}.99999999.${randomUUID()}.lock.recovery-claim`;
		writeRawLockBody(proofPath, {
			runId: opts.runId,
			projectPath: opts.projectPath,
			createdAt: new Date().toISOString(),
		});

		const descriptor = (await resolveCandidates()).find(
			(candidate) => candidate.path === proofPath,
		);
		ok(descriptor);
		strictEqual(descriptor.isCandidate, true);
		strictEqual(descriptor.remediationKind, "recovery-claim");
	});

	it("binds a dead reservation proof-of-claim to its underlying project lock", async () => {
		const opts = await makeStaleRun();
		await updateRun(
			opts.runId,
			{ cleanupState: "complete" },
			(await readRun(opts.runId)).revision,
		);
		const expectedRaw = JSON.stringify({
			runId: opts.runId,
			projectPath: opts.projectPath,
			createdAt: new Date().toISOString(),
		});
		const proofPath = `${projectLockClaimFilePath(opts.projectPath)}.99999999.${randomUUID()}.lock.recovery-claim`;
		writeRawLockBody(proofPath, {
			claimState: "reservation",
			expectedRaw,
		});

		const descriptor = (await resolveCandidates()).find(
			(candidate) => candidate.path === proofPath,
		);
		ok(descriptor);
		strictEqual(descriptor.category, "recovery-claim-reservation-stale");
		strictEqual(descriptor.isCandidate, true);
	});

	it("retains a recovery proof while its recovery owner PID is live", async () => {
		const opts = await makeStaleRun();
		const proofPath = `${projectLockClaimFilePath(opts.projectPath)}.${process.pid}.${randomUUID()}.lock.recovery-claim`;
		writeRawLockBody(proofPath, {
			runId: opts.runId,
			projectPath: opts.projectPath,
			createdAt: new Date().toISOString(),
		});

		const descriptor = (await resolveCandidates()).find(
			(candidate) => candidate.path === proofPath,
		);
		ok(descriptor);
		strictEqual(descriptor.category, "recovery-claim-proof-live");
		strictEqual(descriptor.isCandidate, false);
	});

	it("uses the injected PID probe when resolving recovery-proof liveness", async () => {
		const opts = await makeStaleRun();
		const proofOwnerPid = 99999999;
		const proofPath = `${projectLockClaimFilePath(opts.projectPath)}.${proofOwnerPid}.${randomUUID()}.lock.recovery-claim`;
		writeRawLockBody(proofPath, {
			runId: opts.runId,
			projectPath: opts.projectPath,
			createdAt: new Date().toISOString(),
		});

		const descriptor = (
			await resolveCandidates({
				probePid: (pid) => (pid === proofOwnerPid ? "live" : "dead"),
			})
		).find((candidate) => candidate.path === proofPath);
		ok(descriptor);
		strictEqual(descriptor.category, "recovery-claim-proof-live");
		strictEqual(descriptor.isCandidate, false);
	});
});

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

describe("run() — time-of-check/time-of-use protection (CV-6)", () => {
	it("never removes a lock that was reassigned to a new live run since the candidate set was printed", async () => {
		// Simulate: at print time, this project's lock belonged to a stale
		// run and was correctly flagged a candidate. Before the operator's
		// confirmation is acted on, a new run legitimately re-acquired the
		// same project's lock (the stale run's own lock had already been
		// cleared through some other path). The removal step must re-check
		// ownership against the REAL, current lock file — not the stale
		// snapshot handed to it — and refuse.
		const projectPath = uniquePath("project");

		const staleOpts = makeOptions({ projectPath });
		await initializeRun(staleOpts);
		await advanceState(staleOpts.runId, "failed");
		// staleOpts's own lock was already released elsewhere; nothing to
		// acquire for it here.

		const activeOpts = makeOptions({ projectPath });
		await initializeRun(activeOpts);
		await advanceState(activeOpts.runId, "running");
		const activeCurrent = await readRun(activeOpts.runId);
		await updateRun(
			activeOpts.runId,
			{ workerPid: process.pid },
			activeCurrent.revision,
		);
		await acquireProjectLock(projectPath, activeOpts.runId);

		// Inject a stale, earlier-computed candidate set (simulating "what
		// was true when it was printed"), but let the REAL
		// releaseProjectLockIfOwnedBy run against the REAL, current lock file.
		const staleCandidate = {
			name: "irrelevant-for-this-test.lock",
			path: "irrelevant",
			ageMs: 999_999,
			createdAt: staleOpts.createdAt,
			runId: staleOpts.runId,
			projectPath,
			category: "project-lock-stale",
			isCandidate: true,
			reason: "stale snapshot from an earlier resolution",
		};

		const result = await run(["--confirm"], {
			log: () => {},
			resolveCandidates: async () => [staleCandidate],
			releaseProjectLockIfOwnedBy, // the real function, unmocked
		});

		deepStrictEqual(result.removed, []);
		strictEqual(
			isProjectLockHeld(projectPath),
			true,
			"the new active run's lock must survive",
		);

		const raw = await readFile(projectLockFilePath(projectPath), "utf8");
		strictEqual(JSON.parse(raw).runId, activeOpts.runId);
	});
});

describe("run() — argument validation", () => {
	it("rejects an unknown flag with exit code 2", async () => {
		const result = await run(["--bogus"], { log: () => {} });
		strictEqual(result.exitCode, 2);
	});

	it("rejects --dry-run combined with --confirm", async () => {
		const result = await run(["--dry-run", "--confirm"], { log: () => {} });
		strictEqual(result.exitCode, 2);
	});

	it("--help prints usage and exits 0 without scanning", async () => {
		const logs = [];
		const result = await run(["--help"], { log: (m) => logs.push(m) });
		strictEqual(result.exitCode, 0);
		ok(logs.some((l) => l.includes("Usage")));
	});
});
