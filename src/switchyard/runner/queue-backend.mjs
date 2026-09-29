import { createHash } from "node:crypto";
import {
	createExecutionBackend,
	hostBackendDefaults,
} from "../lifecycle/backend-selection.mjs";
import {
	loadWorkspaceLifecycleHooks,
	runWorkspaceLifecycleHook,
} from "../lifecycle/hooks.mjs";
import {
	captureDirtyOverlay,
	captureTaskStartTree,
	captureTaskStartTreeAsync,
	readDirtyOverlayReceipt,
	releaseTaskStartTree,
	releaseTaskStartTreeAsync,
	seedProjectWithBackend,
	validateDirtyOverlayReceipt,
	validateTaskStartTree,
	validateTaskStartTreeAsync,
} from "../lifecycle/index.mjs";
import {
	acquireVmSlot,
	getVmAdmissionRoot,
	releaseVmSlot,
} from "../run-store/index.mjs";
import { normalizeQueuePlatform } from "./constants.mjs";
import {
	createDefaultQueuePreflight,
	createQueueBootstrapStatusEmitter,
	queueOwnershipContext,
	runBackendGitCommand,
} from "./queue-preflight.mjs";

export function createQueueBackend({
	platform = "macos",
	dependencies = {},
	projectPath,
	runId = null,
	runOptions = null,
} = {}) {
	const taskBaseRunId =
		typeof runId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId)
			? runId
			: `queue-${createHash("sha256")
					.update(String(projectPath ?? "project"))
					.digest("hex")
					.slice(0, 24)}`;
	const selectedPlatform = normalizeQueuePlatform(platform);
	const defaultQueuePreflight = createDefaultQueuePreflight({
		selectedPlatform,
		dependencies: {
			...dependencies,
			qualificationAttempt: runOptions?.qualificationAttempt === true,
		},
	});
	const configuredQueuePreflight =
		dependencies.queuePreflight ?? defaultQueuePreflight;
	const factory = dependencies.backendFactory;
	const supplied = factory?.({
		platform: selectedPlatform,
		projectPath,
		runId,
		runOptions,
	});
	if (supplied && typeof supplied === "object") {
		if (
			supplied.platform &&
			normalizeQueuePlatform(supplied.platform) !== selectedPlatform
		) {
			throw new Error("backendFactory returned a different queue platform");
		}
		if (
			supplied.create &&
			supplied.destroy &&
			supplied.seed &&
			supplied.commit &&
			supplied.reset
		) {
			const suppliedReadiness =
				supplied.readiness ?? supplied.executionBackend?.probeHostReadiness;
			return {
				platform: selectedPlatform,
				...supplied,
				taskBaseRunId,
				create: (path, options = {}) =>
					supplied.create(path, {
						...options,
						onStatus: createQueueBootstrapStatusEmitter(options.onStatus),
					}),
				ensureAgentContainer: supplied.ensureAgentContainer ?? (() => {}),
				readiness: (options = {}) => {
					if (typeof suppliedReadiness !== "function") {
						throw new Error(
							"backendFactory must provide readiness() for macOS queue admission",
						);
					}
					return suppliedReadiness.call(
						supplied.readiness ? supplied : supplied.executionBackend,
						{
							...options,
							onStatus: createQueueBootstrapStatusEmitter(options.onStatus),
						},
					);
				},
				provision: supplied.provision ?? (() => null),
				preflight: supplied.preflight ?? configuredQueuePreflight,
				acquireSlot: supplied.acquireSlot ?? (() => null),
				releaseSlot: supplied.releaseSlot ?? (() => {}),
				captureTaskBase:
					supplied.captureTaskBase ??
					((workspaceId, { taskId, ...options } = {}) =>
						captureTaskStartTree(supplied.executionBackend, workspaceId, {
							runId: taskBaseRunId,
							taskId,
							...options,
						})),
				captureTaskBaseAsync:
					supplied.captureTaskBaseAsync ??
					(async (workspaceId, options = {}) =>
						(
							supplied.captureTaskBase ??
							((id, input) =>
								captureTaskStartTreeAsync(supplied.executionBackend, id, {
									runId: taskBaseRunId,
									...input,
								}))
						)(workspaceId, options)),
				validateTaskBase:
					supplied.validateTaskBase ??
					((workspaceId, base, options = {}) =>
						validateTaskStartTree(
							supplied.executionBackend,
							workspaceId,
							base,
							options,
						)),
				validateTaskBaseAsync:
					supplied.validateTaskBaseAsync ??
					(async (workspaceId, base, options = {}) =>
						(
							supplied.validateTaskBase ??
							((id, value, input) =>
								validateTaskStartTreeAsync(
									supplied.executionBackend,
									id,
									value,
									input,
								))
						)(workspaceId, base, options)),
				releaseTaskBase:
					supplied.releaseTaskBase ??
					((workspaceId, base, options = {}) =>
						releaseTaskStartTree(
							supplied.executionBackend,
							workspaceId,
							base,
							options,
						)),
				releaseTaskBaseAsync:
					supplied.releaseTaskBaseAsync ??
					(async (workspaceId, base, options = {}) =>
						(
							supplied.releaseTaskBase ??
							((id, value, input) =>
								releaseTaskStartTreeAsync(
									supplied.executionBackend,
									id,
									value,
									input,
								))
						)(workspaceId, base, options)),
			};
		}
	}

	const executionBackend =
		supplied?.executionBackend ??
		supplied?.backend ??
		dependencies.executionBackend ??
		createExecutionBackend({
			...hostBackendDefaults(dependencies),
			// Durable record of which golden-image snapshots each clone creates,
			// so a later process can reclaim them after this one dies.
			snapshotSidecarRoot: getVmAdmissionRoot(),
			runId: dependencies.runId ?? process.env.SWITCHYARD_RUN_ID ?? null,
			...(dependencies.hostProcessIdentityProbe
				? {
						hostProcessIdentityProbe: dependencies.hostProcessIdentityProbe,
					}
				: {}),
		});

	const { goldenImage, aquaUid, providerUser } =
		hostBackendDefaults(dependencies);
	return {
		platform: selectedPlatform,
		taskBaseRunId,
		executionBackend,
		ensureAgentContainer: () => {},
		readiness: (options = {}) => {
			if (typeof executionBackend.probeHostReadiness !== "function") {
				throw new Error(
					"Parallels execution backend does not provide host readiness",
				);
			}
			return executionBackend.probeHostReadiness({
				...options,
				onStatus: createQueueBootstrapStatusEmitter(options.onStatus),
			});
		},
		create: (_path, options = {}) => {
			if (!goldenImage) {
				throw new Error(
					"macos queue requires SWITCHYARD_PARALLELS_GOLDEN_IMAGE",
				);
			}
			if (!/^\d+$/u.test(String(aquaUid ?? "")) || Number(aquaUid) <= 0) {
				throw new Error(
					"macos queue requires SWITCHYARD_PARALLELS_AQUA_UID to be a positive numeric uid",
				);
			}
			return executionBackend.create(goldenImage, {
				runId: options.runId ?? runId,
				aquaUid,
				providerUser,
				onStatus: createQueueBootstrapStatusEmitter(options.onStatus),
				// Linked-clone measurement/admission is owned by its later task.
				linked: !!dependencies.linkedCloneMeasurement,
				...(dependencies.linkedCloneMeasurement
					? { linkedCloneMeasurement: dependencies.linkedCloneMeasurement }
					: {}),
				ownershipContext: queueOwnershipContext({
					projectPath: _path,
					runId: options.runId ?? runId,
					taskId: options.taskId ?? "queue-bootstrap",
					attemptId: options.attemptId ?? "bootstrap",
					processStartIdentity: dependencies.processStartIdentity ?? null,
				}),
			});
		},
		// Provider auth is baked into the golden image and survives cloning
		// (verified for codex — see TASKS.md's clone-survival test), so there is
		// no runtime credential-provisioning step; each adapter's own auth
		// check decides at exec time.
		provision: dependencies.provisionCredentials ?? (() => null),
		seed: (workspaceId, path, options = {}) =>
			seedProjectWithBackend(executionBackend, workspaceId, path, options),
		afterCreate: (workspaceId, path, options = {}) =>
			runWorkspaceLifecycleHook(
				executionBackend,
				workspaceId,
				loadWorkspaceLifecycleHooks(path),
				"after_create",
				options,
			),
		beforeRun: (workspaceId, path, options = {}) =>
			runWorkspaceLifecycleHook(
				executionBackend,
				workspaceId,
				loadWorkspaceLifecycleHooks(path),
				"before_run",
				options,
			),
		afterRun: (workspaceId, path, options = {}) =>
			runWorkspaceLifecycleHook(
				executionBackend,
				workspaceId,
				loadWorkspaceLifecycleHooks(path),
				"after_run",
				options,
			),
		beforeRemove: (workspaceId, path, options = {}) =>
			runWorkspaceLifecycleHook(
				executionBackend,
				workspaceId,
				loadWorkspaceLifecycleHooks(path),
				"before_remove",
				options,
			),
		commit: (workspaceId) =>
			runBackendGitCommand(
				executionBackend,
				workspaceId,
				"git add -A && (git diff --cached --quiet || git commit -q -m switchyard-task)",
			),
		reset: (workspaceId) =>
			runBackendGitCommand(
				executionBackend,
				workspaceId,
				"git reset --hard && git clean -fd",
			),
		captureTaskBase: (workspaceId, { taskId, ...options } = {}) =>
			captureTaskStartTree(executionBackend, workspaceId, {
				runId: taskBaseRunId,
				taskId,
				...options,
			}),
		captureTaskBaseAsync: (workspaceId, { taskId, ...options } = {}) =>
			captureTaskStartTreeAsync(executionBackend, workspaceId, {
				runId: taskBaseRunId,
				taskId,
				...options,
			}),
		validateTaskBase: (workspaceId, base, options = {}) =>
			validateTaskStartTree(executionBackend, workspaceId, base, options),
		validateTaskBaseAsync: (workspaceId, base, options = {}) =>
			validateTaskStartTreeAsync(executionBackend, workspaceId, base, options),
		releaseTaskBase: (workspaceId, base, options = {}) =>
			releaseTaskStartTree(executionBackend, workspaceId, base, options),
		releaseTaskBaseAsync: (workspaceId, base, options = {}) =>
			releaseTaskStartTreeAsync(executionBackend, workspaceId, base, options),
		destroy: (workspaceId) => executionBackend.destroy(workspaceId),
		preflight: configuredQueuePreflight,
		acquireSlot: dependencies.acquireVmSlot ?? acquireVmSlot,
		releaseSlot: dependencies.releaseVmSlot ?? releaseVmSlot,
	};
}

