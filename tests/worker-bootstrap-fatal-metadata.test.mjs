// Regression coverage for worker-bootstrap.mjs's production fatal metadata
// composition.

import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	PrlctlCallError,
	prlctlFailureMetadata,
	WorkerBootStageError,
	workerBootStageDiagnosticCode,
} from "../src/switchyard/adapter/exec-error.mjs";
import { buildFatalFailure } from "../src/switchyard/dispatch/worker-bootstrap.mjs";

describe("writeFatalEvent metadata composition", () => {
	it("prefers the prlctl misfire code over the boot stage it happened during, and attaches its exit code", () => {
		// "workspace_prepare_failed" says which stage died; "prlctl_job_misfire"
		// says why, and only the why tells a reader a transient host fault from
		// a real provisioning problem apart. The exit code belongs to the
		// failure that is actually being recorded, so it must survive too.
		const misfire = new PrlctlCallError({
			diagnosticCode: "prlctl_job_misfire",
			subcommand: "exec",
			attempts: 4,
			exitCode: 255,
		});
		const staged = new WorkerBootStageError(
			"workspace_prepare_failed",
			misfire,
		);

		const failure = buildFatalFailure(staged, "worker_boot_exception");

		strictEqual(failure.diagnosticCode, "prlctl_job_misfire");
		strictEqual(failure.exitCode, 255);
		strictEqual(failure.failurePhase, "worker_boot");
	});

	it("falls back to the boot stage code when the cause is not a prlctl failure, and records no exit code", () => {
		const staged = new WorkerBootStageError(
			"clone_hardening_failed",
			new Error("chmod: /Users/switchyard: Read-only file system"),
		);

		const failure = buildFatalFailure(staged, "worker_boot_exception");

		strictEqual(failure.diagnosticCode, "clone_hardening_failed");
		strictEqual(failure.exitCode, undefined);
		strictEqual(failure.signal, undefined);
	});

	it("falls back to the generic diagnosticCode when the error is neither a prlctl nor a boot-stage failure", () => {
		const failure = buildFatalFailure(
			new Error("ENOENT: tasks file not found"),
			"worker_boot_exception",
		);

		strictEqual(failure.diagnosticCode, "worker_boot_exception");
		strictEqual(failure.exitCode, undefined);
	});

	it("never attaches a prlctl exit code to an unrelated closed code the checkpoint-identity branch selected", () => {
		// The misattribution guard: `closedCode === prlctlFailure.diagnosticCode`
		// must gate the exitCode/signal spread, not merely "a prlctl failure was
		// found somewhere in the cause chain". A checkpoint-identity error takes
		// precedence over a prlctl code for closedCode itself (see
		// isRecognizedCheckpointIdentityError), so even if a prlctl failure sits
		// in its cause chain, the checkpoint code's failure record must not
		// borrow that unrelated exit code.
		const misfire = new PrlctlCallError({
			diagnosticCode: "prlctl_job_misfire",
			subcommand: "exec",
			attempts: 2,
			exitCode: 255,
		});
		const identityError = Object.assign(
			new Error("checkpoint task file identity mismatch"),
			{ code: "checkpoint_task_file_mismatch", cause: misfire },
		);

		const failure = buildFatalFailure(identityError, "worker_boot_exception");

		strictEqual(failure.diagnosticCode, "checkpoint_task_file_mismatch");
		strictEqual(
			failure.exitCode,
			undefined,
			"an exit code from an unrelated cause must not be attached to the checkpoint-identity failure",
		);
	});

	it("matches the real closed-code precedence a run record actually reads", () => {
		// Sanity check that the reproduction above still agrees with the two
		// classifiers it composes, independently of this file's own glue.
		const misfire = new PrlctlCallError({
			diagnosticCode: "prlctl_session_not_ready",
			subcommand: "exec",
			attempts: 1,
		});
		const staged = new WorkerBootStageError(
			"workspace_prepare_failed",
			misfire,
		);

		deepStrictEqual(prlctlFailureMetadata(staged), {
			diagnosticCode: "prlctl_session_not_ready",
		});
		strictEqual(
			workerBootStageDiagnosticCode(staged),
			"workspace_prepare_failed",
		);
		strictEqual(
			buildFatalFailure(staged).diagnosticCode,
			"prlctl_session_not_ready",
		);
	});
});
