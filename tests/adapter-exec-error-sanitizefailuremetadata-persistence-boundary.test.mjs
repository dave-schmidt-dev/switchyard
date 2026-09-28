import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	classifyPreProviderFailure,
	classifyProviderDiagnostic,
	cleanupDiagnosticCodeFor,
	describeExecError,
	INTEGRATION_REFUSAL_KINDS,
	isPersistentFailureMetadata,
	PERSISTED_DIAGNOSTIC_CODES,
	PERSISTED_ERROR_KINDS,
	PRE_PROVIDER_FAILURE_TRIPLES,
	PrlctlCallError,
	prlctlTrustedCauseCode,
	reauthHintFor,
	sanitizeFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";

describe("sanitizeFailureMetadata — persistence boundary", () => {
	it("retains only allowlisted structured execution diagnostics", () => {
		const metadata = sanitizeFailureMetadata({
			result: "execution_failed",
			errorKind: "execution_failed",
			diagnosticCode: "cli_usage_error",
			exitCode: 2,
			signal: "SECRET_CANARY_signal",
			failurePhase: "provider_execution",
		});

		deepStrictEqual(metadata, {
			errorKind: "execution_failed",
			reasonCode: "execution_failed",
			reason: "Provider execution failed before a reviewed integration.",
			diagnosticCode: "cli_usage_error",
			exitCode: 2,
			failurePhase: "provider_execution",
		});
		ok(isPersistentFailureMetadata(metadata));
		strictEqual(JSON.stringify(metadata).includes("SECRET_CANARY"), false);
	});

	it("retains silence_timeout as a closed durable execution outcome", () => {
		const metadata = sanitizeFailureMetadata({
			result: "silence_timeout",
			errorKind: "silence_timeout",
			error: "SECRET_CANARY raw provider error",
		});
		deepStrictEqual(metadata, {
			errorKind: "silence_timeout",
			reasonCode: "silence_timeout",
			reason:
				"Provider made no substantive progress before the silence deadline.",
		});
		ok(PERSISTED_ERROR_KINDS.includes("silence_timeout"));
		ok(isPersistentFailureMetadata(metadata));
		strictEqual(JSON.stringify(metadata).includes("SECRET_CANARY"), false);
	});

	it("retains only bounded route provenance alongside a trusted diagnostic", () => {
		const metadata = sanitizeFailureMetadata({
			result: "execution_failed",
			errorKind: "execution_failed",
			diagnosticCode: "provider_exit_nonzero",
			diagnosticOrigin: "adapter",
			diagnosticEvidenceAvailable: true,
			failurePhase: "provider_execution",
			resolvedTargetId: "codex/standard",
			descriptorIdentity: `sha256:${"a".repeat(64)}`,
			descriptorHarness: "codex",
		});
		strictEqual(metadata.diagnosticOrigin, "adapter");
		strictEqual(metadata.diagnosticEvidenceAvailable, true);
		strictEqual(metadata.resolvedTargetId, "codex/standard");
		strictEqual(metadata.descriptorHarness, "codex");
		ok(isPersistentFailureMetadata(metadata));
	});

	it("rejects mismatched diagnostic origins while retaining exact host provenance", () => {
		for (const [diagnosticCode, diagnosticOrigin, failurePhase] of [
			["cli_usage_error", "adapter", "provider_execution"],
			["quota_exhausted", "launcher", "provider_execution"],
			["worker_boot_exception", "adapter", "worker_boot"],
			["quota_exhausted", "worker_boot", undefined],
			["worker_boot_exception", "worker_boot", undefined],
		]) {
			const input = {
				result: "execution_failed",
				diagnosticCode,
				diagnosticOrigin,
				diagnosticEvidenceAvailable: true,
				failurePhase,
			};
			const metadata = sanitizeFailureMetadata(input);
			strictEqual(metadata.diagnosticCode, undefined);
			strictEqual(metadata.diagnosticOrigin, undefined);
			strictEqual(metadata.diagnosticEvidenceAvailable, undefined);
			ok(!isPersistentFailureMetadata({ ...metadata, ...input }));
		}

		for (const input of [
			{
				diagnosticCode: "cli_usage_error",
				diagnosticOrigin: "launcher",
				failurePhase: "provider_execution",
			},
			{
				diagnosticCode: "provider_exit_nonzero",
				diagnosticOrigin: "adapter",
				failurePhase: "provider_execution",
			},
			{
				diagnosticCode: "worker_boot_exception",
				diagnosticOrigin: "worker_boot",
				failurePhase: "worker_boot",
			},
		]) {
			const metadata = sanitizeFailureMetadata({
				result: "execution_failed",
				diagnosticEvidenceAvailable: true,
				...input,
			});
			strictEqual(metadata.diagnosticCode, input.diagnosticCode);
			strictEqual(metadata.diagnosticOrigin, input.diagnosticOrigin);
			ok(isPersistentFailureMetadata(metadata));
		}
	});

	it("uses accurate closed wording for diff capture failures", () => {
		const metadata = sanitizeFailureMetadata({ result: "diff_capture_failed" });
		strictEqual(metadata.reason, "Diff capture failed.");
	});

	it("does not let usage-like provider, task, or child-tool prose mint CLI misuse", () => {
		for (const text of [
			"SECRET_CANARY task says usage: npm run test",
			"SECRET_CANARY model says invalid value is expected",
			"SECRET_CANARY child stderr: usage: helper",
		]) {
			strictEqual(
				classifyProviderDiagnostic({
					text,
					exitCode: 2,
					diagnosticOrigin: "adapter",
					diagnosticEvidenceAvailable: true,
				}),
				"provider_exit_nonzero",
			);
		}
	});

	it("prefers a safe nonzero exit over arbitrary provider output", () => {
		strictEqual(
			classifyProviderDiagnostic({
				text: "SECRET_CANARY arbitrary provider output",
				exitCode: 17,
				diagnosticOrigin: "adapter",
				diagnosticEvidenceAvailable: true,
			}),
			"provider_exit_nonzero",
		);
	});

	it("leaves output without structured diagnostic evidence unknown", () => {
		for (const exitCode of [undefined, null, 0]) {
			strictEqual(
				classifyProviderDiagnostic({
					text: "SECRET_CANARY arbitrary provider output",
					exitCode,
					diagnosticOrigin: "adapter",
					diagnosticEvidenceAvailable: true,
				}),
				null,
			);
		}
	});

	it("retains specific provider diagnostics ahead of a nonzero exit", () => {
		for (const [input, expected] of [
			[{ cancelled: true, exitCode: 1 }, "execution_cancelled"],
			[{ timedOut: true, exitCode: 1 }, "execution_timed_out"],
			[{ diagnosticCode: "auth_expired", exitCode: 1 }, "auth_expired"],
			[{ diagnosticCode: "quota_exhausted", exitCode: 1 }, "quota_exhausted"],
			[
				{ diagnosticCode: "model_unavailable", exitCode: 1 },
				"model_unavailable",
			],
			[{ signal: "SIGTERM", exitCode: 1 }, "provider_signalled"],
		]) {
			strictEqual(
				classifyProviderDiagnostic({
					...input,
					diagnosticOrigin: "adapter",
					diagnosticEvidenceAvailable: true,
				}),
				expected,
			);
		}
		strictEqual(
			classifyProviderDiagnostic({
				diagnosticCode: "cli_usage_error",
				diagnosticOrigin: "launcher",
				diagnosticEvidenceAvailable: true,
				failurePhase: "provider_execution",
			}),
			"cli_usage_error",
		);
		strictEqual(
			classifyProviderDiagnostic({ diagnosticCode: "cli_usage_error" }),
			null,
		);
	});

	it("maps a cleanup stage to a static durable diagnostic", () => {
		strictEqual(
			cleanupDiagnosticCodeFor("pid_marker_removed"),
			"provider_cleanup_after_pid_marker_removed",
		);
		const metadata = sanitizeFailureMetadata({
			result: "execution_failed",
			errorKind: "provider_cleanup_failed",
			cleanupStage: "pid_marker_removed",
			failurePhase: "provider_cleanup",
		});
		deepStrictEqual(metadata, {
			errorKind: "provider_cleanup_failed",
			reasonCode: "provider_cleanup_failed",
			reason: "Working container cleanup failed after execution timeout.",
			diagnosticCode: "provider_cleanup_after_pid_marker_removed",
			failurePhase: "provider_cleanup",
		});
		ok(isPersistentFailureMetadata(metadata));
	});

	it("maps an untrusted provider classification to static metadata without an artifact ref", () => {
		const metadata = sanitizeFailureMetadata({
			taskId: "1.1",
			result: "execution_failed",
			errorKind: "provider_private_reason",
			partialDiffPath: "/Users/dave/project/.partial-diffs/1.1.diff",
		});

		strictEqual(metadata.errorKind, "execution_failed");
		strictEqual(metadata.reasonCode, "execution_failed");
		strictEqual(
			metadata.reason,
			"Provider execution failed before a reviewed integration.",
		);
		strictEqual(metadata.artifactRef, undefined);
		ok(!metadata.reason.includes("/Users/dave"));
		ok(isPersistentFailureMetadata(metadata));
	});

	it("does not synthesize a transcript artifact when a rejection has no diff to point at", () => {
		const metadata = sanitizeFailureMetadata({
			taskId: "1.1",
			result: "integration_failed",
			diagnosticCode: "empty_required_diff",
			gateEvidencePath: "/Users/dave/project/.partial-diffs/1.1.output",
		});

		strictEqual(metadata.diagnosticCode, "empty_required_diff");
		strictEqual(metadata.artifactRef, undefined);
		ok(!JSON.stringify(metadata).includes("/Users/dave"));
		ok(isPersistentFailureMetadata(metadata));
	});

	it("prefers the diff artifact over the transcript when both exist", () => {
		const both = sanitizeFailureMetadata({
			taskId: "1.1",
			result: "integration_failed",
			partialDiffPath: "/Users/dave/project/.partial-diffs/1.1.diff",
			gateEvidencePath: "/Users/dave/project/.partial-diffs/1.1.output",
		});
		const diffOnly = sanitizeFailureMetadata({
			taskId: "1.1",
			result: "integration_failed",
			partialDiffPath: "/Users/dave/project/.partial-diffs/1.1.diff",
		});
		strictEqual(both.artifactRef, diffOnly.artifactRef);
	});

	it("emits no artifact reference when a rejection kept nothing", () => {
		const metadata = sanitizeFailureMetadata({
			taskId: "1.1",
			result: "integration_failed",
			diagnosticCode: "empty_required_diff",
		});
		strictEqual(metadata.artifactRef, undefined);
	});

	it("keeps every integration refusal kind persistable and resolvable to a named reason", () => {
		ok(INTEGRATION_REFUSAL_KINDS.includes("integration_state_unknown"));
		for (const kind of INTEGRATION_REFUSAL_KINDS) {
			ok(
				PERSISTED_DIAGNOSTIC_CODES.includes(kind),
				`${kind} must be persistable to reach run.json, events.jsonl, and the checkpoint`,
			);
			const metadata = sanitizeFailureMetadata({
				taskId: "1.1",
				result: "integration_failed",
				diagnosticCode: kind,
			});
			strictEqual(metadata.diagnosticCode, kind, `${kind} must survive`);
			ok(isPersistentFailureMetadata(metadata));
		}
	});

	it("carries no path, diff hunk, or provider text on any refusal kind", () => {
		for (const kind of INTEGRATION_REFUSAL_KINDS) {
			const metadata = sanitizeFailureMetadata({
				taskId: "1.1",
				result: "integration_failed",
				diagnosticCode: kind,
			});
			const serialized = JSON.stringify(metadata);
			ok(!/\//.test(serialized), `${kind} must carry no path separator`);
			ok(!/^\+\+\+|@@/m.test(serialized), `${kind} must carry no diff hunk`);
			ok(
				!/[Uu]sers|home|tmp|\.diff/.test(serialized),
				`${kind} must name no filesystem location: ${serialized}`,
			);
		}
	});

	it("retains the closed auth-expired enum without persisting the adapter's raw hint", () => {
		const metadata = sanitizeFailureMetadata({
			taskId: "1.2",
			result: "execution_failed",
			errorKind: "auth_expired",
		});

		deepStrictEqual(metadata, {
			errorKind: "auth_expired",
			reasonCode: "auth_expired",
			reason:
				"Provider authentication expired; interactive re-authentication is required.",
		});
		ok(PERSISTED_ERROR_KINDS.includes(metadata.errorKind));
	});

	it("does not create failure metadata for successful results", () => {
		strictEqual(sanitizeFailureMetadata({ result: "success" }), null);
		strictEqual(sanitizeFailureMetadata({ result: "success_no_diff" }), null);
	});

	it("rejects durable metadata carrying raw provider fields", () => {
		ok(
			!isPersistentFailureMetadata({
				errorKind: "execution_failed",
				reasonCode: "execution_failed",
				reason: "Provider execution failed before a reviewed integration.",
				output: "SECRET_CANARY_provider_output",
			}),
		);
	});

	it("retains the unclassified error kind and validates its failure metadata", () => {
		ok(PERSISTED_ERROR_KINDS.includes("unclassified"));
		const metadata = sanitizeFailureMetadata({
			taskId: "1.1",
			result: "execution_failed",
			errorKind: "unclassified",
		});

		deepStrictEqual(metadata, {
			errorKind: "unclassified",
			reasonCode: "unclassified",
			reason: "The task failed for an unclassified reason.",
		});
		ok(isPersistentFailureMetadata(metadata));
	});
});
