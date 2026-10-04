import { randomUUID } from "node:crypto";

import { lstatSync, readFileSync, renameSync, unlinkSync } from "node:fs";

import { mkdir, open, writeFile } from "node:fs/promises";

import { dirname } from "node:path";

import {
	assertOwned,
	boundedRead,
	emit,
	HEALTH_LOCK_STALE_MS,
	hash,
	identityFrom,
	initialControl,
	initialObservations,
	locations,
	MAX_BYTES,
	RouteHealthSchemaError,
	readDerivedForUpdate,
	resolveHealthStateRoot,
	scopeKey,
	UUID_RE,
	unavailable,
	validateControl,
	validateObservations,
} from "./health-schema.mjs";

export function lockRecord(token) {
	return `${token}\n${JSON.stringify({
		pid: process.pid,
		acquiredAt: Date.now(),
	})}\n`;
}

function parseLockRecord(raw) {
	const [token, owner] = String(raw).split("\n");
	if (!UUID_RE.test(token ?? "")) return null;
	let pid = null;
	let acquiredAt = null;
	try {
		const parsed = JSON.parse(owner ?? "");
		if (Number.isInteger(parsed?.pid) && parsed.pid > 0) pid = parsed.pid;
		if (Number.isFinite(parsed?.acquiredAt)) acquiredAt = parsed.acquiredAt;
	} catch {
		// A lock written before owners were recorded, or a truncated write. It
		// has no owner to check, so only the age bound below can retire it.
	}
	return { token, pid, acquiredAt };
}

function lockOwnerIsAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code !== "ESRCH";
	}
}

export function reclaimAbandonedLock(location, seams = {}) {
	const now = seams.now ?? Date.now;
	const ownerAlive = seams.ownerAlive ?? lockOwnerIsAlive;
	let before;
	let raw;
	try {
		before = lstatSync(location.lock);
		if (!before.isFile() || before.isSymbolicLink()) return false;
		raw = readFileSync(location.lock, "utf8");
	} catch {
		// Gone already, or unreadable. Either way this caller reclaims nothing.
		return false;
	}
	const record = parseLockRecord(raw);
	const expired =
		record === null ||
		!Number.isFinite(record.acquiredAt) ||
		record.acquiredAt + HEALTH_LOCK_STALE_MS <= now();
	if (!expired && ownerAlive(record.pid) !== false) return false;
	const stalePath = `${location.lock}.abandoned.${randomUUID()}`;
	try {
		if (lstatSync(location.lock).ino !== before.ino) return false;
		renameSync(location.lock, stalePath);
		unlinkSync(stalePath);
	} catch {
		return false;
	}
	return true;
}

export function verifyLock(location, lease) {
	const stat = lstatSync(location.lock);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.ino !== lease.ino ||
		parseLockRecord(readFileSync(location.lock, "utf8"))?.token !== lease.token
	)
		throw new RouteHealthSchemaError("route health lease displaced");
}

