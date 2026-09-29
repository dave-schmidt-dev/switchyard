import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { executeBrokerRoute } from "../src/switchyard/broker/executor.mjs";
import { BROKER_CONTRACT_VERSION } from "../src/switchyard/broker/schema.mjs";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import { sanitizeReviewResult } from "../src/switchyard/diagnostics/review-result.mjs";
import { getInvocationDescriptorIdentity } from "../src/switchyard/roster/index.mjs";
import { sourceText } from "./helpers/source-text.mjs";

function fixture() {
	const core = {
		target_id: "claude",
		model_ref: "claude-standard",
		selector: "claude-standard",
		effort: null,
		variant: null,
		invocation_args: [],
	};
	const descriptor = {
		...core,
		descriptor_identity: getInvocationDescriptorIdentity(core, "claude"),
	};
	const request = {
		schemaVersion: BROKER_CONTRACT_VERSION,
		capability: "standard",
		dataClass: "repository",
		estimatedConsumption: 2,
		runId: "run-1",
		taskId: "TASK-001",
		snapshotSource: "gradus-v2",
		availableAdapters: ["claude"],
	};
	const route = {
		schemaVersion: BROKER_CONTRACT_VERSION,
		runId: "run-1",
		taskId: "TASK-001",
		capability: "standard",
		provider: "Claude",
		resolvedTarget: "claude",
		harness: "claude",
		model: "claude-standard",
		effort: null,
		snapshotIdentity: {
			source: "gradus-v2",
			status: "fresh",
			mtime: 1,
			ageMs: 2,
		},
		reservation: {
			id: "reservation-1",
			provider: "Claude",
			runId: "run-1",
			taskId: "TASK-001",
			amount: 2,
		},
		reason: "ranked",
	};
	const launcherIdentity = {
		provider: "Claude",
		resolvedTarget: "claude",
		harness: "claude",
		model: "claude-standard",
		effort: null,
		descriptorIdentity: descriptor.descriptor_identity,
		reservationId: "reservation-1",
		snapshotIdentity: route.snapshotIdentity,
	};
	return { request, route, descriptor, launcherIdentity };
}

