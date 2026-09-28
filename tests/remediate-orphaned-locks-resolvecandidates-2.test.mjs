import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { resolveCandidates } from "../src/switchyard/dispatch/remediate-orphaned-locks.mjs";
import {
	acquireLaunchLock,
	acquireProjectLock,
	advanceState,
	getStateRoot,
	initializeRun,
	readRun,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
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