export function verifyControlCas(location, identity, before) {
	if (before === null) {
		try {
			lstatSync(location.control);
			throw new RouteHealthSchemaError("route health revision displaced");
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		return;
	}
	const raw = readFileSync(location.control, "utf8");
	const current = validateControl(JSON.parse(raw), identity);
	if (raw !== before.raw || current.revision !== before.value.revision)
		throw new RouteHealthSchemaError("route health revision displaced");
}

export function observationsDigest(observations) {
	return hash(JSON.stringify(observations));
}

export function pairMatches(control, observations) {
	return (
		control.observationsRevision === observations.revision &&
		control.observationsDigest === observationsDigest(observations)
	);
}

export async function updateScope(
	input,
	mutate,
	{ allowInitialize = false, allowObservationRepair = false } = {},
) {
	const identity = identityFrom(input);
	const root = resolveHealthStateRoot(input.healthStateRoot);
	const location = locations(root, scopeKey(identity));
	let descriptor;
	let lease;
	try {
		emit(input, "health_update_start");
		await mkdir(root, { recursive: true, mode: 0o700 });
		await assertOwned(root, true);
		for (const directory of [
			dirname(location.control),
			dirname(location.observations),
			dirname(location.lock),
		]) {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await assertOwned(directory, true);
		}
		try {
			descriptor = await open(location.lock, "wx", 0o600);
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			// One retry, and only behind a proven-abandoned lock: a held lock
			// still reports held, but a killed writer no longer strands the
			// target for every future reader.
			if (!reclaimAbandonedLock(location, input))
				return unavailable("health-lease-held");
			try {
				descriptor = await open(location.lock, "wx", 0o600);
			} catch (retryError) {
				if (retryError?.code === "EEXIST")
					return unavailable("health-lease-held");
				throw retryError;
			}
		}
		lease = { token: randomUUID(), ino: (await descriptor.stat()).ino };
		await descriptor.writeFile(lockRecord(lease.token));
		await descriptor.sync();
		const beforeControl = await boundedRead(
			location.control,
			validateControl,
			identity,
			true,
		);
		const beforeObservations = await readDerivedForUpdate(
			location.observations,
			identity,
			allowObservationRepair,
		);
		let initialized = false;
		try {
			const initializedStat = await assertOwned(location.initialized);
			initialized = initializedStat.size === 0;
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		if (
			!beforeControl &&
			(initialized || !allowInitialize || beforeObservations)
		)
			return unavailable("health-control-unavailable");
		if (beforeControl && !initialized)
			return unavailable("health-initialization-registry-unavailable");
		if (beforeControl && !beforeObservations && !allowObservationRepair)
			return unavailable("health-observations-unavailable");
		if (
			beforeControl &&
			beforeObservations &&
			(!beforeObservations.value ||
				!pairMatches(beforeControl.value, beforeObservations.value)) &&
			!allowObservationRepair
		)
			return unavailable("health-observation-commit-mismatch");
		const control = structuredClone(
			beforeControl?.value ?? initialControl(identity),
		);
		const observations = structuredClone(
			beforeObservations?.value ?? initialObservations(identity),
		);
		if (
			input.expectedRevision !== undefined &&
			input.expectedRevision !== control.revision
		)
			return unavailable("health-revision-conflict");
		const result = await mutate({ control, observations, identity });
		if (result?.write === false)
			return { available: true, revision: control.revision, ...result };
		control.revision += 1;
		observations.revision = control.revision;
		control.observationsRevision = observations.revision;
		control.observationsDigest = observationsDigest(observations);
		validateControl(control, identity);
		validateObservations(observations, identity);
		const suffix = `${process.pid}.${randomUUID()}.tmp`;
		const controlTemp = `${location.control}.${suffix}`;
		const observationsTemp = `${location.observations}.${suffix}`;
		if (!initialized)
			await writeFile(location.initialized, "", { mode: 0o600, flag: "wx" });
		await writeFile(controlTemp, JSON.stringify(control), {
			mode: 0o600,
			flag: "wx",
		});
		await writeFile(observationsTemp, JSON.stringify(observations), {
			mode: 0o600,
			flag: "wx",
		});
		emit(input, "health_publish_staged");
		verifyLock(location, lease);
		verifyControlCas(location, identity, beforeControl);
		// Publication is synchronous after the final lease/CAS check so another JS
		// writer cannot interleave between validation and rename.
		renameSync(controlTemp, location.control);
		emit(input, "health_control_published");
		renameSync(observationsTemp, location.observations);
		emit(input, "health_publish_complete");
		return { available: true, revision: control.revision, ...result };
	} catch {
		emit(input, "health_update_unavailable");
		return unavailable();
	} finally {
		if (descriptor) {
			try {
				if (lease) verifyLock(location, lease);
				unlinkSync(location.lock);
			} catch {}
			await descriptor.close().catch(() => {});
		}
	}
}

export function readSyncRecord(path, validate, identity, optional = false) {
	try {
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.uid !== process.getuid() ||
			(stat.mode & 0o077) !== 0 ||
			stat.size > MAX_BYTES
		)
			throw new RouteHealthSchemaError("route health storage is unavailable");
		const raw = readFileSync(path, "utf8");
		return { raw, value: validate(JSON.parse(raw), identity) };
	} catch (error) {
		if (optional && error?.code === "ENOENT") return null;
		throw error;
	}
}
