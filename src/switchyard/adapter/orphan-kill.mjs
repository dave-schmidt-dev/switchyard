// D-9: best-effort process cleanup after a host-side execFileSync timeout.
// Neither transport forwards host signals into the executed process's own
// process tree — killing the host-side client (SIGTERM on ETIMEDOUT) leaves
// whatever it spawned running unsupervised, in a container's PID namespace or
// a VM guest alike. Empirically verified for `docker exec`: a process it
// started kept executing for several seconds after its host-side client was
// killed on timeout.
//
// A `ParallelsExecutionBackend` (or any future backend) that implements
// `cleanupProviderProcess(command, args, {onStatus})` is preferred when
// present — it knows how to reach into its own guest and is the only correct
// mechanism there, since a VM has no `docker exec` to fall back to. The
// Docker path below is the fallback for backends that don't provide one.
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createMutationIntent,
	executeMutation,
	executeMutationSync,
	validateMutationRecord,
} from "../lifecycle/mutation-protocol.mjs";
import { getRunRoot } from "../run-store/index.mjs";
import { validateIdentifier } from "./shell-safety.mjs";

const ORPHAN_MUTATION_LIMIT = 64;
const ORPHAN_MUTATION_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}\.json$/u;
const MUTATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MUTATION_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RUN_ID_RE = /^[\w-]+$/u;
const ORPHAN_MUTATION_DIR = "mutations/orphan-termination";
const DEFAULT_STATE_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	".logs",
	"switchyard",
);

function normalizeCleanupContext(cleanupContext) {
	if (cleanupContext == null) return null;
	if (
		typeof cleanupContext !== "object" ||
		typeof cleanupContext.runId !== "string" ||
		!RUN_ID_RE.test(cleanupContext.runId) ||
		typeof cleanupContext.attemptId !== "string" ||
		!MUTATION_ID_RE.test(cleanupContext.attemptId)
	)
		return undefined;
	return {
		runId: cleanupContext.runId,
		attemptId: cleanupContext.attemptId,
	};
}

function orphanMutationRoot(cleanupContext = null) {
	if (cleanupContext) {
		return resolve(getRunRoot(cleanupContext.runId), ORPHAN_MUTATION_DIR);
	}
	return resolve(
		process.env.SWITCHYARD_RUN_STORE_ROOT || DEFAULT_STATE_ROOT,
		ORPHAN_MUTATION_DIR,
	);
}

function orphanMutationPath(operationId, cleanupContext = null) {
	return resolve(orphanMutationRoot(cleanupContext), `${operationId}.json`);
}

function listOrphanMutationSidecars(cleanupContext = null) {
	try {
		return readdirSync(orphanMutationRoot(cleanupContext))
			.filter((name) => ORPHAN_MUTATION_FILE_RE.test(name))
			.map((name) => {
				const path = resolve(orphanMutationRoot(cleanupContext), name);
				try {
					return { path, mtimeMs: statSync(path).mtimeMs };
				} catch {
					return null;
				}
			})
			.filter(Boolean)
			.sort((left, right) => left.mtimeMs - right.mtimeMs);
	} catch {
		return [];
	}
}

function persistOrphanMutation(record, cleanupContext = null) {
	validateMutationRecord(record);
	const durableRecord = {
		version: record.version,
		operationId: record.operationId,
		operation: record.operation,
		resource: record.resource,
		state: record.state,
		outcome: record.outcome,
		attempt: record.attempt,
		maxAttempts: record.maxAttempts,
		idempotency: record.idempotency,
		retryAmbiguous: record.retryAmbiguous,
		recordedAt: record.recordedAt,
		...(typeof record.code === "string" && MUTATION_CODE_RE.test(record.code)
			? { code: record.code }
			: {}),
		...(record.reconciled === true ? { reconciled: true } : {}),
	};
	validateMutationRecord(durableRecord);
	const directory = orphanMutationRoot(cleanupContext);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const destination = orphanMutationPath(record.operationId, cleanupContext);
	const destinationExists = listOrphanMutationSidecars(cleanupContext).some(
		(candidate) => candidate.path === destination,
	);
	trimOrphanMutationSidecars(
		destinationExists ? ORPHAN_MUTATION_LIMIT : ORPHAN_MUTATION_LIMIT - 1,
		cleanupContext,
	);
	const existing = listOrphanMutationSidecars(cleanupContext);
	if (
		!existing.some((candidate) => candidate.path === destination) &&
		existing.length >= ORPHAN_MUTATION_LIMIT
	)
		throw new Error("orphan mutation sidecar capacity exhausted");
	const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(durableRecord), { mode: 0o600 });
		renameSync(temporary, destination);
	} finally {
		try {
			if (existsSync(temporary)) unlinkSync(temporary);
		} catch {
			// The atomic destination is already authoritative.
		}
	}
	trimOrphanMutationSidecars(ORPHAN_MUTATION_LIMIT, cleanupContext);
}

