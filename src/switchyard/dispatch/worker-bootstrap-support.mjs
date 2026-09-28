import { lstatSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	classifyPreProviderFailure,
	prlctlFailureMetadata,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import { failureTransition } from "../outcome/transitions.mjs";

function parseArg(argv, flag) {
	const idx = argv.indexOf(flag);
	if (idx < 0 || idx + 1 >= argv.length) return null;
	return argv[idx + 1];
}
const FATAL_PERSISTENCE_DIAGNOSTIC =
	"worker-bootstrap: fatal event persistence unavailable; durable run state may be incomplete";
const ROUTE_HEALTH_STATES = new Set([
	"healthy",
	"suspect",
	"cooldown",
	"repair-hold",
	"half-open",
	"health-unavailable",
]);
export function boundedRouteHealthDecisionEvent(decision) {
	if (!decision || typeof decision !== "object") return null;
	const provider =
		typeof decision.provider === "string" &&
		decision.provider.length > 0 &&
		decision.provider.length <= 128 &&
		!/[^\x20-\x7e]/.test(decision.provider)
			? decision.provider
			: null;
	if (!provider) return null;
	const state = ROUTE_HEALTH_STATES.has(decision.state)
		? decision.state
		: "health-unavailable";
	const mode = decision.mode === "enforce" ? "enforce" : "shadow";
	const targetId =
		typeof decision.resolvedTargetId === "string" &&
		decision.resolvedTargetId.length > 0 &&
		decision.resolvedTargetId.length <= 256 &&
		!/[^\x20-\x7e]/.test(decision.resolvedTargetId)
			? decision.resolvedTargetId
			: null;
	return {
		phase: "route_health",
		event: "health_decision",
		status: `Route health ${mode} decision: ${state}`,
		provider,
		...(targetId ? { targetId } : {}),
		mode,
		state,
		available: decision.available === true,
		suppress: decision.suppress === true,
		trialAvailable: decision.trialAvailable === true,
		initializable: decision.initializable === true,
	};
}
const MAX_BOOT_DIAGNOSTIC_BYTES = 4096;
function bootDiagnosticPath(runRoot) {
	return resolve(runRoot, "boot-stderr.log");
}
function retainSafeBootDiagnostic(runRoot, category) {
	if (typeof runRoot !== "string" || typeof category !== "string") return false;
	const safeCategory = /^[a-z0-9_]+$/u.test(category)
		? category
		: "worker_boot_failed";
	try {
		try {
			const existing = lstatSync(bootDiagnosticPath(runRoot));
			if (
				!existing.isFile() ||
				existing.isSymbolicLink() ||
				existing.nlink !== 1 ||
				(typeof process.getuid === "function" &&
					existing.uid !== process.getuid()) ||
				(existing.mode & 0o077) !== 0
			)
				return false;
		} catch (error) {
			if (error?.code !== "ENOENT") return false;
		}
		writeFileSync(bootDiagnosticPath(runRoot), `${safeCategory}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "w",
		});
		const stat = lstatSync(bootDiagnosticPath(runRoot));
		return (
			stat.isFile() &&
			!stat.isSymbolicLink() &&
			stat.nlink === 1 &&
			(typeof process.getuid !== "function" || stat.uid === process.getuid()) &&
			(stat.mode & 0o077) === 0 &&
			stat.size > 0 &&
			stat.size <= MAX_BOOT_DIAGNOSTIC_BYTES
		);
	} catch {
		return false;
	}
}
export function createWriteChain({ onFailure = () => {} } = {}) {
	let writeChain = Promise.resolve();

	return {
		queueWrite(fn, { propagateFailure = false } = {}) {
			const write = writeChain.then(fn, fn);
			writeChain = write.catch((error) => {
				onFailure(error);
			});
			// Most callback writes are telemetry: record their failure but allow the
			// queue to continue. Cleanup-state persistence is different: the runner
			// must observe a failure so it can log it, while its finally block still
			// tears down the owned container.
			return propagateFailure ? write : writeChain;
		},
		drain: () => writeChain,
	};
}
export async function persistTerminalOutcome({
	runStore,
	routeHealth,
	runId,
	event,
	routeHealthBinding,
	healthStateRoot,
	onHealthUnavailable = () => {},
}) {
	if (!routeHealthBinding) {
		await runStore.createEvent(runId, event);
		return;
	}
	await runStore.createRouteHealthEvent(runId, event, routeHealthBinding);
	try {
		await routeHealth.ingestRouteHealthEvents({
			authorisedRuns: [{ runId, runRoot: runStore.getRunRoot(runId) }],
			healthStateRoot,
		});
	} catch {
		onHealthUnavailable();
	}
}
export function detachedTerminalOutcome({
	failed = [],
	deferredTaskIds = [],
	writeFailureCount: failedWrites = 0,
} = {}) {
	const persistenceFailure =
		failedWrites > 0
			? sanitizeFailureMetadata({
					result: "run_store_write_failed",
					errorKind: "run_store_write_failed",
					failurePhase: "terminal_reconciliation",
				})
			: null;
	return {
		state:
			failed.length > 0 || persistenceFailure
				? "failed"
				: deferredTaskIds.length > 0
					? "deferred"
					: "succeeded",
		failure: persistenceFailure ?? sanitizeFailureMetadata(failed.at(-1) ?? {}),
	};
}
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
export function isRecognizedCheckpointIdentityError(error) {
	return (
		typeof error?.code === "string" &&
		RECOGNIZED_CHECKPOINT_IDENTITY_CODES.has(error.code)
	);
}
export function buildFatalFailure(
	error,
	diagnosticCode = "worker_boot_exception",
	diagnosticEvidenceAvailable = false,
) {
	const prlctlFailure = prlctlFailureMetadata(error);
	const classified = classifyPreProviderFailure(error) ?? {
		diagnosticCode,
		errorKind: "launch_failed",
		failurePhase: "worker_boot",
	};
	const closedCode = classified.diagnosticCode;
	const decision = failureTransition({
		result: "launch_failed",
		errorKind: classified.errorKind,
		failurePhase: classified.failurePhase,
		diagnosticCode: closedCode,
		diagnosticOrigin: "worker_boot",
		diagnosticEvidenceAvailable: diagnosticEvidenceAvailable === true,
		...(prlctlFailure && closedCode === prlctlFailure.diagnosticCode
			? { exitCode: prlctlFailure.exitCode, signal: prlctlFailure.signal }
			: {}),
		...(isRecognizedCheckpointIdentityError(error)
			? {
					checkpointCode: error.code,
					checkpointDimensions: error.changedDimensions,
				}
			: {}),
	});
	const failure = decision.failureMetadata;
	return failure;
}
async function yieldFatalHandlerTurn() {
	await new Promise((resolveTurn) => setImmediate(resolveTurn));
}

export {
	bootDiagnosticPath,
	FATAL_PERSISTENCE_DIAGNOSTIC,
	parseArg,
	retainSafeBootDiagnostic,
	yieldFatalHandlerTurn,
};

export function createWorkerBootstrapFatalHelpers({
	state,
	finalizeRun,
	retainSafeBootDiagnostic,
	buildFatalFailure,
	isRecognizedCheckpointIdentityError,
	emitFatalPersistenceDiagnostic,
	isPersistentFailureMetadata,
	requestGracefulShutdown,
	yieldFatalHandlerTurn,
	spawnSync,
	isAbsolute,
	relative,
	resolve,
	sep,
}) {
	async function writeFatalEvent(
		error,
		diagnosticCode = "worker_boot_exception",
	) {
		try {
			const runStore = await import("../run-store/index.mjs");
			const current = await runStore.readRun(state.runId);
			const retainedBootDiagnostic = retainSafeBootDiagnostic(
				runStore.getRunRoot(state.runId),
				diagnosticCode,
			);
			const failure = buildFatalFailure(
				error,
				diagnosticCode,
				retainedBootDiagnostic,
			);
			await finalizeRun(
				{
					runId: state.runId,
					state: "failed",
					failure,
					eventName: "worker_boot_failed",
					eventStatus: isRecognizedCheckpointIdentityError(error)
						? error.code
						: "fatal",
					eventReasonCode: isRecognizedCheckpointIdentityError(error)
						? error.code
						: failure.reasonCode,
					terminalSummary: {
						totalTasks: Array.isArray(current.orderedTaskIds)
							? current.orderedTaskIds.length
							: null,
						runnableTasks: null,
						processedTasks: null,
						completedTaskIds: null,
						failedCount: null,
					},
					extraPatch: error?.preflightDetail
						? { preflightDetail: error.preflightDetail }
						: {},
					cleanup: async () => {
						await runStore.reconcileProjectLockClaims();
						await runStore.releaseProjectLockIfOwnedBy(
							current.projectPath,
							state.runId,
						);
					},
				},
				runStore,
			);
		} catch {
			emitFatalPersistenceDiagnostic();
		}
	}

	function isQueueCleanupError(error) {
		return (
			state.queueCleanupErrorType !== null &&
			error instanceof state.queueCleanupErrorType &&
			error?.code === "recovery_incomplete" &&
			isPersistentFailureMetadata(error?.failure)
		);
	}

	async function writeQueueCleanupFailure(error) {
		const runStore = await import("../run-store/index.mjs");
		await finalizeRun(
			{
				runId: state.runId,
				state: "failed",
				failure: error.failure,
				eventName: "run_failed",
				eventStatus: "recovery_required",
				terminalSummary: error.terminalSummary,
				cleanup: async () => {
					throw new Error("queue cleanup incomplete");
				},
			},
			runStore,
		);
	}

	function installProcessHandlers() {
		process.on("SIGINT", () => requestGracefulShutdown("SIGINT"));
		process.on("SIGTERM", () => requestGracefulShutdown("SIGTERM"));
		process.on("uncaughtException", (error) => {
			state.setFatalFinalizationPromise(
				writeFatalEvent(error, "worker_boot_exception").then(() =>
					process.exit(1),
				),
			);
		});
		process.on("unhandledRejection", (reason) => {
			const error =
				reason instanceof Error ? reason : new Error(String(reason));
			state.setFatalFinalizationPromise(
				writeFatalEvent(error, "worker_boot_exception").then(() =>
					process.exit(1),
				),
			);
		});
	}

	function captureCurrentFingerprint(projectPath) {
		let head = "";
		let dirty = "unknown";
		try {
			const headResult = spawnSync("git", ["rev-parse", "HEAD"], {
				cwd: projectPath,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			if (headResult.status === 0) {
				head = headResult.stdout.trim();
			}
			const statusArgs = ["status", "--porcelain", "--untracked-files=all"];
			const relativeStateRoot = relative(
				resolve(projectPath),
				resolve(state.stateRoot),
			);
			if (
				relativeStateRoot &&
				!isAbsolute(relativeStateRoot) &&
				!relativeStateRoot.startsWith(`..${sep}`)
			) {
				statusArgs.push("--", ".", `:(exclude)${relativeStateRoot}/**`);
			}
			const statusResult = spawnSync("git", statusArgs, {
				cwd: projectPath,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			if (statusResult.status === 0) {
				dirty = statusResult.stdout.trim().length > 0 ? "dirty" : "clean";
			}
		} catch {}
		return `git:${head || "no-head"}:${dirty}`;
	}

	async function exitAfterDirectFailure(error, diagnosticCode, exitCode) {
		await yieldFatalHandlerTurn();
		if (state.fatalFinalizationPromise) {
			await state.fatalFinalizationPromise;
			process.exit(1);
		}
		await writeFatalEvent(error, diagnosticCode);
		process.exit(exitCode);
	}

	return {
		captureCurrentFingerprint,
		exitAfterDirectFailure,
		installProcessHandlers,
		isQueueCleanupError,
		writeFatalEvent,
		writeQueueCleanupFailure,
	};
}
