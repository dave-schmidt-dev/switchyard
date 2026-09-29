import { join } from "node:path";
import { AGY_SILENCE_TIMEOUT_MS } from "../adapter/agy.mjs";
import { PROVIDER_EXECUTION_TIMEOUT_MS } from "../adapter/constants.mjs";
import { CLEANUP_STAGES } from "../adapter/exec-error.mjs";
import { DEFAULT_SILENCE_TIMEOUT_MS } from "../adapter/provider-lifecycle.mjs";
import { createAccountRootResolver } from "../broker/accounts.mjs";
import { createBroker } from "../broker/index.mjs";
import { createProviderProcessCompletedOutcome } from "../broker/outcome.mjs";
import { reviewResultFromExecution } from "../diagnostics/review-result.mjs";
import {
	getConfiguredInvocationDescriptor,
	getInvocationDescriptor,
	resolveTargetIdentity,
} from "../roster/index.mjs";
import { readSnapshotAtRoute, route } from "../router/index.mjs";
import { boundedGateEvidence } from "./artifacts.mjs";
import { BOUNDED_ERROR_KINDS } from "./constants.mjs";
import { DEFAULT_ADAPTERS } from "./halts.mjs";
import {
	bindAttemptExecutionBackend,
	executionCleanupContext,
	mergeAttemptCleanupContext,
} from "./route-health.mjs";
import { selectAdapter } from "./task-routing.mjs";

export function launchReviewResult(execution) {
	const derived = reviewResultFromExecution(execution);
	return derived.reason === "missing" ? null : derived;
}

export function createBrokerAdapterLauncher({
	adapter,
	executionBackend,
	workingContainerName,
	prompt,
	timeoutMs = PROVIDER_EXECUTION_TIMEOUT_MS,
	silenceTimeoutMs,
	onTranscript = null,
	cleanupContext = null,
	deriveReviewResult = false,
	onProcessCompleted = null,
}) {
	if (!adapter || typeof adapter.executeAsync !== "function") {
		throw new TypeError("broker adapter requires executeAsync");
	}
	return async function launch({
		request,
		route,
		invocationDescriptor,
		launcherIdentity,
		signal,
		onAdapterStatus,
		onPoll,
		onProgress,
	}) {
		if (
			!launcherIdentity ||
			launcherIdentity.provider !== route.provider ||
			launcherIdentity.resolvedTarget !== route.resolvedTarget ||
			launcherIdentity.harness !== route.harness ||
			launcherIdentity.model !== route.model ||
			launcherIdentity.effort !== route.effort ||
			launcherIdentity.descriptorIdentity !==
				invocationDescriptor.descriptor_identity ||
			launcherIdentity.reservationId !== route.reservation?.id
		) {
			throw new Error("broker launcher identity drift at spawn");
		}
		const requestCleanupContext = mergeAttemptCleanupContext(cleanupContext, {
			taskId: String(request.taskId),
			attemptId: cleanupContext?.attemptId ?? request.attemptId ?? "attempt-1",
			descriptorIdentity: invocationDescriptor.descriptor_identity,
			operation: "provider",
		});
		const execution = await adapter.executeAsync(
			typeof prompt === "string" && prompt.length > 0 ? prompt : request.taskId,
			workingContainerName,
			{
				model: route.model,
				timeoutMs,
				silenceTimeoutMs:
					silenceTimeoutMs ??
					(route.harness === "agy"
						? AGY_SILENCE_TIMEOUT_MS
						: DEFAULT_SILENCE_TIMEOUT_MS),
				executionBackend: bindAttemptExecutionBackend(
					executionBackend,
					requestCleanupContext,
				),
				cleanupContext: requestCleanupContext,
				signal,
				onStatus: onAdapterStatus,
				onPoll,
				onProgress,
				onProcessCompleted,
				invocationDescriptor,
				descriptorIdentity: invocationDescriptor.descriptor_identity,
				descriptorHarness: route.harness,
				resolvedTargetId: route.resolvedTarget,
			},
		);
		// The bounded return shape below stays closed. The raw transcript is
		// handed back in-process instead of crossing it, so an evidence-free
		// gate rejection still has the provider's own account behind it.
		onTranscript?.(execution?.output);
		return {
			success: execution?.success === true,
			cancelled: signal?.aborted === true,
			reason: execution?.error ?? null,
			actualConsumption: execution?.actualConsumption,
			timedOut: execution?.timedOut === true,
			silenceTimedOut: execution?.silenceTimedOut === true,
			outcome: execution?.outcome ?? null,
			// The verdict, not the transcript it was parsed out of. Omitting it here
			// left every review dispatched through the broker with no result to act
			// on, so each one terminated as an undiagnosed `review_unavailable`.
			reviewResult: deriveReviewResult ? launchReviewResult(execution) : null,
			cleanupFailed: execution?.cleanupFailed === true,
			// Which kill step failed, bounded to the backend-owned vocabulary.
			// Omitting it here left `execution.cleanupStage` permanently null on
			// the async path, so a cleanup failure was recorded without naming
			// the stage that failed - the fact that makes it actionable.
			cleanupStage: CLEANUP_STAGES.has(execution?.cleanupStage)
				? execution.cleanupStage
				: null,
			failureKind:
				execution?.failureKind === "transient" ||
				execution?.failureKind === "provider"
					? execution.failureKind
					: null,
			errorKind: BOUNDED_ERROR_KINDS.has(execution?.errorKind)
				? execution.errorKind
				: execution?.errorKind === "silence_timeout"
					? "silence_timeout"
					: null,
			diagnosticCode: execution?.diagnosticCode ?? null,
			exitCode: execution?.exitCode ?? null,
			signal: execution?.signal ?? null,
			failurePhase: execution?.failurePhase ?? null,
			diagnosticOrigin: execution?.diagnosticOrigin ?? null,
			diagnosticEvidenceAvailable:
				execution?.diagnosticEvidenceAvailable === true,
			diagnosticRef:
				typeof execution?.diagnosticRef === "string" &&
				/^diagnostic:[a-f0-9]{32}$/u.test(execution.diagnosticRef)
					? execution.diagnosticRef
					: null,
			diagnosticEvidence: execution?.diagnosticEvidence ?? null,
			// A bounded fact, not the guest-supplied model name: whether the
			// adapter could affirmatively read back what the provider served.
			servedModelVerified:
				execution?.servedModel === undefined
					? null
					: Boolean(execution.servedModel),
			progress: execution?.progress ?? null,
			providerLifecycle: execution?.providerLifecycle ?? null,
		};
	};
}

