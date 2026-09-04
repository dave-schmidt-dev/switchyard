// Regressions for the Antigravity timeout cleanup failure (Task 6.3).
//
// Run c98c0c27-eb6b-46e9-8cba-5e8f1acc50f4 timed out after 30 minutes,
// retained artifacts/1.1.diff, and ended execution_timed_out_cleanup_failed.
// Its events.jsonl records provider_cleanup_started, provider_pid_observed,
// then provider_cleanup_failed — provider_tree_gone never fired, which places
// the fault in the guest kill exec and nowhere else. Two causes produce that
// ordering and the recorded event could not tell them apart: the kill script
// ran and reported survivors, or the guest exec never ran at all. They have
// different fixes, so the event now carries the stage and exit status.
//
// The record was also self-contradictory. It named the timeout in `result`
// (execution_timed_out_cleanup_failed) and in `failurePhase`
// (provider_cleanup), while errorKind, reasonCode, reason, and diagnosticCode
// all still said a plain execution_timed_out. The cause is that
// killOrphanedProcesses returned void: every synchronous adapter discarded the
// cleanup outcome, so runner/index.mjs's `execution.cleanupFailed === true`
// branch could never be taken on that path and a guest provider that survived
// the kill was booked as a clean timeout. That is an INV-3 exposure the
// terminal state hid — the working object outlives the run.
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { readFileSync, rmSync } from "node:fs";

import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	CLEANUP_STAGES,
	sanitizeFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";
import { killOrphanedProcesses } from "../src/switchyard/adapter/orphan-kill.mjs";
import { makeOnStatus } from "./helpers/bootstrap-handler.mjs";
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

const SYNC_ADAPTERS = [
	"agy",
	"claude",
	"codex",
	"copilot",
	"cursor",
	"opencode",
	"vibe",
];

/** A backend whose guest cleanup throws the given error. */
function throwingBackend(error) {
	return {
		cleanupProviderProcess() {
			throw error;
		},
	};
}

function kill(backend) {
	// A container name the Docker backstop rejects outright. The backstop still
	// runs after a backend failure by design, and this keeps it a guaranteed
	// no-op so a passing assertion can only be explained by the backend branch.
	return killOrphanedProcesses("unsafe;name", {
		executionBackend: backend,
		command: "prlctl",
		args: ["exec", "switchyard-guest"],
	});
}

describe("killOrphanedProcesses reports its cleanup outcome (Task 6.3)", () => {
	it("reports failure when the guest kill script runs and finds survivors", () => {
		// execFileSync sets `status` when the command ran and exited non-zero.
		// The kill script's last statement is `[ -z "$survivors" ]`, so a status
		// of 1 means it completed and a process was still alive after SIGKILL.
		const error = Object.assign(new Error("survivors after SIGKILL"), {
			status: 1,
			cleanupStage: "pid_observed",
		});
		deepStrictEqual(kill(throwingBackend(error)), {
			cleanupFailed: true,
			cleanupStage: "pid_observed",
			exitCode: 1,
			signal: null,
			failurePhase: "provider_cleanup",
		});
	});

	it("distinguishes a transport failure, where the kill script never ran", () => {
		// No `status`: prlctl itself could not be executed, so nothing in the
		// guest was signalled. Same event, different fix — this is the case the
		// recorded run could not be told apart from the one above.
		const error = Object.assign(new Error("prlctl unavailable"), {
			code: "ENOENT",
			cleanupStage: "cleanup_started",
		});
		const outcome = kill(throwingBackend(error));
		strictEqual(outcome.cleanupFailed, true);
		strictEqual(outcome.cleanupStage, "cleanup_started");
		strictEqual(
			outcome.exitCode,
			null,
			"a transport failure has no guest exit status to report",
		);
	});

	it("reports success when the backend's cleanup returns", () => {
		const outcome = killOrphanedProcesses("switchyard-nonexistent-container", {
			executionBackend: { cleanupProviderProcess() {} },
			command: "prlctl",
			args: ["exec", "switchyard-guest"],
		});
		strictEqual(outcome.cleanupFailed, false);
		strictEqual(outcome.failurePhase, null);
	});

	it("keeps the Docker-only path's best-effort semantics", () => {
		// No backend at all. killViaDocker swallows everything, so there is no
		// signal either way; reporting failure here would reclassify every
		// Docker timeout as a cleanup failure.
		const outcome = killOrphanedProcesses(
			"switchyard-nonexistent-container",
			{},
		);
		strictEqual(outcome.cleanupFailed, false);
	});

	it("never throws, whatever the backend does", () => {
		// It runs from a timeout catch block and must return the already-failed
		// execution result rather than replace it with a cleanup error.
		for (const thrown of [
			new Error("guest unreachable"),
			"a string, not an Error",
			null,
		]) {
			const outcome = kill(throwingBackend(thrown));
			strictEqual(outcome.cleanupFailed, true);
		}
	});

	it("only reports stages the diagnostic-code map can name", () => {
		// A stage the map does not know would persist as an unmappable value.
		const outcome = kill(
			throwingBackend(
				Object.assign(new Error("x"), { cleanupStage: "pid_observed" }),
			),
		);
		ok(
			CLEANUP_STAGES.has(outcome.cleanupStage),
			`stage ${outcome.cleanupStage} is outside the closed vocabulary`,
		);
	});
});