function trimOrphanMutationSidecars(
	targetLimit = ORPHAN_MUTATION_LIMIT,
	cleanupContext = null,
) {
	const files = listOrphanMutationSidecars(cleanupContext);
	if (files.length <= targetLimit) return;
	let remaining = files.length;
	for (const candidate of files) {
		if (remaining <= targetLimit) break;
		try {
			const record = JSON.parse(readFileSync(candidate.path, "utf8"));
			if (record.state === "completed") {
				unlinkSync(candidate.path);
				remaining -= 1;
			}
		} catch {
			// Preserve malformed or uncertain evidence for manual reconciliation.
		}
	}
}

function readOrphanMutation(operationId, cleanupContext = null) {
	try {
		const record = JSON.parse(
			readFileSync(orphanMutationPath(operationId, cleanupContext), "utf8"),
		);
		return { record: validateMutationRecord(record), corrupt: false };
	} catch (error) {
		if (error?.code === "ENOENT") return { record: null, corrupt: false };
		return { record: null, corrupt: true };
	}
}

function emitOrphanMutationStatus(onStatus, event, operationId) {
	try {
		onStatus?.({ phase: "mutation", event, operationId });
	} catch {
		// Cleanup telemetry cannot replace the primary timeout result.
	}
}

function legacyOrphanResult(mutation) {
	if (mutation?.commandResult) return mutation.commandResult;
	if (mutation?.state === "completed") return CLEANUP_CONFIRMED;
	return {
		...CLEANUP_CONFIRMED,
		cleanupFailed: true,
		failurePhase: "provider_cleanup",
	};
}

function killViaDocker(containerName) {
	try {
		validateIdentifier(containerName, "containerName");
	} catch {
		return;
	}
	try {
		execFileSync(
			"docker",
			[
				"exec",
				containerName,
				"sh",
				"-c",
				"kill -TERM -1 2>/dev/null; sleep 1; kill -KILL -1 2>/dev/null; " +
					"rm -f /project/.git/index.lock 2>/dev/null",
			],
			{ timeout: 5000, stdio: "pipe" },
		);
	} catch {
		// Best-effort — the container may already be gone, or the shell may
		// not exist; either way there's nothing left to clean up.
	}
}

// Cleanup outcome vocabulary. A caller's timeout envelope needs to say
// whether the provider process is known dead, because runner/index.mjs
// classifies `execution_timed_out_cleanup_failed` from exactly this signal.
// Everything reported here is content-free by construction — a boolean, a
// stage name from the backend's own fixed set, an integer, a signal name —
// so no provider output can reach a caller through this return value (INV-2).
const CLEANUP_CONFIRMED = Object.freeze({
	cleanupFailed: false,
	cleanupStage: null,
	exitCode: null,
	signal: null,
	failurePhase: null,
});

/**
 * Classify a thrown cleanup error into the content-free outcome shape.
 *
 * `execFileSync` distinguishes the two causes that matter here and the
 * backend's catch block has already tagged the stage it reached:
 * a non-zero `status` means the guest kill script ran and reported
 * survivors, while a transport failure (`ENOENT`, a signal, no status)
 * means the script never ran at all. The recorded live failure could not
 * tell those apart, which is why the stage and exit code are carried out.
 *
 * @param {unknown} error
 * @returns {{cleanupFailed: true, cleanupStage: string|null,
 *            exitCode: number|null, signal: string|null,
 *            failurePhase: string}}
 */