export function createDispatchBroker(context, dependencies = {}) {
	if (dependencies.broker) return dependencies.broker;
	const adapters = context.adapters ?? DEFAULT_ADAPTERS;
	const contextOnly = Array.isArray(context.only) ? context.only : [];
	const snapshotSources = dependencies.snapshotSources ?? { "gradus-v2": null };
	if (
		typeof context.projectPath !== "string" ||
		context.projectPath.trim() === ""
	) {
		throw new Error(
			"broker runner requires projectPath for its reservation ledger",
		);
	}
	const projectLedgerRoot = join(
		context.projectPath,
		".logs",
		"switchyard",
		"broker",
	);
	const usesProductionRouter = context.route === route;
	const brokerResolveTargetIdentity =
		dependencies.resolveTargetIdentity ?? resolveTargetIdentity;
	return createBroker({
		adapters,
		route: ({
			runId,
			requiredCapability,
			availableProviders,
			snapshotSource,
			snapshotRead,
			exclude = [],
			platform,
			goldenImageVerifiedProviders,
		}) =>
			context.route({
				runId,
				requiredCapability,
				availableProviders,
				snapshotSource,
				snapshotRead,
				exclude: [
					...(Array.isArray(context.exclude) ? context.exclude : []),
					...exclude,
				],
				only: contextOnly,
				platform,
				...(goldenImageVerifiedProviders !== undefined
					? { goldenImageVerifiedProviders }
					: {}),
				...(context.qualificationAttempt
					? { hasInvocationDescriptor: context.hasInvocationDescriptor }
					: {}),
				...(context.healthDecision
					? { healthDecision: context.healthDecision }
					: {}),
				...(context.onHealthDecision
					? { onHealthDecision: context.onHealthDecision }
					: {}),
			}),
		resolveTargetIdentity: brokerResolveTargetIdentity,
		getInvocationDescriptor:
			context.resolveDescriptor ??
			(context.qualificationAttempt
				? getConfiguredInvocationDescriptor
				: getInvocationDescriptor),
		reservations: dependencies.brokerReservations,
		reservationOptions: dependencies.brokerReservationOptions ?? {
			root: projectLedgerRoot,
			// Null unless shared account accounting is switched on, in which case
			// capacity for a provider is decided against the account root shared by
			// every project on this host instead of this project's ledger alone.
			// The account resolver reads identity through the same seam the broker
			// does, so a caller that injected one never gets a second answer from
			// the host roster behind its back.
			accountRootFor: createAccountRootResolver({
				resolveTargetIdentity: brokerResolveTargetIdentity,
			}),
		},
		snapshotSources,
		readSnapshot: usesProductionRouter
			? (dependencies.readSnapshot ??
				(({ source, nowMs }) => {
					if (!Object.hasOwn(snapshotSources, source)) {
						const error = new Error("snapshot_source_unknown");
						error.code = "snapshot_source_unknown";
						throw error;
					}
					const sourcePath = snapshotSources[source];
					if (sourcePath !== null && typeof sourcePath !== "string") {
						throw new TypeError(
							"configured snapshot source must be a path or null",
						);
					}
					return readSnapshotAtRoute(nowMs, sourcePath ?? undefined);
				}))
			: dependencies.readSnapshot,
		refreshSnapshot: dependencies.refreshSnapshot,
		ownerId: context.runId ? `runner:${context.runId}` : undefined,
		platform: context.platform,
		...(context.goldenImageVerifiedProviders !== undefined
			? {
					goldenImageVerifiedProviders: context.goldenImageVerifiedProviders,
				}
			: {}),
		executor: async ({
			request,
			route: selectedRoute,
			invocationDescriptor,
			launcherIdentity,
			signal,
			onStatus,
			onAdapterStatus,
			onPoll,
			onProgress,
			onTaskHeartbeat,
		}) => {
			const adapter = selectAdapter(selectedRoute.harness, adapters);
			if (!adapter) {
				throw new Error(
					`broker route harness '${selectedRoute.harness}' has no runner adapter`,
				);
			}
			const launchResult = await createBrokerAdapterLauncher({
				adapter,
				executionBackend: context.executionBackend,
				workingContainerName: context.workingContainerName,
				prompt: context._activeTaskPrompt,
				timeoutMs: context._activeTaskTimeoutMs,
				deriveReviewResult: context._activeTaskIsReview === true,
				onTranscript: (output) => {
					context._activeTaskTranscript = boundedGateEvidence(output);
				},
				cleanupContext: executionCleanupContext(
					context,
					{ id: request.taskId },
					invocationDescriptor.descriptor_identity,
					request.attemptId ?? null,
				),
				onProcessCompleted:
					typeof context.recordOutcomeEvent === "function"
						? async (processResult) => {
								const processOutcome = createProviderProcessCompletedOutcome({
									request,
									route: selectedRoute,
									processResult,
									writerEpoch: context.outcomeWriterEpoch ?? null,
									operationId: `operation-${request.taskId}-process`,
									attempt: context._activeOutcomeAttempt ?? 1,
								});
								await context.recordOutcomeEvent(processOutcome);
								context._activeProcessOutcomeId = processOutcome.outcomeId;
							}
						: null,
			})({
				request,
				route: selectedRoute,
				invocationDescriptor,
				launcherIdentity,
				signal,
				onAdapterStatus,
				onProgress,
				onPoll: (poll) => {
					onStatus?.(poll);
					onPoll?.(poll);
					const heartbeat = {
						taskId: request.taskId,
						provider: selectedRoute.provider,
						model: invocationDescriptor.selector ?? selectedRoute.model,
						deadline: context._activeTaskDeadline ?? null,
						elapsedMs: Number.isFinite(poll?.elapsedMs)
							? Math.max(0, poll.elapsedMs)
							: 0,
						processPhase: "provider_transport_running",
						resolvedTargetId: selectedRoute.resolvedTarget,
						descriptorIdentity: invocationDescriptor.descriptor_identity,
						descriptorHarness: selectedRoute.harness,
					};
					onTaskHeartbeat?.(heartbeat);
				},
			});
			const inProcessEvidence = launchResult?.diagnosticEvidence;
			const hasInProcessEvidence =
				inProcessEvidence && typeof inProcessEvidence === "object";
			let diagnosticRef = null;
			if (
				launchResult?.success !== true &&
				hasInProcessEvidence &&
				typeof context.persistDiagnosticArtifact === "function"
			) {
				try {
					const persisted =
						await context.persistDiagnosticArtifact(inProcessEvidence);
					if (
						typeof persisted === "string" &&
						/^diagnostic:[a-f0-9]{32}$/u.test(persisted)
					) {
						diagnosticRef = persisted;
					}
				} catch {
					diagnosticRef = null;
				}
			}
			// Raw streams are producer-local and must not reach the broker result,
			// checkpoint, event, or status projections.
			delete launchResult.diagnosticEvidence;
			if (hasInProcessEvidence) {
				launchResult.diagnosticRef = diagnosticRef;
				launchResult.diagnosticEvidenceAvailable = diagnosticRef !== null;
			} else {
				launchResult.diagnosticRef = null;
				launchResult.diagnosticEvidenceAvailable = false;
			}
			return launchResult;
		},
	});
}

export function brokerRequestForTask(task, context, requiredCapability) {
	return {
		schemaVersion: 1,
		capability: requiredCapability,
		dataClass: "repository",
		estimatedConsumption:
			typeof task.estimatedConsumption === "number" &&
			Number.isFinite(task.estimatedConsumption) &&
			task.estimatedConsumption > 0
				? task.estimatedConsumption
				: 1,
		runId: context.runId ?? `runner-${process.pid}`,
		taskId: task.id,
		snapshotSource: context.snapshotSource ?? "gradus-v2",
		availableAdapters: Object.keys(context.adapters ?? DEFAULT_ADAPTERS),
	};
}
