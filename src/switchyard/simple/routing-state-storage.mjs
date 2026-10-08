/** Shared no-follow, owner-only storage primitives for routing state. */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join, parse, resolve } from "node:path";

const fail = (code) => {
	throw Object.assign(new Error(code), { code });
};
const activeRoutingLockClaims = new Set();
const ROUTING_LOCK_CLAIM_MARKER = ".routing-claim.";

export function ensureSafeRoutingDirectories(path, create) {
	const absolute = resolve(path);
	let current = parse(absolute).root;
	for (const part of absolute
		.slice(current.length)
		.split("/")
		.filter(Boolean)) {
		current = join(current, part);
		if (!existsSync(current)) {
			if (!create) return false;
			mkdirSync(current, { mode: 0o700 });
		}
		const stat = lstatSync(current);
		if (
			stat.isSymbolicLink() ||
			!stat.isDirectory() ||
			(stat.mode & 0o022 && !(stat.mode & 0o1000))
		)
			fail("routing_unsafe_directory");
	}
	return true;
}

function safeFileStat(path, maxBytes) {
	const stat = lstatSync(path);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.nlink !== 1 ||
		stat.size > maxBytes ||
		stat.mode & 0o077 ||
		(process.getuid && stat.uid !== process.getuid())
	)
		fail("routing_unsafe_file");
	return stat;
}

function syncRoutingDirectory(path) {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function writeRoutingJsonAtomic(
	dir,
	fileName,
	value,
	failureCode = "routing_state_write_failed",
) {
	const target = join(dir, fileName);
	if (existsSync(target)) safeFileStat(target, 512 * 1024);
	const temporary = join(dir, `.${fileName}-${randomUUID()}`);
	let fd;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeFileSync(fd, JSON.stringify(value));
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, target);
		syncRoutingDirectory(dir);
	} catch {
		fail(failureCode);
	} finally {
		if (fd !== undefined) closeSync(fd);
		if (existsSync(temporary)) unlinkSync(temporary);
	}
}

