#!/usr/bin/env node

// Thin dispatch CLI over runQueue: farm a task queue across the funded
// providers instead of running every task on one. Host-side routing picks a
// provider by usage headroom (INV-4/5); each task then runs headless inside a
// disposable per-provider working container seeded from the project (INV-1),
// and its result returns to the host only through the reviewed integration
// gate (INV-2). The working container is wiped at the end (INV-3).
//
// This is also the executable SWITCHYARD_ORCHESTRATOR_CMD-style entry the
// :implement loop can point at; standalone it dispatches a queue against a
// project.
//
// Usage:
//   switchyard-dispatch run <tasks.md> --project <path> [options]      # legacy, same as positional
//   switchyard-dispatch launch <tasks.md> --project <path> [options]   # detached
//   switchyard-dispatch status <run-id> [--json]                       # read-only
//   switchyard-dispatch result <run-id> [--json]                       # read-only
//   switchyard-dispatch recover [--run <run-id>]                        # cleanup
//   switchyard-dispatch --version                                      # package version
//   node src/switchyard/dispatch/index.mjs <tasks.md> --project <path> [options]  # positional (backwards compat)
//
// Options (run/launch):
//   --project <path>       Host git repo to dispatch against (required). Its
//                          committed HEAD seeds each working container, and
//                          reviewed diffs land back on it.
//   --max-tasks <n>        Cap how many tasks are processed this run.
//   --checkpoint <path>    Checkpoint file (default: <tasks>.checkpoint.json).
//   --no-stop-on-failure   Keep going after a task fails (default: stop).
//   --exclude-provider <name>  Never route to this provider (repeatable).
//   --dirty-overlay        Seed declared tracked dirty bytes by immutable receipt.
//   --json                 Emit one JSON object for run/launch success or failure.
//   --platform <macos>     Queue workspace platform (default: macos).
//   --help                 Show this help.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
	CHECKPOINT_REMEDIATION_MESSAGES,
	checkpointRemediation,
	classifyPreProviderFailure,
	isPersistentFailureMetadata,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import {
	createExecutionBackend,
	hostBackendDefaults,
} from "../lifecycle/backend-selection.mjs";
import {
	captureDirtyOverlay,
	ignoredPath,
	readDirtyOverlayReceipt,
	validateDirtyOverlayReceipt,
	writeDirtyOverlayReceipt,
} from "../lifecycle/index.mjs";
import { assertGenerationAllowed } from "../maintenance/index.mjs";
import {
	applyOutcomeProjection,
	projectOutcomeReader,
} from "../outcome/projection.mjs";
import {
	attestRouteRepair,
	createDefaultRouteHealthDecision,
	ingestRouteHealthEvents,
	inspectRouteHealth,
} from "../router/health.mjs";
import { GOLDEN_IMAGE_VERIFIED_PROVIDERS } from "../router/index.mjs";
import {
	acquireProjectLock,
	acquireRunLock,
	activateOutcomeWriter,
	advanceState,
	applyRetention,
	assertProjectLockOwnership,
	createEvent,
	createRouteHealthEvent,
	getRunRoot,
	getStateRoot,
	getVmAdmissionRoot,
	initializeRun,
	isProjectLockOwnedBy,
	LockError,
	RevisionError,
	readEvents,
	readRun,
	reconcileProjectLockClaims,
	releaseOrphanedProjectLocks,
	releaseProjectLockIfOwnedBy,
	SchemaError,
	updateRun,
	updateRunWithRetry,
} from "../run-store/index.mjs";
import { classifyRunLiveness } from "../run-store/run-liveness.mjs";
import {
	computeQueueIdentityFromFile,
	deriveQueueDiagnostics,
	getCheckpointPath,
	getProjectRevision,
	loadCheckpoint,
	loadTaskQueue,
	normalizeRunOptions,
	reconcileExternalCompletion,
	runQueueAsync,
	sanitizeQueuePreflightDetail,
	validateProjectFileEntries,
} from "../runner/index.mjs";
import { projectDisposition, projectTerminalOutcome } from "./disposition.mjs";
import { run as runOrphanLockRemediation } from "./remediate-orphaned-locks.mjs";
import { finalizeRun } from "./run-finalization.mjs";

const USAGE = `Usage: switchyard-dispatch <subcommand> [args]
       switchyard-dispatch --version

Subcommands:
  run    <tasks.md> --project <path> [options]    Run queue synchronously
  launch <tasks.md> --project <path> [options]    Launch detached run
  status <run-id> [--json]                        Show run status
  result <run-id> [--json]                        Show run result
  recover [--run <run-id>] [--state-root <path>]  Recover managed objects
  reconcile-completion --receipt <path> ...       Record external completion
  remediate-orphaned-locks [--dry-run|--confirm] [--state-root <path>]
                                                Interactively remediate orphaned project locks

Run/Launch options:
  --project <path>       Host git repo to dispatch against (required)
  --max-tasks <n>        Cap how many tasks are processed this run
  --checkpoint <path>    Checkpoint file (default: <tasks>.checkpoint.json)
  --no-stop-on-failure   Keep going after a task fails (default: stop)
  --exclude-provider <name>  Never route to this provider (repeatable)
  --only-provider <name>  Restrict routing to only this provider (repeatable, mutually exclusive with --exclude-provider)
  --platform <macos>     Queue workspace platform (default: macos)
  --task-id <id>          Select an exact task (repeatable; identity-bound)
  --health-enforce        Apply route-health exclusions (default: shadow only)
  --health-state-root <path>  Explicit host-owned route-health root
  --json                  Emit one terminal JSON object
  --help                 Show this help`;

const USAGE_RUN = `Usage: switchyard-dispatch run <tasks.md> --project <path> [options]

  --project <path>       Host git repo to dispatch against (required)
  --max-tasks <n>        Cap how many tasks are processed this run
  --checkpoint <path>    Checkpoint file (default: <tasks>.checkpoint.json)
  --no-stop-on-failure   Keep going after a task fails (default: stop)
  --exclude-provider <name>  Never route to this provider (repeatable)
  --only-provider <name>  Restrict routing to only this provider (repeatable, mutually exclusive with --exclude-provider)
  --platform <macos>     Queue workspace platform (default: macos)
  --task-id <id>          Select an exact task (repeatable; identity-bound)
  --json                  Emit one terminal JSON object
  --help                 Show this help`;

const USAGE_LAUNCH = `Usage: switchyard-dispatch launch <tasks.md> --project <path> [options]

  --project <path>       Host git repo to dispatch against (required)
  --max-tasks <n>        Cap how many tasks are processed this run
  --checkpoint <path>    Checkpoint file (default: <tasks>.checkpoint.json)
  --no-stop-on-failure   Keep going after a task fails (default: stop)
  --exclude-provider <name>  Never route to this provider (repeatable)
  --only-provider <name>  Restrict routing to only this provider (repeatable, mutually exclusive with --exclude-provider)
  --task-id <id>          Select an exact task (repeatable; identity-bound)
  --json                  Emit one JSON object on success or failure
  --help                 Show this help`;

const USAGE_STATUS = `Usage: switchyard-dispatch status <run-id> [--json]

  --json                    Output as JSON (default behavior)
  --state-root <path>       Read the run from this launch's durable state root
  --help     Show this help`;

const USAGE_RESULT = `Usage: switchyard-dispatch result <run-id> [--json]

  --json                    Output as JSON (default behavior)
  --state-root <path>       Read the run from this launch's durable state root
  --help     Show this help`;

const USAGE_RECOVER = `Usage: switchyard-dispatch recover [--run <run-id>] [--state-root <path>]

  --run <run-id>       Recover only this run's managed objects
  --state-root <path>  Reconcile this launch's durable state root
  --help               Show this help`;

const USAGE_HEALTH = `Usage: switchyard-dispatch health <identity|inspect|attest-repair> --target <target-id> [options]

  identity:      --capability <low|standard|high>
  inspect:       --descriptor <descriptor-identity> --public-configuration-epoch <epoch> --repair-epoch <n> [--health-state-root <path>]
  attest-repair: --descriptor <descriptor-identity> --public-configuration-epoch <epoch> --repair-kind <image_repaired|auth_repaired|configuration_repaired> [--health-state-root <path>]
  Run \`health identity\` first: it prints the descriptor identity and public configuration epoch the other two require.
  attest-repair records attended host control metadata only; it never reads credentials or repairs a service.`;

const USAGE_RECONCILE_COMPLETION = `Usage: switchyard-dispatch reconcile-completion --receipt <path> --source-checkpoint <path> --successor-checkpoint <path> --tasks <path> --project <path>

  --receipt <path>              Versioned bounded external-completion receipt
  --source-checkpoint <path>    Existing checkpoint, never modified
  --successor-checkpoint <path> Fresh checkpoint to create
  --tasks <path>                Exact task file for successor identity
  --project <path>              Repository containing the integrated commit
  --json                        Emit JSON
  --help                        Show this help`;

const KNOWN_SUBCOMMANDS = new Set([
	"run",
	"launch",
	"status",
	"result",
	"recover",
	"health",
	"reconcile-completion",
	"remediate-orphaned-locks",
]);

// Distinguishes a bad-invocation error (print usage, exit 2) from a real
// run-time failure (exit 1), mirroring conventional CLI exit-code semantics.
class UsageError extends Error {}

// Grace window for a run that has been initialized but whose worker has not yet
// acquired the run lock (workerPid still null). Within this window `recover`
// treats the run — and its working container — as a launching dispatch and
// leaves it alone; past it, a still-worker-less run is a stuck/abandoned launch
// and is reclaimable. Generous relative to real startup (spawn + fingerprint +
// acquireRunLock is seconds; container creation happens AFTER the lock).

/**
 * Publish the detached-launch handshake only if the worker has not already
 * claimed the run. The worker can reach `running` during the parent's 500 ms
 * launch grace period; an unconditional `advanceState(..., "launcher_ready")`
 * would then regress the durable state and make status lie about a live run.
 *
 * @param {string} runId
 * @returns {Promise<object>} the current or updated run snapshot
 */
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

/**
 * Validate CLI arguments into a runQueue options object.
 * @param {string[]} argv process.argv.slice(2) without subcommand
 * @throws {UsageError} on any invalid/missing argument
 */
function parseDispatchArgs(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				project: { type: "string" },
				"max-tasks": { type: "string" },
				checkpoint: { type: "string" },
				"no-stop-on-failure": { type: "boolean", default: false },
				"exclude-provider": { type: "string", multiple: true },
				"only-provider": { type: "string", multiple: true },
				provider: { type: "string", multiple: true },
				"task-id": { type: "string", multiple: true },
				"health-enforce": { type: "boolean", default: false },
				"health-state-root": { type: "string" },
				platform: { type: "string" },
				"dirty-overlay": { type: "boolean", default: false },
				json: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
		});
	} catch (error) {
		throw new UsageError(error.message);
	}

	const { values, positionals } = parsed;
	if (values.help) {
		return { help: true };
	}

	const tasksFilePath = positionals[0];
	if (!tasksFilePath) {
		throw new UsageError("missing <tasks.md> positional argument");
	}
	if (positionals.length > 1) {
		throw new UsageError(
			`unexpected extra arguments: ${positionals.slice(1).join(" ")}`,
		);
	}
	if (!values.project) {
		throw new UsageError("--project <path> is required");
	}

	const resolvedTasks = resolve(tasksFilePath);
	if (!existsSync(resolvedTasks) || !statSync(resolvedTasks).isFile()) {
		throw new UsageError(`tasks file not found: ${resolvedTasks}`);
	}

	const projectPath = resolve(values.project);
	if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
		throw new UsageError(`--project is not a directory: ${projectPath}`);
	}
	// seedProjectWithBackend archives the project's committed HEAD into each
	// workspace, so a non-repo project can't be dispatched against.
	if (!existsSync(join(projectPath, ".git"))) {
		throw new UsageError(`--project is not a git repository: ${projectPath}`);
	}

	let maxTasks = Number.POSITIVE_INFINITY;
	if (values["max-tasks"] !== undefined) {
		maxTasks = Number.parseInt(values["max-tasks"], 10);
		if (!Number.isInteger(maxTasks) || maxTasks < 1) {
			throw new UsageError(
				`--max-tasks must be a positive integer, got "${values["max-tasks"]}"`,
			);
		}
	}

	const onlyProviders = [
		...(values["only-provider"] ?? []),
		...(values.provider ?? []),
	];
	const platform = String(values.platform ?? "macos")
		.trim()
		.toLowerCase();
	if (platform !== "macos") {
		throw new UsageError(`--platform must be macos, got "${values.platform}"`);
	}
	if (
		onlyProviders.length > 0 &&
		(values["exclude-provider"] ?? []).length > 0
	) {
		throw new UsageError(
			"--only-provider/--provider and --exclude-provider are mutually exclusive",
		);
	}

	return {
		help: false,
		tasksFilePath: resolvedTasks,
		projectPath,
		maxTasks,
		checkpointPath: values.checkpoint ? resolve(values.checkpoint) : undefined,
		stopOnFailure: !values["no-stop-on-failure"],
		excludeProviders: values["exclude-provider"] ?? [],
		onlyProviders,
		taskIds: values["task-id"] ?? [],
		platform,
		dirtyOverlay: values["dirty-overlay"] === true,
		json: values.json,
		healthMode: values["health-enforce"] ? "enforce" : "shadow",
		healthStateRoot: values["health-state-root"]
			? resolve(values["health-state-root"])
			: undefined,
	};
}