export function queuePlatform(options) {
	return normalizeQueuePlatform(
		options.runOptions?.platform ?? options.platform,
	);
}

export function prepareDirtyOverlayReceipt({
	projectPath,
	tasks,
	potentialAttemptTasks,
	runOptions,
	dependencies,
}) {
	if (
		runOptions?.dirtyOverlay !== true &&
		dependencies.dirtyOverlay !== true &&
		!dependencies.dirtyOverlayReceipt
	)
		return null;
	const supplied = dependencies.dirtyOverlayReceipt;
	const receipt =
		supplied ??
		(runOptions?.dirtyOverlayReceiptPath
			? readDirtyOverlayReceipt(runOptions.dirtyOverlayReceiptPath)
			: null);
	const paths = [
		...new Set(
			(potentialAttemptTasks.length > 0
				? potentialAttemptTasks
				: tasks
			).flatMap((task) => task.requiredPaths ?? []),
		),
	];
	if (paths.length === 0)
		throw new Error("dirty overlay requires exact declared task paths");
	if (!receipt) return captureDirtyOverlay(projectPath, paths);
	const validation = validateDirtyOverlayReceipt(projectPath, receipt, paths);
	if (!validation.ok)
		throw new Error(`dirty overlay receipt rejected: ${validation.reason}`);
	return receipt;
}

export function assertDirtyOverlayReceiptCurrent(projectPath, receipt, phase) {
	if (!receipt) return;
	const validation = validateDirtyOverlayReceipt(projectPath, receipt);
	if (!validation.ok)
		throw new Error(`dirty overlay drift ${phase}: ${validation.reason}`);
}
