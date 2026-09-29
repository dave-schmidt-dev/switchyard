import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { classifyPreProviderFailure } from "../adapter/exec-error.mjs";
import { assertGenerationAllowed } from "../maintenance/index.mjs";
import {
	acquireProjectLock,
	advanceState,
	assertProjectLockOwnership,
	getRunRoot,
	getStateRoot,
	initializeRun,
	LockError,
	reconcileProjectLockClaims,
	releaseOrphanedProjectLocks,
	updateRunWithRetry,
} from "../run-store/index.mjs";
import { classifyRunLiveness } from "../run-store/run-liveness.mjs";
import {
	CallerInputValidationError,
	loadTaskQueue,
	validateCallerInputs,
	validateProjectFileEntries,
} from "../runner/index.mjs";
import { parseDispatchArgs, parseLaunchArgs } from "./cli-args.mjs";
import {
	finalizeInitializedLaunchFailure,
	markLauncherReadyIfLaunching,
	materializeValidatedDirtyOverlay,
	validationContractCode,
	validationFailureEnvelope,
} from "./cli-handlers.mjs";
import { USAGE_LAUNCH, USAGE_RUN, UsageError } from "./cli-usage.mjs";
import { projectDisposition } from "./disposition.mjs";
import {
	buildLaunchFailureEnvelope,
	captureHostFingerprint,
	launchCommands,
	prepareDispatchDirtyOverlay,
	prepareRunIdentity,
	resolveBootstrapPath,
} from "./launch-support.mjs";
import { runDispatch } from "./run-dispatch.mjs";
import { recoveryCommandFor } from "./status-envelope.mjs";