/**
 * Parse launch arguments (same shape as run args).
 * @param {string[]} argv
 * @throws {UsageError}
 */
function parseLaunchArgs(argv) {
	return parseDispatchArgs(argv);
}

/**
 * Parse status arguments.
 * @param {string[]} argv
 * @throws {UsageError}
 */
function parseStatusArgs(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				help: { type: "boolean", default: false },
				json: { type: "boolean", default: false },
				"state-root": { type: "string" },
			},
		});
	} catch (error) {
		throw new UsageError(error.message);
	}

	const { values, positionals } = parsed;
	return {
		help: values.help,
		runId: positionals[0] ?? null,
		json: values.json,
		stateRoot: values["state-root"] ?? null,
	};
}

function shellQuote(value) {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function withStateRoot(stateRoot, operation) {
	if (!stateRoot) return operation();
	const previous = process.env.SWITCHYARD_RUN_STORE_ROOT;
	process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;
	try {
		return await operation();
	} finally {
		if (previous === undefined) {
			delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		} else {
			process.env.SWITCHYARD_RUN_STORE_ROOT = previous;
		}
	}
}

/**
 * Parse result arguments.
 * @param {string[]} argv
 * @throws {UsageError}
 */
function parseResultArgs(argv) {
	return parseStatusArgs(argv);
}

/**
 * Parse recover arguments.
 * @param {string[]} argv
 * @throws {UsageError}
 */
function parseRecoverArgs(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: false,
			options: {
				run: { type: "string" },
				"state-root": { type: "string" },
				help: { type: "boolean", default: false },
			},
		});
	} catch (error) {
		throw new UsageError(error.message);
	}

	return {
		help: parsed.values.help,
		runId: parsed.values.run ?? null,
		stateRoot: parsed.values["state-root"] ?? null,
	};
}

function parseHealthArgs(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				target: { type: "string" },
				descriptor: { type: "string" },
				"public-configuration-epoch": { type: "string" },
				"repair-epoch": { type: "string" },
				"repair-kind": { type: "string" },
				capability: { type: "string" },
				"health-state-root": { type: "string" },
				help: { type: "boolean", default: false },
			},
		});
	} catch (error) {
		throw new UsageError(error.message);
	}
	const action = parsed.positionals[0];
	if (parsed.values.help) return { help: true };
	if (!new Set(["identity", "inspect", "attest-repair"]).has(action))
		throw new UsageError("health requires identity, inspect, or attest-repair");
	if (!parsed.values.target)
		throw new UsageError("health --target is required");
	if (action === "identity") {
		const requiredCapability = parsed.values.capability;
		if (!new Set(["low", "standard", "high"]).has(requiredCapability))
			throw new UsageError(
				"health identity --capability must be low, standard, or high",
			);
		return { action, provider: parsed.values.target, requiredCapability };
	}
	for (const name of ["descriptor", "public-configuration-epoch"]) {
		if (!parsed.values[name])
			throw new UsageError(`health --${name} is required`);
	}
	const base = {
		targetId: parsed.values.target,
		descriptorIdentity: parsed.values.descriptor,
		publicConfigurationEpoch: parsed.values["public-configuration-epoch"],
		healthStateRoot: parsed.values["health-state-root"]
			? resolve(parsed.values["health-state-root"])
			: undefined,
	};
	if (action === "inspect") {
		const repairEpochText = parsed.values["repair-epoch"];
		if (!/^(0|[1-9]\d*)$/.test(repairEpochText ?? ""))
			throw new UsageError(
				"health inspect --repair-epoch must be a non-negative integer",
			);
		const repairEpoch = Number(repairEpochText);
		if (!Number.isSafeInteger(repairEpoch))
			throw new UsageError(
				"health inspect --repair-epoch must be a non-negative integer",
			);
		return { action, ...base, repairEpoch };
	}
	if (!parsed.values["repair-kind"])
		throw new UsageError("health attest-repair --repair-kind is required");
	return { action, ...base, repairKind: parsed.values["repair-kind"] };
}

function parseReconcileCompletionArgs(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: false,
			options: {
				receipt: { type: "string" },
				"source-checkpoint": { type: "string" },
				"successor-checkpoint": { type: "string" },
				tasks: { type: "string" },
				project: { type: "string" },
				json: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
		});
	} catch (error) {
		throw new UsageError(error.message);
	}
	if (parsed.values.help) return { help: true };
	const required = [
		"receipt",
		"source-checkpoint",
		"successor-checkpoint",
		"tasks",
		"project",
	];
	if (required.some((field) => !parsed.values[field]))
		throw new UsageError(
			"reconcile-completion requires --receipt, --source-checkpoint, --successor-checkpoint, --tasks, and --project",
		);
	return {
		receiptPath: resolve(parsed.values.receipt),
		sourceCheckpointPath: resolve(parsed.values["source-checkpoint"]),
		successorCheckpointPath: resolve(parsed.values["successor-checkpoint"]),
		tasksFilePath: resolve(parsed.values.tasks),
		projectPath: resolve(parsed.values.project),
		json: parsed.values.json,
	};
}

