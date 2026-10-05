// Parallels lifecycle backend.
//
// The reserved VM name identifies managed candidates; host-owned records bind
// the exact VM, run, project, creator birth, and reclamation authority. Bulk
// transfer is deliberately a host-memory HTTP hop; the prlctl stdin channel is
// reserved for tiny control rules, never tar bytes.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
	PrlctlCallError,
	prlctlTrustedCauseCode,
	WorkerBootStageError,
} from "../adapter/exec-error.mjs";
import { ExecutionBackend, normalizeExecArgv } from "./execution-backend.mjs";
import { executeMutationSync } from "./mutation-protocol.mjs";

import {
	ALLOCATION_INTENT_PREFIX,
	ALLOCATION_INTENT_SUFFIX,
	CLEANUP_STARTED,
	CLIPBOARD_AGENT_LABEL,
	CLIPBOARD_AGENT_PROCESS,
	DEFAULT_AQUA_POLL_MS,
	DEFAULT_AQUA_TIMEOUT_MS,
	DEFAULT_CLIPBOARD_POLL_MS,
	DEFAULT_CLIPBOARD_SETTLE_MS,
	DEFAULT_GOLDEN_STOP_SETTLE_TIMEOUT_MS,
	DEFAULT_HOST_READINESS_ATTEMPTS,
	DEFAULT_HOST_READINESS_BACKOFF_MS,
	DEFAULT_HOST_READINESS_TIMEOUT_MS,
	DEFAULT_LOST_MUTATION_RECONCILIATION_POLL_MS,
	DEFAULT_LOST_MUTATION_RECONCILIATION_TIMEOUT_MS,
	DEFAULT_PRLCTL_CALL_TIMEOUT_MS,
	DEFAULT_PRLCTL_RETRY_ATTEMPTS,
	DEFAULT_PRLCTL_RETRY_BACKOFF_MS,
	DEFAULT_STOP_SETTLE_POLL_MS,
	DEFAULT_STOP_SETTLE_TIMEOUT_MS,
	DEFAULT_TRANSFER_HOST,
	DEFAULT_WORKSPACE_VERIFY_POLL_MS,
	DEFAULT_WORKSPACE_VERIFY_TIMEOUT_MS,
	HOST_READINESS_MAX_BUFFER,
	INDEX_LOCK_PATH,
	INDEX_LOCK_REMOVED,
	KILL_GUEST_PROCESS_TREE,
	MAX_AQUA_EXEC_ARGV_BYTES,
	MAX_TRANSFER_BYTES,
	PID_MARKER_REMOVED,
	PID_OBSERVED,
	PRLCTL_JOB_MISFIRE,
	PROVIDER_TERMINAL_EVIDENCE_KIND,
	PROVIDER_TERMINAL_EVIDENCE_MAX_BYTES,
	PROVIDER_TERMINAL_EVIDENCE_SCHEMA_VERSION,
	parseHostProcessIdentity,
	prlctlHostPermissionDenied,
	probeHostProcessIdentity,
	TREE_TERMINATED,
	UUID,
	VM_CREDENTIAL_LAYOUTS,
	VM_OWNERSHIP_SCHEMA_VERSION,
	validatePid,
	WORKSPACE_MODE,
	WORKSPACE_PREPARE_ATTEMPTS,
	XFER_URL_ASSIGNMENT,
} from "./parallels-primitives.mjs";
import {
	BULK_TRANSFER_HELPER,
	BWS_SECRET_EXEC,
	defaultPidIsAlive,
	defaultSleep,
	describeBulkTransferFailure,
	describePrlctlFailure,
	OPENCODE_BWS_CONSUMERS,
	outputText,
	shellQuote,
	validateAttemptCount,
} from "./parallels-transfer.mjs";
import {
	buildParallelsWorkingName,
	diskBytesFromInfo,
	isBoundedRecordText,
	isUuid,
	markerIdentity,
	normalizedUuid,
	ownershipContextFor,
	ParallelsHostReadinessError,
	parseParallelsWorkingName,
	parseReadinessInventory,
	parseVmList,
	providerHomePath,
	providerPidMarkerPath,
	providerTerminalEvidencePath,
	resolveWorkspacePath,
	snapshotDifference,
	snapshotIdsFromOutput,
	strictSnapshotIdsFromOutput,
	validateDurationMs,
	validateEnvAssignment,
	validateGuestPath,
	validateLinkedCloneMeasurement,
	validateTar,
	validateTransferHost,
	validateUid,
	validateUser,
} from "./parallels-validation.mjs";

export {
	MAX_AQUA_EXEC_ARGV_BYTES,
	PARALLELS_WORKING_PREFIX,
	probeHostProcessIdentity,
} from "./parallels-primitives.mjs";
export {
	BULK_TRANSFER_HELPER,
	describeBulkTransferFailure,
} from "./parallels-transfer.mjs";
export {
	buildParallelsWorkingName,
	ParallelsHostReadinessError,
	parseParallelsWorkingName,
	validateLinkedCloneMeasurement,
} from "./parallels-validation.mjs";

const DEFAULT_TRANSFER_LISTEN_HOST = DEFAULT_TRANSFER_HOST;

/**
 * Synchronous Parallels lifecycle implementation with injectable VM calls.
 *
 * `prlctlFn` receives `(argv, options)` and returns the command's stdout (or
 * an execFileSync-compatible Buffer/string). Supplying it, `sleepFn`,
 * `nowFn`, and `pidIsAlive` makes clone/boot/destroy/reclamation hermetic.
 * @public
 */
export class ParallelsExecutionBackend extends ExecutionBackend {
	constructor({
		prlctlFn,
		execFn,
		bulkTransferFn = null,
		sleepFn = defaultSleep,
		nowFn = Date.now,
		lostMutationNowFn = () => performance.now(),
		onStatus = null,
		pidIsAlive = defaultPidIsAlive,
		creatorPid = process.pid,
		aquaUid = null,
		aquaTimeoutMs = DEFAULT_AQUA_TIMEOUT_MS,
		aquaPollMs = DEFAULT_AQUA_POLL_MS,
		clipboardSettleMs = DEFAULT_CLIPBOARD_SETTLE_MS,
		clipboardPollMs = DEFAULT_CLIPBOARD_POLL_MS,
		workspaceVerifyTimeoutMs = DEFAULT_WORKSPACE_VERIFY_TIMEOUT_MS,
		workspaceVerifyPollMs = DEFAULT_WORKSPACE_VERIFY_POLL_MS,
		stopSettleTimeoutMs = DEFAULT_STOP_SETTLE_TIMEOUT_MS,
		deleteSettlementNowFn = () => performance.now(),
		goldenStopSettleTimeoutMs = DEFAULT_GOLDEN_STOP_SETTLE_TIMEOUT_MS,
		stopSettlePollMs = DEFAULT_STOP_SETTLE_POLL_MS,
		goldenImage = null,
		snapshotSidecarRoot = null,
		runId = null,
		measureLinkedCloneFn = null,
		diskUsageFn = null,
		requireLinkedCloneMeasurement = true,
		providerUser = "switchyard",
		transferHost = DEFAULT_TRANSFER_HOST,
		transferListenHost = DEFAULT_TRANSFER_LISTEN_HOST,
		maxTransferBytes = MAX_TRANSFER_BYTES,
		prlctlRetryAttempts = DEFAULT_PRLCTL_RETRY_ATTEMPTS,
		prlctlRetryBackoffMs = DEFAULT_PRLCTL_RETRY_BACKOFF_MS,
		prlctlCallTimeoutMs = DEFAULT_PRLCTL_CALL_TIMEOUT_MS,
		hostReadinessAttempts = DEFAULT_HOST_READINESS_ATTEMPTS,
		hostReadinessBackoffMs = DEFAULT_HOST_READINESS_BACKOFF_MS,
		hostReadinessTimeoutMs = DEFAULT_HOST_READINESS_TIMEOUT_MS,
		hostReadinessJitterFn = Math.random,
		hostReadinessNowFn = () => performance.now(),
		hostProcessIdentityProbe = probeHostProcessIdentity,
		enableLostMutationReconciliation = false,
		lostMutationReconciliationTimeoutMs = DEFAULT_LOST_MUTATION_RECONCILIATION_TIMEOUT_MS,
		lostMutationReconciliationPollMs = DEFAULT_LOST_MUTATION_RECONCILIATION_POLL_MS,
	} = {}) {
		super();
		if (typeof prlctlFn === "function") {
			this.prlctlFn = prlctlFn;
		} else {
			const invoke = execFn ?? execFileSync;
			this.prlctlFn = (args, options = {}) =>
				invoke("prlctl", args, {
					encoding: "utf8",
					stdio: "pipe",
					...options,
				});
		}
		this.bulkTransferFn = bulkTransferFn;
		this.prlctlRetryAttempts = validateAttemptCount(
			prlctlRetryAttempts,
			"prlctlRetryAttempts",
		);
		this.prlctlCallTimeoutMs = validateDurationMs(
			prlctlCallTimeoutMs,
			"prlctlCallTimeoutMs",
			1,
		);
		this.prlctlRetryBackoffMs = validateDurationMs(
			prlctlRetryBackoffMs,
			"prlctlRetryBackoffMs",
			0,
		);
		this.hostReadinessAttempts = validateAttemptCount(
			hostReadinessAttempts,
			"hostReadinessAttempts",
		);
		this.hostReadinessBackoffMs = validateDurationMs(
			hostReadinessBackoffMs,
			"hostReadinessBackoffMs",
			0,
		);
		this.hostReadinessTimeoutMs = validateDurationMs(
			hostReadinessTimeoutMs,
			"hostReadinessTimeoutMs",
			1,
		);
		if (typeof hostReadinessJitterFn !== "function") {
			throw new TypeError("hostReadinessJitterFn must be a function");
		}
		if (typeof hostReadinessNowFn !== "function") {
			throw new TypeError("hostReadinessNowFn must be a function");
		}
		this.hostReadinessJitterFn = hostReadinessJitterFn;
		this.hostReadinessNowFn = hostReadinessNowFn;
		this.sleepFn = sleepFn;
		this.nowFn = nowFn;
		if (typeof deleteSettlementNowFn !== "function") {
			throw new TypeError("deleteSettlementNowFn must be a function");
		}
		this.deleteSettlementNowFn = deleteSettlementNowFn;
		if (typeof lostMutationNowFn !== "function") {
			throw new TypeError("lostMutationNowFn must be a function");
		}
		if (onStatus !== null && typeof onStatus !== "function") {
			throw new TypeError("onStatus must be a function");
		}
		this.lostMutationNowFn = lostMutationNowFn;
		this.onStatus = onStatus;
		this.pidIsAlive = pidIsAlive;
		this.creatorPid = validatePid(creatorPid);
		if (typeof hostProcessIdentityProbe !== "function") {
			throw new TypeError("hostProcessIdentityProbe must be a function");
		}
		this.hostProcessIdentityProbe = hostProcessIdentityProbe;
		if (typeof enableLostMutationReconciliation !== "boolean") {
			throw new TypeError("enableLostMutationReconciliation must be a boolean");
		}
		this.enableLostMutationReconciliation = enableLostMutationReconciliation;
		this.lostMutationReconciliationTimeoutMs = validateDurationMs(
			lostMutationReconciliationTimeoutMs,
			"lostMutationReconciliationTimeoutMs",
			0,
		);
		this.lostMutationReconciliationPollMs = validateDurationMs(
			lostMutationReconciliationPollMs,
			"lostMutationReconciliationPollMs",
			1,
		);
		this.aquaUid = aquaUid;
		this.aquaTimeoutMs = validateDurationMs(aquaTimeoutMs, "aquaTimeoutMs", 0);
		this.aquaPollMs = validateDurationMs(aquaPollMs, "aquaPollMs", 1);
		this.clipboardSettleMs = validateDurationMs(
			clipboardSettleMs,
			"clipboardSettleMs",
			0,
		);
		this.clipboardPollMs = validateDurationMs(
			clipboardPollMs,
			"clipboardPollMs",
			1,
		);
		this.workspaceVerifyTimeoutMs = validateDurationMs(
			workspaceVerifyTimeoutMs,
			"workspaceVerifyTimeoutMs",
			0,
		);
		this.workspaceVerifyPollMs = validateDurationMs(
			workspaceVerifyPollMs,
			"workspaceVerifyPollMs",
			1,
		);
		this.goldenStopSettleTimeoutMs = validateDurationMs(
			goldenStopSettleTimeoutMs,
			"goldenStopSettleTimeoutMs",
			0,
		);
		this.stopSettleTimeoutMs = validateDurationMs(
			stopSettleTimeoutMs,
			"stopSettleTimeoutMs",
			0,
		);
		this.stopSettlePollMs = validateDurationMs(
			stopSettlePollMs,
			"stopSettlePollMs",
			1,
		);
		this.goldenImage = goldenImage;
		// Injected rather than imported: this backend depends on Node builtins
		// and its own base class only, and its testability rests on injected
		// seams (nowFn, sleepFn, prlctlFn). Importing run-store here to reach
		// getVmAdmissionRoot() would give up both. Null disables the sidecar,
		// which is the correct posture for a backend with nowhere durable to
		// write: destroy() still cleans up in-process.
		this.snapshotSidecarRoot = snapshotSidecarRoot;
		this.runId = typeof runId === "string" && runId ? runId : null;
		this.measureLinkedCloneFn = measureLinkedCloneFn;
		this.diskUsageFn = diskUsageFn;
		this.linkedMeasurementReceipts = new WeakSet();
		this.linkedSnapshotsByUuid = new Map();
		this.ownedResourcesByUuid = new Map();
		this.requireLinkedCloneMeasurement = requireLinkedCloneMeasurement;
		this.providerUser = validateUser(providerUser);
		this.transferHost = validateTransferHost(transferHost);
		if (
			typeof transferListenHost !== "string" ||
			!/^[A-Za-z0-9.:-]+$/.test(transferListenHost)
		) {
			throw new Error("transferListenHost must be a safe host address");
		}
		this.transferListenHost = transferListenHost;
		if (!Number.isInteger(maxTransferBytes) || maxTransferBytes <= 0) {
			throw new Error("maxTransferBytes must be a positive integer");
		}
		this.maxTransferBytes = maxTransferBytes;
	}