describe("every synchronous adapter threads the outcome (Task 6.3)", () => {
	// Source-level: reaching these lines at runtime needs a real provider
	// process and a real timeout. The assertion is still specific — it fails if
	// any one adapter is reverted to discarding the return value.
	for (const name of SYNC_ADAPTERS) {
		it(`${name} captures and forwards the cleanup outcome`, () => {
			const source = readFileSync(`src/switchyard/adapter/${name}.mjs`, "utf8");
			ok(
				/const cleanup = killOrphanedProcesses\(/.test(source),
				`${name}.mjs must capture killOrphanedProcesses' return value`,
			);
			ok(
				/\n\t+\.\.\.cleanup,\n/.test(source),
				`${name}.mjs must spread the cleanup outcome into its timeout envelope`,
			);
		});
	}
});

describe("the cleanup event carries its discriminator (Task 6.3)", () => {
	it("forwards cleanupStage, exitCode and signal through onStatus", () => {
		const { onStatus, emitted } = makeOnStatus();
		onStatus({
			phase: "execution",
			event: "provider_cleanup_failed",
			status: "Guest provider cleanup could not confirm process exit",
			cleanupStage: "pid_observed",
			exitCode: 1,
			signal: "SIGKILL",
		});
		strictEqual(emitted.length, 1);
		strictEqual(emitted[0].cleanupStage, "pid_observed");
		strictEqual(emitted[0].exitCode, 1);
		strictEqual(emitted[0].signal, "SIGKILL");
	});

	it("drops values outside each closed vocabulary rather than persisting them", () => {
		const { onStatus, emitted } = makeOnStatus();
		onStatus({
			phase: "execution",
			event: "provider_cleanup_failed",
			status: "cleanup failed",
			// Not a member of CLEANUP_STAGES — plausibly shaped, still refused.
			cleanupStage: "definitely_not_a_stage",
			exitCode: 256,
			signal: "SIGNOTREAL",
		});
		strictEqual(emitted.length, 1);
		ok(!("cleanupStage" in emitted[0]), "an unknown stage must be dropped");
		ok(
			!("exitCode" in emitted[0]),
			"an out-of-range exit code must be dropped",
		);
		ok(!("signal" in emitted[0]), "an unknown signal must be dropped");
	});

	it("forwards by name, so an unlisted field cannot ride along", () => {
		const { onStatus, emitted } = makeOnStatus();
		onStatus({
			phase: "execution",
			event: "provider_cleanup_failed",
			status: "cleanup failed",
			cleanupStage: "tree_terminated",
			// Raw provider text, exactly what INV-2 forbids persisting.
			stderr: "fatal: could not read Username for 'https://github.com'",
			output: "-----BEGIN PRIVATE KEY-----",
		});
		deepStrictEqual(Object.keys(emitted[0]).sort(), [
			"cleanupStage",
			"event",
			"phase",
			"status",
		]);
	});
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
		// makeOnStatus uses a fake store, so it proves the handler forwards the
		// field but not that createEvent will keep it. cleanupStage had to be
		// added to APPROVED_EVENT_KEYS deliberately; without that entry the
		// handler would forward a value the store silently drops, and the event
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