async function handleReconcileCompletion(argv) {
	const options = parseReconcileCompletionArgs(argv);
	if (options.help) {
		console.log(USAGE_RECONCILE_COMPLETION);
		return;
	}
	// The runner owns every receipt trust check (lstat, bounds, owner, mode,
	// nonsymlink, and only then JSON parsing).  Keeping the CLI path-only also
	// prevents FIFOs and symlink targets from being opened before that gate.
	const result = await reconcileExternalCompletion(options);
	if (options.json) console.log(JSON.stringify(result));
	else
		console.log(
			`${result.status}: ${result.result}${result.reasonCode ? ` (${result.reasonCode})` : ""}`,
		);
	if (["refused", "recovery-required"].includes(result.status))
		process.exitCode = 1;
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

/**
 * Run the dispatch, printing live per-task progress (INV-1: no silent waits).
 * Sets process.exitCode: 1 if any processed task failed, else 0.
 *
 * Wraps runQueue in a minimal run-store lifecycle (a runId + a run lock that
 * stamps this process's PID) so the working container it creates is (a)
 * labeled with the runId and (b) liveness-checkable by `recover`: while this
 * process lives the run reads active and is never reaped; on clean exit we
 * advance to a terminal state; on a crash the dead PID makes the run — and its
 * leaked container — reclaimable. The run-store steps are best-effort: a
 * run-store failure must not block a foreground dispatch, so we fall back to
 * an unlabeled (legacy) container rather than aborting. An exclusive project
 * lock (INV-6) is held across queue execution and released on every terminal
 * path; it is only acquired after the run record exists, so a killed dispatch
 * can never strand a lock whose missing run record `recover` refuses to
 * reclaim.
 * @param {object} opts Result of parseDispatchArgs (help:false variant)
 * @param {object} [dependencies] Injectable dependencies (tests only)
 * @param {(options: object) => object} [dependencies.runQueue] Defaults to the
 *   real runQueue; tests stub it so the dispatch lock lifecycle can be proven
 *   in isolation from queue execution (no VM workspaces on that path).
 */
async function runDispatch(opts, dependencies = {}) {
	const jsonRequested = opts.json === true;
	const report = jsonRequested ? () => {} : (...args) => console.error(...args);
	// A dispatch belongs to its target project, not to this checkout. Keeping
	// durable state beside that project avoids File Provider permissions on a
	// separately checked-out Switchyard source tree. Explicit overrides remain
	// authoritative for isolated tests and shared operational stores.
	if (!process.env.SWITCHYARD_RUN_STORE_ROOT) {
		process.env.SWITCHYARD_RUN_STORE_ROOT = resolve(
			opts.projectPath,
			".logs",
			"switchyard",
		);
	}
	(dependencies.assertGenerationAllowed ?? assertGenerationAllowed)();
	report(`dispatch: queue    ${opts.tasksFilePath}`);
	report(`dispatch: project  ${opts.projectPath}`);
	report(
		"dispatch: routing host-side by usage headroom; each task runs headlessly in a disposable Parallels working VM.",
	);
	report(
		"dispatch: expect several minutes per task while the provider CLI runs.",
	);

	// Pre-dispatch sweep (Piece C): reap any container a prior crashed run
	// leaked so the host self-heals every dispatch. Fire-and-forget — hygiene
	// must NOT sit on the dispatch critical path; the resource limits are the
	// meltdown safety gate, so the sweep only needs to run eventually. It starts
	// before this run's id exists, so it cannot see (or reap) our own run/
	// container. This process lives for the whole dispatch (minutes), giving the
	// sweep ample time to finish. The .catch prevents an unhandledRejection.
	sweepManagedOrphans({ ...dependencies, projectPath: opts.projectPath })
		.then((swept) => {
			// These once read `containersReclaimed`/`volumesReclaimed`, which
			// sweepManagedOrphans stopped returning at the Docker-to-Parallels
			// rename. `undefined > 0` is false, so the branch was unreachable
			// and every pre-run reclamation went unreported.
			if (swept.vmsReclaimed > 0) {
				report(
					`dispatch: pre-run sweep reclaimed ${swept.vmsReclaimed} orphaned VM(s)`,
				);
			}
			for (const entry of swept.unreclaimedSnapshots) {
				report(
					`dispatch: pre-run sweep left snapshots on the golden for ${entry.name} (${entry.reason}) — human review required`,
				);
			}
		})
		.catch((error) => {
			report(`dispatch: pre-run sweep failed (${error.message})`);
		});

	// Retention sweep (Task D.5, revised by Task 6.5). This pass deletes for
	// real; the dry-run mode it used to run in stays available for inspection
	// via `applyRetention({ dryRun: true })`. What it can reach is bounded by
	// what a file IS, not by run state: run.json and events.jsonl are never
	// removed at any age, artifacts/ contents always are, and only a run
	// directory that never recorded an event can be removed outright.
	// maxAgeDays bounds that last rule alone, which is also what keeps a
	// mid-flight run — run.json written, first event not yet appended — out of
	// reach of this sweep. A run whose checkpoint still exists is skipped
	// entirely, because a resume would read it.
	// Malformed run directories are quarantined (moved, not deleted) on every
	// sweep regardless of dryRun — same as always for that path — since a
	// record that can't be read never becomes eligible and would otherwise
	// fail this same scan forever. The one conservative exception: a run
	// directory whose run.json is absent (ENOENT — e.g. a concurrent
	// initializeRun mid-flight) is left for a later sweep, not quarantined.
	// This sweep remains synchronous-dispatch-only:
	// detached launch and worker-bootstrap intentionally do not invoke it.
	applyRetention({ maxAgeDays: 30 })
		.then(({ deletedCount, collectedCount, quarantined }) => {
			if (deletedCount > 0) {
				report(
					`dispatch: retention sweep removed ${deletedCount} run-store director${deletedCount === 1 ? "y" : "ies"} older than 30 days that recorded no events`,
				);
			}
			if (collectedCount > 0) {
				report(
					`dispatch: retention sweep collected ${collectedCount} run-store artifact${collectedCount === 1 ? "" : "s"}`,
				);
			}
			for (const entry of quarantined) {
				report(
					`dispatch: retention sweep quarantined run ${entry.runId} (${entry.reason})`,
				);
			}
		})
		.catch((error) => {
			report(`dispatch: retention sweep failed (${error.message})`);
		});

	const runId = randomUUID();
	const pid = process.pid;
	const startToken = randomUUID();
	const nonce = randomUUID();
	// Production dispatch uses the async runner, which owns broker selection,
	// reservations, fallback, and provider execution. Keep the injectable
	// override for lifecycle tests and compatibility callers.
	const runQueueFn = dependencies.runQueue ?? runQueueAsync;
	let healthDecision = null;

	// Initialize the run record BEFORE the project lock is ever acquired —
	// the same ordering handleLaunch uses. The project lock is keyed by the
	// project path alone and `recover` deliberately refuses to reclaim a lock
	// whose run.json is missing (CR-4/CR-5), so a lock acquired before its run
	// record exists is a permanent block if this process is killed in between.
	// Initializing first means a hard kill at any point after lock acquisition
	// always leaves a run record the recovery model can reason about (INV-6).
	// The lock itself is acquired immediately before queue execution below; on
	// a contention failure it throws the existing LockError and the finally
	// block advances this run's already-written record to a terminal state.
	let runStoreReady = false;
	let identity = null;
	let initialized = false;
	let initializationCode = null;
	try {
		let tasks;
		try {
			tasks = loadTaskQueue(opts.tasksFilePath);
			validateProjectFileEntries(tasks, opts.projectPath);
		} catch (error) {
			// A queue that fails to parse is a caller contract failure with a
			// precise, user-fixable cause. Left unclassified it fell through to
			// `environment_incomplete`, which points at the host instead of at
			// the line of the task file that needs editing.
			initializationCode = "queue_contract_invalid";
			throw new UsageError(error.message);
		}
		if (tasks.length === 0) {
			initializationCode = "queue_empty";
			throw new UsageError("no tasks parsed from the task queue");
		}
		prepareDispatchDirtyOverlay(opts, tasks);
		// Built inside the classified pre-provider block: an invalid golden
		// image reference or health root is a host configuration failure that
		// must produce the closed envelope, not an uncaught exception.
		healthDecision =
			dependencies.healthDecision ??
			createDefaultRouteHealthDecision({
				healthStateRoot: opts.healthStateRoot,
				mode: opts.healthMode,
				qualifiedProviders: GOLDEN_IMAGE_VERIFIED_PROVIDERS,
				// The runner derives the same epoch from dependencies.goldenImage;
				// dispatch must bind to the identical golden image so both paths
				// observe one health generation.
				...(dependencies.goldenImage !== undefined
					? { goldenImageReference: dependencies.goldenImage }
					: {}),
			});
		try {
			identity = prepareRunIdentity(opts);
		} catch (error) {
			initializationCode = "queue_identity_invalid";
			throw error;
		}
		await initializeRun({
			runId,
			tasksFilePath: opts.tasksFilePath,
			projectPath: opts.projectPath,
			orderedTaskIds: tasks.map((t) => t.id),
			initialHostFingerprint: captureHostFingerprint(opts.projectPath),
			workerNonce: nonce,
			projectRevision: identity.projectRevision,
			runOptions: identity.runOptions,
			queueIdentity: identity.queueIdentity,
		});
		initialized = true;
		await acquireRunLock(runId, pid, startToken, nonce);
		runStoreReady = true;
	} catch (error) {
		const classified = classifyPreProviderFailure(error);
		const diagnosticCode =
			initializationCode ??
			classified?.diagnosticCode ??
			"environment_incomplete";
		if (initialized) {
			try {
				const failure = sanitizeFailureMetadata({
					result: "unknown_failure",
					errorKind: classified?.errorKind ?? diagnosticCode,
					diagnosticCode,
					failurePhase: classified?.failurePhase ?? "queue_preflight",
				});
				await finalizeRun({
					runId,
					state: "failed",
					failure,
					eventName: "dispatch_initialization_failed",
					eventStatus: "fatal",
					eventReasonCode: failure.reasonCode,
					terminalSummary: {
						totalTasks: null,
						runnableTasks: null,
						processedTasks: null,
						completedTaskIds: null,
						failedCount: null,
					},
					cleanup: async () => {},
				});
			} catch {
				// A JSON caller receives a null address unless the terminal record is
				// readable below; raw initialization errors never cross that surface.
			}
		}
		if (jsonRequested) {
			let envelope = null;
			if (initialized) {
				try {
					const terminalRun = await readRun(runId);
					if (isTerminalState(terminalRun.state)) {
						envelope = await buildResultEnvelope(runId, terminalRun);
					}
				} catch {
					// No readable terminal record means no addressable run.
				}
			}
			console.log(
				JSON.stringify(
					envelope ??
						(await buildLaunchFailureEnvelope({
							preInitialization: {
								type: "contract_failure",
								code: diagnosticCode,
							},
						})),
				),
			);
			process.exitCode = error instanceof UsageError ? 2 : 1;
			return { runId: envelope?.runId ?? null, error: true };
		}
		if (initialized) {
			Object.defineProperty(error, "switchyardRunId", {
				value: runId,
				enumerable: false,
			});
		}
		// A caller contract failure already carries the precise message; the
		// fixed-string wrapper discarded the only line that says what to fix.
		// These are host-side errors over the caller's own task file, never
		// provider output.
		if (error instanceof UsageError) throw error;
		const wrapped = new Error(
			`dispatch: run-store initialization failed before routing: ${error.message}`,
			{ cause: error },
		);
		if (initialized) {
			Object.defineProperty(wrapped, "switchyardRunId", {
				value: runId,
				enumerable: false,
			});
		}
		throw wrapped;
	}

	let result;
	let queueError = null;
	let eventWriteChain = Promise.resolve();
	let projectLockOwned = false;
	try {
		// Acquire the exclusive project lock immediately before queue
		// execution, mirroring handleLaunch. This is deliberately NOT
		// best-effort like the run-store init above — the lock is the
		// mutual-exclusion gate, and a run that cannot acquire it must not run
		// (it fails fast with the existing LockError). It is only attempted
		// when the run record exists (runStoreReady): when the run store is
		// degraded there is no record for `recover` to key on, so holding the
		// lock would recreate the unreclaimable-orphan window this ordering
		// exists to prevent — the run instead degrades to the unlabeled legacy
		// path (no lock, no runId label), exactly as a run-store failure always
		// has. Release on every terminal path is guaranteed by the finally
		// block below.
		if (runStoreReady) {
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
			const ownsProjectLock = await (
				dependencies.assertProjectLockOwnership ?? assertProjectLockOwnership
			)(opts.projectPath, runId);
			if (ownsProjectLock !== true) {
				throw new LockError("Project lock ownership assertion failed");
			}
			projectLockOwned = true;
		}
		if (runStoreReady) {
			// The run only becomes executing after exclusive project ownership is
			// proven and the provider-capable queue call is ready to begin.
			await advanceState(runId, "running");
		}
		result = await runQueueFn({
			tasksFilePath: opts.tasksFilePath,
			projectPath: opts.projectPath,
			maxTasks: opts.maxTasks,
			checkpointPath:
				opts.checkpointPath ?? getCheckpointPath(opts.tasksFilePath),
			stopOnFailure: opts.stopOnFailure,
			exclude: opts.excludeProviders,
			only: opts.onlyProviders,
			taskIds: opts.taskIds,
			platform: opts.platform,
			runOptions: identity?.runOptions,
			queueIdentity: identity?.queueIdentity,
			projectRevision: identity?.projectRevision,
			...(runStoreReady ? { runId } : {}),
			dependencies: {
				...dependencies,
				healthDecision,
				onHealthDecision: (decision) => {
					dependencies.onHealthDecision?.(decision);
					if (decision.state !== "healthy") {
						report(
							`dispatch: route health ${decision.provider} ${decision.state} (${decision.mode})`,
						);
					}
				},
				onTaskStart: (task) => {
					report(`dispatch: -> task ${task.id} ${task.title ?? ""}`.trimEnd());
					// activeTaskId is not just one datum: buildStatusEnvelope
					// gates activeTaskProvider, activeTaskModel,
					// activeTaskDeadline, activeTaskAgeMs, and runningCount on
					// it being non-null. Without this write the synchronous path
					// reported an idle run for the entire time a provider was
					// executing, and suppressed onTaskRouted's provider/model
					// writes along with it. The detached path has always done
					// this in worker-bootstrap's onTaskStart; only this one was
					// missing. Appended to eventWriteChain so it serializes
					// against onTaskRouted, which fires microseconds later.
					if (runStoreReady) {
						eventWriteChain = eventWriteChain
							.then(() => updateRunWithRetry(runId, { activeTaskId: task.id }))
							.catch(() => {});
					}
				},
				onTaskRouted: (info) => {
					report(
						`dispatch:    routed to ${info.provider}${info.model ? `/${info.model}` : ""} — deadline ${info.deadline ?? "orchestrator"}`,
					);
					if (runStoreReady) {
						eventWriteChain = eventWriteChain
							.then(() =>
								updateRunWithRetry(runId, {
									activeTaskProvider: info.provider,
									activeTaskModel: info.model,
									activeTaskDeadline: info.deadline ?? null,
									resolvedTargetId: info.resolvedTargetId ?? null,
									activeTaskInvocationDescriptor:
										info.invocationDescriptor ?? null,
									activeTaskDescriptorIdentity: info.descriptorIdentity ?? null,
									activeTaskDescriptorHarness: info.descriptorHarness ?? null,
									dispatchContractVersion: info.dispatchContractVersion ?? 1,
									snapshotStatus: info.snapshotStatus ?? null,
									snapshotMtime: info.snapshotMtime ?? null,
									snapshotAgeMsAtRoute: info.snapshotAgeMsAtRoute ?? null,
								}),
							)
							.catch(() => {});
					}
				},
				onResult: (r) => {
					const safeFailure = sanitizeFailureMetadata(r);
					const artifactRef =
						typeof r.artifactRef === "string" &&
						/^artifact:[a-f0-9]{24}$/.test(r.artifactRef)
							? r.artifactRef
							: undefined;
					const where = `${r.provider ?? "no-provider"}${r.model ? `/${r.model}` : ""}`;
					const displayReason =
						safeFailure?.reason ?? (r.success ? "" : "task failed");
					report(
						`dispatch: ${r.success ? "ok  " : "FAIL"} task ${r.taskId} [${where}] ${r.result}${displayReason ? ` (${displayReason})` : ""}`,
					);
					if (runStoreReady) {
						const event = {
							phase: "execution",
							event: r.success ? "task_completed" : "task_failed",
							status: `Task ${r.taskId} ${r.success ? "completed" : "failed"}`,
							taskId: r.taskId,
							provider: r.provider ?? null,
							model: r.model ?? null,
							invocationDescriptor: r.invocationDescriptor ?? null,
							descriptorIdentity: r.descriptorIdentity ?? null,
							descriptorHarness: r.descriptorHarness ?? null,
							resolvedTargetId: r.resolvedTargetId ?? null,
							dispatchContractVersion: r.dispatchContractVersion ?? 1,
							...(typeof r.servedModelVerified === "boolean"
								? { servedModelVerified: r.servedModelVerified }
								: {}),
							result: r.result,
							...(r.reviewResult ? { reviewResult: r.reviewResult } : {}),
							...(r.alreadyApplied ? { alreadyApplied: true } : {}),
							...(safeFailure ?? {}),
							...(artifactRef ? { artifactRef } : {}),
							...(r.routeHealthBinding
								? { attempt: r.routeHealthAttempt }
								: {}),
						};
						eventWriteChain = eventWriteChain
							.then(async () => {
								if (r.routeHealthBinding) {
									await createRouteHealthEvent(
										runId,
										event,
										r.routeHealthBinding,
									);
									try {
										await ingestRouteHealthEvents({
											authorisedRuns: [{ runId, runRoot: getRunRoot(runId) }],
											healthStateRoot: opts.healthStateRoot,
										});
									} catch {
										report("dispatch: route health ingestion unavailable");
									}
								} else {
									await createEvent(runId, event);
								}
								await updateRunWithRetry(runId, {
									activeTaskId: null,
									activeTaskProvider: null,
									activeTaskModel: null,
									activeTaskDeadline: null,
									activeTaskInvocationDescriptor: null,
									activeTaskDescriptorIdentity: null,
									activeTaskDescriptorHarness: null,
									resolvedTargetId: null,
									lastResolvedTargetId: r.resolvedTargetId ?? null,
									lastTaskInvocationDescriptor: r.invocationDescriptor ?? null,
									lastTaskDescriptorIdentity: r.descriptorIdentity ?? null,
									lastTaskDescriptorHarness: r.descriptorHarness ?? null,
									...(r.reviewResult
										? { lastReviewResult: r.reviewResult }
										: {}),
									...(safeFailure ? { lastFailure: safeFailure } : {}),
								});
							})
							.catch(() => {});
					}
				},
			},
		});
	} catch (error) {
		queueError = error;
	} finally {
		if (runStoreReady) {
			const failedResults = result
				? result.results.filter(
						(entry) =>
							!entry.success && entry.result !== "route_health_deferred",
					)
				: [];
			const anyFailed = result ? failedResults.length > 0 : true;
			const deferredTaskIds = Array.isArray(result?.deferredTaskIds)
				? result.deferredTaskIds
				: [];
			const failedResult = result?.results.findLast?.(
				(entry) => !entry.success && entry.result !== "route_health_deferred",
			);
			const classifiedQueueError = classifyPreProviderFailure(queueError);
			const checkpointCode =
				typeof queueError?.code === "string" &&
				Object.hasOwn(CHECKPOINT_REMEDIATION_MESSAGES, queueError.code)
					? queueError.code
					: undefined;
			const classifiedFailure = queueError
				? sanitizeFailureMetadata({
						result: "unknown_failure",
						errorKind: classifiedQueueError?.errorKind ?? "unknown_failure",
						diagnosticCode: classifiedQueueError?.diagnosticCode,
						failurePhase:
							classifiedQueueError?.failurePhase ?? "terminal_reconciliation",
						checkpointCode,
						checkpointDimensions: checkpointCode
							? queueError.changedDimensions
							: undefined,
					})
				: sanitizeFailureMetadata(failedResult ?? {});
			// `sanitizeFailureMetadata` returns null for anything it cannot classify,
			// including the `{}` that a missing `failedResult` supplies. Combined with
			// `anyFailed` defaulting to true when the queue produced no result, that
			// wrote a run recorded as `failed` with `lastFailure: null` — 170 of 764
			// historical failures, median 8ms, with no target and no event. A failed
			// run must always carry a reason, even when the only honest reason is
			// that the queue returned nothing and did not throw.
			const failure =
				classifiedFailure ??
				(anyFailed
					? sanitizeFailureMetadata({
							result: "unknown_failure",
							errorKind: "unknown_failure",
							diagnosticCode: result
								? "terminal_without_failure_metadata"
								: "queue_returned_no_result",
							failurePhase: "terminal_reconciliation",
						})
					: null);
			try {
				await eventWriteChain;
				await finalizeRun({
					runId,
					state: anyFailed
						? "failed"
						: deferredTaskIds.length > 0
							? "deferred"
							: "succeeded",
					failure,
					terminalSummary: result
						? {
								totalTasks: result.totalTasks,
								runnableTasks: result.runnableTasks,
								processedTasks: result.processedTasks,
								completedTaskIds: result.completedTaskIds,
								deferredTaskIds,
								failedCount: failedResults.length,
							}
						: {
								totalTasks: null,
								runnableTasks: null,
								processedTasks: null,
								completedTaskIds: null,
								deferredTaskIds: null,
								failedCount: null,
							},
					extraPatch: queueError?.preflightDetail
						? {
								preflightDetail: queueError.preflightDetail,
								...(result?.policyDeferred
									? { policyDeferred: result.policyDeferred }
									: {}),
							}
						: result?.policyDeferred
							? { policyDeferred: result.policyDeferred }
							: {},
					cleanup: async () => {
						if (projectLockOwned) {
							await (
								dependencies.reconcileProjectLockClaims ??
								reconcileProjectLockClaims
							)();
							await releaseProjectLockIfOwnedBy(opts.projectPath, runId);
						}
					},
				});
			} catch (error) {
				report(`dispatch: run-store teardown failed (${error.message})`);
			}
		}
	}
	if (jsonRequested) {
		let envelope;
		try {
			envelope = await buildResultEnvelope(runId, await readRun(runId));
		} catch {
			envelope = await buildLaunchFailureEnvelope({
				preInitialization: {
					type: "contract_failure",
					code: "environment_incomplete",
				},
			});
		}
		console.log(JSON.stringify(envelope));
		const failed = result
			? result.results.some(
					(entry) => !entry.success && entry.result !== "route_health_deferred",
				)
			: true;
		const deferred = Array.isArray(result?.deferredTaskIds)
			? result.deferredTaskIds.length > 0
			: false;
		process.exitCode = queueError || failed ? 1 : deferred ? 6 : 0;
		return {
			runId: envelope.runId,
			error: Boolean(queueError || failed || deferred),
		};
	}
	if (queueError) {
		Object.defineProperty(queueError, "switchyardRunId", {
			value: runId,
			enumerable: false,
		});
		throw queueError;
	}

	const failed = result.results.filter(
		(r) => !r.success && r.result !== "route_health_deferred",
	);
	const deferredCount = result.deferredTaskIds?.length ?? 0;
	report(
		`dispatch: done — ${result.processedTasks}/${result.runnableTasks} runnable processed, ` +
			`${result.completedTaskIds.length} completed, ${failed.length} failed, ${deferredCount} deferred`,
	);
	report(`dispatch: checkpoint ${result.checkpointPath}`);
	process.exitCode = failed.length > 0 ? 1 : deferredCount > 0 ? 6 : 0;
}

function captureHostFingerprint(projectPath) {
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
			resolve(getStateRoot()),
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
	} catch {
		// git unavailable — fingerprint degrades to no-git sentinel
	}
	return `git:${head || "no-head"}:${dirty}`;
}