function describeCleanupFailure(error) {
	const stage = error?.cleanupStage;
	const status = error?.status;
	const signal = error?.signal;
	return {
		cleanupFailed: true,
		cleanupStage: typeof stage === "string" ? stage : null,
		exitCode:
			Number.isSafeInteger(status) && status >= 0 && status <= 255
				? status
				: null,
		signal: typeof signal === "string" ? signal : null,
		// A member of PERSISTED_FAILURE_PHASES, so sanitizeFailureMetadata
		// keeps it rather than dropping it. Without this the sync path's
		// terminal envelope named a cleanup failure in `result` while every
		// machine-readable field still said a plain timeout.
		failurePhase: "provider_cleanup",
	};
}

/**
 * Kill every process inside a container except PID 1 (the container's own
 * `sleep infinity` keep-alive process — see lifecycle/index.mjs). `kill -1`
 * targets "every process the caller may signal, except PID 1 and the caller
 * itself" (POSIX kill(2)), so this reaches an orphaned provider CLI without
 * needing `pkill`/`ps` to be installed in the agent image. TERM first, then
 * KILL after a short grace period, so a process gets a chance to flush
 * before being forced.
 *
 * Also clears a stale `/project/.git/index.lock` left behind if the killed
 * process was itself mid `git add`/`git commit` (a real, empirically
 * confirmed case: a stale lock makes captureDiff's own `git add -A` fail,
 * which its catch-all swallows into a silent `null` — losing the very work
 * this whole timeout path exists to preserve). Safe specifically at this
 * point: every process has just been force-killed above, so nothing can
 * still legitimately hold the lock.
 *
 * Best-effort throughout: swallows all errors, since this runs from an
 * adapter's timeout catch block and must never itself throw or block
 * returning the (already-failed) execution result.
 * @param {string} containerName
 * @param {object} [options]
 * @param {{cleanupProviderProcess?: Function}} [options.executionBackend]
 * @param {string} [options.command]
 * @param {string[]} [options.args]
 * @returns {{cleanupFailed: boolean, cleanupStage: string|null,
 *            exitCode: number|null, signal: string|null,
 *            failurePhase: string|null}}
 */
