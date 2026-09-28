import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	linkSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { resolveVmAdmissionRoot, vmSlotPath } from "./constants.mjs";
import {
	sanitizeVmAdmissionError,
	VM_ADMISSION_PERMISSION_CODES,
	VM_ADMISSION_STORAGE_CODES,
	VmAdmissionStorageError,
	VmSlotUnavailableError,
} from "./errors.mjs";
import { sanitizeForDisplay } from "./run-records.mjs";

const VM_SLOT_COUNT = 2;
export const TEST_VM_SLOT_WAIT_TIMEOUT_MS = 120_000;
export const TEST_VM_SLOT_WAIT_INTERVAL_MS = 250;
function safeVmRunId(value) {
	if (typeof value !== "string" || value.length === 0) return "unknown";
	const safe = sanitizeForDisplay(value).slice(0, 128);
	return safe || "unknown";
}
function vmSlotBody(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return null;
	}
	const ownerPid = raw.ownerPid ?? raw.pid;
	if (
		!Number.isInteger(ownerPid) ||
		ownerPid <= 0 ||
		typeof raw.runId !== "string" ||
		raw.runId.length === 0 ||
		typeof raw.token !== "string" ||
		raw.token.length === 0
	) {
		return null;
	}
	return { ownerPid, runId: raw.runId, token: raw.token };
}
function readVmSlotBody(slotPath, readSlot = readFileSync) {
	let raw;
	try {
		raw = readSlot(slotPath, "utf8");
	} catch (error) {
		// An unreadable occupied slot is not evidence of ordinary capacity
		// contention. Preserve closed permission/storage failures for the
		// admission boundary instead of collapsing them to an unknown holder.
		if (
			VM_ADMISSION_PERMISSION_CODES.has(error?.code) ||
			VM_ADMISSION_STORAGE_CODES.has(error?.code)
		) {
			throw error;
		}
		// A vanished occupied slot is a normal acquire/release race. The
		// caller retries that slot within its bounded admission loop; other
		// unclassified read failures remain within the closed admission boundary.
		throw error;
	}
	try {
		const body = vmSlotBody(JSON.parse(raw));
		if (body) return body;
	} catch (error) {
		throw new VmAdmissionStorageError(error);
	}
	// A slot that won the atomic publish operation must contain a complete,
	// valid owner record. Treat malformed-but-readable storage as a closed
	// storage failure, never as ordinary contention that can poison a slot.
	throw new VmAdmissionStorageError(
		new Error("VM admission slot contains an invalid owner record"),
	);
}
function removeVmTempFile(tmpPath) {
	try {
		unlinkSync(tmpPath);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}
function vmOwnerIsLive(ownerPid, probePid) {
	if (probePid) {
		try {
			return probePid(ownerPid) !== "dead";
		} catch {
			return true;
		}
	}
	try {
		process.kill(ownerPid, 0);
		return true;
	} catch (error) {
		// Only ESRCH proves that the owner is gone. EPERM, EINVAL, and all
		// other probe failures are conservatively treated as live/unknown.
		return error.code !== "ESRCH";
	}
}
function publishVmSlot(slotPath, body) {
	const tmpPath = `${slotPath}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(body), { mode: 0o600 });
	try {
		linkSync(tmpPath, slotPath);
		return true;
	} catch (error) {
		if (error.code === "EEXIST") return false;
		throw error;
	} finally {
		removeVmTempFile(tmpPath);
	}
}
function vmSlotIndex(value) {
	if (Number.isInteger(value) && value >= 0 && value < VM_SLOT_COUNT) {
		return value;
	}
	if (typeof value !== "string") return null;
	for (let index = 0; index < VM_SLOT_COUNT; index += 1) {
		if (value === vmSlotPath(index)) return index;
	}
	return null;
}
function acquireVmSlotWithDependencies(options = {}, dependencies = {}) {
	const normalized = typeof options === "string" ? { runId: options } : options;
	const publishSlot = dependencies.publishVmSlot ?? publishVmSlot;
	const readSlotBody = dependencies.readVmSlotBody ?? readVmSlotBody;
	const runId =
		typeof normalized?.runId === "string" && normalized.runId.length > 0
			? normalized.runId
			: `pid-${process.pid}-${randomUUID()}`;
	const token =
		typeof normalized?.token === "string" && normalized.token.length > 0
			? normalized.token
			: randomUUID();
	const body = {
		ownerPid: process.pid,
		pid: process.pid,
		runId,
		token,
		createdAt: new Date().toISOString(),
	};

	try {
		mkdirSync(resolveVmAdmissionRoot(), { recursive: true, mode: 0o700 });
		const holders = [];

		for (let slotIndex = 0; slotIndex < VM_SLOT_COUNT; slotIndex += 1) {
			const slotPath = vmSlotPath(slotIndex);
			for (let attempt = 0; attempt < 2; attempt += 1) {
				if (publishSlot(slotPath, body)) {
					const lease = {
						slot: slotIndex,
						slotIndex,
						path: slotPath,
						ownerPid: process.pid,
						runId,
						token,
					};
					lease.release = () => releaseVmSlot(lease);
					return lease;
				}

				let owner;
				try {
					owner = readSlotBody(slotPath);
				} catch (error) {
					if (error?.code === "ENOENT") continue;
					throw error;
				}
				if (owner && !vmOwnerIsLive(owner.ownerPid)) {
					const reclaimPath = `${slotPath}.${process.pid}.${randomUUID()}.reclaim`;
					try {
						renameSync(slotPath, reclaimPath);
					} catch (error) {
						if (error.code === "ENOENT") continue;
						throw error;
					}
					try {
						unlinkSync(reclaimPath);
					} catch (error) {
						if (error.code !== "ENOENT") throw error;
					}
					continue;
				}

				holders.push(owner ? safeVmRunId(owner.runId) : "unknown");
				break;
			}
		}

		throw new VmSlotUnavailableError([...new Set(holders)]);
	} catch (error) {
		if (error instanceof VmSlotUnavailableError) throw error;
		throw sanitizeVmAdmissionError(error);
	}
}
export function acquireVmSlot(options = {}) {
	return acquireVmSlotWithDependencies(options);
}
export function projectVmGateOutcome({
	executed = false,
	unavailableReason = null,
	error = null,
} = {}) {
	if (error) {
		return { status: "failed", reason: "gate-error" };
	}
	if (executed) return { status: "executed" };
	if (
		typeof unavailableReason === "string" &&
		unavailableReason.trim().length > 0
	) {
		return {
			status: "unavailable-with-proof",
			reason: unavailableReason.trim().slice(0, 160),
		};
	}
	return { status: "failed", reason: "missing-unavailability-proof" };
}
export function publishVmGateOutcome(gateName, outcome) {
	const path = process.env.SWITCHYARD_VM_GATE_OUTCOME_FILE;
	if (!path) return false;
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(gateName)) {
		throw new TypeError("VM gate name is invalid");
	}
	const projected = projectVmGateOutcome({
		executed: outcome?.status === "executed",
		unavailableReason:
			outcome?.status === "unavailable-with-proof" ? outcome.reason : null,
		error: outcome?.status === "failed" ? new Error("gate failed") : null,
	});
	const record = {
		schemaVersion: 1,
		gate: gateName,
		status: projected.status,
		...(projected.reason ? { reason: projected.reason } : {}),
	};
	appendFileSync(path, `${JSON.stringify(record)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	return true;
}
function testVmReadinessUnavailable(error) {
	return (
		typeof error?.code === "string" &&
		(error.code.startsWith("vm_host_") ||
			error.code === "VM_ADMISSION_UNAVAILABLE" ||
			error.code === "VM_ADMISSION_PERMISSION_DENIED")
	);
}
export async function acquireVmSlotForTest({
	runId,
	timeoutMs = TEST_VM_SLOT_WAIT_TIMEOUT_MS,
	intervalMs = TEST_VM_SLOT_WAIT_INTERVAL_MS,
	nowFn = () => performance.now(),
	sleepFn = (delayMs) =>
		new Promise((resolveWait) => setTimeout(resolveWait, delayMs)),
	onStatus,
	readinessFn,
	acquireFn = acquireVmSlot,
} = {}) {
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		throw new RangeError("timeoutMs must be a non-negative number");
	}
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
		throw new RangeError("intervalMs must be a positive number");
	}
	if (typeof nowFn !== "function" || typeof sleepFn !== "function") {
		throw new TypeError("nowFn and sleepFn must be functions");
	}
	if (typeof acquireFn !== "function") {
		throw new TypeError("acquireFn must be a function");
	}
	if (readinessFn !== undefined && typeof readinessFn !== "function") {
		throw new TypeError("readinessFn must be a function");
	}

	const startedAt = nowFn();
	const deadline = startedAt + timeoutMs;
	let attempts = 0;
	let lastReason = "vm_slot_unavailable";
	for (;;) {
		attempts += 1;
		let readinessAvailable = true;
		try {
			const readiness = readinessFn ? await readinessFn() : true;
			if (
				readiness === false ||
				(readiness &&
					typeof readiness === "object" &&
					(readiness.ready === false ||
						readiness.status === "unavailable-with-proof"))
			) {
				lastReason =
					typeof readiness?.reason === "string" && readiness.reason.trim()
						? readiness.reason
						: "vm_host_not_ready";
				throw Object.assign(new Error(lastReason), {
					code: "VM_TEST_READINESS_UNAVAILABLE",
				});
			}
		} catch (error) {
			if (
				!testVmReadinessUnavailable(error) &&
				error?.code !== "VM_TEST_READINESS_UNAVAILABLE"
			) {
				throw error;
			}
			readinessAvailable = false;
			lastReason =
				error.code === "VM_TEST_READINESS_UNAVAILABLE"
					? String(error.message || "vm_host_not_ready").slice(0, 160)
					: error.code;
		}

		if (readinessAvailable) {
			try {
				const lease = await acquireFn({ runId });
				return {
					status: "executed",
					lease,
					attempts,
					elapsedMs: Math.max(0, nowFn() - startedAt),
				};
			} catch (error) {
				if (error?.code !== "VM_SLOT_UNAVAILABLE") throw error;
				lastReason = "vm_slot_unavailable";
			}
		}

		const remainingMs = Math.max(0, deadline - nowFn());
		const elapsedMs = Math.max(0, nowFn() - startedAt);
		onStatus?.({
			type: "vm-test-gate",
			event: "vm_slot_wait",
			status: "Waiting for VM admission capacity",
			elapsedMs,
			reason: lastReason,
		});
		if (remainingMs === 0) {
			return {
				status: "unavailable-with-proof",
				reason: lastReason,
				attempts,
				elapsedMs,
			};
		}
		await sleepFn(Math.min(intervalMs, remainingMs));
	}
}
export function releaseVmSlot(leaseOrSlot, token, runId) {
	const lease =
		leaseOrSlot && typeof leaseOrSlot === "object"
			? leaseOrSlot
			: { slot: leaseOrSlot, token, runId };
	const slotIndex = vmSlotIndex(lease.slotIndex ?? lease.slot ?? lease.path);
	const expectedToken = lease.token ?? token;
	if (slotIndex === null || typeof expectedToken !== "string") return false;

	const slotPath = vmSlotPath(slotIndex);
	let owner;
	try {
		owner = readVmSlotBody(slotPath);
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
	if (!owner || owner.token !== expectedToken) return false;
	if (lease.runId !== undefined && owner.runId !== lease.runId) return false;
	if (lease.ownerPid !== undefined && owner.ownerPid !== lease.ownerPid) {
		return false;
	}

	try {
		unlinkSync(slotPath);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}
export const acquireMacosVmSlot = acquireVmSlot;
export const releaseMacosVmSlot = releaseVmSlot;
export {
	acquireVmSlotWithDependencies,
	publishVmSlot,
	readVmSlotBody,
	removeVmTempFile,
	safeVmRunId,
	testVmReadinessUnavailable,
	VM_SLOT_COUNT,
	vmOwnerIsLive,
	vmSlotBody,
	vmSlotIndex,
};
