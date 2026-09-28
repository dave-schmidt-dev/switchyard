import { readFile, unlink, writeFile } from "node:fs/promises";
import { DEFAULT_LEASE_AGE_MS, locksRoot } from "./constants.mjs";
import { LockError } from "./errors.mjs";
import { assertProjectLockOwnership } from "./project-lock-claims.mjs";
import { lockFilePath } from "./project-lock-files.mjs";
import { ensureDir, readRun } from "./run-records.mjs";
import { updateRun } from "./run-updates.mjs";
export async function acquireRunLock(
	runId,
	pid,
	startToken,
	nonce,
	options = {},
) {
	let current = await readRun(runId);
	if (
		(current.state === "launching" || current.state === "launcher_ready") &&
		typeof current.projectPath === "string"
	) {
		await assertProjectLockOwnership(current.projectPath, runId);
		current = await readRun(runId);
	}

	if (current.workerPid !== null) {
		const sameProcessInitialClaim =
			current.workerPid === pid &&
			current.workerStartToken === null &&
			current.workerNonce === nonce;
		if (
			(current.workerPid === pid && current.workerStartToken === startToken) ||
			sameProcessInitialClaim
		) {
			const updated = await updateRun(
				runId,
				{
					workerPid: pid,
					workerStartToken: startToken,
					workerNonce: nonce,
					lastLeaseHeartbeat: new Date().toISOString(),
				},
				current.revision,
			);
			return updated;
		}

		if (!options.allowRecovery) {
			throw new LockError(
				`Run ${runId} is already leased by pid ${current.workerPid}`,
				{ code: "RUN_LOCK_HELD", holderRunId: runId },
			);
		}

		const expired = await isRunLockExpired(runId, {
			maxAgeMs: options.maxAgeMs ?? DEFAULT_LEASE_AGE_MS,
			now: options.now ?? new Date().toISOString(),
		});

		if (!expired) {
			throw new LockError(
				`Run ${runId} is already leased by pid ${current.workerPid} and lease has not expired`,
				{ code: "RUN_LOCK_HELD", holderRunId: runId },
			);
		}

		current = await readRun(runId);
	}

	const updated = await updateRun(
		runId,
		{
			workerPid: pid,
			workerStartToken: startToken,
			workerNonce: nonce,
			lastLeaseHeartbeat: new Date().toISOString(),
		},
		current.revision,
	);
	return updated;
}
export async function releaseRunLock(runId) {
	const current = await readRun(runId);
	const updated = await updateRun(
		runId,
		{
			workerPid: null,
			workerStartToken: null,
			workerNonce: "",
			lastLeaseHeartbeat: new Date().toISOString(),
		},
		current.revision,
	);
	return updated;
}
export async function renewRunLock(runId, pid, startToken) {
	const current = await readRun(runId);

	if (current.workerPid !== pid || current.workerStartToken !== startToken) {
		throw new LockError(
			`Cannot renew lock: identity mismatch for ${runId} (pid ${pid} vs ${current.workerPid})`,
			{ code: "RUN_LOCK_IDENTITY_MISMATCH", holderRunId: runId },
		);
	}

	const updated = await updateRun(
		runId,
		{ lastLeaseHeartbeat: new Date().toISOString() },
		current.revision,
	);
	return updated;
}
export async function isRunLockExpired(runId, options = {}) {
	const current = await readRun(runId);

	if (current.workerPid === null) return true;

	const maxAgeMs = options.maxAgeMs ?? DEFAULT_LEASE_AGE_MS;
	const reference = options.now ? new Date(options.now).getTime() : Date.now();
	const heartbeat = new Date(current.lastLeaseHeartbeat).getTime();

	return reference - heartbeat > maxAgeMs;
}
export async function acquireLaunchLock(canonicalTasksPath, runId) {
	await ensureDir(locksRoot(), 0o700);
	const lockPath = lockFilePath(canonicalTasksPath);
	const content = JSON.stringify({
		runId,
		createdAt: new Date().toISOString(),
	});
	try {
		await writeFile(lockPath, content, { flag: "wx", mode: 0o600 });
	} catch (e) {
		if (e.code === "EEXIST") {
			let holder = "unknown";
			try {
				const raw = await readFile(lockPath, "utf8");
				holder = JSON.parse(raw).runId;
			} catch {
				// ignore
			}
			throw new LockError(
				`Launch lock already held for ${canonicalTasksPath} by ${holder}`,
				{ code: "LAUNCH_LOCK_HELD", holderRunId: holder },
			);
		}
		throw e;
	}
}
export async function releaseLaunchLock(canonicalTasksPath) {
	const lockPath = lockFilePath(canonicalTasksPath);
	try {
		await unlink(lockPath);
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
}