	/**
	 * The single funnel for every synchronous prlctl invocation.
	 *
	 * Mutating lifecycle calls do not receive a timeout, and callers do not kill
	 * an orchestrator blocked in one. The readiness probe is the sole exception:
	 * it owns a read-only `list` client and supplies a small absolute deadline.
	 * prlctl 26.4.1 segfaults when a signal reaches it after its
	 * parent has exited: it jumps to address 0 through `_sigtramp` while blocked
	 * in `QWaitCondition::wait` inside ParallelsVirtualizationSDK. Measured
	 * 2026-08-14 17:33:00 — pid 10735, five minutes into an operation whose
	 * parent was already gone. That crash leaked nothing, but an interrupted
	 * clone is exactly the orphan INV-3's reclamation exists to sweep, and the
	 * sweep only fires for a creator PID it can prove dead.
	 *
	 * The operations here are long by nature: a full clone of the golden image
	 * runs for minutes. Bound them by making the operation smaller, never by
	 * killing it partway.
	 */
	/**
	 * Invoke prlctl, absorbing the measured host-side SDK job misfire.
	 *
	 * This is the single chokepoint every one of the backend's prlctl call
	 * sites already funnelled through, which is why the retry lives here rather
	 * than being sprinkled across ~26 call sites that would each have to
	 * remember it. Only `prlctl_job_misfire` is retried; a timeout, a
	 * not-yet-booted guest, and an ordinary non-zero exit are all real answers
	 * that a caller must see on the first attempt. Every failure that escapes
	 * is a `PrlctlCallError` carrying exit code, signal, killed-by-us, and the
	 * attempt count, so a run record can say what happened instead of "no
	 * metadata recorded".
	 *
	 * @param {string[]} args
	 * @param {object} [options] execFileSync options, plus `retry: false` to opt out.
	 * @returns {string|Buffer} prlctl stdout
	 * @throws {PrlctlCallError}
	 */
	_call(args, options = {}) {
		const { retry = true, ...callerOptions } = options;
		// Defaulted here rather than in the prlctlFn factory so the deadline
		// covers every path into prlctl, including an injected client. A timeout
		// classifies as `prlctl_call_timed_out`, never `prlctl_job_misfire`, so
		// it is surfaced rather than retried.
		const invokeOptions = {
			timeout: this.prlctlCallTimeoutMs,
			killSignal: "SIGKILL",
			...callerOptions,
		};
		const maxAttempts = retry ? this.prlctlRetryAttempts : 1;
		for (let attempt = 1; ; attempt += 1) {
			try {
				return this.prlctlFn(args, invokeOptions);
			} catch (error) {
				const failure = describePrlctlFailure(error, {
					args,
					attempts: attempt,
				});
				if (
					failure.diagnosticCode !== "prlctl_job_misfire" ||
					attempt >= maxAttempts
				) {
					throw failure;
				}
				// Linear backoff. The fault clears on the next call in every
				// measured case, so this is a courtesy pause for the dispatcher
				// rather than a wait for a slow resource to free up.
				this.sleepFn(this.prlctlRetryBackoffMs * attempt);
			}
		}
	}

	/**
	 * Resolve a lost mutation result through bounded, non-retrying read probes.
	 * A probe can establish only success; every contrary, malformed, or missing
	 * identity observation preserves the original ambiguous mutation failure.
	 */
	_reconcileLostMutation(cause, observe, { operation, onStatus } = {}) {
		if (
			!this.enableLostMutationReconciliation ||
			!(cause instanceof PrlctlCallError) ||
			cause.diagnosticCode !== "prlctl_job_misfire"
		) {
			throw cause;
		}
		const emit = onStatus ?? this.onStatus;
		emit?.({
			type: "lost-mutation-reconciliation",
			event: "start",
			operation,
		});
		const startedAt = this.lostMutationNowFn();
		if (!Number.isFinite(startedAt)) {
			emit?.({
				type: "lost-mutation-reconciliation",
				event: "unavailable",
				operation,
			});
			throw cause;
		}
		const deadline = startedAt + this.lostMutationReconciliationTimeoutMs;
		if (!Number.isFinite(deadline)) {
			emit?.({
				type: "lost-mutation-reconciliation",
				event: "unavailable",
				operation,
			});
			throw cause;
		}
		let lastObservedAt = startedAt;
		const remaining = () => {
			const observedAt = this.lostMutationNowFn();
			const remainingMs = Math.floor(deadline - observedAt);
			if (
				!Number.isFinite(observedAt) ||
				observedAt < lastObservedAt ||
				observedAt >= deadline ||
				remainingMs < 1
			) {
				throw cause;
			}
			lastObservedAt = observedAt;
			return remainingMs;
		};
		const budget = { remaining };
		for (;;) {
			let remainingMs;
			try {
				remainingMs = remaining();
				emit?.({
					type: "lost-mutation-reconciliation",
					event: "probe",
					operation,
				});
				const achieved = observe(budget);
				remainingMs = remaining();
				if (achieved) {
					emit?.({
						type: "lost-mutation-reconciliation",
						event: "complete",
						operation,
					});
					return;
				}
			} catch {
				emit?.({
					type: "lost-mutation-reconciliation",
					event: "unavailable",
					operation,
				});
				throw cause;
			}
			const sleepMs = Math.min(
				this.lostMutationReconciliationPollMs,
				remainingMs,
			);
			if (sleepMs <= 0) throw cause;
			this.sleepFn(sleepMs);
			try {
				remaining();
			} catch {
				emit?.({
					type: "lost-mutation-reconciliation",
					event: "unavailable",
					operation,
				});
				throw cause;
			}
		}
	}

	_lostMutationIdentity(entry, allowUnmanaged) {
		if (!entry.ownership) {
			if (allowUnmanaged) return null;
			throw new Error("lost-result reconciliation requires owned VM metadata");
		}
		const record = this.ownedResourcesByUuid.get(entry.uuid);
		if (
			!record ||
			record.vmUuid !== entry.uuid ||
			record.vmName !== entry.name ||
			record.runId !== entry.runId ||
			record.creatorPid !== entry.creatorPid
		) {
			throw new Error(
				"lost-result reconciliation requires exact owned VM metadata",
			);
		}
		return Object.freeze({
			vmUuid: record.vmUuid,
			vmName: record.vmName,
			runId: record.runId,
			creatorPid: record.creatorPid,
		});
	}

	/** Read one complete VM inventory and preserve the original exact identity. */
	_observeExactVm(entry, budget, identity = null) {
		if (identity) {
			const current = this.ownedResourcesByUuid.get(entry.uuid);
			if (
				!current ||
				current.vmUuid !== identity.vmUuid ||
				current.vmName !== identity.vmName ||
				current.runId !== identity.runId ||
				current.creatorPid !== identity.creatorPid
			) {
				throw new Error("VM ownership metadata changed during reconciliation");
			}
		}
		const timeout = budget.remaining();
		const rows = parseReadinessInventory(
			this._call(["list", "-a", "-o", "uuid,status,name"], {
				retry: false,
				timeout,
				killSignal: "SIGKILL",
				maxBuffer: HOST_READINESS_MAX_BUFFER,
			}),
		);
		budget.remaining();
		if (identity) {
			const current = this.ownedResourcesByUuid.get(entry.uuid);
			if (
				!current ||
				current.vmUuid !== identity.vmUuid ||
				current.vmName !== identity.vmName ||
				current.runId !== identity.runId ||
				current.creatorPid !== identity.creatorPid
			) {
				throw new Error("VM ownership metadata changed during reconciliation");
			}
		}
		const matches = rows.filter(([uuid, _status, ...nameParts]) => {
			const name = nameParts.join(" ").trim();
			if (uuid !== entry.uuid || name !== entry.name) return false;
			const ownership =
				entry.ownership ?? parseParallelsWorkingName(entry.name);
			const observedOwnership = parseParallelsWorkingName(name);
			return (
				!ownership ||
				(observedOwnership &&
					observedOwnership.runId === ownership.runId &&
					observedOwnership.creatorPid === ownership.creatorPid)
			);
		});
		if (matches.length !== 1) {
			throw new Error("VM identity changed during lost-result reconciliation");
		}
		return { status: matches[0][1] };
	}

	/** Read one strict snapshot inventory for the exact golden-image identity. */
	_observeSnapshotIds(golden, budget) {
		const current = this._observeExactVm(golden, budget);
		// A changed or unavailable golden image is not authoritative evidence for
		// a snapshot mutation, even if a name later happens to match.
		if (!current.status) {
			throw new Error("golden image status is unavailable");
		}
		const output = this._call(["snapshot-list", golden.uuid, "--json"], {
			retry: false,
			timeout: budget.remaining(),
			killSignal: "SIGKILL",
			maxBuffer: HOST_READINESS_MAX_BUFFER,
		});
		budget.remaining();
		return strictSnapshotIdsFromOutput(output);
	}

	/**
	 * Preserve a failed stop/kill result unless the exact VM is independently
	 * observed stopped. Parallels can return 255 after completing a stop, so the
	 * command result alone is not sufficient evidence that deletion is unsafe.
	 * Conversely, never let a failed stop fall through to delete while the VM
	 * still reports running (or has disappeared from the authoritative list).
	 */
	_reprobeStopped(entry, cause) {
		const current = this._awaitSettled(entry, cause);
		if (!current) throw cause;
		return current;
	}

	/**
	 * Poll the authoritative list until the exact UUID is stopped or gone.
	 *
	 * Shutdown is asynchronous: `prlctl stop` returns while Parallels is still
	 * releasing the VM, and during that window the VM answers `running` and
	 * refuses deletion as busy. Waiting the window out is the whole point --
	 * sampling once resolves the race by coin flip. Returns the stopped entry,
	 * or undefined when the UUID has left the list; throws `cause` if the VM is
	 * still running when the deadline expires, so a genuinely stuck VM is
	 * reported with the failure that led here rather than a timeout of our own.
	 *
	 * A `listAll()` that throws also surfaces as `cause`, which means an
	 * unreachable or timed-out list reads as whatever state `cause` names. The
	 * list failure is attached as `cause.cause` when nothing else claims that
	 * slot, so the reader can tell "the VM is stuck" from "we could not see it".
	 */
	_awaitSettled(entry, cause, { timeoutMs = this.stopSettleTimeoutMs } = {}) {
		const startedAt = this.nowFn();
		for (;;) {
			let current;
			try {
				current = this.listAll().find(
					(candidate) => candidate.uuid === entry.uuid,
				);
			} catch (listError) {
				if (cause instanceof Error && cause.cause === undefined) {
					cause.cause = listError;
				}
				throw cause;
			}
			if (!current) return undefined;
			if (/^stopped$/i.test(String(current.status ?? ""))) return current;
			const elapsedMs = this.nowFn() - startedAt;
			if (elapsedMs >= timeoutMs) throw cause;
			this.sleepFn(Math.min(this.stopSettlePollMs, timeoutMs - elapsedMs));
		}
	}

	/**
	 * Force a VM down and prove the exact owned identity settled before delete.
	 * A successful `stop --kill` is not evidence of a stopped VM: Parallels has
	 * returned zero while leaving the guest running. Retry one time only when a
	 * complete authoritative inventory still reports that exact VM running.
	 */
	_forceStopAndAwaitSettled(entry, cause) {
		const policy = {
			maxAttempts: 2,
			retryOn: ["failed"],
			retryAmbiguous: false,
			idempotency: "conditional",
		};
		const result = executeMutationSync({
			operation: "parallels-force-stop",
			resource: entry.uuid.replace(/[{}]/gu, ""),
			policy,
			command: () => this._call(["stop", entry.uuid, "--kill"]),
			observe: () => this._observeForceStop(entry),
			sleepFn: this.sleepFn,
		});
		if (result.state === "completed") return result;
		const error =
			cause ?? new Error(`${entry.name ?? entry.uuid} force-stop failed`);
		error.cleanupUncertain = true;
		if (result.outcome === "ambiguous") {
			error.cause ??= new Error(
				`${entry.name ?? entry.uuid} force-stop observation was not authoritative`,
			);
		}
		throw error;
	}

	_observeForceStop(entry) {
		const startedAt = this.nowFn();
		for (;;) {
			let rows;
			try {
				rows = parseReadinessInventory(
					this._call(["list", "-a", "-o", "uuid,status,name"], {
						retry: false,
						timeout: this.prlctlCallTimeoutMs,
						killSignal: "SIGKILL",
						maxBuffer: HOST_READINESS_MAX_BUFFER,
					}),
				);
			} catch {
				return { status: "ambiguous", ownership: "unknown" };
			}
			const matches = rows.filter(([uuid]) => uuid === entry.uuid);
			if (matches.length !== 1) {
				return matches.length === 0
					? { status: "confirmed", ownership: "confirmed" }
					: { status: "ambiguous", ownership: "unknown" };
			}
			const [, status, ...nameParts] = matches[0];
			const name = nameParts.join(" ").trim();
			const expectedOwnership =
				entry.ownership ??
				this.ownedResourcesByUuid.get(entry.uuid) ??
				parseParallelsWorkingName(entry.name);
			const observedOwnership = parseParallelsWorkingName(name);
			if (
				!expectedOwnership ||
				entry.name !== name ||
				!observedOwnership ||
				observedOwnership.runId !== expectedOwnership.runId ||
				observedOwnership.creatorPid !== expectedOwnership.creatorPid
			) {
				return { status: "ambiguous", ownership: "unknown" };
			}
			if (/^stopped$/i.test(String(status)))
				return { status: "confirmed", ownership: "confirmed" };
			const elapsedMs = this.nowFn() - startedAt;
			if (elapsedMs >= this.stopSettleTimeoutMs)
				return { status: "failed", ownership: "confirmed" };
			this.sleepFn(
				Math.min(this.stopSettlePollMs, this.stopSettleTimeoutMs - elapsedMs),
			);
		}
	}

	/**
	 * Prove a VM is down by observing it, not by reading a return code.
	 *
	 * `prlctl stop` has been observed printing "The VM has been successfully
	 * stopped" and exiting 0 while the VM kept running for at least two minutes,
	 * with `prlctl exec` still answering and uptime unbroken -- the inverse of
	 * `prlctl_job_misfire`, and uncatchable by any check on the call itself. So
	 * every caller that needs the VM to actually be down polls for it. The
	 * synthesized cause names the state that is wrong rather than whatever
	 * collateral failure happened to surface it.
	 * The message names the window that was waited out, because "still running"
	 * on its own does not distinguish a wedged VM from one that simply needed
	 * longer than the budget it was given.
	 * @param {{uuid: string, name?: string}} entry
	 * @param {string} after Human-readable description of what already ran.
	 * @param {number} [timeoutMs] Settle budget; defaults to the clone budget.
	 */
	_assertNotRunning(entry, after, timeoutMs = this.stopSettleTimeoutMs) {
		return this._awaitSettled(
			entry,
			new Error(
				`${entry.name ?? entry.uuid} is still running ${timeoutMs}ms after ${after}`,
			),
			{ timeoutMs },
		);
	}

