import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import {
	CHECKPOINT_REMEDIATION_MESSAGES,
	classifyPreProviderFailure,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import {
	createExecutionBackend,
	hostBackendDefaults,
} from "../lifecycle/backend-selection.mjs";
import { ignoredPath, writeDirtyOverlayReceipt } from "../lifecycle/index.mjs";
import {
	attestRouteRepair,
	createDefaultRouteHealthDecision,
	inspectRouteHealth,
} from "../router/health.mjs";
import { GOLDEN_IMAGE_VERIFIED_PROVIDERS } from "../router/index.mjs";
import {
	RevisionError,
	readRun,
	reconcileProjectLockClaims,
	releaseProjectLockIfOwnedBy,
	updateRun,
} from "../run-store/index.mjs";
import {
	CallerInputValidationError,
	validateCallerInputs,
} from "../runner/index.mjs";
import {
	parseDispatchArgs,
	parseHealthArgs,
	parseOrphanLockRemediationArgs,
	withStateRoot,
} from "./cli-args.mjs";
import {
	USAGE_BACKEND_HEALTH,
	USAGE_HEALTH,
	USAGE_VALIDATE_INPUTS,
	UsageError,
} from "./cli-usage.mjs";
import { relativeWithin } from "./launch-support.mjs";
import { run as runOrphanLockRemediation } from "./remediate-orphaned-locks.mjs";
import { finalizeRun } from "./run-finalization.mjs";

async function markLauncherReadyIfLaunching(runId) {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const current = await readRun(runId);
		if (current.state !== "launching") return current;

		try {
			return await updateRun(
				runId,
				{ state: "launcher_ready" },
				current.revision,
			);
		} catch (error) {
			if (!(error instanceof RevisionError)) throw error;
			// A worker or another lifecycle writer won the optimistic-concurrency
			// race. Re-read before deciding whether the handshake is still valid.
		}
	}

	throw new Error(
		`Could not publish launcher_ready for ${runId}: run changed concurrently`,
	);
}
async function finalizeInitializedLaunchFailure(
	runId,
	projectPath,
	error,
	{ projectLockOwned = false } = {},
) {
	const classified = classifyPreProviderFailure(error);
	const checkpointCode =
		typeof error?.code === "string" &&
		Object.hasOwn(CHECKPOINT_REMEDIATION_MESSAGES, error.code)
			? error.code
			: undefined;
	const failure = sanitizeFailureMetadata({
		result: "launch_failed",
		errorKind: classified?.errorKind ?? "launch_failed",
		diagnosticCode: classified?.diagnosticCode ?? "worker_boot_exception",
		failurePhase: classified?.failurePhase ?? "worker_boot",
		checkpointCode,
		checkpointDimensions: checkpointCode ? error.changedDimensions : undefined,
	});
	return finalizeRun({
		runId,
		state: "failed",
		failure,
		eventName: "worker_boot_failed",
		eventStatus: "fatal",
		eventReasonCode: failure.reasonCode,
		terminalSummary: {
			totalTasks: null,
			runnableTasks: null,
			processedTasks: null,
			completedTaskIds: null,
			failedCount: null,
		},
		cleanup: async () => {
			if (projectLockOwned) {
				await reconcileProjectLockClaims();
				await releaseProjectLockIfOwnedBy(projectPath, runId);
			}
		},
	});
}
function validationEnvelope(result) {
	return {
		valid: true,
		checkpointPath: result.checkpointPath,
		queueIdentity: result.queueIdentity,
		runnableTaskIds: result.potentialAttemptTasks.map((task) => task.id),
		selectedTaskIds: result.selectedTaskIds,
		evaluatedTaskIds: result.evaluatedTaskIds,
		...(result.dirtyOverlayReceipt ? { dirtyOverlay: true } : {}),
	};
}
function validationFailureEnvelope(error, { standalone = false } = {}) {
	if (error?.name === "CallerInputValidationUnavailableError") {
		return {
			valid: false,
			code: error.code,
			remedy: error.remedy,
		};
	}
	if (error instanceof UsageError) {
		return {
			valid: false,
			code: standalone ? "invalid_invocation" : "queue_contract_invalid",
			remedy: standalone
				? "invocation options must follow validate-inputs usage"
				: "caller invocation or queue inputs must be corrected",
		};
	}
	if (error instanceof CallerInputValidationError) {
		return {
			valid: false,
			code: error.code,
			...(error.taskId ? { taskId: error.taskId } : {}),
			...(error.path ? { path: error.path } : {}),
			...(Array.isArray(error.selectedTaskIds)
				? { selectedTaskIds: error.selectedTaskIds }
				: {}),
			...(Array.isArray(error.evaluatedTaskIds)
				? { evaluatedTaskIds: error.evaluatedTaskIds }
				: {}),
			remedy: error.remedy,
		};
	}
	if (error?.name === "CheckpointIdentityError") {
		return {
			valid: false,
			code: standalone ? error.code : "queue_identity_invalid",
			remedy: standalone
				? error.remedy
				: "checkpoint identity or run options do not match this queue",
		};
	}
	return {
		valid: false,
		code: "queue_contract_invalid",
		remedy: "caller inputs could not be read and validated",
	};
}
function validationContractCode(error, validation) {
	if (error?.name === "CallerInputValidationUnavailableError")
		return "environment_incomplete";
	if (error?.name === "CheckpointIdentityError")
		return "queue_identity_invalid";
	if (validation.code === "queue_empty") return "queue_empty";
	if (validation.code === "task_selection_failed")
		return "task_selection_failed";
	return "queue_contract_invalid";
}
function materializeValidatedDirtyOverlay(opts, validation) {
	if (!validation.dirtyOverlayReceipt) return;
	const receiptPath = validation.dirtyOverlayReceiptPath;
	const checkpointPath = validation.checkpointPath;
	for (const path of [checkpointPath, receiptPath]) {
		const relativePath = relativeWithin(opts.projectPath, path);
		if (relativePath !== null && !ignoredPath(opts.projectPath, relativePath)) {
			throw new UsageError(
				`dirty overlay checkpoint and receipt must live outside the project or be ignored by it: ${relativePath}`,
			);
		}
	}
	if (!existsSync(receiptPath)) {
		writeDirtyOverlayReceipt(receiptPath, validation.dirtyOverlayReceipt);
	}
	opts.dirtyOverlayReceiptPath = receiptPath;
}
async function handleValidateInputs(argv) {
	try {
		const opts = parseDispatchArgs(argv);
		if (opts.help) {
			console.log(USAGE_VALIDATE_INPUTS);
			return;
		}
		const result = validateCallerInputs(opts);
		console.log(JSON.stringify(validationEnvelope(result)));
	} catch (error) {
		console.log(
			JSON.stringify(validationFailureEnvelope(error, { standalone: true })),
		);
		process.exitCode =
			error instanceof CallerInputValidationError ||
			error instanceof UsageError ||
			error?.name === "CheckpointIdentityError"
				? 2
				: 1;
	}
}
export async function handleBackendHealth(argv, dependencies = {}) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			options: {
				json: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
			allowPositionals: false,
			strict: true,
		});
	} catch (error) {
		throw new UsageError(error.message);
	}
	if (parsed.values.help) {
		console.log(USAGE_BACKEND_HEALTH);
		return;
	}
	const observedAt = new Date((dependencies.now ?? Date.now)()).toISOString();
	const backend =
		dependencies.executionBackend ??
		createExecutionBackend(hostBackendDefaults(dependencies));
	try {
		if (typeof backend.probeHostReadiness !== "function") {
			throw Object.assign(new Error("backend readiness probe unavailable"), {
				code: "backend_readiness_probe_unavailable",
			});
		}
		await Promise.resolve(backend.probeHostReadiness());
		console.log(
			JSON.stringify({
				schemaVersion: 1,
				backend: "parallels",
				observedAt,
				ready: true,
				errorKind: null,
				diagnosticCode: null,
			}),
		);
	} catch (error) {
		const classified = classifyPreProviderFailure(error);
		console.log(
			JSON.stringify({
				schemaVersion: 1,
				backend: "parallels",
				observedAt,
				ready: false,
				errorKind: classified?.errorKind ?? "environment_incomplete",
				diagnosticCode:
					classified?.diagnosticCode ??
					(typeof error?.code === "string"
						? error.code
						: "backend_readiness_unavailable"),
				failurePhase: "backend_preflight",
			}),
		);
		process.exitCode = 1;
	}
}
async function handleHealth(argv) {
	const input = parseHealthArgs(argv);
	if (input.help) {
		console.log(USAGE_HEALTH);
		return;
	}
	const onStatus = ({ event }) =>
		console.error(`dispatch: route health ${event}`);
	if (input.action === "identity") {
		const decision = createDefaultRouteHealthDecision({
			qualifiedProviders: GOLDEN_IMAGE_VERIFIED_PROVIDERS,
		});
		const identity = decision.identityFor(input);
		if (!identity) process.exitCode = 1;
		console.log(JSON.stringify(identity ?? { available: false }));
		return;
	}
	const result =
		input.action === "inspect"
			? await inspectRouteHealth({ ...input, onStatus })
			: await attestRouteRepair({ ...input, onStatus });
	if (result?.available === false) process.exitCode = 1;
	console.log(JSON.stringify(result));
}
async function handleOrphanLockRemediation(argv) {
	const { argv: remediationArgv, stateRoot } =
		parseOrphanLockRemediationArgs(argv);
	return withStateRoot(stateRoot, async () => {
		const result = await runOrphanLockRemediation(remediationArgv);
		process.exitCode = result.exitCode;
		return result;
	});
}

export {
	finalizeInitializedLaunchFailure,
	handleHealth,
	handleOrphanLockRemediation,
	handleValidateInputs,
	markLauncherReadyIfLaunching,
	materializeValidatedDirtyOverlay,
	validationContractCode,
	validationFailureEnvelope,
};
