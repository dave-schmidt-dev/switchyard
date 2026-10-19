// @test-phase: other
// Regression for the partial-diff artifact channel (Task 6.5, Part A).
//
// The retired queue runner used to copy a timed-out task's partial diff into
// <runRoot>/artifacts/<taskId>.diff, persisting raw provider output only so a
// count would appear in an opaque artifact ref: the situation INV-2 exists to
// prevent. The replacement keeps the fact and drops the content: a
// `partial_diff_captured` event carries the task id and the diff's size in
// bytes, and the run store must keep both without provisioning an artifacts
// directory.

import { ok, strictEqual } from "node:assert";
import { rmSync } from "node:fs";

import { join } from "node:path";
import { after, describe, it } from "node:test";
import { tempDir } from "./helpers/tempdir.mjs";

const TEST_ROOT = tempDir("switchyard-partial-diff-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_ROOT, "store");

const { createEvent, getRunRoot, initializeRun, readEvents } = await import(
	"../src/switchyard/run-store/index.mjs"
);

after(() => {
	try {
		rmSync(TEST_ROOT, { recursive: true, force: true });
	} catch {
		// no-op
	}
});

describe("partial diffs are recorded, not copied (Task 6.5)", () => {
	it("persists the task id and byte count through createEvent to events.jsonl", async () => {
		const runId = "3f2b0c1e-9a44-4d7e-8c21-5b6d0a4e7f10";
		await initializeRun({
			runId,
			tasksFilePath: join(TEST_ROOT, "tasks.md"),
			projectPath: TEST_ROOT,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "git:test:clean",
		});
		await createEvent(runId, {
			phase: "execution",
			event: "partial_diff_captured",
			status: "Task 1.1 timed out; partial diff saved for review",
			taskId: "1.1",
			byteCount: 4096,
		});
		const events = await readEvents(runId);
		const captured = events.find((e) => e.event === "partial_diff_captured");
		ok(captured, "the event must reach events.jsonl");
		strictEqual(captured.taskId, "1.1");
		strictEqual(captured.byteCount, 4096);
		ok(
			!Object.hasOwn(captured, "partialDiffPath"),
			"no host path may be persisted",
		);
		// The run has no artifacts directory at all: the diagnostic is the event,
		// the diff itself lives beside the checkpoint, and with the copy gone
		// there is no writer left to provision a directory for.
		const artifactsDir = join(getRunRoot(runId), "artifacts");
		const { existsSync } = await import("node:fs");
		ok(!existsSync(artifactsDir), "no empty artifacts directory may be left");
	});
});
