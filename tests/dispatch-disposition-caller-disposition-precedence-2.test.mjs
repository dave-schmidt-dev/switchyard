import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	projectDisposition,
	projectTerminalOutcome,
} from "../src/switchyard/dispatch/disposition.mjs";
import { run } from "./helpers/dispatch-disposition-fixtures.mjs";

function failure(overrides = {}) {
	return {
		errorKind: "execution_failed",
		reasonCode: "execution_failed",
		reason: "closed",
		diagnosticCode: "provider_exit_nonzero",
		failurePhase: "provider_execution",
		diagnosticOrigin: "adapter",
		diagnosticEvidenceAvailable: true,
		...overrides,
	};
}
function exactFailure(targetId, taskId = "2.1") {
	const descriptorIdentity = `sha256:${"a".repeat(64)}`;
	return {
		taskId,
		success: false,
		resolvedTargetId: targetId,
		descriptorHarness: "codex",
		descriptorIdentity,
		invocationDescriptor: {
			target_id: targetId,
			descriptor_identity: descriptorIdentity,
		},
		...failure(),
	};
}

describe("caller disposition precedence", () => {
	const recoveryCommand =
		"switchyard-dispatch recover --run run-1 --state-root '/tmp/state'";
	// biome-ignore lint/correctness/noUnusedVariables: source-specific pure closure retained for exact registration parity
	const cases = [
		[
			"recovery required outranks dead-worker recovery",
			{
				run: run({ state: "recovery_required", cleanupState: "failed" }),
				liveness: "dead",
			},
			"stop",
			"recovery_incomplete",
		],
		[
			"live succeeded finalizer outranks completion",
			{
				run: run({ state: "succeeded", cleanupState: "pending" }),
				liveness: "live",
			},
			"monitor",
			"cleanup_in_progress",
		],
		[
			"live failed finalizer outranks contract repair",
			{
				run: run({
					state: "failed",
					cleanupState: "pending",
					lastFailure: failure({
						diagnosticCode: "worker_contract_unsupported",
					}),
				}),
				liveness: "startup_grace",
			},
			"monitor",
			"cleanup_in_progress",
		],
		[
			"dead terminal cleanup is recoverable",
			{
				run: run({ state: "failed", cleanupState: "not_started" }),
				liveness: "dead",
				recoveryCommand,
			},
			"recover",
			"cleanup_incomplete",
		],
		[
			"clean success completes",
			{
				run: run({ state: "succeeded", cleanupState: "complete" }),
				liveness: "terminal_clean",
			},
			"complete",
			"run_succeeded",
		],
		[
			"live nonterminal with no cleanup work monitors",
			{ run: run({ cleanupState: "complete" }), liveness: "live" },
			"monitor",
			"run_in_progress",
		],
		[
			"dead nonterminal recovers",
			{ run: run(), liveness: "dead", recoveryCommand },
			"recover",
			"worker_dead",
		],
		[
			"contract diagnostics repair",
			{
				run: run({
					state: "failed",
					cleanupState: "complete",
					lastFailure: failure({
						diagnosticCode: "checkpoint_queue_identity_mismatch",
						diagnosticOrigin: "worker_boot",
						failurePhase: "worker_boot",
					}),
				}),
				liveness: "terminal_clean",
			},
			"repair_contract",
			"checkpoint_queue_identity_mismatch",
		],
		[
			"exact target failure is projected without authority",
			{
				run: run({
					state: "failed",
					cleanupState: "complete",
					lastFailure: failure(),
				}),
				checkpoint: { retryAttempts: [exactFailure("codex/standard")] },
				liveness: "terminal_clean",
			},
			"target_failed",
			"provider_exit_nonzero",
		],
		[
			"insufficient evidence stops",
			{
				run: run({ state: "failed", cleanupState: "complete" }),
				liveness: "terminal_clean",
			},
			"stop",
			"insufficient_evidence",
		],
	];
	it("projects descriptor-bound Agy and OpenCode attempts from existing checkpoint channels", () => {
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure(),
			}),
			checkpoint: {
				retryAttempts: [exactFailure("agy-gemini", "2.3")],
				results: [exactFailure("opencode-go", "2.3")],
			},
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "target_failed");
		strictEqual(result.taskId, "2.3");
		deepStrictEqual(result.failedTargetIds, ["agy-gemini", "opencode-go"]);
	});
	it("stops when trusted failures span tasks without a current task context", () => {
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure(),
			}),
			checkpoint: {
				retryAttempts: [
					exactFailure("opencode-go", "2.4"),
					exactFailure("agy-gemini", "2.3"),
					exactFailure("codex-standard", "2.3"),
					exactFailure("invalid-task", "2.3/unsafe"),
					exactFailure("oversized-task", "1".repeat(65)),
				],
			},
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "stop");
		strictEqual(result.reasonCode, "insufficient_evidence");
		strictEqual(result.taskId, null);
		deepStrictEqual(result.failedTargetIds, []);
	});
	it("uses the current checkpoint task instead of historical task order", () => {
		const current = exactFailure("opencode-go", "10.1");
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				currentTaskId: null,
				lastFailure: failure({
					taskId: "10.1",
					resolvedTargetId: current.resolvedTargetId,
					descriptorIdentity: current.descriptorIdentity,
					descriptorHarness: current.descriptorHarness,
				}),
			}),
			checkpoint: {
				lastTaskId: "10.1",
				retryAttempts: [current, exactFailure("opencode-go", "2.1")],
			},
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "target_failed");
		strictEqual(result.taskId, "10.1");
		deepStrictEqual(result.failedTargetIds, ["opencode-go"]);
	});
	it("does not authorize a current failure from legacy-only historical evidence", () => {
		const legacy = exactFailure("vibe", "1.1");
		delete legacy.diagnosticOrigin;
		delete legacy.diagnosticEvidenceAvailable;
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				currentTaskId: null,
				lastFailure: failure({
					taskId: "1.2",
					resolvedTargetId: "opencode-go",
					descriptorIdentity: `sha256:${"b".repeat(64)}`,
					descriptorHarness: "opencode",
				}),
			}),
			checkpoint: {
				lastTaskId: "1.2",
				completedTaskIds: ["1.1"],
				retryAttempts: [legacy],
			},
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "stop");
		strictEqual(result.reasonCode, "insufficient_evidence");
		strictEqual(result.taskId, null);
		deepStrictEqual(result.failedTargetIds, []);
	});
	it("excludes trusted completed-task evidence without mutating the checkpoint", () => {
		const completed = exactFailure("vibe", "1.1");
		const checkpoint = {
			lastTaskId: "1.2",
			completedTaskIds: ["1.1"],
			retryAttempts: [completed],
		};
		const snapshot = structuredClone(checkpoint);
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				currentTaskId: null,
				lastFailure: failure({ taskId: "1.2" }),
			}),
			checkpoint,
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "stop");
		deepStrictEqual(result.failedTargetIds, []);
		deepStrictEqual(checkpoint, snapshot);
	});
	it("keeps all trusted current-task attempts after matching the terminal route", () => {
		const terminal = exactFailure("opencode-go", "1.2");
		terminal.descriptorHarness = "opencode";
		const priorAttempt = exactFailure("agy-gemini", "1.2");
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				currentTaskId: null,
				lastFailure: failure({
					taskId: "1.2",
					resolvedTargetId: terminal.resolvedTargetId,
					descriptorIdentity: terminal.descriptorIdentity,
					descriptorHarness: terminal.descriptorHarness,
				}),
			}),
			checkpoint: {
				lastTaskId: "1.2",
				completedTaskIds: ["1.1"],
				retryAttempts: [priorAttempt, terminal],
				results: [exactFailure("vibe", "1.1")],
			},
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "target_failed");
		strictEqual(result.taskId, "1.2");
		deepStrictEqual(result.failedTargetIds, ["agy-gemini", "opencode-go"]);
	});
	it("stops when terminal and checkpoint task contexts disagree", () => {
		const current = exactFailure("opencode-go", "1.2");
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure({ taskId: "1.3" }),
			}),
			checkpoint: { lastTaskId: "1.2", retryAttempts: [current] },
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "stop");
		strictEqual(result.reasonCode, "insufficient_evidence");
		deepStrictEqual(result.failedTargetIds, []);
	});
	it("deduplicates six sanitized OpenCode execution failures without a cooldown schema", () => {
		const events = Array.from({ length: 6 }, () => ({
			...exactFailure("opencode-go", "2.3"),
			phase: "execution",
			event: "task_failed",
		}));
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure(),
			}),
			checkpoint: { retryAttempts: [], results: [] },
			events,
			liveness: "terminal_clean",
		});
		deepStrictEqual(result.failedTargetIds, ["opencode-go"]);
		strictEqual(Object.hasOwn(result, "cooldown"), false);
		strictEqual(Object.hasOwn(result, "cooldownUntil"), false);
	});
	it("does not promote run-record route fields into attempt evidence", () => {
		const exact = exactFailure("opencode-go", "2.3");
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure(),
				lastResolvedTargetId: exact.resolvedTargetId,
				lastTaskInvocationDescriptor: exact.invocationDescriptor,
				lastTaskDescriptorIdentity: exact.descriptorIdentity,
				lastTaskDescriptorHarness: exact.descriptorHarness,
			}),
			checkpoint: { retryAttempts: [], results: [] },
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "stop");
		deepStrictEqual(result.failedTargetIds, []);
	});
	it("ignores descriptor-bound failures outside sanitized execution events", () => {
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure(),
			}),
			checkpoint: { retryAttempts: [], results: [] },
			events: [
				{
					...exactFailure("opencode-go", "2.3"),
					phase: "broker",
					event: "task_failed",
				},
			],
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "stop");
		deepStrictEqual(result.failedTargetIds, []);
	});
	it("requires a provider or integration failure for target_failed", () => {
		const preProviderFailure = {
			...exactFailure("opencode-go", "2.3"),
			errorKind: "declared_path_not_seeded",
			failurePhase: "adapter_validation",
		};
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure({
					errorKind: "declared_path_not_seeded",
					failurePhase: "adapter_validation",
				}),
			}),
			checkpoint: { retryAttempts: [preProviderFailure], results: [] },
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "stop");
		deepStrictEqual(result.failedTargetIds, []);
	});
	it("rejects target IDs without exact descriptor-bound failure evidence", () => {
		const inexact = exactFailure("codex/standard");
		inexact.invocationDescriptor.target_id = "different";
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure(),
			}),
			checkpoint: { retryAttempts: [inexact] },
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "stop");
		deepStrictEqual(result.failedTargetIds, []);
	});
});