function prepareRunIdentity(opts) {
	const checkpointPath =
		opts.checkpointPath ?? getCheckpointPath(opts.tasksFilePath);
	const runOptions = normalizeRunOptions({
		maxTasks: opts.maxTasks,
		checkpointPath,
		stopOnFailure: opts.stopOnFailure,
		onlyProviders: opts.onlyProviders,
		excludeProviders: opts.excludeProviders,
		taskIds: opts.taskIds,
		platform: opts.platform,
		dirtyOverlay: opts.dirtyOverlay,
		dirtyOverlayReceiptPath: opts.dirtyOverlayReceiptPath,
		dirtyOverlayReceiptHash: opts.dirtyOverlayReceiptPath
			? readDirtyOverlayReceipt(opts.dirtyOverlayReceiptPath).receiptHash
			: null,
	});
	const projectRevision = getProjectRevision(opts.projectPath);
	const { queueIdentity } = computeQueueIdentityFromFile(
		opts.tasksFilePath,
		projectRevision,
		runOptions,
	);
	return { checkpointPath, projectRevision, runOptions, queueIdentity };
}

function relativeWithin(projectPath, path) {
	const root = realpathSafe(resolve(projectPath));
	const target = resolve(path);
	const parent = realpathSafe(dirname(target));
	const resolved = join(parent, basename(target));
	if (resolved === root) return ".";
	if (!resolved.startsWith(`${root}${sep}`)) return null;
	return relative(root, resolved);
}

function realpathSafe(path) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function prepareDispatchDirtyOverlay(opts, tasks) {
	if (opts.dirtyOverlay !== true) return;
	const checkpointPath =
		opts.checkpointPath ?? getCheckpointPath(opts.tasksFilePath);
	const receiptPath =
		opts.dirtyOverlayReceiptPath ?? `${checkpointPath}.dirty-overlay.json`;
	// A single undeclared task is enough to reach provider allocation inside a
	// workspace seeded with overlay bytes it never scoped, so every task in the
	// queue declares its own paths — an aggregate that happens to be non-empty
	// because some other task declared is not sufficient.
	const undeclared = tasks.find(
		(task) => (task.requiredPaths ?? []).length === 0,
	);
	if (undeclared)
		throw new UsageError(
			`dirty overlay requires exact declared task paths: task ${undeclared.id} declares none`,
		);
	const paths = [...new Set(tasks.flatMap((task) => task.requiredPaths ?? []))];
	if (paths.length === 0)
		throw new UsageError("dirty overlay requires exact declared task paths");
	// The checkpoint and receipt are written during the run. Left unignored
	// inside the project they become untracked strays that the capture's own
	// scope check refuses, so a launch that succeeded would fail every task on
	// revalidation. Refuse here, before either file exists.
	for (const path of [checkpointPath, receiptPath]) {
		const relativePath = relativeWithin(opts.projectPath, path);
		if (relativePath !== null && !ignoredPath(opts.projectPath, relativePath))
			throw new UsageError(
				`dirty overlay checkpoint and receipt must live outside the project or be ignored by it: ${relativePath}`,
			);
	}
	if (existsSync(receiptPath)) {
		let receipt;
		try {
			receipt = readDirtyOverlayReceipt(receiptPath);
		} catch (error) {
			throw new UsageError(`dirty overlay receipt rejected: ${error.message}`);
		}
		// Publication is create-only, so a receipt left over from an earlier
		// capture is reused as-is. Revalidate here: `launch` would otherwise mint
		// identity from a stale hash, exit 0, and hand the detached worker a
		// receipt it rejects — a successful launch followed by a failed run.
		const validated = validateDirtyOverlayReceipt(
			opts.projectPath,
			receipt,
			paths,
		);
		if (!validated.ok)
			throw new UsageError(
				`dirty overlay receipt rejected: ${validated.reason}; remove ${receiptPath} to recapture`,
			);
	} else {
		const receipt = captureDirtyOverlay(opts.projectPath, paths);
		writeDirtyOverlayReceipt(receiptPath, receipt);
	}
	opts.dirtyOverlayReceiptPath = receiptPath;
}

function resolveBootstrapPath() {
	return fileURLToPath(new URL("./worker-bootstrap.mjs", import.meta.url));
}

/**
 * Handle the launch subcommand.
 * @param {string[]} argv arguments after the subcommand
 */
function launchCommands(runId, stateRoot) {
	return {
		statusCommand: `switchyard-dispatch status ${runId} --state-root ${shellQuote(stateRoot)}`,
		resultCommand: `switchyard-dispatch result ${runId} --state-root ${shellQuote(stateRoot)}`,
	};
}

async function buildLaunchFailureEnvelope(context) {
	const {
		runId = null,
		stateRoot = null,
		preInitialization = null,
		preflightDetail = null,
	} = context;
	let run = null;
	if (runId !== null) {
		try {
			run = await readRun(runId);
		} catch {
			// Commands and durable identity are emitted only after this read proves
			// the target actually resolves in the selected state root.
		}
	}
	const durable = run !== null && stateRoot !== null;
	const recoveryTarget =
		preInitialization?.type === "lock_conflict"
			? preInitialization.holderRunId
			: runId;
	const disposition = projectDisposition({
		...(preInitialization ? { preInitialization } : { run }),
		...(durable && recoveryTarget
			? { recoveryCommand: recoveryCommandFor(recoveryTarget) }
			: {}),
		...(durable ? { remediationCommand: remediationCommandFor() } : {}),
		...(run ? { liveness: classifyRunLiveness(run) } : {}),
	});
	return {
		schemaVersion: run?.schemaVersion ?? 2,
		runId: durable ? runId : null,
		state: run?.state ?? "failed",
		queueIdentity: run?.queueIdentity ?? null,
		...(preflightDetail ? { preflightDetail } : {}),
		stateRoot: durable ? stateRoot : null,
		...(durable
			? launchCommands(runId, stateRoot)
			: { statusCommand: null, resultCommand: null }),
		disposition,
	};
}

/** Handle synchronous dispatch, including its content-free JSON surface. */
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
		process.exitCode = error instanceof UsageError ? 2 : 1;
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
		console.log(
			JSON.stringify(
				await buildLaunchFailureEnvelope({
					preInitialization: {
						type: "contract_failure",
						code:
							classifyPreProviderFailure(error)?.diagnosticCode ??
							"environment_incomplete",
					},
					preflightDetail: error.preflightDetail ?? null,
				}),
			),
		);
		process.exitCode = error instanceof UsageError ? 2 : 1;
	}
}

/**
 * Handle detached launch. `--json` changes only the failure surface: legacy
 * success already returns JSON, while legacy failure text and exit codes stay
 * unchanged when the flag is absent.
 */
async function handleLaunch(argv, dependencies = {}) {
	const jsonRequested = argv.includes("--json");
	let opts;
	try {
		opts = parseLaunchArgs(argv);
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
		process.exitCode = error instanceof UsageError ? 2 : 1;
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
					preInitialization,
					preflightDetail: error.preflightDetail ?? null,
				}),
			),
		);
		process.exitCode = error instanceof UsageError ? 2 : 1;
	}
}

// Best-effort event read: a missing/unreadable events.jsonl (e.g. a run
// that hasn't started executing yet) degrades to an empty list rather than
// failing the envelope build.
async function readEventsSafe(runId) {
	try {
		const events = await readEvents(runId);
		Object.defineProperty(events, "evidenceValid", { value: true });
		return events;
	} catch {
		// events may be absent or unreadable
		const events = [];
		Object.defineProperty(events, "evidenceValid", { value: false });
		return events;
	}
}

function recoveryCommandFor(runId) {
	return `switchyard-dispatch recover --run ${runId} --state-root ${shellQuote(getStateRoot())}`;
}

function remediationCommandFor() {
	return `switchyard-dispatch remediate-orphaned-locks --state-root ${shellQuote(getStateRoot())}`;
}

function countCompletedAndFailed(events) {
	let completedCount = 0;
	let failedCount = 0;
	for (const evt of events) {
		if (evt.phase === "execution" && evt.event === "task_completed") {
			completedCount += 1;
		}
		if (evt.phase === "execution" && evt.event === "task_failed") {
			failedCount += 1;
		}
	}
	return { completedCount, failedCount };
}

function shadowEnvelope(run) {
	const shadow = run?.outcomeShadow;
	if (!shadow || typeof shadow !== "object") return null;
	return {
		version: shadow.version ?? 1,
		projection: shadow.projection ?? null,
		parity: shadow.parity ?? null,
		recoveryQueue: Array.isArray(shadow.recoveryQueue)
			? shadow.recoveryQueue
			: [],
	};
}

function sanitizedExecutionFailureEvents(events) {
	const failureFields = [
		"errorKind",
		"reasonCode",
		"reason",
		"artifactRef",
		"diagnosticCode",
		"exitCode",
		"signal",
		"failurePhase",
	];
	return events.filter((event) => {
		if (event?.phase !== "execution" || event?.event !== "task_failed") {
			return false;
		}
		const failure = {};
		for (const field of failureFields) {
			if (event[field] !== undefined) failure[field] = event[field];
		}
		return isPersistentFailureMetadata(failure);
	});
}

