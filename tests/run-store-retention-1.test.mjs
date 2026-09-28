import { ok, strictEqual } from "node:assert";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	advanceState,
	applyCheckpointArtifactRetention,
	getStateRoot,
	initializeRun,
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
	it("bounds purpose-complete checkpoint evidence without deleting unsafe entries", async () => {
		const checkpointPath = join(
			TEST_ROOT,
			`bounded-${uniqueRunId()}.checkpoint.json`,
		);
		writeFileSync(
			checkpointPath,
			JSON.stringify({
				completedTaskIds: ["1.1", "1.2"],
				results: [
					{ taskId: "1.1", attempt: 1, success: true },
					{ taskId: "1.1", attempt: 2, success: true },
					{ taskId: "1.2", attempt: 1, success: true },
				],
				taskAttempts: { 1.1: 2, 1.2: 1 },
				integrationIntents: {},
			}),
		);
		chmodSync(checkpointPath, 0o600);
		const artifactsDir = `${checkpointPath}.partial-diffs`;
		mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
		writeFileSync(join(artifactsDir, "1.1.attempt-1.diff"), "1234567890", {
			mode: 0o600,
		});
		writeFileSync(join(artifactsDir, "1.1.attempt-2.diff"), "abcdefghij", {
			mode: 0o600,
		});
		writeFileSync(join(artifactsDir, "unknown.tmp"), "must remain");
		const symlink = join(artifactsDir, "1.2.attempt-1.diff");
		symlinkSync(join(artifactsDir, "unknown.tmp"), symlink);

		const first = await applyCheckpointArtifactRetention(checkpointPath, {
			terminal: true,
			maxBytes: 10,
			maxEntries: 1,
		});
		strictEqual(first.deletedCount, 1);
		ok(existsSync(join(artifactsDir, "1.1.attempt-2.diff")));
		ok(existsSync(join(artifactsDir, "unknown.tmp")));
		ok(existsSync(symlink));
		ok(first.reports.some((entry) => entry.reason === "symlink"));
		ok(first.reports.some((entry) => entry.reason === "unknown_entry"));

		const second = await applyCheckpointArtifactRetention(checkpointPath, {
			terminal: true,
			maxBytes: 10,
			maxEntries: 1,
		});
		strictEqual(second.deletedCount, 0);
	});
	it("preserves active reconciliation and current review evidence", async () => {
		const checkpointPath = join(
			TEST_ROOT,
			`active-${uniqueRunId()}.checkpoint.json`,
		);
		writeFileSync(
			checkpointPath,
			JSON.stringify({
				completedTaskIds: [],
				results: [
					{ taskId: "1.1", attempt: 1, success: false, timedOut: true },
				],
				taskAttempts: { 1.1: 1 },
				integrationIntents: {
					1.1: { status: "pending", operation: { taskId: "1.1", attempt: 1 } },
				},
			}),
		);
		chmodSync(checkpointPath, 0o600);
		const artifactsDir = `${checkpointPath}.partial-diffs`;
		mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
		const artifactPath = join(artifactsDir, "1.1.attempt-1.diff");
		writeFileSync(artifactPath, "active review evidence", { mode: 0o600 });
		const result = await applyCheckpointArtifactRetention(checkpointPath, {
			terminal: true,
			maxBytes: 0,
			maxEntries: 0,
		});
		strictEqual(result.deletedCount, 0);
		strictEqual(readFileSync(artifactPath, "utf8"), "active review evidence");
		ok(
			result.reports.some((entry) => entry.reason === "active_reconciliation"),
		);
	});
	it("reports ambiguous legacy identity without deleting it", async () => {
		const checkpointPath = join(
			TEST_ROOT,
			`ambiguous-${uniqueRunId()}.checkpoint.json`,
		);
		writeFileSync(
			checkpointPath,
			JSON.stringify({
				completedTaskIds: ["1.1"],
				results: [
					{ taskId: "1.1", attempt: 1, success: false },
					{ taskId: "1.1", attempt: 2, success: true },
				],
				taskAttempts: { 1.1: 2 },
				integrationIntents: {},
			}),
		);
		chmodSync(checkpointPath, 0o600);
		const artifactsDir = `${checkpointPath}.partial-diffs`;
		mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
		const artifactPath = join(artifactsDir, "1.1.diff");
		writeFileSync(artifactPath, "ambiguous", { mode: 0o600 });
		const result = await applyCheckpointArtifactRetention(checkpointPath, {
			terminal: true,
			maxBytes: 0,
			maxEntries: 0,
		});
		strictEqual(result.deletedCount, 0);
		ok(existsSync(artifactPath));
		ok(
			result.reports.some(
				(entry) => entry.reason === "attempt_identity_ambiguous",
			),
		);
	});
	it("rejects an explicit attempt absent from durable checkpoint evidence", async () => {
		const checkpointPath = join(
			TEST_ROOT,
			`attempt-mismatch-${uniqueRunId()}.checkpoint.json`,
		);
		writeFileSync(
			checkpointPath,
			JSON.stringify({
				completedTaskIds: ["1.1"],
				results: [{ taskId: "1.1", attempt: 1, success: true }],
				taskAttempts: { 1.1: 1 },
				integrationIntents: {},
			}),
			{ mode: 0o600 },
		);
		const artifactsDir = `${checkpointPath}.partial-diffs`;
		mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
		const artifactPath = join(artifactsDir, "1.1.attempt-2.diff");
		writeFileSync(artifactPath, "unproven", { mode: 0o600 });
		const result = await applyCheckpointArtifactRetention(checkpointPath, {
			terminal: true,
			maxBytes: 0,
			maxEntries: 0,
		});
		strictEqual(result.deletedCount, 0);
		ok(existsSync(artifactPath));
		ok(
			result.reports.some(
				(entry) => entry.reason === "attempt_not_in_checkpoint",
			),
		);
	});
	it("rejects an explicit attempt when the durable result omits attempt", async () => {
		const checkpointPath = join(
			TEST_ROOT,
			`attempt-missing-${uniqueRunId()}.checkpoint.json`,
		);
		writeFileSync(
			checkpointPath,
			JSON.stringify({
				completedTaskIds: ["1.1"],
				results: [{ taskId: "1.1", success: true }],
				taskAttempts: { 1.1: 1 },
				integrationIntents: {},
			}),
			{ mode: 0o600 },
		);
		const artifactsDir = `${checkpointPath}.partial-diffs`;
		mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
		const artifactPath = join(artifactsDir, "1.1.attempt-1.diff");
		writeFileSync(artifactPath, "missing attempt evidence", { mode: 0o600 });
		const result = await applyCheckpointArtifactRetention(checkpointPath, {
			terminal: true,
			maxBytes: 0,
			maxEntries: 0,
		});
		strictEqual(result.deletedCount, 0);
		ok(existsSync(artifactPath));
		ok(
			result.reports.some(
				(entry) => entry.reason === "attempt_not_in_checkpoint",
			),
		);
	});
	it("rejects an explicit attempt duplicated in durable results", async () => {
		const checkpointPath = join(
			TEST_ROOT,
			`attempt-duplicate-${uniqueRunId()}.checkpoint.json`,
		);
		writeFileSync(
			checkpointPath,
			JSON.stringify({
				completedTaskIds: ["1.1"],
				results: [
					{ taskId: "1.1", attempt: 1, success: true },
					{ taskId: "1.1", attempt: 1, success: true },
				],
				taskAttempts: { 1.1: 1 },
				integrationIntents: {},
			}),
			{ mode: 0o600 },
		);
		const artifactsDir = `${checkpointPath}.partial-diffs`;
		mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
		const artifactPath = join(artifactsDir, "1.1.attempt-1.diff");
		writeFileSync(artifactPath, "duplicate attempt evidence", { mode: 0o600 });
		const result = await applyCheckpointArtifactRetention(checkpointPath, {
			terminal: true,
			maxBytes: 0,
			maxEntries: 0,
		});
		strictEqual(result.deletedCount, 0);
		ok(existsSync(artifactPath));
		ok(
			result.reports.some(
				(entry) => entry.reason === "attempt_not_in_checkpoint",
			),
		);
	});
	it("refuses deletion when the checkpoint changes before the unlink", async () => {
		const checkpointPath = join(
			TEST_ROOT,
			`checkpoint-race-${uniqueRunId()}.checkpoint.json`,
		);
		const checkpoint = {
			completedTaskIds: ["1.1"],
			results: [{ taskId: "1.1", attempt: 1, success: true }],
			taskAttempts: { 1.1: 1 },
			integrationIntents: {},
			revision: 1,
		};
		writeFileSync(checkpointPath, JSON.stringify(checkpoint), { mode: 0o600 });
		const artifactsDir = `${checkpointPath}.partial-diffs`;
		mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
		const artifactPath = join(artifactsDir, "1.1.attempt-1.diff");
		writeFileSync(artifactPath, "checkpoint race", { mode: 0o600 });
		const result = await applyCheckpointArtifactRetention(checkpointPath, {
			terminal: true,
			maxBytes: 0,
			maxEntries: 0,
			beforeDelete: () => {
				writeFileSync(
					checkpointPath,
					JSON.stringify({ ...checkpoint, revision: 2 }),
					{ mode: 0o600 },
				);
			},
		});
		strictEqual(result.deletedCount, 0);
		ok(existsSync(artifactPath));
		ok(result.reports.some((entry) => entry.reason === "checkpoint_changed"));
	});
	it("refuses deletion when the partial-diffs parent becomes a symlink", async () => {
		const checkpointPath = join(
			TEST_ROOT,
			`parent-race-${uniqueRunId()}.checkpoint.json`,
		);
		writeFileSync(
			checkpointPath,
			JSON.stringify({
				completedTaskIds: ["1.1"],
				results: [{ taskId: "1.1", attempt: 1, success: true }],
				taskAttempts: { 1.1: 1 },
				integrationIntents: {},
			}),
			{ mode: 0o600 },
		);
		const artifactsDir = `${checkpointPath}.partial-diffs`;
		const movedDir = `${artifactsDir}.moved`;
		mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
		const artifactPath = join(artifactsDir, "1.1.attempt-1.diff");
		writeFileSync(artifactPath, "parent race", { mode: 0o600 });
		const result = await applyCheckpointArtifactRetention(checkpointPath, {
			terminal: true,
			maxBytes: 0,
			maxEntries: 0,
			beforeDelete: () => {
				renameSync(artifactsDir, movedDir);
				symlinkSync(movedDir, artifactsDir);
			},
		});
		strictEqual(result.deletedCount, 0);
		ok(existsSync(join(movedDir, "1.1.attempt-1.diff")));
		ok(
			result.reports.some(
				(entry) => entry.reason === "parent_directory_changed",
			),
		);
	});
	it("refuses deletion when the candidate is replaced at the same path", async () => {
		const checkpointPath = join(
			TEST_ROOT,
			`candidate-race-${uniqueRunId()}.checkpoint.json`,
		);
		writeFileSync(
			checkpointPath,
			JSON.stringify({
				completedTaskIds: ["1.1"],
				results: [{ taskId: "1.1", attempt: 1, success: true }],
				taskAttempts: { 1.1: 1 },
				integrationIntents: {},
			}),
			{ mode: 0o600 },
		);
		const artifactsDir = `${checkpointPath}.partial-diffs`;
		mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
		const artifactPath = join(artifactsDir, "1.1.attempt-1.diff");
		const replacedPath = `${artifactPath}.original`;
		writeFileSync(artifactPath, "original candidate", { mode: 0o600 });
		const result = await applyCheckpointArtifactRetention(checkpointPath, {
			terminal: true,
			maxBytes: 0,
			maxEntries: 0,
			beforeClaim: () => {
				renameSync(artifactPath, replacedPath);
				writeFileSync(artifactPath, "replacement candidate", { mode: 0o600 });
			},
		});
		strictEqual(result.deletedCount, 0);
		ok(existsSync(replacedPath));
		strictEqual(readFileSync(artifactPath, "utf8"), "replacement candidate");
		ok(result.reports.some((entry) => entry.reason === "entry_changed"));
	});
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
	function writeMalformedRun(runId, rawContent) {
		const runDir = join(getStateRoot(), "runs", runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "run.json"), rawContent, "utf8");
		return runDir;
	}
});