	/**
	 * Create the lazy, monotonic budget used only by deletion postconditions.
	 *
	 * The first inventory read starts the deadline. Mutation calls retain their
	 * independent command deadlines, while every subsequent inventory read gets
	 * only the time that remains in this one settlement window.
	 */
	_createDeleteSettlementBudget() {
		let deadline = null;
		let lastNow = null;
		return {
			remainingForObservation: () => {
				const now = this.deleteSettlementNowFn();
				if (!Number.isFinite(now) || (lastNow !== null && now < lastNow)) {
					throw new Error("delete settlement clock is not monotonic");
				}
				lastNow = now;
				if (deadline === null) {
					deadline = now + this.stopSettleTimeoutMs;
					return this.stopSettleTimeoutMs;
				}
				const remaining = Math.floor(deadline - now);
				if (remaining <= 0) {
					throw new Error("delete settlement budget exhausted");
				}
				return remaining;
			},
			remainingForPoll: () => {
				const now = this.deleteSettlementNowFn();
				if (
					deadline === null ||
					!Number.isFinite(now) ||
					(lastNow !== null && now < lastNow)
				) {
					throw new Error("delete settlement clock is not monotonic");
				}
				lastNow = now;
				return Math.max(0, Math.floor(deadline - now));
			},
			recheckAfterObservation: () => {
				const now = this.deleteSettlementNowFn();
				if (!Number.isFinite(now) || (lastNow !== null && now < lastNow)) {
					throw new Error("delete settlement clock is not monotonic");
				}
				lastNow = now;
				// A zero budget explicitly permits one immediate inventory read.
				if (this.stopSettleTimeoutMs === 0) return;
				if (deadline === null || now >= deadline) {
					throw new Error("delete settlement budget exhausted");
				}
			},
		};
	}

	_deletionAbsenceUncertainty(entry, cause, detail) {
		if (cause instanceof Error && cause.cause === undefined && detail) {
			cause.cause = detail;
		}
		return new Error(
			`${entry.name ?? entry.uuid} could not verify absence after delete`,
			{ cause },
		);
	}

	/**
	 * Read one complete inventory for a delete postcondition.
	 *
	 * This path is deliberately retry-free and strict: a malformed or failed
	 * inventory cannot prove that the exact UUID is absent. `null` is the only
	 * successful absence result; a present VM, including one reported stopped,
	 * remains present evidence for the absence-only poll.
	 */
	_observeDeletionVm(entry, budget) {
		const timeout = budget.remainingForObservation();
		const output = this._call(["list", "-a", "-o", "uuid,status,name"], {
			retry: false,
			timeout: Math.max(1, timeout),
			killSignal: "SIGKILL",
			maxBuffer: HOST_READINESS_MAX_BUFFER,
		});
		budget.recheckAfterObservation();
		const rows = parseReadinessInventory(output);
		const match = rows.find(([uuid]) => uuid === entry.uuid);
		if (!match) return null;
		return {
			uuid: match[0],
			status: match[1],
			name: match.slice(2).join(" ").trim(),
		};
	}

	/**
	 * Poll only for exact-UUID absence. A stopped row is not deletion evidence.
	 */
	_awaitDeletionAbsent(entry, budget, cause, initialState = undefined) {
		let current = initialState;
		for (;;) {
			if (current === undefined) {
				try {
					current = this._observeDeletionVm(entry, budget);
				} catch (observationError) {
					throw this._deletionAbsenceUncertainty(
						entry,
						cause,
						observationError,
					);
				}
			}
			if (current === null) return;
			let remaining;
			try {
				remaining = budget.remainingForPoll();
			} catch (budgetError) {
				throw this._deletionAbsenceUncertainty(entry, cause, budgetError);
			}
			if (remaining <= 0) throw cause;
			this.sleepFn(Math.min(this.stopSettlePollMs, remaining));
			current = undefined;
		}
	}

	preflight() {
		return outputText(this._call(["--version"])).trim();
	}

	/**
	 * Prove the read-only Parallels inventory path before a queue occupies a VM
	 * slot. A version check only proves the client binary exists; a complete
	 * `list` response proves the host service can answer the operation needed to
	 * account for managed guests. This probe owns its own small retry budget so
	 * no mutating lifecycle operation inherits a new retry path.
	 *
	 * @param {{onStatus?: Function}} [options]
	 * @returns {{inventoryCount: number}}
	 * @throws {ParallelsHostReadinessError}
	 */
	probeHostReadiness({ onStatus } = {}) {
		const startedAt = this.hostReadinessNowFn();
		const deadline = startedAt + this.hostReadinessTimeoutMs;
		let failure = null;
		for (let attempt = 1; attempt <= this.hostReadinessAttempts; attempt += 1) {
			const elapsedMs = Math.max(0, this.hostReadinessNowFn() - startedAt);
			const remainingMs = Math.floor(deadline - this.hostReadinessNowFn());
			if (remainingMs <= 0) {
				throw new ParallelsHostReadinessError(
					"vm_host_inventory_unavailable",
					failure,
				);
			}
			onStatus?.({
				type: "host-readiness",
				event: "host_readiness_probe",
				status: "Checking Parallels VM inventory readiness",
				attempt,
				elapsedMs,
			});
			try {
				const inventory = parseReadinessInventory(
					this._call(["list", "-a", "-o", "uuid,status,name"], {
						retry: false,
						timeout: remainingMs,
						killSignal: "SIGKILL",
						maxBuffer: HOST_READINESS_MAX_BUFFER,
					}),
				);
				onStatus?.({
					type: "host-readiness",
					event: "host_readiness_ready",
					status: "Parallels VM inventory is ready",
					attempt,
					elapsedMs: Math.max(0, this.hostReadinessNowFn() - startedAt),
					inventoryCount: inventory.length,
				});
				return { inventoryCount: inventory.length };
			} catch (error) {
				const causeCode = prlctlTrustedCauseCode(error);
				const retryable =
					error instanceof PrlctlCallError &&
					["prlctl_job_misfire", "prlctl_session_not_ready"].includes(
						error.diagnosticCode,
					);
				const code =
					["EACCES", "EPERM"].includes(causeCode) ||
					prlctlHostPermissionDenied(error)
						? "vm_host_inventory_permission_denied"
						: !(error instanceof PrlctlCallError) ||
								["ENOENT", "ETIMEDOUT"].includes(causeCode) ||
								error.diagnosticCode === "prlctl_call_timed_out"
							? "vm_host_inventory_unavailable"
							: "vm_host_service_degraded";
				failure = new ParallelsHostReadinessError(code, error);
				if (!retryable || attempt >= this.hostReadinessAttempts) {
					throw failure;
				}
				const jitter = Number(this.hostReadinessJitterFn());
				const boundedJitter = Number.isFinite(jitter)
					? Math.min(1, Math.max(0, jitter))
					: 0;
				const requestedDelayMs = Math.round(
					this.hostReadinessBackoffMs * attempt * (1 + boundedJitter),
				);
				const delayMs = Math.min(
					requestedDelayMs,
					Math.max(0, Math.floor(deadline - this.hostReadinessNowFn())),
				);
				onStatus?.({
					type: "host-readiness",
					event: "host_readiness_wait",
					status: "Waiting to retry Parallels VM inventory readiness",
					attempt,
					elapsedMs: Math.max(0, this.hostReadinessNowFn() - startedAt),
					delayMs,
				});
				if (delayMs > 0) this.sleepFn(delayMs);
			}
		}
		throw failure;
	}

	/**
	 * Build the complete prlctl argument vector for one guest command.
	 *
	 * Two properties of `prlctl exec` shape this, both measured against a live
	 * guest rather than assumed:
	 *
	 * 1. It does not pass its argument vector through. It joins the arguments
	 *    with spaces and the guest applies exactly one round of shell parsing
	 *    to the result, so an unquoted prompt is word-split at its first space
	 *    and the tail of a multi-line argument runs as separate commands.
	 * 2. It cannot carry a byte above 0x7F. Every multi-byte UTF-8 character —
	 *    an em dash, a curly quote, an accented name, CJK, an emoji — corrupts
	 *    the command line the guest reconstructs, which surfaces as an
	 *    unbalanced-quote syntax error rather than as mangled text.
	 *
	 * So the guest command is shell-quoted here and then base64-encoded, and
	 * what crosses the boundary is only the base64 alphabet. Callers append
	 * nothing: `argv` is the whole command, because a transport that never
	 * sees the full vector cannot encode it.
	 *
	 * @param {string} workspaceId
	 * @param {string[]} argv complete guest command vector
	 * @param {{cwd?: string, aquaUid?: string|number, providerUser?: string,
	 *          recordPid?: boolean, env?: string[]}} [options]
	 * @returns {string[]}
	 */
	_buildAquaExecArgs(
		workspaceId,
		argv,
		{
			cwd = "/project",
			aquaUid,
			providerUser,
			recordPid = false,
			env = [],
			cleanupContext = null,
			terminalEvidenceToken = null,
		} = {},
	) {
		const command = normalizeExecArgv(argv);
		const uid = validateUid(aquaUid ?? this.aquaUid);
		const user = validateUser(providerUser ?? this.providerUser);
		const resolvedCwd = resolveWorkspacePath(cwd, user);
		validateGuestPath(resolvedCwd, "cwd");
		const marker = recordPid
			? markerIdentity(workspaceId, cleanupContext)
			: null;
		if (recordPid && !marker) {
			throw new Error(
				"provider/helper process marker requires an exact attempt identity",
			);
		}
		const pidPath = marker
			? providerPidMarkerPath(workspaceId, cleanupContext)
			: null;
		const terminalEvidencePath =
			recordPid && cleanupContext?.operation === "provider"
				? providerTerminalEvidencePath(workspaceId, cleanupContext)
				: null;
		if (
			terminalEvidencePath &&
			(typeof terminalEvidenceToken !== "string" ||
				!isUuid(terminalEvidenceToken))
		) {
			throw new Error("provider terminal evidence token is missing or invalid");
		}
		const quotedCommand = command.map((entry) => shellQuote(entry)).join(" ");
		const launch = `exec ${quotedCommand}`;
		const inner = recordPid
			? terminalEvidencePath
				? `cd ${shellQuote(resolvedCwd)} || exit $?; umask 077; rm -f -- ${shellQuote(terminalEvidencePath)} ${shellQuote(`${terminalEvidencePath}.tmp`)}; trap 'rm -f -- ${shellQuote(pidPath)}' EXIT; ${quotedCommand} <&0 & provider_pid=$!; { printf '%s\\n' "$provider_pid"; printf '%s\\n' ${shellQuote(marker.token)}; } > ${shellQuote(pidPath)}; wait "$provider_pid"; provider_status=$?; { printf '%s\\n' '{"schemaVersion":${PROVIDER_TERMINAL_EVIDENCE_SCHEMA_VERSION},"kind":"${PROVIDER_TERMINAL_EVIDENCE_KIND}","token":"${terminalEvidenceToken}","status":"stopped","exitCode":'; printf '%s\\n' "$provider_status"; printf '%s\\n' '}'; } > ${shellQuote(`${terminalEvidencePath}.tmp`)} && mv -f -- ${shellQuote(`${terminalEvidencePath}.tmp`)} ${shellQuote(terminalEvidencePath)}; exit "$provider_status"`
				: `cd ${shellQuote(resolvedCwd)} || exit $?; trap 'rm -f -- ${shellQuote(pidPath)}' EXIT; ${quotedCommand} <&0 & provider_pid=$!; { printf '%s\\n' "$provider_pid"; printf '%s\\n' ${shellQuote(marker.token)}; } > ${shellQuote(pidPath)}; wait "$provider_pid"; provider_status=$?; exit "$provider_status"`
			: `cd ${shellQuote(resolvedCwd)} && ${launch}`;
		const payload = Buffer.from(inner, "utf8").toString("base64");
		const args = [
			"exec",
			workspaceId,
			"--use-advanced-terminal",
			"launchctl",
			"asuser",
			uid,
			"sudo",
			"-u",
			user,
			// The account's environment has to be established before bash starts,
			// not inside the -c script: `-l` sources /etc/profile and then
			// $HOME/.bash_profile *first*, and with the inherited HOME=/ it would
			// read the wrong profile and leave providers writing their caches to a
			// read-only /.
			"/usr/bin/env",
			`HOME=${providerHomePath(user)}`,
			`USER=${user}`,
			`LOGNAME=${user}`,
			// Extra assignments stay outside the base64 payload so a value that is
			// only known once the transport is running — the bulk-transfer URL and
			// its ephemeral port — can still be substituted into the argv.
			...env.map((entry) => validateEnvAssignment(entry)),
			"/bin/bash",
			"-lc",
			// The decode runs in a command substitution, so the provider still
			// inherits this process's stdin, stdout, stderr and exit status.
			shellQuote(`eval "$(printf %s ${payload} | /usr/bin/base64 -D)"`),
		];
		const totalBytes = args.reduce(
			(total, entry) => total + Buffer.byteLength(entry, "utf8"),
			0,
		);
		if (totalBytes > MAX_AQUA_EXEC_ARGV_BYTES) {
			throw new Error(
				`guest command exceeds the macOS ARG_MAX-safe limit (${totalBytes} bytes > ${MAX_AQUA_EXEC_ARGV_BYTES} bytes); this VM lane cannot execute a payload this large`,
			);
		}
		return args;
	}

	/**
	 * Return the exact transport for one provider command. It runs in the
	 * provider's Aqua session and inherits its stdin, stdout, stderr, exit
	 * status, and killable prlctl process handle.
	 * @param {string[]} [options.env] Extra `KEY=value` assignments for the
	 *   guest process — e.g. an interactive login that needs
	 *   `NO_OPEN_BROWSER=1`. Real dispatch never needs this; it exists for
	 *   `auth/index.mjs`'s interactive login, which shares this exact
	 *   inherit-stdio transport rather than a second one.
	 */
	execArgv(
		workspaceId,
		{
			cwd = "/project",
			aquaUid,
			providerUser,
			argv,
			recordPid = false,
			env,
			cleanupContext = null,
		} = {},
	) {
		const terminalEvidence =
			recordPid && cleanupContext?.operation === "provider"
				? {
						path: providerTerminalEvidencePath(workspaceId, cleanupContext),
						token: randomUUID(),
					}
				: null;
		return {
			command: "prlctl",
			args: this._buildAquaExecArgs(workspaceId, argv, {
				cwd,
				aquaUid,
				providerUser,
				recordPid,
				env,
				cleanupContext,
				terminalEvidenceToken: terminalEvidence?.token ?? null,
			}),
			...(terminalEvidence ? { terminalEvidence } : {}),
		};
	}