// Best-effort checkpoint read, mirroring readEventsSafe above: status/result
// are read-only diagnostic commands, so a checkpoint that's absent (fresh
// run, nothing written yet) or corrupt (loadCheckpoint's fail-loud path —
// appropriate for runQueue's own write path, where silently discarding
// completed-task history would cause a full destructive re-run) must not
// crash the *observation* of a run. It degrades to null, which
// deriveTelemetryFields treats as an empty completed set — the same
// pendingCount an operator would see before any checkpoint existed.
//
// Reads the same checkpoint state `runQueue` itself consults
// (getCheckpointPath(tasksFilePath)) so `pendingCount` reflects tasks
// completed by a prior process on a resumed run, not just this run's own
// event log. Mirrors runQueue's own default-path resolution — dispatch never
// threads a custom `--checkpoint` path through run-store, so the default is
// always the one in effect for a launched run.
function readCheckpointStateForRun(run) {
	try {
		const checkpointPath =
			run.runOptions?.checkpointPath ?? getCheckpointPath(run.tasksFilePath);
		return loadCheckpoint(
			checkpointPath,
			run.tasksFilePath,
			run.queueIdentity
				? {
						queueIdentity: run.queueIdentity,
						runOptions: run.runOptions,
					}
				: null,
		);
	} catch {
		// checkpoint exists but is corrupt/unreadable — degrade rather than
		// failing an otherwise-healthy status/result read
		return null;
	}
}

const QUEUE_DIAGNOSTICS_UNAVAILABLE = Object.freeze({
	selected: { count: 0, reason: "queue_unavailable" },
	runnable: { count: 0, reason: "queue_unavailable" },
	humanGated: { count: 0, reason: "queue_unavailable" },
	nativeGated: { count: 0, reason: "queue_unavailable" },
	dependencyBlocked: { count: 0, reason: "queue_unavailable" },
	externalBlocked: { count: 0, reason: "queue_unavailable" },
	completed: { count: 0, reason: "queue_unavailable" },
});

function readQueueDiagnosticsForRun(run, checkpointState) {
	try {
		const tasks = loadTaskQueue(run.tasksFilePath);
		return deriveQueueDiagnostics(tasks, checkpointState, {
			selectedTaskIds: run.runOptions?.taskIds ?? run.taskIds ?? [],
		});
	} catch {
		// Status/result are observation surfaces. A malformed or unavailable
		// queue must never echo its parser error or arbitrary task content.
		return QUEUE_DIAGNOSTICS_UNAVAILABLE;
	}
}

/**
 * Derive the throughput/telemetry fields shared by buildStatusEnvelope and
 * buildResultEnvelope, so the two envelope builders can't drift on the same
 * underlying aggregate-progress signal.
 *
 * @param {object} run parsed run snapshot
 * @param {Array<object>} events this run's event log (readEventsSafe result)
 * @param {object|null} checkpointState checkpoint state read via
 *   readCheckpointStateForRun; `pendingCount` is derived from its
 *   `completedTaskIds` rather than from `events`, so a resumed run against a
 *   pre-existing checkpoint (tasks completed by a prior process, with no
 *   matching event in this run's own events.jsonl) is still counted
 *   correctly instead of over/under-counting via a flat
 *   `orderedTaskIds.length - events.length` subtraction.
 * @returns {object} shared telemetry fields
 */
function deriveTelemetryFields(run, events, checkpointState) {
	void events;

	const now = Date.now();
	const queueStartedAt = new Date(run.createdAt).getTime();
	const completedIds = new Set(checkpointState?.completedTaskIds ?? []);
	const pendingCount = run.orderedTaskIds.filter(
		(id) => !completedIds.has(id),
	).length;

	return {
		queueStartedAt,
		elapsedMs: now - queueStartedAt,
		totalTaskCount: run.orderedTaskIds.length,
		pendingCount,
		// Single worker processes one task at a time, so "running" is a
		// 0/1 signal keyed off whether a task is currently active.
		runningCount: run.activeTaskId != null ? 1 : 0,
		lastCompletionAt: run.lastCompletionAt ?? null,
		// Before the first completion this falls back to queueStartedAt,
		// overstating elapsed time by launch/lock/verification overhead
		// (typically sub-second to low-single-digit seconds) — negligible
		// against this field's hours-scale purpose.
		elapsedSinceLastCompletionMs:
			now - (run.lastCompletionAt ?? queueStartedAt),
		// Gated on activeTaskId, not activeTaskStartedAt: activeTaskStartedAt
		// is set once at task start and never cleared (onResult's patch nulls
		// activeTaskId/Provider/Model/Deadline but omits it), so gating on it
		// directly would report a stale, ever-growing age after the task
		// completes or the run reaches a terminal state. activeTaskId IS
		// reliably nulled on completion/terminal/crash — same reasoning as
		// runningCount two lines above.
		activeTaskAgeMs:
			run.activeTaskId != null ? now - run.activeTaskStartedAt : null,
		// Display-only: derived from the routed deadline, not a scheduling
		// guarantee. Can go negative if a task runs past its deadline.
		activeTaskRemainingMs:
			run.activeTaskDeadline != null
				? new Date(run.activeTaskDeadline).getTime() - now
				: null,
	};
}

function deriveRetryProjection(checkpointState) {
	return {
		quarantinedTargetIds: Array.isArray(checkpointState?.quarantinedTargetIds)
			? [...checkpointState.quarantinedTargetIds]
			: [],
		retryState: checkpointState?.retryState ?? null,
		retryTransitionId: Number.isInteger(checkpointState?.retryTransitionId)
			? checkpointState.retryTransitionId
			: 0,
	};
}

// Maps a run's routed provider (run.activeTaskProvider) to the binary name
// its CLI actually execs as inside the working container. Most providers'
// CLI binary matches the provider key, but cursor's does not — its package
// is "cursor-agent", not "cursor" — so this must stay an explicit map
// rather than an assumed identity transform.
const PROVIDER_BINARY_NAMES = {
	claude: "claude",
	codex: "codex",
	agy: "agy",
	cursor: "cursor-agent",
	copilot: "copilot",
	opencode: "opencode",
};

/**
 * Build the execution backend used to inspect/reclaim a run's workspace,
 * mirroring runner/index.mjs's createQueueBackend construction so a later,
 * separate `status`/`result`/`recover` process reconstructs the same backend
 * shape the worker did.
 * @returns {import("../lifecycle/execution-backend.mjs").ExecutionBackend}
 */
function executionBackendForRun() {
	return createExecutionBackend({
		...hostBackendDefaults(),
		// This is the process that reclaims a dead worker's clones, so it is the
		// one that most needs to read the sidecars a live worker wrote.
		snapshotSidecarRoot: getVmAdmissionRoot(),
	});
}

/**
 * Match one `ps -axo pid=,command=` output line against a target binary
 * name. The format is "<pid><whitespace><args...>" where the args column is
 * itself whitespace-separated (argv[0] is its first token); this compares
 * the basename of that first token so a fully-qualified path (e.g.
 * "/usr/local/bin/claude") still matches "claude".
 * @param {string} line one line of guest `ps` output
 * @param {string} binaryName target executable basename
 * @returns {boolean}
 */
function lineMatchesBinary(line, binaryName) {
	const match = line.trim().match(/^\d+\s+(\S+)/);
	if (!match) return false;
	const executable = match[1];
	const base = executable.split("/").pop();
	return base === binaryName;
}

/**
 * Best-effort presence probe for whether the provider CLI routed to this
 * run (run.activeTaskProvider) is actually executing inside the run's
 * workspace: inspect the workspace through the execution backend, catch any
 * failure, and degrade to null rather than throwing — a diagnostic nicety
 * surfaced via the providerProcessDetected envelope field must never crash
 * or indefinitely block a status/result read.
 *
 * Only the derived boolean crosses into the envelope — raw guest `ps`
 * output (which can include other processes' full command lines) is never
 * exposed, since that would be a potential information leak, not just a
 * style choice.
 *
 * Self-gates on run.state === "running" as its first check (in addition to
 * the identical ternary at each call site, mirroring workerLive) so the
 * function is safe to call unconditionally and never shells out at all —
 * not even attempting a probe whose result gets discarded — for a
 * non-running run.
 *
 * @param {object} run parsed run snapshot
 * @param {object} [deps] Injectable dependencies (tests only)
 * @param {import("../lifecycle/execution-backend.mjs").ExecutionBackend} [deps.executionBackend]
 *   Defaults to a fresh ParallelsExecutionBackend
 * @param {(command: string, args: string[], options: object) => Buffer | string} [deps.execFn]
 *   Compatibility injection: routed into a ParallelsExecutionBackend's own
 *   execFn seam instead of executionBackend when supplied.
 * @returns {boolean|null} true/false once the probe runs successfully;
 *   null if the run isn't currently running, isn't routed to a
 *   workspace/provider yet, the provider has no known binary mapping, or
 *   the probe itself failed
 */
function probeProviderProcess(run, { executionBackend, execFn } = {}) {
	if (run.state !== "running") return null;

	const { workingContainerName, activeTaskProvider } = run;
	if (!workingContainerName || !activeTaskProvider) return null;

	const binaryName = PROVIDER_BINARY_NAMES[activeTaskProvider];
	if (!binaryName) return null;

	try {
		const backend = execFn
			? createExecutionBackend({ execFn })
			: (executionBackend ?? executionBackendForRun());
		const output = backend.inspectProcess(workingContainerName).toString();
		return output
			.split("\n")
			.some((line) => lineMatchesBinary(line, binaryName));
	} catch {
		// VM unreachable, workspace gone/mid-restart, the guest ps call
		// erroring, or a timeout tripped — degrade to null rather than throw.
		return null;
	}
}

async function buildStatusEnvelope(runId, run) {
	const events = await readEventsSafe(runId);
	const outcomeProjection = projectOutcomeReader({ run, events });
	const projectedRun = applyOutcomeProjection(run, outcomeProjection);
	const { completedCount, failedCount } = countCompletedAndFailed(events);
	const checkpointState = readCheckpointStateForRun(run);
	const telemetry = deriveTelemetryFields(run, events, checkpointState);
	const retryProjection = deriveRetryProjection(checkpointState);
	const queueDiagnostics = readQueueDiagnosticsForRun(run, checkpointState);
	const liveness = classifyRunLiveness(run);
	const disposition = projectDisposition({
		run: projectedRun,
		outcomeProjection,
		checkpoint: checkpointState,
		events: sanitizedExecutionFailureEvents(events),
		liveness,
		recoveryCommand: recoveryCommandFor(runId),
		remediationCommand: remediationCommandFor(),
		optionalEvidenceValid:
			events.evidenceValid !== false && checkpointState !== null,
	});
	const outcomeShadow = shadowEnvelope(run);
	if (outcomeShadow) disposition.outcomeShadow = outcomeShadow;
	return {
		schemaVersion: run.schemaVersion ?? 1,
		runId: run.runId,
		queueIdentity: run.queueIdentity ?? null,
		...(sanitizeQueuePreflightDetail(run.preflightDetail)
			? { preflightDetail: sanitizeQueuePreflightDetail(run.preflightDetail) }
			: {}),
		state: projectedRun.state,
		cleanupState: run.cleanupState,
		// Liveness derived from a signal-0 probe of the recorded worker pid
		// (see isWorkerLive), so an operator doesn't have to shell out to
		// `ps` to tell active work from a stalled/ghost run.
		workerLive: run.state === "running" ? liveness === "live" : null,
		// Presence of the routed provider's CLI process inside the working
		// VM workspace (see probeProviderProcess) — same conditional-null-when-
		// not-running shape as workerLive, and same "skip the shell-out
		// entirely when not running" rule.
		providerProcessDetected:
			run.state === "running"
				? probeProviderProcess(run, {
						executionBackend: executionBackendForRun(),
					})
				: null,
		activeTaskId: run.state === "running" ? (run.activeTaskId ?? null) : null,
		activeTaskProvider:
			run.state === "running" ? (run.activeTaskProvider ?? null) : null,
		activeTaskModel:
			run.state === "running" ? (run.activeTaskModel ?? null) : null,
		activeTaskDeadline:
			run.state === "running" ? (run.activeTaskDeadline ?? null) : null,
		activeTaskElapsedMs:
			run.state === "running" && run.activeTaskId != null
				? (run.activeTaskElapsedMs ?? 0)
				: null,
		activeTaskHeartbeatAt:
			run.state === "running" && run.activeTaskId != null
				? (run.activeTaskHeartbeatAt ?? null)
				: null,
		activeTaskProcessPhase:
			run.state === "running" && run.activeTaskId != null
				? (run.activeTaskProcessPhase ?? null)
				: null,
		telemetryWriteFailures: run.telemetryWriteFailures ?? 0,
		lastTelemetryWriteFailure: run.lastTelemetryWriteFailure ?? null,
		resolvedTargetId: run.resolvedTargetId ?? null,
		activeTaskInvocationDescriptor:
			run.state === "running"
				? (run.activeTaskInvocationDescriptor ?? null)
				: null,
		activeTaskDescriptorIdentity:
			run.state === "running"
				? (run.activeTaskDescriptorIdentity ?? null)
				: null,
		activeTaskDescriptorHarness:
			run.state === "running"
				? (run.activeTaskDescriptorHarness ?? null)
				: null,
		lastTaskInvocationDescriptor: run.lastTaskInvocationDescriptor ?? null,
		lastTaskDescriptorIdentity: run.lastTaskDescriptorIdentity ?? null,
		lastTaskDescriptorHarness: run.lastTaskDescriptorHarness ?? null,
		lastResolvedTargetId: run.lastResolvedTargetId ?? null,
		dispatchContractVersion: run.dispatchContractVersion ?? null,
		snapshotStatus: run.snapshotStatus ?? null,
		snapshotMtime: run.snapshotMtime ?? null,
		snapshotAgeMsAtRoute: run.snapshotAgeMsAtRoute ?? null,
		completedCount:
			outcomeProjection.reader === "reducer"
				? (outcomeProjection.taskCounters?.completed ?? completedCount)
				: completedCount,
		failedCount:
			outcomeProjection.reader === "reducer"
				? (outcomeProjection.taskCounters?.failed ?? failedCount)
				: failedCount,
		// Reconciled against the same artifacts channel `result` reports, so the
		// two envelopes cannot disagree about whether a failure has an artifact.
		lastFailure: reconcileFailureArtifactRef(
			run.lastFailure ?? null,
			await listArtifactRefs(runId),
		),
		lastReviewResult: run.lastReviewResult ?? null,
		...retryProjection,
		queueDiagnostics,
		startedAt: run.startedAt ?? null,
		finishedAt: run.finishedAt ?? null,
		updatedAt: run.updatedAt,
		disposition,
		outcomeShadow,
		outcomeProjection,
		...telemetry,
	};
}

