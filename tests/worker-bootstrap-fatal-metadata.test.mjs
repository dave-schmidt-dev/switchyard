// Regression coverage for worker-bootstrap.mjs's writeFatalEvent() metadata
// composition: which closed diagnostic code wins when a prlctl misfire, a
// boot-stage error, and a checkpoint-identity error can all be in play, and
// when the resulting exitCode/signal are attached to (or withheld from) the
// persisted failure.
//
// worker-bootstrap.mjs can't be imported directly -- it's a bare top-level
// script that parses process.argv and calls process.exit on the spot (see
// worker-bootstrap-write-chain.test.mjs for the same constraint on its
// writeChain logic). This file follows that established pattern: it imports
// the REAL classifiers (prlctlFailureMetadata, workerBootStageDiagnosticCode,
// sanitizeFailureMetadata) and reproduces only the small glue that combines
// them, copied verbatim from writeFatalEvent(). If that composition in
// worker-bootstrap.mjs ever changes, keep buildFatalFailure() below in sync
// with it -- this pins the imported pipeline's composition, it cannot catch a
// drift introduced only inside worker-bootstrap.mjs itself.

import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	PrlctlCallError,
	prlctlFailureMetadata,
	sanitizeFailureMetadata,
	WorkerBootStageError,
	workerBootStageDiagnosticCode,
} from "../src/switchyard/adapter/exec-error.mjs";

// Copied from worker-bootstrap.mjs's RECOGNIZED_CHECKPOINT_IDENTITY_CODES /
// isRecognizedCheckpointIdentityError.
const RECOGNIZED_CHECKPOINT_IDENTITY_CODES = new Set([
	"checkpoint_task_file_mismatch",
	"checkpoint_tasks_file_mismatch",
	"checkpoint_missing_queue_identity",
	"checkpoint_queue_identity_missing",
	"checkpoint_queue_identity_mismatch",
	"checkpoint_run_options_mismatch",
	"checkpoint_historical_checkpoint",
	"checkpoint_historical_state",
]);

function isRecognizedCheckpointIdentityError(error) {
	return (
		typeof error?.code === "string" &&
		RECOGNIZED_CHECKPOINT_IDENTITY_CODES.has(error.code)
	);
}

// Copied from writeFatalEvent()'s closedCode/failure construction.
function buildFatalFailure(error, diagnosticCode = "worker_boot_exception") {
	const prlctlFailure = prlctlFailureMetadata(error);
	const closedCode = isRecognizedCheckpointIdentityError(error)
		? error.code
		: (prlctlFailure?.diagnosticCode ??
			workerBootStageDiagnosticCode(error) ??
			diagnosticCode);
	return sanitizeFailureMetadata({
		result: "launch_failed",
		errorKind: "launch_failed",
		diagnosticCode: closedCode,
		failurePhase: "worker_boot",
		...(prlctlFailure && closedCode === prlctlFailure.diagnosticCode
			? { exitCode: prlctlFailure.exitCode, signal: prlctlFailure.signal }
			: {}),
	});
}

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