async function handleRun(argv, dependencies = {}, usage = USAGE_RUN) {
	const jsonRequested = argv.includes("--json");
	let opts;
	try {
		opts = parseDispatchArgs(argv);
	} catch (error) {
		if (!jsonRequested) throw error;
		console.log(
			JSON.stringify(
				await buildLaunchFailureEnvelope({
					preInitialization: {
						type: "contract_failure",
						code: "invalid_invocation",
					},
				}),
			),
		);
		process.exitCode =
			error instanceof UsageError ||
			error instanceof CallerInputValidationError ||
			error?.name === "CheckpointIdentityError"
				? 2
				: 1;
		return;
	}
	if (opts.help) {
		console.log(usage);
		return;
	}
	try {
		await runDispatch(opts, dependencies);
	} catch (error) {
		if (!jsonRequested) throw error;
		const validation = validationFailureEnvelope(error);
		const callerInputFailure =
			error instanceof CallerInputValidationError ||
			error instanceof UsageError ||
			error?.name === "CallerInputValidationUnavailableError" ||
			error?.name === "CheckpointIdentityError";
		console.log(
			JSON.stringify(
				await buildLaunchFailureEnvelope({
					preInitialization: {
						type: "contract_failure",
						code: callerInputFailure
							? validationContractCode(error, validation)
							: (classifyPreProviderFailure(error)?.diagnosticCode ??
								"environment_incomplete"),
					},
					preflightDetail: callerInputFailure
						? validation
						: (error.preflightDetail ?? null),
				}),
			),
		);
		process.exitCode =
			error instanceof UsageError ||
			error instanceof CallerInputValidationError ||
			error?.name === "CheckpointIdentityError"
				? 2
				: 1;
	}
}
async function handleLaunch(argv, dependencies = {}) {
	const jsonRequested = argv.includes("--json");
	let opts;
	try {
		opts = parseLaunchArgs(argv);
	} catch (error) {
		if (!jsonRequested) throw error;
		console.log(
			// Detailed caller-validation codes remain in preflightDetail. The
			// top-level disposition uses its existing closed contract vocabulary.
			JSON.stringify(
				await buildLaunchFailureEnvelope({
					preInitialization: {
						type: "contract_failure",
						code: "invalid_invocation",
					},
				}),
			),
		);
		process.exitCode =
			error instanceof UsageError ||
			error instanceof CallerInputValidationError ||
			error?.name === "CheckpointIdentityError"
				? 2
				: 1;
		return;
	}
	if (opts.help) {
		console.log(USAGE_LAUNCH);
		return;
	}

	let stateRoot = null;
	let runId = null;
	let initialized = false;
	let preInitialization = null;
	let spawnFailure = false;
	let projectLockOwned = false;
	try {
		(dependencies.assertGenerationAllowed ?? assertGenerationAllowed)();
		// Parent launch has no durable run state until this read-only validation
		// succeeds. Later host changes are intentionally rechecked by the child.
		const callerInputs = validateCallerInputs(opts);
		materializeValidatedDirtyOverlay(opts, callerInputs);
		if (!process.env.SWITCHYARD_RUN_STORE_ROOT) {
			process.env.SWITCHYARD_RUN_STORE_ROOT = resolve(
				opts.projectPath,
				".logs",
				"switchyard",
			);
		}

		stateRoot = getStateRoot();
		runId = randomUUID();
		let tasks;
		try {
			tasks = loadTaskQueue(opts.tasksFilePath);
			validateProjectFileEntries(tasks, opts.projectPath);
		} catch (error) {
			preInitialization = {
				type: "contract_failure",
				code: "queue_contract_invalid",
			};
			throw new UsageError(error.message);
		}
		if (tasks.length === 0) {
			preInitialization = {
				type: "contract_failure",
				code: "queue_empty",
			};
			throw new UsageError(
				`no tasks parsed from ${opts.tasksFilePath} — 0 headings matching ` +
					`"### Task <id>: <title>" were found. Expected format:\n` +
					`### Task <id>: <title>\n- **Status:** pending\n- **Description:** ...`,
			);
		}
		prepareDispatchDirtyOverlay(opts, tasks);
		const orderedTaskIds = tasks.map((t) => t.id);
		let identity;
		try {
			identity = (dependencies.prepareRunIdentity ?? prepareRunIdentity)(opts);
		} catch (error) {
			preInitialization = {
				type: "contract_failure",
				code: "queue_identity_invalid",
			};
			throw error;
		}

		const launchArgs = process.argv.slice(2).filter((a) => a !== "launch");
		const nonce = randomUUID();
		const fingerprint = captureHostFingerprint(opts.projectPath);

		await initializeRun({
			runId,
			tasksFilePath: opts.tasksFilePath,
			projectPath: opts.projectPath,
			orderedTaskIds,
			initialHostFingerprint: fingerprint,
			workerNonce: nonce,
			launchArgs,
			projectRevision: identity.projectRevision,
			runOptions: identity.runOptions,
			queueIdentity: identity.queueIdentity,
		});
		initialized = true;

		try {
			await updateRunWithRetry(runId, {
				excludeProviders: opts.excludeProviders,
				onlyProviders: opts.onlyProviders,
				stopOnFailure: opts.stopOnFailure,
				taskIds: opts.taskIds,
			});

			await (
				dependencies.releaseOrphanedProjectLocks ?? releaseOrphanedProjectLocks
			)();
			await (
				dependencies.reconcileProjectLockClaims ?? reconcileProjectLockClaims
			)();
			await (dependencies.acquireProjectLock ?? acquireProjectLock)(
				opts.projectPath,
				runId,
			);
			if (
				(await (
					dependencies.assertProjectLockOwnership ?? assertProjectLockOwnership
				)(opts.projectPath, runId)) !== true
			) {
				throw new LockError("Project lock ownership assertion failed", {
					code: "PROJECT_LOCK_OWNERSHIP_FAILED",
				});
			}
			projectLockOwned = true;

			await advanceState(runId, "launching");
		} catch (error) {
			await finalizeInitializedLaunchFailure(runId, opts.projectPath, error, {
				projectLockOwned,
			});
			initialized = false;
			throw error;
		}

		const bootstrapPath = resolveBootstrapPath();
		let bootFd = null;
		try {
			bootFd = openSync(
				resolve(getRunRoot(runId), "boot-stderr.log"),
				"w",
				0o600,
			);
		} catch {
			// A diagnostics file must never be able to fail a launch.
		}

		let child;
		try {
			child = (dependencies.spawn ?? spawn)(
				process.execPath,
				[
					bootstrapPath,
					"--state-root",
					stateRoot,
					"--run-id",
					runId,
					"--nonce",
					nonce,
				],
				{
					detached: true,
					stdio: bootFd !== null ? ["ignore", "ignore", bootFd] : "ignore",
					env: {
						...process.env,
						SWITCHYARD_ROUTE_HEALTH_MODE: opts.healthMode,
						...(opts.healthStateRoot
							? {
									SWITCHYARD_ROUTE_HEALTH_STATE_ROOT: opts.healthStateRoot,
								}
							: {}),
					},
				},
			);
		} finally {
			if (bootFd !== null) {
				try {
					closeSync(bootFd);
				} catch {
					// Parent copy close is best effort.
				}
			}
		}
		child.unref();

		let spawnError = null;
		child.on("error", (error) => {
			spawnError = error;
		});

		await new Promise((resolveDelay) => {
			setTimeout(resolveDelay, 500);
		});

		if (spawnError) {
			spawnFailure = true;
			await finalizeInitializedLaunchFailure(
				runId,
				opts.projectPath,
				spawnError,
				{
					projectLockOwned,
				},
			);
			initialized = false;
			throw spawnError;
		}

		const readyRun = await markLauncherReadyIfLaunching(runId);
		const envelope = {
			schemaVersion: readyRun.schemaVersion ?? 1,
			runId,
			state: "launcher_ready",
			queueIdentity: readyRun.queueIdentity ?? null,
			stateRoot,
			...launchCommands(runId, stateRoot),
			disposition: projectDisposition({
				run: readyRun,
				liveness: classifyRunLiveness(readyRun),
				recoveryCommand: recoveryCommandFor(runId),
			}),
		};
		console.log(JSON.stringify(envelope));
	} catch (error) {
		if (initialized && runId !== null && opts?.projectPath) {
			try {
				await finalizeInitializedLaunchFailure(runId, opts.projectPath, error, {
					projectLockOwned,
				});
			} catch {
				// The envelope will omit unresolved durable targets.
			}
		}
		if (!jsonRequested) {
			if (spawnFailure) {
				console.error(
					`dispatch: launch failed — child spawn error: ${error.message}`,
				);
				process.exitCode = 1;
				return;
			}
			throw error;
		}
		console.log(
			JSON.stringify(
				await buildLaunchFailureEnvelope({
					runId,
					stateRoot,
					preInitialization:
						preInitialization ??
						(error instanceof CallerInputValidationError ||
						error instanceof UsageError ||
						error?.name === "CallerInputValidationUnavailableError" ||
						error?.name === "CheckpointIdentityError"
							? {
									type: "contract_failure",
									code: validationContractCode(
										error,
										validationFailureEnvelope(error),
									),
								}
							: null),
					preflightDetail:
						error instanceof CallerInputValidationError ||
						error instanceof UsageError ||
						error?.name === "CallerInputValidationUnavailableError" ||
						error?.name === "CheckpointIdentityError"
							? validationFailureEnvelope(error)
							: (error.preflightDetail ?? null),
				}),
			),
		);
		process.exitCode =
			error instanceof UsageError ||
			error instanceof CallerInputValidationError ||
			error?.name === "CheckpointIdentityError"
				? 2
				: 1;
	}
}

export { handleLaunch, handleRun };