describe("broker async executor", () => {
	it("reports a null verification for a launcher that cannot read one back", async () => {
		const value = fixture();
		const result = await executeBrokerRoute({
			request: value.request,
			route: value.route,
			invocationDescriptor: value.descriptor,
			launcherIdentity: value.launcherIdentity,
			launch: async () => ({ success: true, actualConsumption: 1 }),
			terminal: async () => ({ changed: true }),
		});
		strictEqual(result.servedModelVerified, null);
	});

	it("forwards every broker field the runner reads off the result", async () => {
		const runnerSource = sourceText(
			new URL("../src/switchyard/runner/index.mjs", import.meta.url),
			new URL("../src/switchyard/runner/constants.mjs", import.meta.url),
			new URL(
				"../src/switchyard/runner/checkpoint-errors.mjs",
				import.meta.url,
			),
			new URL("../src/switchyard/runner/task-fields.mjs", import.meta.url),
			new URL("../src/switchyard/runner/task-queue.mjs", import.meta.url),
			new URL("../src/switchyard/runner/ledger-reporting.mjs", import.meta.url),
			new URL("../src/switchyard/runner/review-results.mjs", import.meta.url),
			new URL("../src/switchyard/runner/quick-checks.mjs", import.meta.url),
			new URL("../src/switchyard/runner/checkpoint-store.mjs", import.meta.url),
			new URL("../src/switchyard/runner/checkpoint-load.mjs", import.meta.url),
			new URL(
				"../src/switchyard/runner/reconciliation-intent.mjs",
				import.meta.url,
			),
			new URL(
				"../src/switchyard/runner/reconciliation-validate.mjs",
				import.meta.url,
			),
			new URL(
				"../src/switchyard/runner/external-completion.mjs",
				import.meta.url,
			),
			new URL("../src/switchyard/runner/artifacts.mjs", import.meta.url),
			new URL("../src/switchyard/runner/queue-selection.mjs", import.meta.url),
			new URL("../src/switchyard/runner/caller-inputs.mjs", import.meta.url),
			new URL("../src/switchyard/runner/task-routing.mjs", import.meta.url),
			new URL("../src/switchyard/runner/route-health.mjs", import.meta.url),
			new URL("../src/switchyard/runner/task-base.mjs", import.meta.url),
			new URL(
				"../src/switchyard/runner/retry-transitions.mjs",
				import.meta.url,
			),
			new URL("../src/switchyard/runner/halts.mjs", import.meta.url),
			new URL("../src/switchyard/runner/broker.mjs", import.meta.url),
			new URL("../src/switchyard/runner/outcome-writer.mjs", import.meta.url),
			new URL(
				"../src/switchyard/runner/execute-task-unsafe.mjs",
				import.meta.url,
			),
			new URL(
				"../src/switchyard/runner/execute-task-unsafe-prepare.mjs",
				import.meta.url,
			),
			new URL(
				"../src/switchyard/runner/execute-task-unsafe-failure.mjs",
				import.meta.url,
			),
			new URL(
				"../src/switchyard/runner/execute-task-unsafe-success.mjs",
				import.meta.url,
			),
			new URL(
				"../src/switchyard/runner/execute-task-async-unsafe.mjs",
				import.meta.url,
			),
			new URL(
				"../src/switchyard/runner/execute-task-async-unsafe-prepare.mjs",
				import.meta.url,
			),
			new URL(
				"../src/switchyard/runner/execute-task-async-unsafe-failure.mjs",
				import.meta.url,
			),
			new URL(
				"../src/switchyard/runner/execute-task-async-unsafe-success.mjs",
				import.meta.url,
			),
			new URL("../src/switchyard/runner/execute-task.mjs", import.meta.url),
			new URL(
				"../src/switchyard/runner/execute-orchestrator-unsafe.mjs",
				import.meta.url,
			),
			new URL("../src/switchyard/runner/queue-preflight.mjs", import.meta.url),
			new URL("../src/switchyard/runner/queue-backend.mjs", import.meta.url),
			new URL("../src/switchyard/runner/queue-launch.mjs", import.meta.url),
			new URL(
				"../src/switchyard/runner/run-queue-async-impl.mjs",
				import.meta.url,
			),
			new URL(
				"../src/switchyard/runner/run-queue-async-loop.mjs",
				import.meta.url,
			),
			new URL(
				"../src/switchyard/runner/run-queue-async-terminal.mjs",
				import.meta.url,
			),
			new URL("../src/switchyard/runner/run-queue-impl.mjs", import.meta.url),
			new URL(
				"../src/switchyard/runner/run-queue-task-attempt.mjs",
				import.meta.url,
			),
			new URL(
				"../src/switchyard/runner/run-queue-task-settlement.mjs",
				import.meta.url,
			),
			new URL(
				"../src/switchyard/runner/run-queue-terminal.mjs",
				import.meta.url,
			),
			new URL(
				"../src/switchyard/runner/run-queue-orchestrator-impl.mjs",
				import.meta.url,
			),
			new URL(
				"../src/switchyard/runner/run-queue-orchestrator-core.mjs",
				import.meta.url,
			),
		);
		const readFields = new Set(
			Array.from(
				runnerSource.matchAll(/brokerExecution\.([A-Za-z_][A-Za-z0-9_]*)/g),
				(match) => match[1],
			),
		);
		ok(
			readFields.size > 0,
			"the runner must read fields off the broker result",
		);

		// Every launcher field the executor is expected to relay, set to a value
		// its own bounding accepts so a dropped field cannot pass as a defaulted one.
		const launcherResult = {
			success: false,
			timedOut: true,
			cleanupFailed: true,
			cleanupStage: "tree_terminated",
			reason: "provider execution timed out",
			errorKind: "execution_timed_out",
			diagnosticCode: "execution_timed_out",
			exitCode: 7,
			signal: "SIGKILL",
			failurePhase: "provider_cleanup",
			failureKind: "provider",
			servedModelVerified: true,
			providerReliability: createProviderReliabilityDiagnostic({
				causeCode: "auth_expired",
				phase: "provider",
			}),
		};
		const value = fixture();
		const failed = await executeBrokerRoute({
			request: value.request,
			route: value.route,
			invocationDescriptor: value.descriptor,
			launcherIdentity: value.launcherIdentity,
			launch: async () => launcherResult,
			terminal: async () => ({ changed: true }),
		});
		const missing = [...readFields].filter(
			(field) => !Object.hasOwn(failed, field),
		);
		deepStrictEqual(
			missing,
			[],
			`the executor's failure shape drops fields the runner reads: ${missing.join(", ")}`,
		);
		strictEqual(failed.cleanupStage, "tree_terminated");
		strictEqual(failed.cleanupFailed, true);
		deepStrictEqual(
			failed.providerReliability,
			launcherResult.providerReliability,
		);

		// A task can succeed while the kill of its provider process fails, so
		// the cleanup facts have to survive the success shape too.
		const succeeded = await executeBrokerRoute({
			request: value.request,
			route: value.route,
			invocationDescriptor: value.descriptor,
			launcherIdentity: value.launcherIdentity,
			launch: async () => ({
				success: true,
				actualConsumption: 1,
				cleanupFailed: true,
				cleanupStage: "pid_marker_removed",
				servedModelVerified: false,
				providerReliability: launcherResult.providerReliability,
			}),
			terminal: async () => ({ changed: true }),
		});
		strictEqual(succeeded.cleanupFailed, true);
		strictEqual(succeeded.cleanupStage, "pid_marker_removed");
		strictEqual(succeeded.servedModelVerified, false);
		deepStrictEqual(
			succeeded.providerReliability,
			launcherResult.providerReliability,
		);
	});

	it("drops malformed provider reliability without relaying launcher data", async () => {
		const value = fixture();
		const result = await executeBrokerRoute({
			request: value.request,
			route: value.route,
			invocationDescriptor: value.descriptor,
			launcherIdentity: value.launcherIdentity,
			launch: async () => ({
				success: false,
				providerReliability: {
					...createProviderReliabilityDiagnostic({
						causeCode: "auth_expired",
						phase: "provider",
					}),
					privateOutput: "must not cross the broker boundary",
				},
			}),
			terminal: async () => ({ changed: true }),
		});
		strictEqual(result.providerReliability, null);
		strictEqual(JSON.stringify(result).includes("must not cross"), false);
	});

	it("refuses a cleanup stage outside the backend-owned vocabulary", async () => {
		const value = fixture();
		const result = await executeBrokerRoute({
			request: value.request,
			route: value.route,
			invocationDescriptor: value.descriptor,
			launcherIdentity: value.launcherIdentity,
			launch: async () => ({
				success: true,
				actualConsumption: 1,
				cleanupStage: "rm -rf /etc/passwd",
			}),
			terminal: async () => ({ changed: true }),
		});
		strictEqual(result.cleanupStage, null);
	});

	it("constructs one complete typed outcome for success, failure, and cancellations", async () => {
		const value = fixture();
		const outcomes = [];
		const common = {
			request: value.request,
			route: value.route,
			invocationDescriptor: value.descriptor,
			launcherIdentity: value.launcherIdentity,
			terminal: async () => ({ changed: true }),
			recordOutcome: async (outcome) => outcomes.push(outcome),
			writerEpoch: "epoch-1",
			dispatchCausality: `sha256:${"e".repeat(64)}`,
		};
		await executeBrokerRoute({
			...common,
			launch: async () => ({
				success: true,
				servedModelVerified: true,
				reviewResult: sanitizeReviewResult({ verdict: "clean" }),
				completionContinuationProof: {
					version: 1,
					kind: "completion_continuation_lifecycle",
					providerExited: true,
					childrenExited: true,
					cleanupSucceeded: true,
					taskId: "1.1",
					attemptId: "attempt-1",
					descriptorIdentity: value.descriptor.descriptor_identity,
					workspaceId: "switchyard-work-1",
				},
			}),
		});
		await executeBrokerRoute({
			...common,
			launch: async () => ({ success: false, errorKind: "execution_failed" }),
		});
		const controller = new AbortController();
		controller.abort();
		await executeBrokerRoute({
			...common,
			signal: controller.signal,
			launch: async () => ({ success: true }),
		});
		await executeBrokerRoute({
			...common,
			launch: async () => ({ success: false, cancelled: true }),
		});
		strictEqual(outcomes.length, 4);
		strictEqual(
			outcomes.filter((outcome) => outcome.stage === "provider").length,
			4,
		);
		strictEqual(outcomes[0].status, "succeeded");
		strictEqual(outcomes[0].detail.servedModelVerified, true);
		strictEqual(outcomes[0].detail.reviewResult.status, "available");
		strictEqual(
			outcomes[0].detail.completionContinuationProof.kind,
			"completion_continuation_lifecycle",
		);
		strictEqual(outcomes[1].status, "failed");
		strictEqual(outcomes[2].status, "skipped");
		strictEqual(
			Object.hasOwn(outcomes[2].detail, "servedModelVerified"),
			false,
		);
		strictEqual(outcomes[3].status, "skipped");
		strictEqual(outcomes[0].causedBy, null);
		strictEqual(outcomes[0].operationId, outcomes[1].operationId);
		strictEqual(outcomes[0].dispatchCausality, outcomes[1].dispatchCausality);
	});

	it("does not retry a failed outcome write or reclassify provider success", async () => {
		const value = fixture();
		let writes = 0;
		const result = await executeBrokerRoute({
			request: value.request,
			route: value.route,
			invocationDescriptor: value.descriptor,
			launcherIdentity: value.launcherIdentity,
			launch: async () => ({ success: true }),
			terminal: async () => ({ changed: true }),
			recordOutcome: async () => {
				writes += 1;
				throw new Error("ledger unavailable");
			},
		});
		strictEqual(writes, 1);
		strictEqual(result.success, true);
		strictEqual(result.outcome, "success");
		strictEqual(result.executionOutcome.status, "succeeded");
		strictEqual(result.outcomePersistenceFailed, true);
	});

	it("binds the execution fact to the process fact completed by the launcher", async () => {
		const value = fixture();
		let processOutcomeId = null;
		const result = await executeBrokerRoute({
			request: value.request,
			route: value.route,
			invocationDescriptor: value.descriptor,
			launcherIdentity: value.launcherIdentity,
			launch: async () => {
				processOutcomeId = "outcome-process-completed";
				return { success: true };
			},
			terminal: async () => ({ changed: true }),
			causedBy: () => processOutcomeId,
		});
		strictEqual(result.executionOutcome.causedBy, processOutcomeId);
		strictEqual(result.executionOutcome.resumesOutcomeId, processOutcomeId);
	});
});