	/**
	 * Return the fixed BWS consumer invocation for a one-off OpenCode API-key
	 * dispatch. The request is non-secret stdin: the pinned consumer obtains the
	 * key itself and keeps it out of host argv, guest disk, and auth.json.
	 *
	 * @param {string} workspaceId Linked-clone UUID.
	 * @param {{model:string, invocationArgs:string[], prompt:string, idleSeconds:number}} request
	 * @returns {{command:string, args:string[], input:string}|null}
	 */
	ephemeralOpenCodeKeyExecution(workspaceId, request = {}) {
		if (!UUID.test(String(workspaceId ?? ""))) {
			throw new Error(
				"workspaceId must be a VM UUID for ephemeral OpenCode credentials",
			);
		}
		const model = String(request.model ?? "");
		const prefix = Object.keys(OPENCODE_BWS_CONSUMERS).find((entry) =>
			model.startsWith(entry),
		);
		if (!prefix) return null;
		if (
			!Array.isArray(request.invocationArgs) ||
			request.invocationArgs.some((value) => typeof value !== "string") ||
			typeof request.prompt !== "string" ||
			!Number.isInteger(request.idleSeconds)
		) {
			throw new TypeError("ephemeral OpenCode request is malformed");
		}
		return {
			command: BWS_SECRET_EXEC,
			args: [OPENCODE_BWS_CONSUMERS[prefix], "--"],
			input: JSON.stringify({
				workspaceId: String(workspaceId).replace(/^\{|\}$/g, ""),
				model,
				invocationArgs: request.invocationArgs,
				prompt: request.prompt,
				idleSeconds: request.idleSeconds,
			}),
			cleanupContext: { workspaceId },
		};
	}

	/**
	 * Return the marker path used by execArgv for this VM workspace.
	 * @param {string} workspaceId
	 * @returns {string}
	 */
	providerPidPath(workspaceId, cleanupContext = {}) {
		return providerPidMarkerPath(workspaceId, cleanupContext);
	}

	/** Return the content-free terminal evidence path for one provider attempt. */
	providerTerminalEvidencePath(workspaceId, cleanupContext = {}) {
		const path = providerTerminalEvidencePath(workspaceId, cleanupContext);
		if (!path)
			throw new Error(
				"provider terminal evidence requires an exact provider attempt identity",
			);
		return path;
	}

	/**
	 * Read and validate one provider attempt's terminal status. A transport
	 * exit of 255 is ambiguous by itself; this accepts only a fresh, exact
	 * token-bound, closed sidecar and never invokes the provider command.
	 */
	readProviderTerminalEvidence(
		workspaceId,
		cleanupContext = {},
		{ token, onStatus } = {},
	) {
		const emit = onStatus ?? this.onStatus;
		emit?.({
			phase: "execution",
			event: "provider_terminal_evidence_started",
			status: "Reading provider terminal evidence",
		});
		let path;
		try {
			path = this.providerTerminalEvidencePath(workspaceId, cleanupContext);
		} catch {
			return { status: "uncertain", reason: "evidence_identity_unavailable" };
		}
		if (!isUuid(token)) {
			return { status: "uncertain", reason: "evidence_identity_unavailable" };
		}
		let raw;
		try {
			raw = this.execGuest(workspaceId, "/bin/cat", [path], {
				cwd: "/",
				// Read one extra byte so an oversized sidecar is distinguishable
				// from an unavailable transport while keeping the read bounded.
				prlctlOptions: {
					maxBuffer: PROVIDER_TERMINAL_EVIDENCE_MAX_BYTES + 1,
				},
			});
		} catch {
			return { status: "uncertain", reason: "evidence_missing_or_unreadable" };
		}
		const text = outputText(raw);
		if (
			Buffer.byteLength(text, "utf8") > PROVIDER_TERMINAL_EVIDENCE_MAX_BYTES
		) {
			return { status: "uncertain", reason: "evidence_oversized" };
		}
		let record;
		try {
			record = JSON.parse(text);
		} catch {
			return { status: "uncertain", reason: "evidence_malformed" };
		}
		const fields = ["schemaVersion", "kind", "token", "status", "exitCode"];
		if (
			!record ||
			typeof record !== "object" ||
			Array.isArray(record) ||
			Object.keys(record).length !== fields.length ||
			fields.some((field) => !Object.hasOwn(record, field)) ||
			record.schemaVersion !== PROVIDER_TERMINAL_EVIDENCE_SCHEMA_VERSION ||
			record.kind !== PROVIDER_TERMINAL_EVIDENCE_KIND ||
			record.token !== token ||
			record.status !== "stopped" ||
			!Number.isSafeInteger(record.exitCode) ||
			record.exitCode < 0 ||
			record.exitCode > 255
		) {
			return { status: "uncertain", reason: "evidence_mismatched" };
		}
		emit?.({
			phase: "execution",
			event: "provider_terminal_evidence_completed",
			status: "Provider terminal evidence confirmed",
		});
		return { status: "confirmed", exitCode: record.exitCode };
	}

	/** Remove confirmed terminal evidence without touching an uncertain file. */
	clearProviderTerminalEvidence(
		workspaceId,
		cleanupContext = {},
		{ onStatus } = {},
	) {
		const emit = onStatus ?? this.onStatus;
		try {
			const path = this.providerTerminalEvidencePath(
				workspaceId,
				cleanupContext,
			);
			this.execGuest(workspaceId, "/bin/rm", ["-f", "--", path], {
				cwd: "/",
			});
			emit?.({
				phase: "execution",
				event: "provider_terminal_evidence_removed",
				status: "Provider terminal evidence removed",
			});
			return { status: "removed" };
		} catch {
			return { status: "uncertain", reason: "evidence_cleanup_uncertain" };
		}
	}

	/** @returns {string} */
	get kind() {
		return "macos";
	}

	/**
	 * Home directory of the provider user in the guest. macOS-shaped because
	 * this backend is macOS; adapters ask for it instead of assembling it so
	 * that the shape stays a backend fact.
	 * @returns {string}
	 */
	guestHomePath() {
		return providerHomePath(this.providerUser);
	}

