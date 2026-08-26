// Regressions for the partial-diff artifact channel (Task 6.5, Part A).
//
// worker-bootstrap.mjs used to copy a timed-out task's partial diff into
// <runRoot>/artifacts/<taskId>.diff. Nothing ever read those bytes back:
// listArtifactRefs hashes the file NAME into an opaque `artifact:<hash>` ref
// and never opens the file, and opaqueArtifactRef rejects any reference that
// is not exactly that opaque form. So raw provider output was persisted in
// the run store purely so a count would appear in `switchyard result`'s
// artifactRefs — the situation INV-2 exists to prevent.
//
// The replacement keeps the fact and drops the content: the runner already
// emits a `partial_diff_captured` status event carrying the task id and the
// diff's size in bytes, and worker-bootstrap's onStatus handler now forwards
// both instead of discarding them.
//
// worker-bootstrap.mjs cannot be imported: it is a bare top-level script that
// parses process.argv and calls process.exit on the spot, so importing it
// would kill the test runner. The onStatus regression therefore extracts the
// real shipped handler body out of the source and executes it against a fake
// run store, so these tests fail if the handler stops forwarding — not merely
// if a comment changes.

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	BOOTSTRAP_SOURCE,
	makeOnStatus,
} from "./helpers/bootstrap-handler.mjs";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "switchyard-partial-diff-"));
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
	it("proves the failure path no longer copies a partial diff into artifacts/", () => {
		ok(
			!/copyFile/.test(BOOTSTRAP_SOURCE),
			"worker-bootstrap must not import or call copyFile: the only caller was the partial-diff copy",
		);
		ok(
			!/\.diff`/.test(BOOTSTRAP_SOURCE) && !/\.diff"/.test(BOOTSTRAP_SOURCE),
			"worker-bootstrap must not construct a .diff filename in the run store",
		);
		// The plan's own acceptance grep. `partialDiffPath` may still be named
		// in a comment explaining why it is not copied, but it must not be
		// consumed by any expression.
		for (const line of BOOTSTRAP_SOURCE.split("\n")) {
			const code = line.replace(/^\s*\/\/.*$/, "");
			ok(
				!/partialDiffPath/.test(code),
				`worker-bootstrap must not read partialDiffPath outside a comment: ${line.trim()}`,
			);
		}
	});

	it("proves onStatus forwards the task id and the partial diff's size in bytes", () => {
		const { onStatus, emitted } = makeOnStatus();
		onStatus({
			phase: "execution",
			event: "partial_diff_captured",
			status: "Task 1.1 timed out; partial diff saved for review (not applied)",
			taskId: "1.1",
			byteCount: 4096,
		});
		strictEqual(emitted.length, 1);
		strictEqual(emitted[0].event, "partial_diff_captured");
		strictEqual(
			emitted[0].taskId,
			"1.1",
			"the task id must survive onStatus: without it the event says a diff happened to some task",
		);
		strictEqual(
			emitted[0].byteCount,
			4096,
			"the byte count must survive onStatus: it is the whole remaining diagnostic",
		);
	});

	it("proves onStatus forwards nothing beyond the approved scalars", () => {
		const { onStatus, emitted } = makeOnStatus();
		onStatus({
			phase: "execution",
			event: "partial_diff_captured",
			status: "Task 1.1 timed out",
			taskId: "1.1",
			byteCount: 12,
			// Every one of these is raw provider output or a host path. None
			// may reach events.jsonl.
			partialDiffPath: "/tmp/tasks.md.checkpoint.json.partial-diffs/1.1.diff",
			partialDiff: "diff --git a/secret.txt b/secret.txt",
			output: "provider stdout",
			error: "provider stderr",
		});
		deepStrictEqual(
			Object.keys(emitted[0]).sort(),
			["byteCount", "event", "phase", "status", "taskId"],
			"onStatus must forward by explicit name, never by spread",
		);
	});

	it("drops a byteCount that is not a non-negative safe integer", () => {
		const { onStatus, emitted } = makeOnStatus();
		for (const byteCount of [-1, 1.5, Number.NaN, "4096", null, {}]) {
			onStatus({
				phase: "execution",
				event: "partial_diff_captured",
				status: "s",
				byteCount,
			});
		}
		for (const event of emitted) {
			ok(
				!Object.hasOwn(event, "byteCount"),
				`a byteCount of ${String(event.byteCount)} must not be forwarded`,
			);
		}
	});

	it("truncates a forwarded task id to the same bound as the other scalars", () => {
		const { onStatus, emitted } = makeOnStatus();
		onStatus({
			phase: "execution",
			event: "partial_diff_captured",
			status: "s",
			taskId: "x".repeat(500),
		});
		strictEqual(emitted[0].taskId.length, 64);
	});

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
		// The run's artifacts directory stays empty: the diagnostic is the
		// event, and the diff itself lives beside the checkpoint.
		const artifactsDir = join(getRunRoot(runId), "artifacts");
		const { readdirSync } = await import("node:fs");
		deepStrictEqual(readdirSync(artifactsDir), []);
	});
});
