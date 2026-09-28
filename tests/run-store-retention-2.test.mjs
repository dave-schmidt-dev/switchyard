import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	advanceState,
	applyRetention,
	createEvent,
	getRunRoot,
	getStateRoot,
	initializeRun,
	readEvents,
	readRun,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import {
	makeOptions,
	TEST_ROOT,
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
describe("retention", () => {
	async function createTerminalRun(idSuffix, overrides = {}) {
		const opts = makeOptions({
			runId: `retention-${idSuffix}-${uniqueRunId().slice(0, 8)}`,
		});
		await initializeRun(opts);

		let run = await advanceState(opts.runId, "succeeded");
		run = await updateRun(
			opts.runId,
			{ cleanupState: "complete", ...overrides },
			run.revision,
		);
		return run;
	}
	it("deletes eligible completed runs respecting maxRuns", async () => {
		const runs = [];
		for (let i = 0; i < 5; i++) {
			runs.push(await createTerminalRun(i));
		}

		const result = await applyRetention({ maxRuns: 2 });
		strictEqual(result.deletedCount, 3);

		for (let i = 0; i < 3; i++) {
			await rejects(readRun(runs[i].runId), /Run not found/);
		}
		for (let i = 3; i < 5; i++) {
			const r = await readRun(runs[i].runId);
			strictEqual(r.state, "succeeded");
		}
	});
	it("removes a non-terminal run that never recorded an event", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const nonTerminal = await updateRun(
			opts.runId,
			{ state: "failed", cleanupState: "not_started" },
			1,
		);

		await createTerminalRun("ok");

		const result = await applyRetention({ maxRuns: 0 });
		strictEqual(result.deletedCount, 2);
		await rejects(readRun(nonTerminal.runId), /Run not found/);
	});
	it("removes a cleanup-failed run that never recorded an event", async () => {
		const run = await createTerminalRun("cf");
		await updateRun(run.runId, { cleanupState: "failed" }, run.revision);

		const result = await applyRetention({ maxRuns: 0 });
		strictEqual(result.deletedCount, 1);
		await rejects(readRun(run.runId), /Run not found/);
	});
	it("pins allocating, active, and retained roots without events, but reclaims removed roots", async () => {
		const pinned = [];
		let removedId;
		for (const state of ["allocating", "active", "retained", "removed"]) {
			const canonicalParent = TEST_ROOT;
			const candidateChild = `switchyard-simple-${state}`;
			const opts = makeOptions({
				worktree: {
					canonicalParent,
					candidateChild,
					path: join(canonicalParent, candidateChild),
					state,
					reason: state === "retained" ? "salvage_retained" : null,
					retainedAt: state === "retained" ? new Date().toISOString() : null,
				},
			});
			await initializeRun(opts);
			strictEqual(
				existsSync(join(getRunRoot(opts.runId), "events.jsonl")),
				false,
			);
			if (state === "removed") removedId = opts.runId;
			else pinned.push(opts.runId);
		}
		const result = await applyRetention({
			maxRuns: 0,
			maxAgeDays: 0,
			now: new Date(Date.now() + 86_400_000).toISOString(),
		});
		strictEqual(result.deletedCount, 1);
		for (const id of pinned) strictEqual((await readRun(id)).runId, id);
		await rejects(readRun(removedId), /Run not found/);
	});
	it("accepts complete durable worktree identity and rejects partial identity", async () => {
		const runId = uniqueRunId();
		const canonicalParent = TEST_ROOT;
		const candidateChild = `switchyard-simple-${runId}`;
		const worktree = {
			canonicalParent,
			candidateChild,
			path: join(canonicalParent, candidateChild),
			state: "active",
			device: "1",
			inode: "42",
			nonce: "12345678-1234-4234-8234-123456789abc",
		};
		await initializeRun(makeOptions({ runId, worktree }));
		strictEqual((await readRun(runId)).worktree.inode, "42");
		await rejects(
			initializeRun(
				makeOptions({ worktree: { ...worktree, nonce: undefined } }),
			),
			/worktree identity must be complete/,
		);
	});
	it("keeps run.json and events.jsonl at any age, for any run state", async () => {
		const states = [
			{ state: "created", cleanupState: "not_started" },
			{ state: "running", cleanupState: "not_started" },
			{ state: "failed", cleanupState: "failed" },
			{ state: "succeeded", cleanupState: "complete" },
		];
		const runIds = [];
		for (const [index, override] of states.entries()) {
			const opts = makeOptions({
				runId: `retention-keep-${index}-${uniqueRunId().slice(0, 8)}`,
			});
			await initializeRun(opts);
			// One event is the whole difference between a diagnostic record
			// and a directory that only attests it once existed.
			await createEvent(opts.runId, {
				phase: "execution",
				event: "task_failed",
				status: "Task 1.1 failed: provider_error",
				taskId: "1.1",
			});
			const current = await readRun(opts.runId);
			await updateRun(opts.runId, override, current.revision);
			runIds.push(opts.runId);
		}

		// maxRuns: 0 and a cutoff a day in the future together say "reclaim
		// everything you are allowed to reclaim".
		const result = await applyRetention({
			maxRuns: 0,
			maxAgeDays: 0,
			now: new Date(Date.now() + 86_400_000).toISOString(),
		});
		strictEqual(result.deletedCount, 0);

		for (const runId of runIds) {
			const run = await readRun(runId);
			ok(run.runId === runId, "run.json must survive");
			ok(
				existsSync(join(getRunRoot(runId), "events.jsonl")),
				"events.jsonl must survive",
			);
		}
	});
	it("removes a directory with no events.jsonl whatever its state", async () => {
		const states = [
			{ state: "created", cleanupState: "not_started" },
			{ state: "running", cleanupState: "not_started" },
			{ state: "failed", cleanupState: "failed" },
			{ state: "succeeded", cleanupState: "complete" },
		];
		const runIds = [];
		for (const [index, override] of states.entries()) {
			const opts = makeOptions({
				runId: `retention-noev-${index}-${uniqueRunId().slice(0, 8)}`,
			});
			await initializeRun(opts);
			await updateRun(opts.runId, override, 1);
			runIds.push(opts.runId);
		}

		const result = await applyRetention({ maxRuns: 0 });
		strictEqual(result.deletedCount, 4);
		for (const runId of runIds) {
			await rejects(readRun(runId), /Run not found/);
		}
	});
	it("collects artifacts from a failed run while its diagnostics survive", async () => {
		const opts = makeOptions({
			runId: `retention-collect-${uniqueRunId().slice(0, 8)}`,
		});
		await initializeRun(opts);
		await createEvent(opts.runId, {
			phase: "execution",
			event: "task_failed",
			status: "Task 1.1 failed: execution_timed_out",
			taskId: "1.1",
		});
		const current = await readRun(opts.runId);
		await updateRun(
			opts.runId,
			{ state: "failed", cleanupState: "complete" },
			current.revision,
		);
		const artifactsDir = join(getRunRoot(opts.runId), "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		writeFileSync(join(artifactsDir, "1.1.diff"), "diff --git a/x b/x\n");

		// No age or count limit at all: collection is unconditional, because
		// an artifact is raw provider output at every age.
		const result = await applyRetention({});
		strictEqual(result.collectedCount, 1);
		strictEqual(result.deletedCount, 0);

		deepStrictEqual(readdirSync(artifactsDir), []);
		const run = await readRun(opts.runId);
		strictEqual(run.state, "failed");

		// The point of the rule is a readable post-mortem, so assert the
		// failure event survives intact rather than that the file exists:
		// a truncated or sanitized-to-nothing events.jsonl would still pass
		// an existence check while leaving the diagnostic worthless.
		const events = await readEvents(opts.runId);
		const failure = events.find((e) => e.event === "task_failed");
		ok(failure, `task_failed missing from events: ${JSON.stringify(events)}`);
		strictEqual(failure.taskId, "1.1");
		strictEqual(failure.status, "Task 1.1 failed: execution_timed_out");
		strictEqual(failure.phase, "execution");
	});
	it("does not touch a run still referenced by a live checkpoint", async () => {
		// uniquePath() is keyed on its label, so every makeOptions() run shares
		// one tasksFilePath. This test writes a checkpoint beside that path and
		// TEST_ROOT outlives afterEach, so it must use a path of its own and
		// remove it — otherwise it protects every later test's runs too.
		const tasksFilePath = join(TEST_ROOT, `ckpt-tasks-${uniqueRunId()}.md`);
		const checkpointPath = `${tasksFilePath}.checkpoint.json`;
		const opts = makeOptions({
			runId: `retention-ckpt-${uniqueRunId().slice(0, 8)}`,
			tasksFilePath,
		});
		await initializeRun(opts);
		const artifactsDir = join(getRunRoot(opts.runId), "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		writeFileSync(join(artifactsDir, "1.1.diff"), "partial");
		writeFileSync(
			checkpointPath,
			JSON.stringify({ version: 1, tasksFilePath, completedTaskIds: [] }),
		);

		try {
			// This run has no events.jsonl, so rule 3 would remove it outright.
			const result = await applyRetention({ maxRuns: 0 });
			strictEqual(result.deletedCount, 0);
			strictEqual(
				result.collectedCount,
				0,
				"artifacts are not collected either",
			);
			const run = await readRun(opts.runId);
			strictEqual(run.runId, opts.runId);
			deepStrictEqual(readdirSync(artifactsDir), ["1.1.diff"]);
		} finally {
			rmSync(checkpointPath, { force: true });
		}
	});
	it("dryRun reports collection without removing anything", async () => {
		const opts = makeOptions({
			runId: `retention-drycollect-${uniqueRunId().slice(0, 8)}`,
		});
		await initializeRun(opts);
		await createEvent(opts.runId, {
			phase: "execution",
			event: "task_failed",
			status: "Task 1.1 failed: provider_error",
			taskId: "1.1",
		});
		const artifactsDir = join(getRunRoot(opts.runId), "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		writeFileSync(join(artifactsDir, "1.1.diff"), "partial");

		const result = await applyRetention({ dryRun: true });
		strictEqual(result.collectedCount, 1);
		deepStrictEqual(readdirSync(artifactsDir), ["1.1.diff"]);
	});
	it("deletes runs older than maxAgeDays", async () => {
		await createTerminalRun("old");

		const result = await applyRetention({
			maxAgeDays: 0,
			now: new Date(Date.now() + 86_400_000).toISOString(),
		});
		strictEqual(result.deletedCount, 1);
	});
	it("dryRun reports maxAgeDays-eligible runs without deleting them", async () => {
		const run = await createTerminalRun("dry-age");

		const result = await applyRetention({
			maxAgeDays: 0,
			now: new Date(Date.now() + 86_400_000).toISOString(),
			dryRun: true,
		});
		// Same count as the non-dryRun call above, but nothing was removed.
		strictEqual(result.deletedCount, 1);

		const r = await readRun(run.runId);
		strictEqual(r.state, "succeeded");
	});
	it("dryRun reports maxRuns-eligible runs without deleting them", async () => {
		const runs = [];
		for (let i = 0; i < 3; i++) {
			runs.push(await createTerminalRun(`dry-runs-${i}`));
		}

		const result = await applyRetention({ maxRuns: 1, dryRun: true });
		strictEqual(result.deletedCount, 2);

		for (const run of runs) {
			const r = await readRun(run.runId);
			strictEqual(r.state, "succeeded");
		}
	});
	it("deletes nothing when no retention limits set", async () => {
		await createTerminalRun("keep");
		const result = await applyRetention({});
		strictEqual(result.deletedCount, 0);
	});
	it("returns 0 when runs directory does not exist", async () => {
		const result = await applyRetention({ maxRuns: 1 });
		strictEqual(result.deletedCount, 0);
	});
	function writeMalformedRun(runId, rawContent) {
		const runDir = join(getStateRoot(), "runs", runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "run.json"), rawContent, "utf8");
		return runDir;
	}
	it("quarantines a run with invalid JSON using a safe, static reason", async () => {
		const runId = `quarantine-badjson-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(runId, "not valid json at all {{{");

		const result = await applyRetention({});
		strictEqual(result.deletedCount, 0);
		strictEqual(result.quarantined.length, 1);
		strictEqual(result.quarantined[0].runId, runId);
		strictEqual(result.quarantined[0].reason, "run.json contains invalid JSON");
		ok(!result.quarantined[0].reason.includes("{{{"));

		strictEqual(existsSync(join(getStateRoot(), "runs", runId)), false);
		strictEqual(
			existsSync(join(getStateRoot(), ".quarantine", runId, "run.json")),
			true,
		);
		await rejects(readRun(runId), /Run not found/);
	});
});