/**
 * Drop a `lastFailure.artifactRef` the artifacts channel cannot resolve.
 *
 * The ref and the channel are written by two different paths: the ref is
 * derived unconditionally from the task id, while the copy into the run's
 * `artifacts/` directory is best-effort and swallows its own failure. When the
 * copy loses, the operator sees a reference in `lastFailure` that is absent
 * from `artifactRefs` and has no way to tell a lost artifact from a bad
 * pointer. Observed on run eab7d23c (2026-08-25): `artifactRef` was set while
 * `artifactRefs` was `[]`. Report only what the run can actually produce.
 * @param {object|null} lastFailure
 * @param {string[]} artifactRefs refs the artifacts channel actually lists
 * @returns {object|null}
 */
function reconcileFailureArtifactRef(lastFailure, artifactRefs) {
	if (!lastFailure || typeof lastFailure !== "object") {
		return lastFailure ?? null;
	}
	if (typeof lastFailure.artifactRef !== "string") return lastFailure;
	if (artifactRefs.includes(lastFailure.artifactRef)) return lastFailure;
	const { artifactRef: _unresolvable, ...rest } = lastFailure;
	return rest;
}

function projectFailureRemedy(lastFailure) {
	if (
		!lastFailure ||
		typeof lastFailure !== "object" ||
		typeof lastFailure.checkpointCode !== "string" ||
		!Object.hasOwn(CHECKPOINT_REMEDIATION_MESSAGES, lastFailure.checkpointCode)
	)
		return lastFailure;
	return {
		...lastFailure,
		reason: checkpointRemediation(lastFailure.checkpointCode, {
			dimensions: lastFailure.checkpointDimensions,
		}),
	};
}

async function listArtifactRefs(runId) {
	const artifactsDir = resolve(getRunRoot(runId), "artifacts");
	try {
		const entries = await readdir(artifactsDir, { withFileTypes: true });
		return entries
			.filter((e) => e.isFile())
			.map(
				(e) =>
					`artifact:${createHash("sha256")
						.update(e.name)
						.digest("hex")
						.slice(0, 24)}`,
			);
	} catch {
		return [];
	}
}

async function buildResultEnvelope(runId, run) {
	const events = await readEventsSafe(runId);
	const outcomeProjection = projectOutcomeReader({ run, events });
	const projectedRun = applyOutcomeProjection(run, outcomeProjection);
	const { completedCount, failedCount } = countCompletedAndFailed(events);
	const checkpointState = readCheckpointStateForRun(run);
	const telemetry = deriveTelemetryFields(run, events, checkpointState);
	const retryProjection = deriveRetryProjection(checkpointState);
	const queueDiagnostics = readQueueDiagnosticsForRun(run, checkpointState);
	const artifactRefs = await listArtifactRefs(runId);
	const liveness = classifyRunLiveness(run);
	const disposition = projectDisposition({
		run: projectedRun,
		outcomeProjection,
		checkpoint: checkpointState,
		events: sanitizedExecutionFailureEvents(events),
		liveness,
		recoveryCommand: recoveryCommandFor(runId),
		remediationCommand: remediationCommandFor(),
		optionalEvidenceValid:
			events.evidenceValid !== false && checkpointState !== null,
	});
	const outcomeShadow = shadowEnvelope(run);
	if (outcomeShadow) disposition.outcomeShadow = outcomeShadow;
	return {
		schemaVersion: run.schemaVersion ?? 1,
		runId: run.runId,
		queueIdentity: run.queueIdentity ?? null,
		...(sanitizeQueuePreflightDetail(run.preflightDetail)
			? { preflightDetail: sanitizeQueuePreflightDetail(run.preflightDetail) }
			: {}),
		state: projectedRun.state,
		cleanupState: run.cleanupState,
		workerLive: run.state === "running" ? liveness === "live" : null,
		providerProcessDetected:
			run.state === "running"
				? probeProviderProcess(run, {
						executionBackend: executionBackendForRun(),
					})
				: null,
		activeTaskId: run.state === "running" ? (run.activeTaskId ?? null) : null,
		activeTaskProvider:
			run.state === "running" ? (run.activeTaskProvider ?? null) : null,
		activeTaskModel:
			run.state === "running" ? (run.activeTaskModel ?? null) : null,
		activeTaskDeadline:
			run.state === "running" ? (run.activeTaskDeadline ?? null) : null,
		activeTaskElapsedMs:
			run.state === "running" && run.activeTaskId != null
				? (run.activeTaskElapsedMs ?? 0)
				: null,
		activeTaskHeartbeatAt:
			run.state === "running" && run.activeTaskId != null
				? (run.activeTaskHeartbeatAt ?? null)
				: null,
		activeTaskProcessPhase:
			run.state === "running" && run.activeTaskId != null
				? (run.activeTaskProcessPhase ?? null)
				: null,
		telemetryWriteFailures: run.telemetryWriteFailures ?? 0,
		lastTelemetryWriteFailure: run.lastTelemetryWriteFailure ?? null,
		resolvedTargetId: run.resolvedTargetId ?? null,
		activeTaskInvocationDescriptor:
			run.state === "running"
				? (run.activeTaskInvocationDescriptor ?? null)
				: null,
		activeTaskDescriptorIdentity:
			run.state === "running"
				? (run.activeTaskDescriptorIdentity ?? null)
				: null,
		activeTaskDescriptorHarness:
			run.state === "running"
				? (run.activeTaskDescriptorHarness ?? null)
				: null,
		lastTaskInvocationDescriptor: run.lastTaskInvocationDescriptor ?? null,
		lastTaskDescriptorIdentity: run.lastTaskDescriptorIdentity ?? null,
		lastTaskDescriptorHarness: run.lastTaskDescriptorHarness ?? null,
		lastResolvedTargetId: run.lastResolvedTargetId ?? null,
		dispatchContractVersion: run.dispatchContractVersion ?? null,
		snapshotStatus: run.snapshotStatus ?? null,
		snapshotMtime: run.snapshotMtime ?? null,
		snapshotAgeMsAtRoute: run.snapshotAgeMsAtRoute ?? null,
		completedCount:
			outcomeProjection.reader === "reducer"
				? (outcomeProjection.taskCounters?.completed ?? completedCount)
				: completedCount,
		failedCount:
			outcomeProjection.reader === "reducer"
				? (outcomeProjection.taskCounters?.failed ?? failedCount)
				: failedCount,
		lastFailure: projectFailureRemedy(
			reconcileFailureArtifactRef(run.lastFailure ?? null, artifactRefs),
		),
		lastReviewResult: run.lastReviewResult ?? null,
		...retryProjection,
		queueDiagnostics,
		startedAt: run.startedAt ?? null,
		finishedAt: run.finishedAt ?? null,
		updatedAt: run.updatedAt,
		terminalSummary: {
			...(run.terminalSummary ?? {}),
			outcome: projectTerminalOutcome(projectedRun, outcomeProjection),
		},
		artifactRefs,
		disposition,
		outcomeShadow,
		outcomeProjection,
		...telemetry,
	};
}

function isTerminalState(state) {
	return state === "succeeded" || state === "failed" || state === "deferred";
}

function isCleanupComplete(cleanupState) {
	return cleanupState === "complete";
}

/**
 * Handle the status subcommand.
 * @param {string[]} argv arguments after the subcommand
 */
async function handleStatus(argv) {
	const { help, runId, json: _json, stateRoot } = parseStatusArgs(argv);

	if (help) {
		console.log(USAGE_STATUS);
		return;
	}

	if (!runId) {
		throw new UsageError("missing <run-id> positional argument");
	}

	return withStateRoot(stateRoot, async () => {
		let run;
		try {
			run = await readRun(runId);
		} catch (error) {
			if (error instanceof SchemaError || error?.name === "SchemaError") {
				console.error(
					`status: corrupt or unsupported state for ${runId}: ${error.message}`,
				);
				process.exitCode = 4;
				return;
			}
			if (error.message?.includes("not found")) {
				console.error(`status: run not found: ${runId}`);
				process.exitCode = 3;
				return;
			}
			throw error;
		}

		const envelope = await buildStatusEnvelope(runId, run);
		console.log(JSON.stringify(envelope));
		process.exitCode = 0;
	});
}

/**
 * Handle the result subcommand.
 * @param {string[]} argv arguments after the subcommand
 */
async function handleResult(argv) {
	const { help, runId, json: _json, stateRoot } = parseResultArgs(argv);

	if (help) {
		console.log(USAGE_RESULT);
		return;
	}

	if (!runId) {
		throw new UsageError("missing <run-id> positional argument");
	}

	return withStateRoot(stateRoot, async () => {
		let run;
		try {
			run = await readRun(runId);
		} catch (error) {
			if (error instanceof SchemaError || error?.name === "SchemaError") {
				console.error(
					`result: corrupt or unsupported state for ${runId}: ${error.message}`,
				);
				process.exitCode = 4;
				return;
			}
			if (error.message?.includes("not found")) {
				console.error(`result: run not found: ${runId}`);
				process.exitCode = 3;
				return;
			}
			throw error;
		}

		if (!isTerminalState(run.state)) {
			console.error(
				`result: run ${runId} is not terminal (state: ${run.state})`,
			);
			process.exitCode = 5;
			return;
		}

		const envelope = await buildResultEnvelope(runId, run);
		console.log(JSON.stringify(envelope));

		if (run.state === "succeeded" && isCleanupComplete(run.cleanupState)) {
			process.exitCode = 0;
		} else if (
			run.state === "deferred" &&
			isCleanupComplete(run.cleanupState)
		) {
			process.exitCode = 6;
		} else {
			process.exitCode = 1;
		}
	});
}

async function resolveIsRunDead(runId, dependencies) {
	const readRunFn = dependencies.readRun ?? readRun;
	let run;
	try {
		run = await readRunFn(runId);
	} catch {
		// run record not found => demonstrably dead (its container is an orphan).
		return true;
	}

	const classifier = dependencies.classifyRunLiveness ?? classifyRunLiveness;
	const options = dependencies.isWorkerLive
		? { probePid: () => (dependencies.isWorkerLive(run) ? "live" : "dead") }
		: undefined;
	const liveness = classifier(run, options);
	return liveness === "terminal_clean" || liveness === "dead";
}

/**
 * Release stale project locks for runs that are dead or terminal.
 *
 * The worker releases its own project lock on every terminal path, but a worker
 * that crashes hard (e.g. process.exit from a fatal handler) can bypass that
 * cleanup. `recover` is the safety net: for each candidate run whose worker is
 * gone (terminal state, or a running state with no live worker), release the
 * project lock so the project is not blocked forever. Runs whose run.json is
 * unreadable are skipped — without a projectPath there is no lock to key on.
 *
 * Release is ownership-checked (`releaseProjectLockIfOwnedBy`), not a blind
 * unlink by path: a lock is keyed by project path only, so a stale candidate
 * whose lock was already superseded by a newer, currently-active run against
 * the same project must never have that active run's lock pulled out from
 * under it.
 *
 * @param {string[]} candidateIds run ids to consider
 * @param {object} dependencies optional injected readRun/releaseProjectLockIfOwnedBy
 * @returns {Promise<string[]>} run ids whose project lock was released
 */