export function readRoutingJsonFile(
	path,
	{
		missingCode = "routing_state_missing",
		malformedCode = "routing_state_malformed",
		maxBytes = 512 * 1024,
		validate = () => {},
	} = {},
) {
	let fd;
	try {
		const before = safeFileStat(path, maxBytes);
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const actual = fstatSync(fd);
		if (
			before.dev !== actual.dev ||
			before.ino !== actual.ino ||
			actual.nlink !== 1
		)
			fail("routing_unsafe_file");
		const value = JSON.parse(readFileSync(fd, "utf8"));
		validate(value);
		return value;
	} catch (error) {
		if (error?.code === "ENOENT") fail(missingCode);
		if (error?.code?.startsWith("routing_")) throw error;
		fail(malformedCode);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function safeRoutingLockStat(path, allowLinked = false) {
	const stat = lstatSync(path);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(stat.nlink !== 1 && !(allowLinked && stat.nlink === 2)) ||
		stat.size > 64 ||
		stat.mode & 0o077 ||
		(process.getuid && stat.uid !== process.getuid())
	)
		fail("routing_unsafe_file");
	return stat;
}

function readRoutingLock(path, allowLinked = false) {
	let fd;
	try {
		const before = safeRoutingLockStat(path, allowLinked);
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const actual = fstatSync(fd);
		if (
			before.dev !== actual.dev ||
			before.ino !== actual.ino ||
			before.nlink !== actual.nlink ||
			(actual.nlink !== 1 && !(allowLinked && actual.nlink === 2)) ||
			actual.size > 64 ||
			actual.mode & 0o077 ||
			(process.getuid && actual.uid !== process.getuid()) ||
			!actual.isFile()
		)
			fail("routing_unsafe_file");
		const content = readFileSync(fd, "utf8");
		const match = /^([1-9]\d*)\r?\n?$/u.exec(content);
		const pid = Number(match?.[1]);
		if (!Number.isSafeInteger(pid) || pid <= 0) fail("routing_lock_malformed");
		return { content, pid, stat: actual };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function sameLockIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino && left.isFile();
}

function lockClaimPath(path) {
	return `${path}${ROUTING_LOCK_CLAIM_MARKER}${process.pid}.${randomUUID()}`;
}

function claimOwnerPid(path, lockPath) {
	const prefix = `${basename(lockPath)}${ROUTING_LOCK_CLAIM_MARKER}`;
	const name = basename(path);
	if (!name.startsWith(prefix)) return null;
	const match =
		/^([1-9]\d*)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.exec(
			name.slice(prefix.length),
		);
	const pid = Number(match?.[1]);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function pidIsProvenDead(pid, probePid) {
	try {
		(probePid ?? process.kill)(pid, 0);
		return false;
	} catch (error) {
		return error?.code === "ESRCH";
	}
}

function lockClaimPaths(dir, path) {
	const prefix = `${basename(path)}${ROUTING_LOCK_CLAIM_MARKER}`;
	return readdirSync(dir)
		.filter((name) => name.startsWith(prefix))
		.map((name) => join(dir, name));
}

function restoreClaimWithoutClobber(claimPath, lockPath, dir, expectedStat) {
	try {
		linkSync(claimPath, lockPath);
	} catch (error) {
		if (error?.code === "EEXIST") return false;
		fail("routing_lock_claim_recovery_failed");
	}
	let restored;
	let claimed;
	try {
		restored = safeRoutingLockStat(lockPath, true);
		claimed = safeRoutingLockStat(claimPath, true);
	} catch {
		fail("routing_lock_claim_recovery_failed");
	}
	if (
		!sameLockIdentity(restored, expectedStat) ||
		!sameLockIdentity(claimed, expectedStat) ||
		restored.nlink !== 2 ||
		claimed.nlink !== 2
	)
		fail("routing_lock_claim_recovery_failed");
	unlinkSync(claimPath);
	syncRoutingDirectory(dir);
	return true;
}

function discardClaim(claimPath, dir, expectedStat) {
	let current;
	try {
		current = safeRoutingLockStat(claimPath, true);
	} catch {
		fail("routing_lock_claim_recovery_failed");
	}
	if (!sameLockIdentity(current, expectedStat))
		fail("routing_lock_claim_recovery_failed");
	unlinkSync(claimPath);
	syncRoutingDirectory(dir);
}

function recoverRoutingLockClaims(dir, path, { contentionCode, probePid }) {
	for (const stalePath of lockClaimPaths(dir, path)) {
		const staleOwnerPid = claimOwnerPid(stalePath, path);
		if (staleOwnerPid === null) fail(contentionCode);
		if (activeRoutingLockClaims.has(stalePath)) fail(contentionCode);
		if (
			staleOwnerPid !== process.pid &&
			!pidIsProvenDead(staleOwnerPid, probePid)
		)
			fail(contentionCode);
		let prior;
		try {
			prior = readRoutingLock(stalePath, true);
		} catch {
			fail(contentionCode);
		}
		const processingPath = lockClaimPath(path);
		activeRoutingLockClaims.add(processingPath);
		try {
			renameSync(stalePath, processingPath);
			syncRoutingDirectory(dir);
			const claimed = readRoutingLock(processingPath, true);
			if (
				!sameLockIdentity(claimed.stat, prior.stat) ||
				claimed.content !== prior.content
			)
				fail(contentionCode);
			let current = null;
			try {
				current = safeRoutingLockStat(path, true);
			} catch (error) {
				if (error?.code !== "ENOENT") fail(contentionCode);
			}
			if (current && sameLockIdentity(current, claimed.stat)) {
				discardClaim(processingPath, dir, claimed.stat);
				continue;
			}
			if (pidIsProvenDead(claimed.pid, probePid)) {
				discardClaim(processingPath, dir, claimed.stat);
				continue;
			}
			if (
				!current &&
				restoreClaimWithoutClobber(processingPath, path, dir, claimed.stat)
			)
				continue;
			fail(contentionCode);
		} catch (error) {
			if (error?.code?.startsWith("routing_")) throw error;
			fail(contentionCode);
		} finally {
			activeRoutingLockClaims.delete(processingPath);
		}
	}
}

function takeLockIntoClaim(path, dir, expectedStat, failureCode) {
	const claimPath = lockClaimPath(path);
	activeRoutingLockClaims.add(claimPath);
	try {
		renameSync(path, claimPath);
		syncRoutingDirectory(dir);
	} catch {
		activeRoutingLockClaims.delete(claimPath);
		fail(failureCode);
	}
	let claimed;
	try {
		claimed = safeRoutingLockStat(claimPath);
	} catch {
		activeRoutingLockClaims.delete(claimPath);
		fail(failureCode);
	}
	if (!sameLockIdentity(claimed, expectedStat)) {
		try {
			restoreClaimWithoutClobber(claimPath, path, dir, claimed);
		} finally {
			activeRoutingLockClaims.delete(claimPath);
		}
		fail(failureCode);
	}
	return { claimPath, stat: claimed };
}

function reclaimDeadRoutingLock(dir, path, { contentionCode, probePid }) {
	ensureSafeRoutingDirectories(dir, false);
	recoverRoutingLockClaims(dir, path, { contentionCode, probePid });
	let lock;
	try {
		lock = readRoutingLock(path);
	} catch (error) {
		if (
			error?.code === "routing_unsafe_file" ||
			error?.code === "routing_unsafe_directory"
		)
			throw error;
		fail(contentionCode);
	}
	if (!pidIsProvenDead(lock.pid, probePid)) fail(contentionCode);
	let current;
	try {
		current = lstatSync(path);
	} catch {
		fail(contentionCode);
	}
	if (!sameLockIdentity(current, lock.stat)) fail(contentionCode);
	const claim = takeLockIntoClaim(path, dir, lock.stat, contentionCode);
	try {
		const claimed = readRoutingLock(claim.claimPath);
		if (
			!sameLockIdentity(claimed.stat, lock.stat) ||
			claimed.content !== lock.content ||
			claimed.pid !== lock.pid ||
			!pidIsProvenDead(claimed.pid, probePid)
		) {
			restoreClaimWithoutClobber(claim.claimPath, path, dir, claimed.stat);
			fail(contentionCode);
		}
		discardClaim(claim.claimPath, dir, claim.stat);
	} finally {
		activeRoutingLockClaims.delete(claim.claimPath);
	}
}

export function acquireRoutingFileLock(
	dir,
	{
		fileName = ".lock",
		contentionCode = "routing_run_lock_contention",
		writeCode = "routing_state_write_failed",
		identityCode = "routing_lock_identity_changed",
		probePid,
	} = {},
) {
	ensureSafeRoutingDirectories(dir, false);
	const path = join(dir, fileName);
	let fd;
	let ownedStat;
	const releaseCurrent = () => {
		if (!ownedStat) return;
		const stat = ownedStat;
		ownedStat = undefined;
		releaseOwnedLock(path, dir, stat, identityCode);
	};
	const writeLock = () => {
		recoverRoutingLockClaims(dir, path, { contentionCode, probePid });
		fd = openSync(path, "wx", 0o600);
		ownedStat = fstatSync(fd);
		writeFileSync(fd, `${process.pid}\n`);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		syncRoutingDirectory(dir);
		try {
			recoverRoutingLockClaims(dir, path, { contentionCode, probePid });
		} catch (error) {
			releaseCurrent();
			throw error;
		}
	};
	try {
		writeLock();
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		releaseCurrent();
		if (error?.code !== "EEXIST") {
			if (error?.code === contentionCode || error?.code?.startsWith("routing_"))
				throw error;
			fail(writeCode);
		}
		reclaimDeadRoutingLock(dir, path, { contentionCode, probePid });
		try {
			writeLock();
		} catch (retryError) {
			if (fd !== undefined) closeSync(fd);
			releaseCurrent();
			if (retryError?.code === "EEXIST" || retryError?.code === contentionCode)
				fail(contentionCode);
			if (retryError?.code?.startsWith("routing_")) throw retryError;
			fail(writeCode);
		}
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		releaseOwnedLock(path, dir, ownedStat, identityCode);
	};
}

function releaseOwnedLock(path, dir, ownedStat, identityCode) {
	let stat;
	try {
		stat = safeRoutingLockStat(path);
	} catch {
		fail(identityCode);
	}
	if (
		stat.dev !== ownedStat.dev ||
		stat.ino !== ownedStat.ino ||
		stat.nlink !== 1
	)
		fail(identityCode);
	const claim = takeLockIntoClaim(path, dir, ownedStat, identityCode);
	try {
		discardClaim(claim.claimPath, dir, claim.stat);
	} finally {
		activeRoutingLockClaims.delete(claim.claimPath);
	}
}