export function killOrphanedProcesses(containerName, options = {}) {
	const { executionBackend, command, args, onStatus } = options;
	if (
		!options._mutationRaw &&
		!options.mutationProtocol &&
		options.cleanupContext != null
	) {
		const cleanupContext = normalizeCleanupContext(options.cleanupContext);
		if (options.cleanupContext != null && cleanupContext === undefined) {
			emitOrphanMutationStatus(onStatus, "mutation_uncertain", "invalid");
			return {
				...CLEANUP_CONFIRMED,
				cleanupFailed: true,
				failurePhase: "provider_cleanup",
			};
		}
		const identity = cleanupContext
			? `${cleanupContext.runId}:${cleanupContext.attemptId}:${String(containerName)}`
			: String(containerName);
		const resource = `container-${createHash("sha256")
			.update(identity, "utf8")
			.digest("hex")
			.slice(0, 32)}`;
		const operation = "orphan_termination";
		const policy = {
			maxAttempts: 1,
			idempotency: "conditional",
			reconcile: true,
			...(options.policy ?? {}),
		};
		const expectedOperationId = createMutationIntent({
			operation,
			resource,
			policy,
		}).operationId;
		const operationId = options.operationId ?? expectedOperationId;
		if (typeof operationId !== "string" || !MUTATION_ID_RE.test(operationId)) {
			emitOrphanMutationStatus(onStatus, "mutation_uncertain", "invalid");
			return {
				...CLEANUP_CONFIRMED,
				cleanupFailed: true,
				failurePhase: "provider_cleanup",
			};
		}
		if (cleanupContext && operationId !== expectedOperationId) {
			emitOrphanMutationStatus(onStatus, "mutation_uncertain", operationId);
			return {
				...CLEANUP_CONFIRMED,
				cleanupFailed: true,
				failurePhase: "provider_cleanup",
			};
		}
		const loaded = options.resume
			? { record: options.resume, corrupt: false }
			: readOrphanMutation(operationId, cleanupContext);
		if (loaded.corrupt) {
			emitOrphanMutationStatus(onStatus, "mutation_uncertain", operationId);
			return {
				...CLEANUP_CONFIRMED,
				cleanupFailed: true,
				failurePhase: "provider_cleanup",
			};
		}
		try {
			const mutation = executeMutationSync({
				operation,
				resource,
				operationId,
				policy,
				resume: loaded.record,
				command: () =>
					killOrphanedProcesses(containerName, {
						...options,
						_mutationRaw: true,
					}),
				observe:
					options.observe ??
					((result) =>
						result?.cleanupFailed === false
							? { status: "confirmed", ownership: "confirmed" }
							: { status: "ambiguous", ownership: "unknown" }),
				reconcile: options.reconcile,
				persist: (record) => persistOrphanMutation(record, cleanupContext),
				onStatus,
			});
			return legacyOrphanResult(mutation);
		} catch {
			emitOrphanMutationStatus(onStatus, "mutation_uncertain", operationId);
			return {
				...CLEANUP_CONFIRMED,
				cleanupFailed: true,
				failurePhase: "provider_cleanup",
			};
		}
	}
	if (options.mutationProtocol) {
		const protocol = options.mutationProtocol;
		return executeMutation({
			...protocol,
			operation: protocol.operation ?? "orphan_termination",
			resource: protocol.resource ?? containerName,
			command:
				protocol.command ??
				(() =>
					killOrphanedProcesses(containerName, {
						...options,
						mutationProtocol: null,
					})),
			observe:
				protocol.observe ??
				((result) =>
					result?.cleanupFailed === false
						? { status: "confirmed", ownership: "confirmed" }
						: { status: "ambiguous", ownership: "unknown" }),
			onStatus: protocol.onStatus ?? onStatus,
		});
	}
	if (typeof executionBackend?.cleanupProviderProcess === "function") {
		try {
			executionBackend.cleanupProviderProcess(command, args, { onStatus });
			return CLEANUP_CONFIRMED;
		} catch (error) {
			// Fall through to the Docker path as a last-resort backstop, but
			// keep reporting failure: the backstop reaches a Docker container,
			// and a backend that implements cleanupProviderProcess is reaching
			// somewhere the backstop cannot (a VM guest). A docker exec that
			// no-ops against a container that was never there is not evidence
			// the provider process died, so a successful backstop must not
			// overwrite a failed guest cleanup with a clean result.
			killViaDocker(containerName);
			return describeCleanupFailure(error);
		}
	}
	// Docker-only backends: unchanged best-effort semantics. killViaDocker
	// swallows everything, so there is no signal to report either way, and
	// reporting failure here would reclassify every Docker timeout.
	killViaDocker(containerName);
	return CLEANUP_CONFIRMED;
}

/**
 * Non-blocking counterpart for async provider lifecycles. Docker-only: the
 * async provider-lifecycle path (`executeProviderInvocation` in
 * provider-lifecycle.mjs) already calls a VM-native
 * `executionBackend.cleanupProviderProcess()` itself, before falling back to
 * this function, so this stays the Docker backstop it always was. The
 * command is deliberately identical to killOrphanedProcesses so TERM/KILL
 * ordering and stale-index cleanup remain one containment policy.
 * @param {string} containerName
 * @returns {Promise<void>}
 */
export function killOrphanedProcessesAsync(containerName) {
	try {
		validateIdentifier(containerName, "containerName");
	} catch {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		let child;
		try {
			child = execFile(
				"docker",
				[
					"exec",
					containerName,
					"sh",
					"-c",
					"kill -TERM -1 2>/dev/null; sleep 1; kill -KILL -1 2>/dev/null; " +
						"rm -f /project/.git/index.lock 2>/dev/null",
				],
				{ timeout: 5000, stdio: "ignore" },
				finish,
			);
		} catch {
			finish();
			return;
		}
		child?.once?.("error", finish);
		child?.once?.("close", finish);
		setTimeout(finish, 5000).unref?.();
	});
}
