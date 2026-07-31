// Tests for the F.3 human-confirmed remediation CLI
// (src/switchyard/dispatch/remediate-orphaned-locks.mjs). Exercised entirely
// against synthetic fixture lock/run files under a temp
// SWITCHYARD_RUN_STORE_ROOT override — the same pattern
// tests/run-store.test.mjs already uses for lock tests. Never touches the
// real .logs/switchyard state directory.

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

const TEST_ROOT = mkdtempSync(join(tmpdir(), "switchyard-remediate-locks-"));
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
	const resolvedPath = resolve(`project:${canonicalProjectPath}`);
	const hash = createHash("sha256").update(resolvedPath).digest("hex");
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

	it("flags a project lock whose runId has no run.json as a run-missing candidate", async () => {
		const path = uniquePath("ghost");
		const ghostRunId = uniqueRunId();
		await acquireProjectLock(path, ghostRunId);

		const descriptors = await resolveCandidates();
		const d = descriptors.find((x) => x.runId === ghostRunId);
		ok(d);
		strictEqual(d.category, "run-missing");
		strictEqual(d.isCandidate, true);
		strictEqual(d.projectPath, path);
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