	/** Execute one small control command through the same Aqua identity route. */
	execGuest(workspaceId, command, args = [], options = {}) {
		if (
			typeof command !== "string" ||
			!/^[A-Za-z0-9._+@%/=:-]+$/.test(command)
		) {
			throw new Error("guest command must be a safe executable name");
		}
		if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
			throw new TypeError("guest command arguments must be strings");
		}
		// Misfires are retried here. This is the small-control-command route, and
		// every caller is an inspection, provisioning or cleanup command that is
		// safe to repeat: read a marker, set a mode, `rm -f`, confirm a process
		// tree is already gone, ask a CLI its version, check a credential's size.
		// Paid provider work does not arrive here. Adapters execute through the
		// `execArgv` descriptor, which the caller spawns itself and which never
		// reaches this retry at all. That separation is a contract rather than a
		// physical barrier -- auth/liveness.mjs does invoke a provider CLI through
		// this path, and opts in knowingly at its own call site -- so a caller
		// whose command is NOT safe to repeat must say so with
		// `prlctlOptions: { retry: false }` and record why.
		return this._call(
			this._buildAquaExecArgs(workspaceId, [command, ...args], options),
			{ retry: true, ...(options.prlctlOptions ?? {}) },
		);
	}

	/**
	 * Read a PID marker written by a future launch wrapper. Task 4.2 has no
	 * caller that needs a supervisor; this helper keeps the guest PID handoff
	 * explicit for the timeout task without adding one.
	 */
	getGuestPid(workspaceId, pidPath, cleanupContext = {}) {
		validateGuestPath(pidPath, "pidPath");
		const identity = markerIdentity(workspaceId, cleanupContext);
		if (!identity?.strongStart)
			throw new Error("guest PID marker process-start identity is unknown");
		const output = outputText(
			this.execGuest(workspaceId, "/bin/cat", [pidPath], { cwd: "/" }),
		).trim();
		const [pidText, markerToken, ...extra] = output.split(/\r?\n/);
		if (
			!/^\d+$/.test(pidText) ||
			Number(pidText) <= 0 ||
			markerToken !== identity.token ||
			extra.length > 0
		) {
			throw new Error("guest PID marker was missing or invalid");
		}
		return Number(pidText);
	}

	_runBulkTransfer({ direction, workspaceId, payload, guestArgs }) {
		const tar = direction === "push" ? validateTar(payload) : Buffer.alloc(0);
		// pf anchor names are bounded by the kernel's fixed buffer. The golden
		// ruleset already delegates this child namespace, so an 8-byte random
		// suffix is sufficient without exceeding that bound.
		const anchor = `com.apple/switchyard-c3/switchyard-transfer/${randomUUID()
			.replaceAll("-", "")
			.slice(0, 8)}`;
		const config = {
			direction,
			transferHost: this.transferHost,
			listenHost: this.transferListenHost,
			maxBytes: this.maxTransferBytes,
			misfireSource: PRLCTL_JOB_MISFIRE.source,
			retryAttempts: this.prlctlRetryAttempts,
			retryBackoffMs: this.prlctlRetryBackoffMs,
			guestArgs,
			pfArgs: ["exec", workspaceId, "/sbin/pfctl", "-a", anchor, "-f", "-"],
			cleanupArgs: [
				"exec",
				workspaceId,
				"/sbin/pfctl",
				"-a",
				anchor,
				"-F",
				"all",
			],
		};
		const descriptor = { ...config, workspaceId, tar };
		if (typeof this.bulkTransferFn === "function") {
			const result = this.bulkTransferFn(descriptor);
			if (direction === "pull") return validateTar(result);
			return {
				bytes: tar.length,
				sha256: createHash("sha256").update(tar).digest("hex"),
				...(result && typeof result === "object" ? result : {}),
			};
		}

		const input = Buffer.concat([
			Buffer.from(`${JSON.stringify(config)}\n`, "utf8"),
			tar,
		]);
		const result = spawnSync(
			process.execPath,
			["--input-type=module", "-e", BULK_TRANSFER_HELPER],
			{
				input,
				encoding: null,
				maxBuffer: this.maxTransferBytes + 1024 * 1024,
			},
		);
		if (result.error || result.status !== 0) {
			throw describeBulkTransferFailure(
				outputText(result.stderr).trim(),
				result.error ?? null,
			);
		}
		const output = Buffer.from(result.stdout ?? Buffer.alloc(0));
		const separator = output.indexOf(10);
		if (separator < 0)
			throw new Error("Parallels bulk transfer returned no receipt");
		let receipt;
		try {
			receipt = JSON.parse(output.subarray(0, separator).toString("utf8"));
		} catch {
			throw new Error("Parallels bulk transfer returned an invalid receipt");
		}
		if (direction === "pull")
			return validateTar(output.subarray(separator + 1));
		return receipt;
	}

	/**
	 * Transfer a tar to a guest directory through a temporary host HTTP
	 * endpoint. The endpoint is permitted by one guest-only pf anchor and the
	 * anchor is flushed in the helper's finally path.
	 */
	pushTar(workspaceId, tar, destination = "/project", options = {}) {
		const user = validateUser(options.providerUser ?? this.providerUser);
		const resolvedDestination = resolveWorkspacePath(destination, user);
		validateGuestPath(resolvedDestination, "destination");
		// A caller that knows exactly which paths it extracted can name them and
		// skip the recursive sweep below. Credential provisioning must: one of
		// claude's two files lives at the root of the provider's home, so a
		// `chown -R` of that destination would descend through the seeded
		// workspace and everything else the account owns.
		const chownTargets =
			Array.isArray(options.chownTargets) && options.chownTargets.length > 0
				? options.chownTargets.map((value) =>
						validateGuestPath(resolveWorkspacePath(value, user), "chownTarget"),
					)
				: null;
		const script =
			`set -o pipefail; /bin/mkdir -p -- ${shellQuote(resolvedDestination)} && ` +
			`/usr/bin/curl --fail --silent --show-error --location --retry 15 --retry-delay 1 --retry-connrefused --output - "$SWITCHYARD_XFER_URL" | ` +
			`/usr/bin/tar -xpf - -C ${shellQuote(resolvedDestination)}`;
		const guestArgs =
			options.providerUser || options.aquaUid
				? this._buildAquaExecArgs(workspaceId, ["/bin/bash", "-lc", script], {
						cwd: "/",
						aquaUid: options.aquaUid,
						providerUser: options.providerUser,
						env: [XFER_URL_ASSIGNMENT],
					})
				: [
						"exec",
						workspaceId,
						"/usr/bin/env",
						XFER_URL_ASSIGNMENT,
						"/bin/bash",
						"-lc",
						shellQuote(script),
					];
		const receipt = this._runBulkTransfer({
			direction: "push",
			workspaceId,
			payload: tar,
			guestArgs,
		});
		// BSD tar preserves the archive's root ownership even when the
		// extraction is initiated by the provider account. Normalize only the
		// destination subtree so generated Xcode projects and Git metadata are
		// writable without weakening the sealed system volume.
		this._call(
			chownTargets
				? ["exec", workspaceId, "/usr/sbin/chown", user, ...chownTargets]
				: [
						"exec",
						workspaceId,
						"/usr/sbin/chown",
						"-R",
						user,
						resolvedDestination,
					],
		);
		return receipt;
	}

	/** Pull a guest path through the same in-memory HTTP endpoint. */
	pullTar(workspaceId, sourcePath, options = {}) {
		const user = validateUser(options.providerUser ?? this.providerUser);
		const resolvedSourcePath = resolveWorkspacePath(sourcePath, user);
		validateGuestPath(resolvedSourcePath, "sourcePath");
		const parent = dirname(resolvedSourcePath);
		const name = basename(resolvedSourcePath);
		const script =
			`/usr/bin/tar -cpf - -C ${shellQuote(parent)} ${shellQuote(name)} | ` +
			`/usr/bin/curl --fail --silent --show-error --request PUT --data-binary @- "$SWITCHYARD_XFER_URL"`;
		const guestArgs =
			options.providerUser || options.aquaUid
				? this._buildAquaExecArgs(workspaceId, ["/bin/bash", "-lc", script], {
						cwd: "/",
						aquaUid: options.aquaUid,
						providerUser: options.providerUser,
						env: [XFER_URL_ASSIGNMENT],
					})
				: [
						"exec",
						workspaceId,
						"/usr/bin/env",
						XFER_URL_ASSIGNMENT,
						"/bin/bash",
						"-lc",
						shellQuote(script),
					];
		return this._runBulkTransfer({ direction: "pull", workspaceId, guestArgs });
	}

	/**
	 * Provision one Task 1.3 tar-provisionable provider's credential files into
	 * the provider's home. Unknown or non-tar providers fail closed; there is no
	 * Keychain copy fallback and no guest-side supervisor.
	 *
	 * `credentials` is a list because a provider can need more than one file at
	 * more than one depth, and the caller supplies each file's bytes while this
	 * method owns the allowlist — a caller cannot name a destination, only pick
	 * from the measured layout.
	 * @param {string} workspaceId VM UUID
	 * @param {object} options
	 * @param {string} options.provider Routed provider name
	 * @param {{file: string, tar: Buffer}[]} options.credentials Home-relative
	 *   path plus its in-memory tar, one entry per file in the provider's layout
	 * @param {number|string} [options.aquaUid] Guest Aqua UID
	 * @param {string} [options.providerUser] Guest provider account
	 */
	provisionCredentials(
		workspaceId,
		{ provider, credentials, aquaUid, providerUser } = {},
	) {
		const providerKey = String(provider ?? "").toLowerCase();
		const layout = VM_CREDENTIAL_LAYOUTS[providerKey];
		if (!layout)
			throw new Error(
				`provider is not tar-provisionable on macOS: ${provider}`,
			);
		const supplied = new Map();
		for (const entry of Array.isArray(credentials) ? credentials : []) {
			const file = String(entry?.file ?? "");
			if (!layout.includes(file))
				throw new Error(
					`unexpected credential file for ${providerKey}: ${file}`,
				);
			supplied.set(file, entry.tar);
		}
		// Every file in the layout, or none. claude is why this is a list and not
		// a single path: measured in the guest, it reports `"loggedIn": false`
		// with `.claude.json` alone and with `.claude/.credentials.json` alone.
		// A partial push would leave a guest that looks provisioned and behaves
		// unauthenticated, which is the PM3-5 failure the layout exists to stop.
		for (const file of layout) {
			if (!supplied.has(file))
				throw new Error(`missing credential file for ${providerKey}: ${file}`);
		}
		const user = validateUser(providerUser ?? this.providerUser);
		const files = layout.map((file) => {
			const credentialPath = validateGuestPath(
				`${providerHomePath(user)}/${file}`,
				"credentialPath",
			);
			const receipt = this.pushTar(
				workspaceId,
				supplied.get(file),
				dirname(credentialPath),
				{ aquaUid, providerUser: user, chownTargets: [credentialPath] },
			);
			// The transfer runs as the provider account. This chmod is deliberately
			// also routed through Aqua so the auth check measures the same identity.
			this.execGuest(workspaceId, "/bin/chmod", ["600", credentialPath], {
				cwd: "/",
				aquaUid,
				providerUser: user,
			});
			return { path: credentialPath, ...receipt };
		});
		return { provider: providerKey, files };
	}

	/** Inspect provider processes from the same Aqua identity as execution. */
	inspectProcess(workspaceId) {
		return this._call(
			this._buildAquaExecArgs(
				workspaceId,
				["/bin/ps", "-axo", "pid=,command="],
				{ cwd: "/" },
			),
		);
	}

	/**
	 * Kill the recorded provider tree in a VM, then clear its stale Git lock.
	 * This is called through provider-lifecycle's existing cleanup parameter;
	 * it never destroys the VM.
	 * @param {string} command
	 * @param {string[]} args
	 * @returns {{workspaceId: string, pid: number}}
	 */
	cleanupProviderProcess(
		command,
		args,
		{ onStatus, workspaceId: requestedWorkspaceId, ...cleanupContext } = {},
	) {
		const bridgeInvocation =
			command === BWS_SECRET_EXEC &&
			Array.isArray(args) &&
			Object.values(OPENCODE_BWS_CONSUMERS).includes(args[0]);
		if (
			(command !== "prlctl" || !Array.isArray(args) || args[0] !== "exec") &&
			!bridgeInvocation
		) {
			return null;
		}
		const workspaceId = bridgeInvocation ? requestedWorkspaceId : args[1];
		if (typeof workspaceId !== "string" || workspaceId.length === 0) {
			throw new Error("Parallels provider cleanup received no VM handle");
		}
		const ownerContext = {
			...cleanupContext,
			workspaceId: requestedWorkspaceId ?? workspaceId,
		};
		const marker = markerIdentity(workspaceId, ownerContext);
		if (!marker || !["provider", "helper"].includes(ownerContext.operation)) {
			throw new Error(
				"refusing process cleanup without matching attempt identity",
			);
		}
		const pidPath = this.providerPidPath(workspaceId, ownerContext);
		let cleanupStage = CLEANUP_STARTED;
		onStatus?.({
			phase: "execution",
			event: "provider_cleanup_started",
			status: "Guest provider cleanup started",
		});
		try {
			const pid = this.getGuestPid(workspaceId, pidPath, ownerContext);
			cleanupStage = PID_OBSERVED;
			onStatus?.({
				phase: "execution",
				event: "provider_pid_observed",
				status: "Guest provider PID observed",
			});
			this.execGuest(
				workspaceId,
				"/bin/bash",
				["-lc", KILL_GUEST_PROCESS_TREE, "switchyard-kill-tree", String(pid)],
				{ cwd: "/" },
			);
			cleanupStage = TREE_TERMINATED;
			onStatus?.({
				phase: "execution",
				event: "provider_tree_gone",
				status: "Guest provider tree confirmed gone",
			});
			this.execGuest(workspaceId, "/bin/rm", ["-f", "--", pidPath], {
				cwd: "/",
			});
			cleanupStage = PID_MARKER_REMOVED;
			onStatus?.({
				phase: "execution",
				event: "provider_pid_marker_removed",
				status: "Guest provider PID marker removed",
			});
			this.execGuest(workspaceId, "/bin/rm", ["-f", "--", INDEX_LOCK_PATH], {
				cwd: "/",
			});
			cleanupStage = INDEX_LOCK_REMOVED;
			onStatus?.({
				phase: "execution",
				event: "provider_index_lock_removed",
				status: "Guest Git index lock removed",
			});
			onStatus?.({
				phase: "execution",
				event: "provider_cleanup_complete",
				status: "Guest provider cleanup complete; VM retained",
			});
			return { cleanupStage, workspaceId, pid };
		} catch (error) {
			if (error && typeof error === "object") error.cleanupStage = cleanupStage;
			// Two causes reach here and the bare event could not tell them
			// apart: the kill script ran and reported survivors (execFileSync
			// sets `status`), or the guest exec never ran at all (a transport
			// failure sets `code`/`signal` and no status). Carrying the stage
			// and the exit status makes one event self-describing instead of
			// requiring the reader to infer the stage from which later events
			// are absent. All three values are content-free: a name from a
			// fixed set, an integer, and a signal name.
			const status = error?.status;
			const signal = error?.signal;
			onStatus?.({
				phase: "execution",
				event: "provider_cleanup_failed",
				status: "Guest provider cleanup could not confirm process exit",
				cleanupStage,
				...(Number.isSafeInteger(status) ? { exitCode: status } : {}),
				...(typeof signal === "string" ? { signal } : {}),
			});
			throw error;
		}
	}

	listAll() {
		return parseVmList(this._call(["list", "-a", "-o", "uuid,status,name"]));
	}

	/**
	 * List only VMs whose complete reserved name proves a Switchyard owner.
	 * Foreign and malformed-prefix VMs are intentionally omitted.
	 */
	listManaged() {
		return this.listAll()
			.filter((entry) => entry.ownership)
			.map(({ ownership, ...entry }) => ({ ...entry, ...ownership }));
	}

	resolveHandle(handle, { allowUnmanaged = false } = {}) {
		const requested =
			handle && typeof handle === "object"
				? { uuid: handle.uuid, name: handle.name }
				: isUuid(handle)
					? { uuid: handle, name: null }
					: { uuid: null, name: handle };
		if (!requested.uuid && !requested.name) {
			throw new Error("VM handle must be a Parallels UUID or VM name");
		}
		const entry = this.listAll().find((candidate) => {
			if (requested.uuid && candidate.uuid !== requested.uuid) return false;
			if (requested.name && candidate.name !== requested.name) return false;
			return true;
		});
		if (!entry) throw new Error("VM handle does not identify an existing VM");
		if (!entry.ownership && !allowUnmanaged) {
			throw new Error(`refusing unmanaged Parallels VM: ${entry.name}`);
		}
		return entry.ownership ? { ...entry, ...entry.ownership } : entry;
	}

	assertGoldenImageAvailable(goldenImage = this.goldenImage) {
		const owned = this.listManaged();
		if (owned.length > 0) {
			const names = owned.map((entry) => entry.name).join(", ");
			throw new Error(
				`refusing golden image ${goldenImage ?? "<unnamed>"}: owned clones exist (${names})`,
			);
		}
		return true;
	}

	/** Start the golden image only when no owned clone can reference it. */
	bootGoldenImage(goldenImage = this.goldenImage, options = {}) {
		if (!goldenImage) throw new Error("goldenImage is required");
		this.assertGoldenImageAvailable(goldenImage);
		const entry = this.resolveHandle(goldenImage, { allowUnmanaged: true });
		return this.boot(entry.uuid, {
			...options,
			skipGoldenCheck: true,
			allowUnmanaged: true,
		});
	}

	/**
	 * Stop the golden image itself — never delete it. `destroy()`/`stopAndDelete()`
	 * are for disposable managed clones; the golden image is the one VM every
	 * future clone is made from, so this method's entire reason to exist is to
	 * NOT be those. Used to leave the golden image stopped again after
	 * `auth/index.mjs` boots it directly to check or refresh a provider's
	 * credential, so a subsequent dispatch's `bootGoldenImage()`/clone is not
	 * blocked by it still running.
	 */
	stopGoldenImage(handle = this.goldenImage) {
		if (!handle) throw new Error("goldenImage is required");
		const entry = this.resolveHandle(handle, { allowUnmanaged: true });
		this._call(["stop", entry.uuid]);
		// The whole point of this method is that the next bootGoldenImage() or
		// clone is not blocked by the golden still running, which is exactly the
		// postcondition a false success breaks. No `--kill` escalation here: the
		// golden is not disposable, so a golden that will not stop is reported to
		// the caller rather than forced.
		this._assertNotRunning(
			entry,
			"prlctl stop exited 0",
			this.goldenStopSettleTimeoutMs,
		);
		return { uuid: entry.uuid, name: entry.name, status: "stopped" };
	}

	/**
	 * Boot a managed VM and wait for its Aqua launchd domain.
	 * @returns {{uuid: string, name: string, status: string}}
	 */
	boot(handle, options = {}) {
		const entry = this.resolveHandle(handle, {
			allowUnmanaged: options.allowUnmanaged === true,
		});
		const golden = options.goldenImage ?? this.goldenImage;
		if (!options.skipGoldenCheck && golden && entry.name === golden) {
			this.assertGoldenImageAvailable(golden);
		}
		if (this.enableLostMutationReconciliation) {
			const identity = this._lostMutationIdentity(
				entry,
				options.allowUnmanaged === true,
			);
			try {
				// A lost SDK result is ambiguous. Do not let _call replay start before
				// the exact owned VM's authoritative running state is observed.
				this._call(["start", entry.uuid], { retry: false });
			} catch (error) {
				this._reconcileLostMutation(
					error,
					(budget) =>
						/^running$/i.test(
							this._observeExactVm(entry, budget, identity).status,
						),
					{ operation: "start", onStatus: options.onStatus },
				);
			}
		} else {
			// Preserve the legacy generic-retry behavior until the explicit gate is
			// activated after its attended disposable-VM observation.
			(options.onStatus ?? this.onStatus)?.({
				type: "lost-mutation-reconciliation",
				event: "unavailable",
				operation: "start",
			});
			this._call(["start", entry.uuid]);
		}
		this.waitForAqua(entry.uuid, options);
		return { uuid: entry.uuid, name: entry.name, status: "running" };
	}

	waitForAqua(uuid, options = {}) {
		const uid = options.aquaUid ?? this.aquaUid;
		if (!/^\d+$/.test(String(uid ?? ""))) {
			throw new Error("aquaUid is required to probe the Aqua launchd domain");
		}
		const domain = `gui/${uid}`;
		const timeoutMs = options.aquaTimeoutMs ?? this.aquaTimeoutMs;
		const pollMs = options.aquaPollMs ?? this.aquaPollMs;
		const onStatus = options.onStatus;
		const startedAt = this.nowFn();
		const emit = (event) => {
			if (typeof onStatus === "function") onStatus(event);
		};

		for (;;) {
			try {
				this._call(["exec", uuid, "launchctl", "print", domain], {
					timeout: Math.max(1, Math.min(5_000, timeoutMs)),
				});
				emit({ type: "aqua-ready", uuid, domain });
				return;
			} catch (error) {
				const elapsedMs = this.nowFn() - startedAt;
				if (elapsedMs >= timeoutMs) {
					throw new Error(
						`Aqua domain ${domain} was not ready within ${timeoutMs}ms`,
						{ cause: error },
					);
				}
				emit({ type: "aqua-wait", uuid, domain, elapsedMs });
				this.sleepFn(Math.min(pollMs, timeoutMs - elapsedMs));
			}
		}
	}

	listSnapshotIds(goldenImage) {
		return snapshotIdsFromOutput(this._call(["snapshot-list", goldenImage]));
	}

	deleteSnapshots(goldenImage, snapshotIds, options = {}) {
		const gatedGolden = this.enableLostMutationReconciliation
			? this.resolveHandle(goldenImage, { allowUnmanaged: true })
			: null;
		for (const snapshotId of snapshotIds) {
			if (!this.enableLostMutationReconciliation) {
				(options.onStatus ?? this.onStatus)?.({
					type: "lost-mutation-reconciliation",
					event: "unavailable",
					operation: "snapshot_delete",
				});
				this._call(["snapshot-delete", goldenImage, "--id", snapshotId]);
				continue;
			}
			const exactSnapshotId = normalizedUuid(snapshotId);
			if (!exactSnapshotId) {
				throw new Error("snapshot deletion requires an exact snapshot UUID");
			}
			try {
				this._call(["snapshot-delete", gatedGolden.uuid, "--id", snapshotId], {
					retry: false,
				});
			} catch (error) {
				this._reconcileLostMutation(
					error,
					(budget) =>
						!this._observeSnapshotIds(gatedGolden, budget).has(exactSnapshotId),
					{ operation: "snapshot_delete", onStatus: options.onStatus },
				);
			}
		}
	}

	/**
	 * Directory holding one sidecar per linked clone, or null when no durable
	 * root was injected.
	 * @returns {string|null}
	 */
	snapshotSidecarDir() {
		return this.snapshotSidecarRoot
			? join(this.snapshotSidecarRoot, "linked-snapshots")
			: null;
	}

	/**
	 * Map a Parallels uuid to a sidecar filename.
	 *
	 * Parallels reports uuids brace-wrapped (`{9f6e...}`). Strip everything
	 * outside the hex-and-dash alphabet so the value can never traverse out of
	 * the sidecar directory or name a file the caller did not intend.
	 * @param {string} uuid
	 * @returns {string|null} null when the uuid has no usable characters
	 */
	snapshotSidecarPath(uuid) {
		const dir = this.snapshotSidecarDir();
		if (!dir || typeof uuid !== "string") return null;
		const safe = uuid.replace(/[^A-Za-z0-9-]/g, "");
		return safe ? join(dir, `${safe}.json`) : null;
	}

	/**
	 * Record which golden-image snapshots a clone created, durably.
	 *
	 * The in-process map is enough for destroy() but useless to reclaim(),
	 * which runs in a different process against VMs whose creator is dead. Left
	 * in-process only, every crashed or killed run leaks its parent snapshot
	 * onto the one VM that is not disposable: one such orphan sat on
	 * switchyard-golden-6 for 13 days.
	 *
	 * Throws rather than swallowing. A lost sidecar is exactly the orphan this
	 * record exists to prevent, and create()'s caller already rolls the clone
	 * and its snapshots back when this stage fails.
	 * @param {string} uuid clone VM uuid
	 * @param {{goldenImage: string, snapshotIds: string[]}} metadata
	 */
	writeSnapshotSidecar(uuid, metadata) {
		const path = this.snapshotSidecarPath(uuid);
		if (!path) return;
		mkdirSync(this.snapshotSidecarDir(), { recursive: true });
		writeFileSync(
			path,
			`${JSON.stringify({
				vmUuid: uuid,
				goldenImage: metadata.goldenImage,
				snapshotIds: metadata.snapshotIds,
				runId: this.runId,
				creatorPid: this.creatorPid,
				recordedAt: this.nowFn(),
			})}\n`,
			"utf8",
		);
	}

	/**
	 * Read a clone's sidecar, or null when it is missing, unreadable, or does
	 * not carry the two fields a delete decision needs. A corrupt sidecar is
	 * treated as absent: the snapshots then survive for human review, which is
	 * the safe direction on an image that cannot be recreated cheaply.
	 * @param {string} uuid
	 * @returns {{goldenImage: string, snapshotIds: string[]}|null}
	 */
	readSnapshotSidecar(uuid) {
		const path = this.snapshotSidecarPath(uuid);
		if (!path) return null;
		let parsed;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return null;
		}
		if (!parsed || typeof parsed.goldenImage !== "string") return null;
		if (!Array.isArray(parsed.snapshotIds)) return null;
		const snapshotIds = parsed.snapshotIds.filter(
			(id) => typeof id === "string" && id.length > 0,
		);
		if (snapshotIds.length !== parsed.snapshotIds.length) return null;
		return { ...parsed, snapshotIds };
	}

	/** Remove a clone's sidecar. Absent is success. */
	deleteSnapshotSidecar(uuid) {
		const path = this.snapshotSidecarPath(uuid);
		if (path) rmSync(path, { force: true });
	}

	cleanupLinkedSnapshots(goldenImage, snapshotIds) {
		if (!goldenImage || !snapshotIds?.length) return;
		const remaining = snapshotDifference(
			this.listSnapshotIds(goldenImage),
			new Set(),
		).filter((snapshotId) => snapshotIds.includes(snapshotId));
		if (remaining.length > 0) this.deleteSnapshots(goldenImage, remaining);
	}

	captureCreatorOwnership(options = {}) {
		const ownership = ownershipContextFor(options, this);
		let probe;
		try {
			probe = this.hostProcessIdentityProbe(ownership.creatorPid, {
				onStatus: options.onStatus,
			});
		} catch {
			probe = { state: "unknown" };
		}
		const captured =
			probe?.state === "present"
				? parseHostProcessIdentity(probe.identity)
				: null;
		if (!captured || captured.pid !== ownership.creatorPid) {
			throw new Error(
				"VM allocation refused: host creator birth identity unavailable",
			);
		}
		if (
			ownership.processStartIdentity !== null &&
			ownership.processStartIdentity !== captured.identity
		) {
			throw new Error(
				"VM allocation refused: host creator birth identity changed",
			);
		}
		return Object.freeze({
			...ownership,
			processStartIdentity: captured.identity,
		});
	}

	vmOwnershipPath(uuid, resourceRoot) {
		if (
			typeof uuid !== "string" ||
			!/^[A-Za-z0-9{}-]+$/.test(uuid) ||
			typeof resourceRoot !== "string" ||
			!isAbsolute(resourceRoot)
		)
			return null;
		return join(
			resourceRoot,
			`parallels-vm-${String(uuid).replace(/[^A-Za-z0-9-]/g, "")}.json`,
		);
	}

	allocationIntentPath(name, resourceRoot) {
		const token = createHash("sha256").update(String(name)).digest("hex");
		return join(
			resourceRoot,
			`${ALLOCATION_INTENT_PREFIX}${token}${ALLOCATION_INTENT_SUFFIX}`,
		);
	}

	/**
	 * Audit allocation intents under caller-enumerated run resource roots.
	 * This method is read-only: it never invokes prlctl or changes an intent.
	 */
	auditAllocationIntents({ knownResourceRoots = [] } = {}) {
		const audits = [];
		for (const root of knownResourceRoots) {
			const resourceRoot = root?.resourceRoot;
			if (
				typeof resourceRoot !== "string" ||
				!isAbsolute(resourceRoot) ||
				resolve(resourceRoot) !== resourceRoot
			) {
				audits.push({
					file: null,
					runId: null,
					vmName: null,
					classification: "unknown",
					reason: "resource_root_unknown",
				});
				continue;
			}
			let entries;
			try {
				const stat = lstatSync(resourceRoot);
				if (!stat.isDirectory() || stat.isSymbolicLink()) {
					throw new Error("not an owned directory");
				}
				entries = readdirSync(resourceRoot, { withFileTypes: true });
			} catch (error) {
				if (error?.code === "ENOENT") continue;
				audits.push({
					file: null,
					runId: typeof root?.runId === "string" ? root.runId : null,
					vmName: null,
					classification: "unknown",
					reason: "resource_root_unreadable",
				});
				continue;
			}
			for (const entry of entries
				.filter((candidate) =>
					candidate.name.startsWith(ALLOCATION_INTENT_PREFIX),
				)
				.sort((left, right) => left.name.localeCompare(right.name))) {
				const base = {
					file: entry.name,
					runId: null,
					vmName: null,
				};
				const filePattern =
					/^parallels-allocation-([0-9a-f]{64})\.intent\.json$/u;
				const fileMatch = entry.name.match(filePattern);
				let record;
				try {
					if (!entry.isFile() || !fileMatch) {
						throw new Error("invalid intent file");
					}
					record = JSON.parse(
						readFileSync(join(resourceRoot, entry.name), "utf8"),
					);
				} catch {
					audits.push({
						...base,
						classification: "malformed",
						reason: "intent_malformed",
					});
					continue;
				}
				const parsedName = parseParallelsWorkingName(record?.vmName);
				const uncertain = record?.state === "cleanup_uncertain";
				const expectedFields = new Set([
					"schemaVersion",
					"kind",
					"vmName",
					"resourceRoot",
					"runId",
					"taskId",
					"attemptId",
					"projectRoot",
					"purpose",
					"creatorPid",
					"processStartIdentity",
					"createdAt",
					...(uncertain ? ["state", "reasonCode"] : []),
				]);
				const malformed =
					!record ||
					typeof record !== "object" ||
					Array.isArray(record) ||
					Object.keys(record).length !== expectedFields.size ||
					Object.keys(record).some((field) => !expectedFields.has(field)) ||
					record.schemaVersion !== VM_OWNERSHIP_SCHEMA_VERSION ||
					record.kind !== "parallels_vm_allocation_intent" ||
					!parsedName ||
					parsedName.runId !== record.runId ||
					parsedName.creatorPid !== record.creatorPid ||
					fileMatch?.[1] !==
						createHash("sha256").update(String(record.vmName)).digest("hex") ||
					record.resourceRoot !== resourceRoot ||
					!isBoundedRecordText(record.runId, 256) ||
					!isBoundedRecordText(record.taskId, 256) ||
					!isBoundedRecordText(record.attemptId, 256) ||
					!isAbsolute(record.projectRoot) ||
					record.projectRoot !== resolve(record.projectRoot) ||
					!isBoundedRecordText(record.purpose, 128) ||
					!Number.isSafeInteger(record.creatorPid) ||
					record.creatorPid <= 0 ||
					parseHostProcessIdentity(record.processStartIdentity)?.pid !==
						record.creatorPid ||
					!Number.isFinite(record.createdAt) ||
					(uncertain && !isBoundedRecordText(record.reasonCode, 128));
				if (malformed) {
					audits.push({
						...base,
						classification: "malformed",
						reason: "intent_malformed",
					});
					continue;
				}

				const identified = {
					file: entry.name,
					runId: record.runId,
					vmName: record.vmName,
				};
				if (root.runRecordStatus !== "valid") {
					audits.push({
						...identified,
						classification: "unknown",
						reason:
							root.runRecordStatus === "missing"
								? "run_missing"
								: "run_record_unknown",
					});
					continue;
				}
				if (
					record.runId !== root.runId ||
					typeof root.projectPath !== "string" ||
					record.projectRoot !== resolve(root.projectPath)
				) {
					audits.push({
						...identified,
						classification: "unknown",
						reason: "run_identity_mismatch",
					});
					continue;
				}
				if (
					root.cleanupState !== "failed" &&
					["dead", "terminal_clean"].includes(root.liveness)
				) {
					audits.push({
						...identified,
						classification: "stale",
						reason: "stale_run",
					});
					continue;
				}
				if (["live", "startup_grace"].includes(root.liveness)) {
					audits.push({
						...identified,
						classification: "valid",
						reason: "active_run",
					});
					continue;
				}
				audits.push({
					...identified,
					classification: "unknown",
					reason:
						root.cleanupState === "failed"
							? "cleanup_failed"
							: "liveness_unknown",
				});
			}
		}
		return audits;
	}

	writeAllocationIntent(name, ownership) {
		mkdirSync(ownership.resourceRoot, { recursive: true, mode: 0o700 });
		writeFileSync(
			this.allocationIntentPath(name, ownership.resourceRoot),
			`${JSON.stringify({
				schemaVersion: VM_OWNERSHIP_SCHEMA_VERSION,
				kind: "parallels_vm_allocation_intent",
				vmName: name,
				...ownership,
				createdAt: this.nowFn(),
			})}\n`,
			"utf8",
		);
	}

	writeAllocationUncertainty(name, ownership, reasonCode) {
		writeFileSync(
			this.allocationIntentPath(name, ownership.resourceRoot),
			`${JSON.stringify({
				schemaVersion: VM_OWNERSHIP_SCHEMA_VERSION,
				kind: "parallels_vm_allocation_intent",
				state: "cleanup_uncertain",
				reasonCode,
				vmName: name,
				...ownership,
				createdAt: this.nowFn(),
			})}\n`,
			"utf8",
		);
	}

	writeVmOwnership(uuid, name, ownership) {
		const path = this.vmOwnershipPath(uuid, ownership.resourceRoot);
		if (!path)
			throw new Error("VM ownership metadata requires an exact VM UUID");
		if (
			parseHostProcessIdentity(ownership.processStartIdentity)?.pid !==
			ownership.creatorPid
		) {
			throw new Error(
				"VM ownership metadata requires a canonical creator birth identity",
			);
		}
		mkdirSync(ownership.resourceRoot, { recursive: true, mode: 0o700 });
		const record = Object.freeze({
			schemaVersion: VM_OWNERSHIP_SCHEMA_VERSION,
			kind: "parallels_vm_ownership",
			vmUuid: uuid,
			vmName: name,
			...ownership,
			createdAt: this.nowFn(),
		});
		writeFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
		this.ownedResourcesByUuid.set(uuid, record);
		return record;
	}

	readVmOwnership(uuid, resourceRoot) {
		const path = this.vmOwnershipPath(uuid, resourceRoot);
		if (!path) return null;
		try {
			const record = JSON.parse(readFileSync(path, "utf8"));
			const expectedFields = new Set([
				"schemaVersion",
				"kind",
				"vmUuid",
				"vmName",
				"resourceRoot",
				"runId",
				"taskId",
				"attemptId",
				"projectRoot",
				"purpose",
				"creatorPid",
				"processStartIdentity",
				"createdAt",
			]);
			const parsedName = parseParallelsWorkingName(record?.vmName);
			if (
				!record ||
				typeof record !== "object" ||
				Array.isArray(record) ||
				Object.keys(record).length !== expectedFields.size ||
				Object.keys(record).some((field) => !expectedFields.has(field)) ||
				record?.schemaVersion !== VM_OWNERSHIP_SCHEMA_VERSION ||
				record.kind !== "parallels_vm_ownership" ||
				record.vmUuid !== uuid ||
				!isUuid(record.vmUuid) ||
				!parsedName ||
				parsedName.runId !== record.runId ||
				parsedName.creatorPid !== record.creatorPid ||
				resolve(record.resourceRoot) !== resolve(resourceRoot) ||
				record.resourceRoot !== resolve(resourceRoot) ||
				!isBoundedRecordText(record.runId, 256) ||
				!isBoundedRecordText(record.taskId, 256) ||
				!isBoundedRecordText(record.attemptId, 256) ||
				!isAbsolute(record.projectRoot) ||
				record.projectRoot !== resolve(record.projectRoot) ||
				!isBoundedRecordText(record.purpose, 128) ||
				!Number.isSafeInteger(record.creatorPid) ||
				record.creatorPid <= 0 ||
				parseHostProcessIdentity(record.processStartIdentity)?.pid !==
					record.creatorPid ||
				!Number.isFinite(record.createdAt)
			)
				return null;
			return record;
		} catch {
			return null;
		}
	}

	deleteVmOwnership(uuid, resourceRoot) {
		const path = this.vmOwnershipPath(uuid, resourceRoot);
		if (path) rmSync(path, { force: true });
		this.ownedResourcesByUuid.delete(uuid);
	}

	probeStoredCreator(ownership, onStatus) {
		const stored = parseHostProcessIdentity(ownership.processStartIdentity);
		if (!stored || stored.pid !== ownership.creatorPid) return "unknown";
		let fresh;
		try {
			fresh = this.hostProcessIdentityProbe(stored.pid, { onStatus });
		} catch {
			return "unknown";
		}
		if (fresh?.state === "present") {
			const current = parseHostProcessIdentity(fresh.identity);
			return current?.identity === stored.identity ? "same_birth" : "changed";
		}
		if (
			fresh?.state === "absent" &&
			fresh.bootSessionUuid === stored.bootSessionUuid
		) {
			return "absent";
		}
		return "unknown";
	}

	/**
	 * Measure a real linked clone when no test probe is injected. The probe is
	 * created, booted, measured, and destroyed before its receipt is accepted by
	 * create(); a fabricated measurement object can never authorize cloning.
	 */
	measureLinkedCloneLifecycle(goldenImage, options = {}) {
		const ownership = this.captureCreatorOwnership(options);
		const golden = this.resolveHandle(goldenImage, { allowUnmanaged: true });
		if (!/^stopped$/i.test(String(golden.status ?? ""))) {
			throw new Error(
				"linked-clone measurement requires a stopped golden image",
			);
		}
		const beforeSnapshots = this.listSnapshotIds(goldenImage);
		const probeName = buildParallelsWorkingName(
			ownership.runId,
			ownership.creatorPid,
		);
		this.writeAllocationIntent(probeName, ownership);
		const startedAt = this.nowFn();
		let probe = null;
		let createdSnapshots = [];
		let allocationAttempted = false;
		let evidence = null;
		let failure = null;
		try {
			// Same reason the workspace clone opts out: `probeName` is computed
			// once above, so a retry after a misfire reuses it and collides with
			// the clone the first attempt may already have made.
			allocationAttempted = true;
			this._call(["clone", goldenImage, "--name", probeName, "--linked"], {
				retry: false,
			});
			probe = this.listAll().find((entry) => entry.name === probeName);
			if (!probe?.ownership)
				throw new Error("linked-clone probe returned no UUID");
			this.writeVmOwnership(probe.uuid, probe.name, ownership);
			createdSnapshots = snapshotDifference(
				this.listSnapshotIds(goldenImage),
				beforeSnapshots,
			);
			const diskBytes = diskBytesFromInfo(
				this._call(["list", "-i", probe.uuid]),
				this.diskUsageFn,
			);
			this.boot(probe.uuid, options);
			evidence = validateLinkedCloneMeasurement({
				diskBytes,
				cloneToBootMs: Math.max(0, this.nowFn() - startedAt),
			});
		} catch (error) {
			failure = error;
		}
		if (probe?.uuid) {
			try {
				this.stopAndDelete(probe);
				this.deleteVmOwnership(probe.uuid, ownership.resourceRoot);
				this.cleanupLinkedSnapshots(goldenImage, createdSnapshots);
			} catch (cleanupError) {
				failure ??= cleanupError;
				if (failure !== cleanupError) failure.rollbackError = cleanupError;
				failure.cleanupUncertain = true;
				try {
					this.writeAllocationUncertainty(
						probeName,
						ownership,
						"known_allocation_cleanup_failed",
					);
				} catch (evidenceError) {
					failure.uncertaintyEvidenceError = evidenceError;
				}
			}
		} else if (allocationAttempted) {
			failure ??= new Error("linked-clone allocation identity is unknown");
			failure.cleanupUncertain = true;
			try {
				this.writeAllocationUncertainty(
					probeName,
					ownership,
					"allocation_identity_unknown",
				);
			} catch (evidenceError) {
				failure.uncertaintyEvidenceError = evidenceError;
			}
		}
		if (failure) throw failure;
		return evidence;
	}

	/**
	 * Measure linked-clone evidence through a real probe or an injected
	 * hermetic probe. No caller-supplied object is accepted directly.
	 */
	measureLinkedClone(goldenImage, options = {}) {
		const measure =
			this.measureLinkedCloneFn ??
			((image, measureOptions) =>
				this.measureLinkedCloneLifecycle(image, measureOptions));
		const evidence = validateLinkedCloneMeasurement(
			measure(goldenImage, options),
		);
		const receipt = Object.freeze({
			...evidence,
			goldenImage,
			measuredAt: this.nowFn(),
		});
		this.linkedMeasurementReceipts.add(receipt);
		return receipt;
	}

	create(goldenImage, options = {}) {
		if (!goldenImage || typeof goldenImage !== "string") {
			throw new Error("goldenImage is required");
		}
		const runId = options.runId ?? randomUUID();
		const creatorPid = validatePid(options.creatorPid ?? this.creatorPid);
		const name = buildParallelsWorkingName(runId, creatorPid);
		const ownership = this.captureCreatorOwnership(options);
		if (ownership.runId !== runId || ownership.creatorPid !== creatorPid) {
			throw new Error(
				"VM ownership context does not match requested VM identity",
			);
		}
		const linked = options.linked ?? true;
		if (linked && this.requireLinkedCloneMeasurement) {
			const evidence = options.linkedCloneMeasurement;
			if (
				!evidence ||
				!this.linkedMeasurementReceipts.has(evidence) ||
				evidence.goldenImage !== goldenImage
			) {
				throw new Error(
					"linked clone requires a measurement receipt produced for this golden image",
				);
			}
		}

		// Intent is durable before the first mutating clone call.  A failed write
		// therefore proves that no VM allocation was attempted.
		this.writeAllocationIntent(name, ownership);
		const snapshotBefore = linked ? this.listSnapshotIds(goldenImage) : null;
		let createdSnapshots = [];
		let entry = null;
		try {
			const cloneArgs = ["clone", goldenImage, "--name", name];
			if (linked) cloneArgs.push("--linked");
			// Not retried: the working name is deterministic, so a second attempt
			// after a misfire collides on the existing clone and reports a name
			// conflict rather than the fault that actually happened.
			this._call(cloneArgs, { retry: false });
			if (linked) {
				createdSnapshots = snapshotDifference(
					this.listSnapshotIds(goldenImage),
					snapshotBefore,
				);
			}
			entry = this.listAll().find((candidate) => candidate.name === name);
			if (!entry?.ownership) {
				throw new Error(
					`cloned VM ${name} was not returned with a UUID handle`,
				);
			}
			this.writeVmOwnership(entry.uuid, entry.name, ownership);
			if (linked) {
				const metadata = { goldenImage, snapshotIds: createdSnapshots };
				this.linkedSnapshotsByUuid.set(entry.uuid, metadata);
				this.writeSnapshotSidecar(entry.uuid, metadata);
			}
			this.boot(entry.uuid, options);
			try {
				this._hardenClone(entry.uuid, options);
			} catch (error) {
				throw new WorkerBootStageError("clone_hardening_failed", error);
			}
			try {
				this._prepareWorkspace(
					entry.uuid,
					options.providerUser ?? this.providerUser,
				);
			} catch (error) {
				throw new WorkerBootStageError("workspace_prepare_failed", error);
			}
			return entry.uuid;
		} catch (error) {
			if (!entry?.uuid) {
				error.cleanupUncertain = true;
				throw error;
			}
			try {
				this.rollback(name, entry.uuid, {
					goldenImage: linked ? goldenImage : null,
					snapshotBefore,
					snapshotIds: createdSnapshots,
					ownershipContext: ownership,
				});
			} catch (rollbackError) {
				error.rollbackError = rollbackError;
			}
			throw error;
		}
	}

	/**
	 * Disarm the guest clipboard agent on this clone, then prove it is gone.
	 *
	 * INV-1 is asserted when the golden image is built but consumed here, at
	 * dispatch, and the two moments drifted apart: a Parallels Guest Tools
	 * refresh inside the golden on 2026-08-21 restored the package-owned
	 * `com.parallels.copypaste` LaunchAgent that the build had renamed away, and
	 * every clone taken afterwards synced the host pasteboard into the guest
	 * with nothing on this path to notice. A clone is disposable, so enforce the
	 * posture per clone instead of inheriting it on faith.
	 *
	 * Enforcement here does not retire the golden-image repair or the build-time
	 * assertion; it removes their drift from the dispatch path.
	 *
	 * @param {string} workspaceId Cloned VM handle
	 * @param {{aquaUid?: string|number, clipboardSettleMs?: number,
	 *   clipboardPollMs?: number}} [options]
	 */
	_hardenClone(workspaceId, options = {}) {
		// A missing uid fails the clone rather than skipping the teardown. An
		// unenforced clone reporting success is the exact shape this method
		// exists to close, and it must not be reintroduced one level down.
		const uid = validateUid(options.aquaUid ?? this.aquaUid);
		const label = `gui/${uid}/${CLIPBOARD_AGENT_LABEL}`;
		const settleMs = options.clipboardSettleMs ?? this.clipboardSettleMs;
		const pollMs = options.clipboardPollMs ?? this.clipboardPollMs;

		this._disarmClipboard(workspaceId, label);

		// Any sighting inside the settle window fails the clone. If prltoolsd
		// supervises the agent directly, `bootout` and `disable` cannot hold it
		// down, and dispatch has to stop rather than quietly run in a guest that
		// still reaches the host pasteboard.
		const deadline = this.nowFn() + settleMs;
		for (;;) {
			const residue = this._clipboardResidue(workspaceId, label);
			if (residue) {
				throw new Error(
					`clipboard isolation could not be enforced on ${workspaceId}: ${residue}`,
				);
			}
			const remaining = deadline - this.nowFn();
			if (remaining <= 0) return;
			this.sleepFn(Math.min(pollMs, remaining));
		}
	}

	/**
	 * Unload the clipboard agent, refuse future loads, and kill any live copy.
	 * Every step is expected to fail on a correctly repaired golden image, where
	 * there is nothing left to unload, so failures are not escalated here --
	 * `_clipboardResidue` is what decides the outcome.
	 */
	_disarmClipboard(workspaceId, label) {
		const attempts = [
			["/bin/launchctl", "bootout", label],
			["/bin/launchctl", "disable", label],
			["/usr/bin/pkill", "-f", CLIPBOARD_AGENT_PROCESS],
		];
		for (const argv of attempts) {
			try {
				this._call(["exec", workspaceId, ...argv], { timeout: 10_000 });
			} catch {
				// Already absent, or launchd has nothing to unload.
			}
		}
	}

	/**
	 * Describe why the guest is still clipboard-capable, or null when it is not.
	 * Both halves matter: the launchd label proves the service is registered,
	 * the process check catches a copy that is running without it.
	 */
	_clipboardResidue(workspaceId, label) {
		try {
			this._call(["exec", workspaceId, "/bin/launchctl", "print", label], {
				timeout: 10_000,
			});
			return `${label} is still loaded`;
		} catch {
			// Not registered in the Aqua domain, which is the wanted state.
		}
		try {
			const pids = String(
				this._call(
					[
						"exec",
						workspaceId,
						"/usr/bin/pgrep",
						"-f",
						CLIPBOARD_AGENT_PROCESS,
					],
					{ timeout: 10_000 },
				) ?? "",
			).trim();
			if (pids) {
				return `${CLIPBOARD_AGENT_PROCESS} is running (pid ${pids.split(/\s+/).join(", ")})`;
			}
		} catch {
			// pgrep exits non-zero when nothing matches.
		}
		return null;
	}

	/**
	 * Describe every way this VM currently violates the no-host-rights posture,
	 * or an empty array when it holds. Reports; never repairs.
	 *
	 * The golden image is the one VM that is not disposable, and
	 * `withBootedGoldenImage` boots and mutates it. Anything a body left behind
	 * survives into every clone taken afterwards, so the posture the build
	 * certifies has to be re-read on the way out rather than assumed.
	 *
	 * A check that cannot run throws rather than returning "clean": an
	 * unverifiable posture proves nothing, and reporting it as held is the
	 * failure this method exists to close.
	 *
	 * @param {string} uuid a RUNNING VM handle — the guest half needs to exec
	 * @param {{aquaUid?: string|number}} [options]
	 * @returns {string[]} human-readable violations, empty when the posture holds
	 */
	describePostureViolations(uuid, options = {}) {
		const violations = [];
		const info = String(this._call(["list", "-i", uuid], { timeout: 30_000 }));
		// Same three host-side facts the INV-1 gate reads off `prlctl list -i`.
		for (const [label, pattern] of [
			["host shared folders are attached", /Host Shared Folders:\s*\(-\)/],
			["host-defined sharing is on", /Host defined sharing:\s*Off/],
			["the host profile is shared", /Shared Profile:\s*\(-\)/],
		]) {
			if (!pattern.test(info)) violations.push(label);
		}

		const mounts = String(
			this._call(["exec", uuid, "/sbin/mount"], { timeout: 30_000 }) ?? "",
		);
		const hostMounts = mounts
			.split("\n")
			.filter((line) => /prl_fs|\bmacOS\b.*on \//.test(line));
		if (hostMounts.length > 0) {
			violations.push(
				`host filesystem is mounted (${hostMounts.length} mount(s))`,
			);
		}

		const uid = validateUid(options.aquaUid ?? this.aquaUid);
		const residue = this._clipboardResidue(
			uuid,
			`gui/${uid}/${CLIPBOARD_AGENT_LABEL}`,
		);
		if (residue) violations.push(`clipboard is still available: ${residue}`);

		return violations;
	}

	/**
	 * Create the isolated logical workspace before the non-admin user enters it.
	 *
	 * The stage is defined by the state it leaves behind, not by three exit
	 * codes prlctl may never have read (see DEFAULT_WORKSPACE_VERIFY_TIMEOUT_MS).
	 * So apply the layout, then ask the guest what the state actually is, and
	 * repair once before giving up. That is the same posture `_reprobeStopped`
	 * takes toward a stop Parallels reports as failed after completing it, and
	 * it is strictly stronger than what it replaces: a passing run now proves
	 * owner and mode on both directories, which is the INV-1 property this
	 * stage exists to establish and which no exit code ever demonstrated.
	 */
	_prepareWorkspace(workspaceId, providerUser) {
		const user = validateUser(providerUser);
		const root = resolveWorkspacePath("/project", user);
		const parent = root.slice(0, root.lastIndexOf("/"));
		const paths = [parent, root];
		let cause = null;
		for (let attempt = 1; ; attempt += 1) {
			cause =
				this._applyWorkspaceLayout(workspaceId, user, root, paths) ?? cause;
			const mismatch = this._reprobeWorkspace(workspaceId, user, paths, cause);
			if (!mismatch) return;
			if (attempt >= WORKSPACE_PREPARE_ATTEMPTS) throw mismatch;
		}
	}

	/**
	 * Run the three idempotent layout commands, returning the first failure
	 * rather than throwing it. A failure here is a hypothesis about the guest,
	 * not a verdict; `_reprobeWorkspace` decides.
	 * @returns {Error|null}
	 */
	_applyWorkspaceLayout(workspaceId, user, root, paths) {
		let firstFailure = null;
		for (const argv of [
			["/bin/mkdir", "-p", root],
			["/usr/sbin/chown", user, ...paths],
			["/bin/chmod", WORKSPACE_MODE, ...paths],
		]) {
			try {
				this._call(["exec", workspaceId, ...argv]);
			} catch (error) {
				firstFailure ??= error;
			}
		}
		return firstFailure;
	}

	/**
	 * Read the workspace's owner and mode back out of the guest.
	 *
	 * `stat` is chosen because it produces output: an empty result is therefore
	 * itself evidence that the probe -- not the workspace -- is what failed, and
	 * is retried rather than believed. A probe that never produces output within
	 * the budget rethrows the layout's own failure, so a genuinely broken guest
	 * still reports the command that broke instead of this reconciliation.
	 *
	 * @returns {Error|null} null when the state is correct, otherwise the
	 *   mismatch to raise if repair does not settle it.
	 */
	_reprobeWorkspace(workspaceId, user, paths, cause) {
		const expected = paths.map(() => `${user}:${WORKSPACE_MODE}`).join("\n");
		const timeoutMs = this.workspaceVerifyTimeoutMs;
		const startedAt = this.nowFn();
		let probeFailure = null;
		for (;;) {
			let observed = null;
			try {
				const raw = this._call([
					"exec",
					workspaceId,
					"/usr/bin/stat",
					"-f",
					"%Su:%Lp",
					...paths,
				]);
				const text = outputText(raw).trim();
				if (text) observed = text;
			} catch (error) {
				probeFailure = error;
			}
			if (observed !== null) {
				if (observed === expected) return null;
				return new Error(
					`workspace ${paths.join(" ")} is ${JSON.stringify(observed)}, expected ${JSON.stringify(expected)}`,
					{ cause: cause ?? probeFailure },
				);
			}
			const elapsedMs = this.nowFn() - startedAt;
			if (elapsedMs >= timeoutMs) {
				throw (
					cause ??
					probeFailure ??
					new Error(
						`workspace ${paths.join(" ")} could not be verified within ${timeoutMs}ms`,
					)
				);
			}
			this.sleepFn(Math.min(this.workspaceVerifyPollMs, timeoutMs - elapsedMs));
		}
	}

	rollback(
		name,
		uuid = null,
		{
			goldenImage = null,
			snapshotBefore = null,
			snapshotIds = [],
			ownershipContext = null,
		} = {},
	) {
		const target = uuid;
		if (!target) return false;
		const ownership =
			this.ownedResourcesByUuid.get(target) ??
			(ownershipContext?.resourceRoot
				? this.readVmOwnership(target, ownershipContext.resourceRoot)
				: null);
		if (
			!ownership ||
			ownership.vmUuid !== target ||
			ownership.vmName !== name
		) {
			throw new Error("refusing rollback without exact owned VM identity");
		}
		this.stopAndDelete({ uuid: target, name });
		this.linkedSnapshotsByUuid.delete(target);
		this.deleteVmOwnership(target, ownership.resourceRoot);
		if (goldenImage) {
			const candidates = snapshotIds.length
				? snapshotIds
				: snapshotBefore
					? snapshotDifference(
							this.listSnapshotIds(goldenImage),
							snapshotBefore,
						)
					: [];
			this.cleanupLinkedSnapshots(goldenImage, candidates);
		}
		return true;
	}

	stopAndDelete(entry, { forceOnly = false } = {}) {
		let forced = false;
		if (forceOnly) {
			if (!/^stopped$/i.test(String(entry.status ?? ""))) {
				forced = true;
				this._forceStopAndAwaitSettled(entry);
			}
		} else {
			try {
				this._call(["stop", entry.uuid]);
				this._assertNotRunning(entry, "prlctl stop exited 0");
			} catch (stopError) {
				// Covers both a thrown stop and a stop that reported success
				// without stopping; the escalation is the same either way.
				forced = true;
				this._forceStopAndAwaitSettled(entry, stopError);
			}
		}
		const deleteSettlement = this._createDeleteSettlementBudget();
		let deleteError = null;
		try {
			this._call(["delete", entry.uuid]);
		} catch (error) {
			deleteError = error;
		}
		if (!deleteError) {
			this._awaitDeletionAbsent(
				entry,
				deleteSettlement,
				new Error(`${entry.name ?? entry.uuid} remained present after delete`),
			);
			return { uuid: entry.uuid, name: entry.name, forced };
		}
		{
			const error = deleteError;
			if (!forced) {
				this._forceStopAndAwaitSettled(entry, error);
			}
			forced = true;
			let current;
			try {
				current = this._observeDeletionVm(entry, deleteSettlement);
			} catch (observationError) {
				throw this._deletionAbsenceUncertainty(entry, error, observationError);
			}
			if (current === null)
				return {
					uuid: entry.uuid,
					name: entry.name,
					forced,
				};
			if (!/^stopped$/i.test(String(current.status ?? ""))) throw error;
			try {
				this._call(["delete", entry.uuid]);
			} catch (retryError) {
				if (retryError instanceof Error && retryError.cause === undefined) {
					retryError.cause = error;
				}
				this._awaitDeletionAbsent(entry, deleteSettlement, retryError);
				return {
					uuid: entry.uuid,
					name: entry.name,
					forced,
				};
			}
			this._awaitDeletionAbsent(entry, deleteSettlement, error);
		}
		return { uuid: entry.uuid, name: entry.name, forced };
	}

	destroy(handle) {
		const entry = this.resolveHandle(handle);
		const ownedInThisProcess = this.ownedResourcesByUuid.has(entry.uuid);
		const suppliedOwnership =
			handle && typeof handle === "object" ? handle.ownershipContext : null;
		const registeredResourceRoot =
			handle &&
			typeof handle === "object" &&
			typeof handle.runId === "string" &&
			process.env.SWITCHYARD_RUN_STORE_ROOT
				? join(
						resolve(process.env.SWITCHYARD_RUN_STORE_ROOT),
						"runs",
						handle.runId,
						"resources",
					)
				: null;
		const ownership =
			this.ownedResourcesByUuid.get(entry.uuid) ??
			(suppliedOwnership?.resourceRoot
				? this.readVmOwnership(entry.uuid, suppliedOwnership.resourceRoot)
				: registeredResourceRoot
					? this.readVmOwnership(entry.uuid, registeredResourceRoot)
					: null);
		if (!ownership) {
			throw new Error("recovery_evidence_missing for targeted VM destruction");
		}
		if (
			!ownedInThisProcess &&
			this.probeStoredCreator(ownership) !== "same_birth"
		) {
			throw new Error("VM creator birth identity is not current");
		}
		if (
			ownership.vmUuid !== entry.uuid ||
			ownership.vmName !== entry.name ||
			(handle &&
				typeof handle === "object" &&
				((handle.runId && handle.runId !== ownership.runId) ||
					(handle.taskId && handle.taskId !== ownership.taskId) ||
					(handle.attemptId && handle.attemptId !== ownership.attemptId) ||
					(handle.processStartIdentity &&
						handle.processStartIdentity !== ownership.processStartIdentity)))
		) {
			throw new Error("VM identity changed before destruction");
		}
		if (
			handle &&
			typeof handle === "object" &&
			((handle.uuid && handle.uuid !== entry.uuid) ||
				(handle.name && handle.name !== entry.name) ||
				(handle.runId && handle.runId !== entry.runId) ||
				(Number.isInteger(handle.creatorPid) &&
					handle.creatorPid !== entry.creatorPid))
		) {
			throw new Error("VM identity changed before destruction");
		}
		// The sidecar is the fallback, not the primary: a clone created by this
		// same process is already in the map, and reading it back would make the
		// common path depend on the filesystem for no gain.
		const metadata =
			this.linkedSnapshotsByUuid.get(entry.uuid) ??
			this.readSnapshotSidecar(entry.uuid);
		const result = this.stopAndDelete(entry);
		this.linkedSnapshotsByUuid.delete(entry.uuid);
		if (metadata) {
			this.cleanupLinkedSnapshots(metadata.goldenImage, metadata.snapshotIds);
		}
		// Only after cleanup: a sidecar removed ahead of the snapshots it names
		// converts a retryable failure into a permanent orphan.
		this.deleteSnapshotSidecar(entry.uuid);
		this.deleteVmOwnership(entry.uuid, ownership.resourceRoot);
		return result;
	}

	/**
	 * Reclaim exact-prefix VMs only when the caller supplies an ownership and
	 * liveness eligibility predicate. An omitted or failed predicate is fail
	 * closed. Identity and eligibility are checked again immediately before any
	 * VM mutation.
	 */
	reclaim({
		dryRun = false,
		onStatus,
		eligibility = null,
		ownershipContext = null,
	} = {}) {
		// `skipped` answers one question only: which VMs were left alone. The
		// snapshot channels are separate because a VM can be reclaimed AND have
		// its snapshots left behind, so a single list would have to mean two
		// contradictory things about the same entry.
		const result = {
			reclaimed: [],
			reclaimedSnapshots: [],
			skipped: [],
			skippedSnapshots: [],
			errors: [],
		};
		for (const entry of this.listManaged()) {
			const registeredRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
			const resourceRoot = registeredRoot
				? join(resolve(registeredRoot), "runs", entry.runId, "resources")
				: null;
			if (
				!resourceRoot ||
				(ownershipContext?.resourceRoot &&
					resolve(ownershipContext.resourceRoot) !== resourceRoot)
			) {
				result.skipped.push({ ...entry, reason: "recovery_evidence_missing" });
				continue;
			}
			const ownership = this.readVmOwnership(entry.uuid, resourceRoot);
			if (
				!ownership ||
				ownership.vmName !== entry.name ||
				ownership.runId !== entry.runId ||
				ownership.creatorPid !== entry.creatorPid ||
				typeof ownership.processStartIdentity !== "string" ||
				!ownership.processStartIdentity ||
				(ownershipContext?.projectRoot &&
					resolve(ownershipContext.projectRoot) !== ownership.projectRoot) ||
				(ownershipContext?.runId &&
					ownershipContext.runId !== ownership.runId) ||
				(Number.isInteger(ownershipContext?.creatorPid) &&
					ownershipContext.creatorPid !== ownership.creatorPid)
			) {
				result.skipped.push({ ...entry, reason: "recovery_evidence_missing" });
				onStatus?.({
					type: "skip",
					name: entry.name,
					reason: "recovery_evidence_missing",
				});
				continue;
			}
			const creatorState = this.probeStoredCreator(ownership, onStatus);
			if (creatorState !== "same_birth" && creatorState !== "absent") {
				result.skipped.push({
					...entry,
					reason: "creator-birth-unverified",
				});
				onStatus?.({
					type: "skip",
					name: entry.name,
					reason: "creator-birth-unverified",
				});
				continue;
			}
			let eligible = false;
			try {
				eligible =
					typeof eligibility === "function" &&
					eligibility({ ...entry, ownership }) === true;
			} catch {
				eligible = false;
			}
			if (!eligible) {
				result.skipped.push({ ...entry, reason: "ineligible" });
				onStatus?.({ type: "skip", name: entry.name, reason: "ineligible" });
				continue;
			}
			if (dryRun) {
				result.reclaimed.push({ ...entry, dryRun: true });
				continue;
			}
			let current;
			let currentOwnership;
			try {
				current = this.listManaged().find(
					(candidate) =>
						candidate.uuid === entry.uuid &&
						candidate.name === entry.name &&
						candidate.runId === entry.runId &&
						candidate.creatorPid === entry.creatorPid,
				);
				currentOwnership = current
					? this.readVmOwnership(current.uuid, resourceRoot)
					: null;
				eligible =
					current !== undefined &&
					currentOwnership !== null &&
					currentOwnership.vmUuid === current.uuid &&
					currentOwnership.vmName === current.name &&
					currentOwnership.runId === current.runId &&
					currentOwnership.creatorPid === current.creatorPid &&
					(!ownershipContext?.projectRoot ||
						currentOwnership.projectRoot ===
							resolve(ownershipContext.projectRoot)) &&
					(!ownershipContext?.runId ||
						currentOwnership.runId === ownershipContext.runId) &&
					(!Number.isInteger(ownershipContext?.creatorPid) ||
						currentOwnership.creatorPid === ownershipContext.creatorPid) &&
					eligibility({
						...current,
						ownership: currentOwnership,
						recoveryPhase: "pre_mutation",
					}) === true;
			} catch {
				current = undefined;
				currentOwnership = undefined;
				eligible = false;
			}
			if (!eligible) {
				result.skipped.push({
					...entry,
					reason: "identity-or-eligibility-changed",
				});
				onStatus?.({
					type: "skip",
					name: entry.name,
					reason: "identity-or-eligibility-changed",
				});
				continue;
			}
			const currentCreatorState = this.probeStoredCreator(
				currentOwnership,
				onStatus,
			);
			if (
				currentCreatorState !== "same_birth" &&
				currentCreatorState !== "absent"
			) {
				result.skipped.push({
					...entry,
					reason: "creator-birth-changed-before-delete",
				});
				onStatus?.({
					type: "skip",
					name: entry.name,
					reason: "creator-birth-changed-before-delete",
				});
				continue;
			}
			// Read before the delete: once the VM is gone its uuid is the only
			// way back to the sidecar, and a failure here must not cost the
			// record.
			const metadata = this.readSnapshotSidecar(current.uuid);
			try {
				const removed = this.stopAndDelete(current, { forceOnly: true });
				result.reclaimed.push(removed);
				onStatus?.({ type: "reclaimed", name: entry.name });
			} catch (error) {
				result.errors.push({ name: entry.name, reason: error.message });
				continue;
			}
			// The absolute rule, enforced here rather than by convention:
			// reclaim deletes only snapshot ids it finds in a sidecar this code
			// wrote. Nothing discovered by listing is ever eligible, so a
			// snapshot that predates the sidecar convention — such as
			// switchyard-golden-26-5 — survives every path through this method.
			if (!metadata) {
				result.skippedSnapshots.push({
					name: entry.name,
					uuid: entry.uuid,
					reason: "no-snapshot-sidecar",
				});
				onStatus?.({
					type: "skip",
					name: entry.name,
					reason: "no-snapshot-sidecar",
				});
				try {
					this.deleteVmOwnership(entry.uuid, currentOwnership.resourceRoot);
				} catch (error) {
					result.errors.push({ name: entry.name, reason: error.message });
				}
				continue;
			}
			try {
				this.cleanupLinkedSnapshots(metadata.goldenImage, metadata.snapshotIds);
				this.deleteSnapshotSidecar(entry.uuid);
				this.deleteVmOwnership(entry.uuid, currentOwnership.resourceRoot);
				result.reclaimedSnapshots.push({
					name: entry.name,
					goldenImage: metadata.goldenImage,
					snapshotIds: metadata.snapshotIds,
				});
				onStatus?.({
					type: "reclaimed-snapshots",
					name: entry.name,
					count: metadata.snapshotIds.length,
				});
			} catch (error) {
				result.errors.push({ name: entry.name, reason: error.message });
			}
		}
		return result;
	}
}
