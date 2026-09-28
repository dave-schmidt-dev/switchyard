import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { run } from "../src/switchyard/dispatch/remediate-orphaned-locks.mjs";
import {
	acquireProjectLock,
	advanceState,
	initializeRun,
	isProjectLockHeld,
	readRun,
	releaseProjectLockIfOwnedBy,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import {
	makeOptions,
	projectLockFilePath,
	TEST_ROOT,
	uniquePath,
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
