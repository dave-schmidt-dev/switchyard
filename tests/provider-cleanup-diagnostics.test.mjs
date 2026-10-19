// @test-phase: other
// Regressions for the Antigravity timeout cleanup failure (Task 6.3).
//
// Run c98c0c27-eb6b-46e9-8cba-5e8f1acc50f4 timed out after 30 minutes and
// ended execution_timed_out_cleanup_failed, but errorKind, reasonCode, reason
// and diagnosticCode all still said a plain execution_timed_out, and the
// recorded event could not say which cleanup stage failed. The retired queue
// adapters and their guest kill path are gone; what remains is the shared
// contract: the sanitized terminal envelope names the cleanup failure in every
// field, and the run store keeps the cleanup stage on the event.
import { ok, strictEqual } from "node:assert";
import { rmSync } from "node:fs";

import { join } from "node:path";
import { after, describe, it } from "node:test";
import { sanitizeFailureMetadata } from "../src/switchyard/adapter/exec-error.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const TEST_ROOT = tempDir("switchyard-cleanup-diag-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_ROOT, "store");

const { createEvent, initializeRun, readEvents } = await import(
	"../src/switchyard/run-store/index.mjs"
);

after(() => {
	try {
		rmSync(TEST_ROOT, { recursive: true, force: true });
	} catch {
		// no-op
	}
});

describe("the terminal envelope agrees with itself (Task 6.3)", () => {
	it("names the cleanup failure in every field, not only in the result", () => {
		// The exact shape runner/index.mjs builds from a sync adapter whose
		// guest cleanup reported survivors.
		const execution = {
			cleanupFailed: true,
			cleanupStage: "pid_observed",
			exitCode: 1,
			signal: null,
			failurePhase: "provider_cleanup",
			diagnosticCode: undefined,
		};
		const cleanupFailed = execution.cleanupFailed === true;
		const safe = sanitizeFailureMetadata({
			taskId: "1.1",
			result: cleanupFailed
				? "execution_timed_out_cleanup_failed"
				: "execution_timed_out",
			errorKind: (cleanupFailed && "provider_cleanup_failed") || null,
			timedOut: true,
			diagnosticCode: execution.diagnosticCode,
			exitCode: execution.exitCode,
			signal: execution.signal,
			failurePhase: execution.failurePhase,
			cleanupStage: execution.cleanupStage,
		});

		strictEqual(safe.errorKind, "provider_cleanup_failed");
		strictEqual(safe.reasonCode, "provider_cleanup_failed");
		strictEqual(safe.failurePhase, "provider_cleanup");
		// The stage the run actually reached, not a generic cleanup code: the
		// recorded run stopped after provider_pid_observed.
		strictEqual(safe.diagnosticCode, "provider_cleanup_after_pid_observed");
		strictEqual(safe.exitCode, 1);
	});

	it("still books a clean timeout as a plain timeout", () => {
		const safe = sanitizeFailureMetadata({
			taskId: "1.1",
			result: "execution_timed_out",
			errorKind: null,
			timedOut: true,
			exitCode: null,
			signal: null,
			failurePhase: "provider_execution",
			cleanupStage: null,
		});
		strictEqual(safe.errorKind, "execution_timed_out");
		strictEqual(safe.failurePhase, "provider_execution");
	});
});

describe("the discriminator survives into events.jsonl (Task 6.3)", () => {
	it("persists cleanupStage through the real run store, not just the forwarder", async () => {
		// cleanupStage had to be added to APPROVED_EVENT_KEYS deliberately;
		// without that entry a caller would forward a value the store silently
		// drops, and the event
		// would be exactly as uninformative as the one that was recorded live.
		const runId = "cleanup-diagnostic-persistence";
		await initializeRun({
			runId,
			tasksFilePath: join(TEST_ROOT, "tasks.md"),
			projectPath: TEST_ROOT,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});
		await createEvent(runId, {
			phase: "execution",
			event: "provider_cleanup_failed",
			status: "Guest provider cleanup could not confirm process exit",
			cleanupStage: "pid_observed",
			exitCode: 1,
		});

		const events = await readEvents(runId);
		const failure = events.find(
			(event) => event.event === "provider_cleanup_failed",
		);
		ok(failure, "the cleanup failure must be readable back");
		strictEqual(failure.cleanupStage, "pid_observed");
		strictEqual(failure.exitCode, 1);
	});
});