async function releaseStaleProjectLocks(candidateIds, dependencies = {}) {
	const readRunFn = dependencies.readRun ?? readRun;
	const releaseFn =
		dependencies.releaseProjectLockIfOwnedBy ?? releaseProjectLockIfOwnedBy;
	const released = [];
	for (const rid of candidateIds) {
		let run;
		try {
			run = await readRunFn(rid);
		} catch {
			// run.json missing/unreadable — no projectPath to key the lock on
			continue;
		}
		if (run.cleanupState === "failed") continue;
		const classifier = dependencies.classifyRunLiveness ?? classifyRunLiveness;
		const options = dependencies.isWorkerLive
			? { probePid: () => (dependencies.isWorkerLive(run) ? "live" : "dead") }
			: undefined;
		const liveness = classifier(run, options);
		if (liveness === "terminal_clean" || liveness === "dead") {
			try {
				const didRelease = await releaseFn(run.projectPath, rid);
				if (didRelease) released.push(rid);
			} catch {
				// unlink failure is non-fatal; the run's VM recovery still ran
			}
		}
	}
	return released;
}

function recoveryLiveness(run, dependencies) {
	const classifier = dependencies.classifyRunLiveness ?? classifyRunLiveness;
	const options = dependencies.isWorkerLive
		? { probePid: () => (dependencies.isWorkerLive(run) ? "live" : "dead") }
		: undefined;
	return classifier(run, options);
}

function managedIdentity(entry) {
	if (
		typeof entry?.uuid !== "string" ||
		typeof entry?.name !== "string" ||
		typeof entry?.runId !== "string" ||
		!Number.isInteger(entry?.creatorPid)
	)
		return null;
	return JSON.stringify([
		entry.uuid,
		entry.name,
		entry.runId,
		entry.creatorPid,
	]);
}

const RECOVERY_SKIP_REASONS = new Set([
	"recovery_evidence_missing",
	"creator-birth-unverified",
	"ineligible",
	"identity-or-eligibility-changed",
	"creator-birth-changed-before-delete",
]);

function closedRecoverySkipReason(value) {
	return RECOVERY_SKIP_REASONS.has(value) ? value : "recovery_evidence_changed";
}

async function assessRecoveryEntry(entry, dependencies, projectPath) {
	const identity = managedIdentity(entry);
	if (identity === null)
		return {
			eligible: false,
			liveness: "unknown",
			reason: "identity_malformed",
		};
	if (typeof projectPath !== "string")
		return {
			eligible: false,
			liveness: "unknown",
			reason: "project_identity_unknown",
		};
	const readRunFn = dependencies.readRun ?? readRun;
	let run;
	try {
		run = await readRunFn(entry.runId);
	} catch {
		return { eligible: false, liveness: "unknown", reason: "run_missing" };
	}
	if (run?.runId !== entry.runId)
		return {
			eligible: false,
			liveness: "unknown",
			reason: "run_identity_mismatch",
		};
	if (
		typeof run.projectPath !== "string" ||
		resolve(run.projectPath) !== resolve(projectPath)
	)
		return {
			eligible: false,
			liveness: "unknown",
			reason: "project_identity_mismatch",
		};
	if (run.cleanupState === "failed")
		return { eligible: false, liveness: "unknown", reason: "cleanup_failed" };
	const liveness = recoveryLiveness(run, dependencies);
	if (liveness === "terminal_clean" || liveness === "dead") {
		const canonicalRunDigest = createHash("sha256")
			.update(JSON.stringify(run))
			.digest("hex");
		const ownershipContext = {
			resourceRoot: join(getRunRoot(run.runId), "resources"),
			runId: run.runId,
			projectRoot: resolve(run.projectPath),
			creatorPid: entry.creatorPid,
		};
		return {
			eligible: true,
			liveness,
			reason: "stale_owned_resource",
			ownershipContext,
			canonicalRunDigest,
			proof: JSON.stringify([
				identity,
				run.runId,
				resolve(run.projectPath),
				ownershipContext.resourceRoot,
				entry.creatorPid,
				liveness,
				canonicalRunDigest,
			]),
		};
	}
	return {
		eligible: false,
		liveness,
		reason:
			liveness === "live"
				? "live_run"
				: liveness === "startup_grace"
					? "startup_grace"
					: "liveness_unknown",
	};
}

function recoveryEntryIsEligibleAtMutation(
	entry,
	dependencies,
	ownershipContext,
	canonicalRunDigest,
) {
	if (
		managedIdentity(entry) === null ||
		entry.runId !== ownershipContext.runId ||
		entry.creatorPid !== ownershipContext.creatorPid ||
		entry.ownership?.resourceRoot !== ownershipContext.resourceRoot ||
		entry.ownership?.projectRoot !== ownershipContext.projectRoot ||
		entry.ownership?.runId !== ownershipContext.runId ||
		entry.ownership?.creatorPid !== ownershipContext.creatorPid
	)
		return false;
	let run;
	try {
		run = JSON.parse(
			readFileSync(join(getRunRoot(entry.runId), "run.json"), "utf8"),
		);
	} catch {
		return false;
	}
	// `canonicalRunDigest` came from readRun's complete schema validation at the
	// last async boundary. Exact binding rejects every replacement, including a
	// parseable object that this local subset of identity checks would accept.
	if (
		createHash("sha256").update(JSON.stringify(run)).digest("hex") !==
		canonicalRunDigest
	)
		return false;
	if (
		!run ||
		typeof run !== "object" ||
		Array.isArray(run) ||
		run.runId !== entry.runId ||
		typeof run.projectPath !== "string" ||
		resolve(run.projectPath) !== ownershipContext.projectRoot ||
		run.cleanupState === "failed"
	)
		return false;
	const liveness = recoveryLiveness(run, dependencies);
	return liveness === "terminal_clean" || liveness === "dead";
}

function emptyReclaimResult() {
	return { reclaimed: [], skippedSnapshots: [], errors: [] };
}

async function reclaimManagedEntries({ managed, dependencies, projectPath }) {
	const executionBackend = recoveryExecutionBackend(dependencies);
	const reclaim =
		dependencies.reclaim ?? ((opts) => executionBackend.reclaim(opts));
	const combined = emptyReclaimResult();
	const eligibleRunIds = new Set();
	const candidates = [];
	let invoked = false;
	for (const entry of managed) {
		const first = await assessRecoveryEntry(entry, dependencies, projectPath);
		if (!first.eligible) {
			candidates.push({
				entry,
				disposition: "preserved",
				reason: first.reason,
			});
			continue;
		}
		// Re-read authoritative run/liveness evidence at the last asynchronous
		// boundary before the synchronous backend performs its own VM, creator,
		// ownership-record, and eligibility checks immediately before mutation.
		const final = await assessRecoveryEntry(entry, dependencies, projectPath);
		if (!final.eligible || final.proof !== first.proof) {
			candidates.push({
				entry,
				disposition: "preserved",
				reason: final.eligible ? "recovery_evidence_changed" : final.reason,
			});
			continue;
		}
		const identity = managedIdentity(entry);
		invoked = true;
		eligibleRunIds.add(entry.runId);
		try {
			const ownershipContext = final.ownershipContext;
			const result = reclaim({
				dryRun: false,
				ownershipContext,
				eligibility: (candidate) => {
					if (managedIdentity(candidate) !== identity) return false;
					if (candidate.recoveryPhase !== "pre_mutation") return true;
					return recoveryEntryIsEligibleAtMutation(
						candidate,
						dependencies,
						ownershipContext,
						final.canonicalRunDigest,
					);
				},
			});
			combined.reclaimed.push(...(result.reclaimed ?? []));
			combined.skippedSnapshots.push(...(result.skippedSnapshots ?? []));
			combined.errors.push(...(result.errors ?? []));
			const reclaimed = (result.reclaimed ?? []).some(
				(candidate) =>
					candidate?.uuid === entry.uuid && candidate?.name === entry.name,
			);
			const skipped = (result.skipped ?? []).find(
				(candidate) => managedIdentity(candidate) === identity,
			);
			candidates.push({
				entry,
				disposition: reclaimed ? "reclaimed" : "preserved",
				reason: reclaimed
					? "stale_owned_resource"
					: closedRecoverySkipReason(skipped?.reason),
			});
		} catch {
			combined.errors.push({
				name: entry.name,
				reason: "managed_reclaim_failed",
			});
			candidates.push({
				entry,
				disposition: "preserved",
				reason: "managed_reclaim_failed",
			});
		}
	}
	if (!invoked) {
		const result = reclaim({ dryRun: false, eligibility: () => false });
		combined.errors.push(...(result.errors ?? []));
	}
	return { result: combined, eligibleRunIds, candidates };
}

async function auditKnownAllocationIntents({
	stateRoot,
	runId = null,
	managed,
	dependencies,
	executionBackend,
}) {
	let runIds;
	if (runId) {
		runIds = [runId];
	} else {
		try {
			runIds = (await readdir(join(stateRoot, "runs"), { withFileTypes: true }))
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort();
		} catch {
			runIds = [];
		}
	}
	const readRunFn = dependencies.readRun ?? readRun;
	const knownResourceRoots = [];
	for (const candidateRunId of runIds) {
		const descriptor = {
			resourceRoot: join(stateRoot, "runs", candidateRunId, "resources"),
			runId: candidateRunId,
			runRecordStatus: "missing",
			projectPath: null,
			cleanupState: null,
			liveness: "unknown",
		};
		try {
			const run = await readRunFn(candidateRunId);
			if (
				run?.runId === candidateRunId &&
				typeof run.projectPath === "string"
			) {
				descriptor.runRecordStatus = "valid";
				descriptor.projectPath = run.projectPath;
				descriptor.cleanupState = run.cleanupState ?? null;
				descriptor.liveness = recoveryLiveness(run, dependencies);
			} else {
				descriptor.runRecordStatus = "unknown";
			}
		} catch (error) {
			descriptor.runRecordStatus =
				error?.code === "ENOENT" ? "missing" : "unknown";
		}
		knownResourceRoots.push(descriptor);
	}
	const audit =
		dependencies.auditAllocationIntents ??
		((options) => executionBackend.auditAllocationIntents(options));
	try {
		return audit({ knownResourceRoots, managed });
	} catch {
		return [
			{
				file: null,
				runId,
				vmName: null,
				classification: "unknown",
				reason: "allocation_audit_unavailable",
			},
		];
	}
}

async function canonicalRecoveryProject(managed, dependencies) {
	const readRunFn = dependencies.readRun ?? readRun;
	const projects = new Set();
	for (const entry of managed) {
		if (managedIdentity(entry) === null) continue;
		try {
			const run = await readRunFn(entry.runId);
			if (run?.runId === entry.runId && typeof run.projectPath === "string") {
				projects.add(run.projectPath);
			}
		} catch {
			// Missing or malformed records contribute no destruction authority.
		}
	}
	return projects.size === 1 ? [...projects][0] : null;
}

/**
 * Build the execution backend a recovery-path caller (sweep or `recover`)
 * inspects/reclaims managed VMs through. Recovery requires the exact VM and
 * host-owned resource identity, the current authoritative run/project record
 * and liveness/cleanup eligibility, plus fresh host process-birth proof.
 * @param {object} [dependencies]
 * @returns {import("../lifecycle/parallels-execution-backend.mjs").ParallelsExecutionBackend}
 */
function recoveryExecutionBackend(dependencies = {}) {
	return dependencies.executionBackend ?? executionBackendForRun();
}

/**
 * Best-effort reap of leaked managed VMs whose creator process is dead —
 * the reusable core of the no-runId `recover` path. Called as a
 * pre-dispatch sweep (Piece C of the leak-recovery loop) so every dispatch
 * self-heals the previous run's leaks before creating its own workspace.
 * @param {object} [dependencies]
 * @returns {Promise<{vmsReclaimed:number,
 *   unreclaimedSnapshots:Array<{name:string, uuid:string, reason:string}>,
 *   errors:string[], projectLocksReleased:number}>}
 */