describe("terminal outcome projection", () => {
	const summary = (processedTasks) => ({ processedTasks });
	for (const [name, evidence, expected] of [
		[
			"completed work",
			run({
				state: "succeeded",
				cleanupState: "complete",
				terminalizedBy: "worker",
				terminalSummary: summary(2),
			}),
			"completed_work",
		],
		[
			"no runnable work",
			run({
				state: "succeeded",
				cleanupState: "complete",
				terminalizedBy: "worker",
				terminalSummary: summary(0),
			}),
			"no_runnable_work",
		],
		[
			"deferred work",
			run({
				state: "deferred",
				cleanupState: "complete",
				terminalSummary: summary(0),
			}),
			"deferred_work",
		],
		[
			"failed work",
			run({
				state: "failed",
				cleanupState: "complete",
				terminalizedBy: "worker",
				terminalSummary: summary(1),
			}),
			"failed_work",
		],
		[
			"failed before work",
			run({
				state: "failed",
				cleanupState: "complete",
				terminalizedBy: "worker",
				terminalSummary: summary(0),
			}),
			"failed_before_work",
		],
		[
			"dead worker recovery outranks counts",
			run({
				state: "failed",
				cleanupState: "complete",
				terminalizedBy: "dead_worker_recovery",
				terminalSummary: summary(7),
			}),
			"recovered_dead_worker",
		],
		[
			"historical failure stays unknown",
			run({
				state: "failed",
				cleanupState: "complete",
				terminalSummary: summary(3),
			}),
			"unknown_failure",
		],
		[
			"missing counts stay unknown",
			run({
				state: "failed",
				cleanupState: "complete",
				terminalizedBy: "worker",
				terminalSummary: summary(null),
			}),
			"unknown_failure",
		],
	]) {
		it(name, () => strictEqual(projectTerminalOutcome(evidence), expected));
	}
});

describe("shadow disposition parity", () => {
	it("carries reducer evidence without changing the legacy action", () => {
		const outcomeShadow = {
			version: 1,
			projection: { finalStatus: "failed" },
			parity: { version: 1, status: "match", evidence: "shadow" },
			recoveryQueue: [],
		};
		const result = projectDisposition({
			run: run({ state: "running" }),
			liveness: "live",
			outcomeShadow,
		});
		strictEqual(result.action, "monitor");
		strictEqual(result.direction, "wait");
		deepStrictEqual(result.outcomeShadow, outcomeShadow);
	});
});