async function sweepManagedOrphans(dependencies = {}) {
	const executionBackend = recoveryExecutionBackend(dependencies);
	const listManaged =
		dependencies.listManaged ?? (() => executionBackend.listManaged());
	const currentProjectPath = dependencies.projectPath ?? null;
	let managed = [];
	const errors = [];
	try {
		managed = listManaged();
	} catch {
		errors.push("managed_inventory_unavailable");
	}
	let result = emptyReclaimResult();
	let eligibleRunIds = new Set();
	try {
		({ result, eligibleRunIds } = await reclaimManagedEntries({
			managed,
			dependencies,
			projectPath: currentProjectPath,
		}));
	} catch {
		errors.push("managed_reclaim_unavailable");
	}

	const candidateIds = [...eligibleRunIds];

	const targeted = await releaseStaleProjectLocks(candidateIds, dependencies);
	const direct = await (
		dependencies.releaseOrphanedProjectLocks ?? releaseOrphanedProjectLocks
	)();
	const claims = await (
		dependencies.reconcileProjectLockClaims ?? reconcileProjectLockClaims
	)();
	const projectLocksReleased = new Set([...targeted, ...direct, ...claims])
		.size;

	return {
		vmsReclaimed: result.reclaimed.length,
		// A reclaimed VM whose sidecar was lost leaves parent snapshots on the
		// golden that this code may never delete (see reclaim()). That residue
		// is the one INV-3 leak the sweep cannot fix, so it has to leave the
		// sweep as a fact rather than dying inside it.
		unreclaimedSnapshots: result.skippedSnapshots ?? [],
		errors: [...errors, ...result.errors.map((e) => `${e.name}: ${e.reason}`)],
		projectLocksReleased,
	};
}

/**
 * Handle the recover subcommand. With no `--run`, sweeps every managed VM
 * whose creator process is dead (same liveness rule as sweepManagedOrphans).
 * With `--run <run-id>`, limits recovery to that run while retaining the same
 * ownership and liveness proof required by unattended recovery.
 * @param {string[]} argv arguments after the subcommand
 */
async function handleRecover(argv, dependencies = {}) {
	const { help, runId, stateRoot } = parseRecoverArgs(argv);

	if (help) {
		console.log(USAGE_RECOVER);
		return;
	}

	const effectiveStateRoot = stateRoot ?? getStateRoot();
	return withStateRoot(effectiveStateRoot, async () => {
		const executionBackend = recoveryExecutionBackend(dependencies);
		const listManaged =
			dependencies.listManaged ?? (() => executionBackend.listManaged());
		let managed = [];
		let inventoryErrors = [];
		try {
			managed = listManaged();
		} catch {
			inventoryErrors = ["managed_inventory_unavailable"];
		}
		const candidateIds = managed.map((entry) => entry.runId).filter(Boolean);

		let reclaimedCount = 0;
		const errors = [...inventoryErrors];
		let unreclaimedSnapshots = [];
		let candidateResults = [];
		let recoveredByFinalizer = false;
		let projectLockReleasedByFinalizer = false;
		if (runId) {
			let recoveryRun = null;
			try {
				recoveryRun = await (dependencies.readRun ?? readRun)(runId);
			} catch {
				// Missing run evidence never authorizes VM destruction.
			}
			const target = managed.find((entry) => entry.runId === runId);
			const recoveryRunMatchesTarget =
				recoveryRun?.runId === runId &&
				typeof recoveryRun.projectPath === "string";
			const liveness = recoveryRunMatchesTarget
				? recoveryLiveness(recoveryRun, dependencies)
				: "unknown";
			const reclaimTarget = async () => {
				if (!target || !recoveryRunMatchesTarget) return false;
				const targetDependencies =
					typeof dependencies.destroy === "function" &&
					typeof dependencies.reclaim !== "function"
						? {
								...dependencies,
								reclaim: ({ eligibility }) => {
									if (!eligibility(target)) return emptyReclaimResult();
									dependencies.destroy(target);
									return {
										...emptyReclaimResult(),
										reclaimed: [target],
									};
								},
							}
						: dependencies;
				const { result, candidates } = await reclaimManagedEntries({
					managed: [target],
					dependencies: targetDependencies,
					projectPath: recoveryRun.projectPath,
				});
				candidateResults = candidates;
				const reclaimed = result.reclaimed.some(
					(entry) => entry.uuid === target.uuid && entry.name === target.name,
				);
				if (reclaimed) reclaimedCount = 1;
				unreclaimedSnapshots.push(...(result.skippedSnapshots ?? []));
				errors.push(
					...(result.errors ?? []).map(
						(error) => `${error.name}: ${error.reason}`,
					),
				);
				return reclaimed;
			};
			if (
				recoveryRunMatchesTarget &&
				liveness === "dead" &&
				!isTerminalState(recoveryRun.state)
			) {
				// Preserve the dead-worker proof through the destructive boundary.
				// Claiming the recovery writer lease first would make the run appear
				// live and correctly disqualify its managed VM from reclamation.
				let destroyFailed = false;
				if (target) {
					try {
						if (!(await reclaimTarget())) destroyFailed = true;
					} catch {
						destroyFailed = true;
						errors.push("managed_reclaim_failed");
					}
				}
				const recoveryStartToken = randomUUID();
				const recoveryNonce = randomUUID();
				await acquireRunLock(
					runId,
					process.pid,
					recoveryStartToken,
					recoveryNonce,
					{
						allowRecovery: true,
						maxAgeMs: 0,
						now: new Date(Date.now() + 1).toISOString(),
					},
				);
				await activateOutcomeWriter(runId, {
					pid: process.pid,
					startToken: recoveryStartToken,
					nonce: recoveryNonce,
					writerEpoch: `epoch-recovery-${randomUUID()}`,
					allowRecovery: true,
				});
				const failure = sanitizeFailureMetadata({
					result: "unknown_failure",
					errorKind: "unknown_failure",
					failurePhase: "terminal_reconciliation",
				});
				const finalized = await finalizeRun({
					runId,
					state: "failed",
					terminalizedBy: "dead_worker_recovery",
					failure,
					terminalSummary: {
						totalTasks: Array.isArray(recoveryRun.orderedTaskIds)
							? recoveryRun.orderedTaskIds.length
							: null,
						runnableTasks: null,
						processedTasks: null,
						completedTaskIds: null,
						failedCount: null,
					},
					cleanup: async () => {
						await (
							dependencies.reconcileProjectLockClaims ??
							reconcileProjectLockClaims
						)();
						projectLockReleasedByFinalizer = await (
							dependencies.releaseProjectLockIfOwnedBy ??
							releaseProjectLockIfOwnedBy
						)(recoveryRun.projectPath, runId);
						if (
							await (dependencies.isProjectLockOwnedBy ?? isProjectLockOwnedBy)(
								recoveryRun.projectPath,
								runId,
							)
						) {
							throw new Error("recovery ownership cleanup incomplete");
						}
						if (destroyFailed) throw new Error("managed reclaim failed");
					},
				});
				recoveredByFinalizer = finalized.terminal;
				if (!finalized.cleanupComplete) errors.push("recovery_incomplete");
			} else if (
				target &&
				(liveness === "terminal_clean" || liveness === "dead")
			) {
				try {
					await reclaimTarget();
				} catch {
					errors.push("managed_reclaim_failed");
				}
			}
			if (candidateResults.length === 0) {
				candidateResults = target
					? [
							{
								entry: target,
								disposition: "preserved",
								reason: recoveryRunMatchesTarget
									? liveness === "live"
										? "live_run"
										: liveness === "startup_grace"
											? "startup_grace"
											: "liveness_unknown"
									: recoveryRun
										? "run_identity_mismatch"
										: "run_missing",
							},
						]
					: [];
			}
		} else {
			const projectPath = await canonicalRecoveryProject(managed, dependencies);
			try {
				const { result, candidates } = await reclaimManagedEntries({
					managed,
					dependencies,
					projectPath,
				});
				candidateResults = candidates;
				reclaimedCount = result.reclaimed.length;
				errors.push(...result.errors.map((e) => `${e.name}: ${e.reason}`));
				unreclaimedSnapshots = result.skippedSnapshots ?? [];
			} catch {
				errors.push("managed_reclaim_unavailable");
			}
		}

		const targeted = recoveredByFinalizer
			? projectLockReleasedByFinalizer
				? [runId]
				: []
			: await releaseStaleProjectLocks(
					runId ? [runId] : candidateIds,
					dependencies,
				);
		const direct = await (
			dependencies.releaseOrphanedProjectLocks ?? releaseOrphanedProjectLocks
		)();
		const claims = await (
			dependencies.reconcileProjectLockClaims ?? reconcileProjectLockClaims
		)();
		const releasedIds = [...new Set([...targeted, ...direct, ...claims])];
		const allocationIntents = await auditKnownAllocationIntents({
			stateRoot: effectiveStateRoot,
			runId,
			managed,
			dependencies,
			executionBackend,
		});

		const output = {
			disposition:
				errors.length > 0
					? "partial_failure"
					: reclaimedCount > 0
						? "reclaimed"
						: managed.length === 0
							? "no_candidates"
							: "preserved",
			vmsReclaimed: reclaimedCount,
			unreclaimedSnapshots,
			allocationIntents,
			errors,
			projectLocksReleased: releasedIds.length,
			runId: runId ?? null,
			candidates:
				candidateResults.length > 0
					? candidateResults.map(({ entry, disposition, reason }) => ({
							name: entry.name,
							runId: entry.runId,
							status: entry.status,
							disposition,
							reason,
						}))
					: runId
						? [
								{
									runId,
									disposition: "preserved",
									reason: "resource_missing",
								},
							]
						: [],
		};

		console.log(JSON.stringify(output));
		process.exitCode = errors.length > 0 ? 1 : 0;
	});
}

function parseOrphanLockRemediationArgs(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: false,
			options: {
				"dry-run": { type: "boolean", default: false },
				confirm: { type: "boolean", default: false },
				"state-root": { type: "string" },
				help: { type: "boolean", default: false },
			},
		});
	} catch (error) {
		throw new UsageError(error.message);
	}
	const forwarded = [];
	if (parsed.values["dry-run"]) forwarded.push("--dry-run");
	if (parsed.values.confirm) forwarded.push("--confirm");
	if (parsed.values.help) forwarded.push("--help");
	return {
		argv: forwarded,
		stateRoot: parsed.values["state-root"] ?? null,
	};
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

/**
 * Main entry point: route to subcommand or backwards-compat positional dispatch.
 * @param {string[]} argv process.argv.slice(2)
 */
async function main(argv) {
	if (argv.length === 1 && argv[0] === "--version") {
		const packageUrl = new URL("../../../package.json", import.meta.url);
		const { version } = JSON.parse(readFileSync(packageUrl, "utf8"));
		console.log(version);
		return;
	}

	// Find the first positional argument (non-flag) that is a known subcommand
	const subIdx = argv.findIndex(
		(a) => !a.startsWith("-") && KNOWN_SUBCOMMANDS.has(a),
	);

	if (subIdx >= 0) {
		const subcommand = argv[subIdx];
		const subArgs = [...argv.slice(0, subIdx), ...argv.slice(subIdx + 1)];

		switch (subcommand) {
			case "run":
			case undefined: {
				await handleRun(subArgs, {}, subcommand === "run" ? USAGE_RUN : USAGE);
				break;
			}
			case "launch": {
				await handleLaunch(subArgs);
				break;
			}
			case "status": {
				await handleStatus(subArgs);
				break;
			}
			case "result": {
				await handleResult(subArgs);
				break;
			}
			case "recover": {
				await handleRecover(subArgs);
				break;
			}
			case "health": {
				await handleHealth(subArgs);
				break;
			}
			case "reconcile-completion": {
				await handleReconcileCompletion(subArgs);
				break;
			}
			case "remediate-orphaned-locks": {
				await handleOrphanLockRemediation(subArgs);
				break;
			}
			default:
				throw new UsageError(`unknown subcommand: ${subcommand}`);
		}
	} else {
		// Backwards compat: positional dispatch (no explicit subcommand)
		await handleRun(argv, {}, USAGE);
	}
}

function formatRunAbort(error) {
	const runAddress = error.switchyardRunId
		? ` (run ${error.switchyardRunId})`
		: "";
	return `dispatch: run aborted${runAddress}: ${error.message}`;
}

if (
	process.argv[1] &&
	existsSync(process.argv[1]) &&
	import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
	try {
		await main(process.argv.slice(2));
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(`dispatch: ${error.message}\n`);
			console.error(USAGE);
			process.exitCode = 2;
		} else {
			console.error(formatRunAbort(error));
			process.exitCode = 1;
		}
	}
}

export {
	assessRecoveryEntry,
	auditKnownAllocationIntents,
	captureHostFingerprint,
	formatRunAbort,
	handleHealth,
	handleLaunch,
	handleOrphanLockRemediation,
	handleReconcileCompletion,
	handleRecover,
	handleResult,
	handleRun,
	handleStatus,
	markLauncherReadyIfLaunching,
	parseDispatchArgs,
	parseHealthArgs,
	parseLaunchArgs,
	parseOrphanLockRemediationArgs,
	parseReconcileCompletionArgs,
	parseRecoverArgs,
	parseResultArgs,
	parseStatusArgs,
	probeProviderProcess,
	resolveIsRunDead,
	runDispatch,
	sweepManagedOrphans,
	USAGE,
	USAGE_LAUNCH,
	USAGE_RECOVER,
	USAGE_RESULT,
	USAGE_RUN,
	USAGE_STATUS,
};
