/** Durable run-scoped routing state. Unknown or in-flight state fails closed. */
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";
import { getStateRoot } from "../run-store/index.mjs";

export const MAX_ATTEMPT_HISTORY = 256;
const CAPABILITIES = new Set(["low", "standard", "high"]);
const TARGETS = new Set([
	"claude-code",
	"codex",
	"antigravity",
	"antigravity-claude",
	"cursor",
	"opencode-go",
	"vibe",
	"vibe-code",
	"copilot",
	"copilot-student",
]);
const REASONS = new Set([
	"succeeded",
	"execution_failed",
	"empty_diff",
	"unsafe_failure",
	"lifecycle_unconfirmed",
	"check_failed",
	"environment_failure",
	"policy_rejected",
	"baseline_failed",
]);
const fail = (code) => {
	throw Object.assign(new Error(code), { code });
};
const hasControls = (value) =>
	[...value].some(
		(char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127,
	);
const invocationValid = (id) =>
	typeof id === "string" &&
	/^\/?[A-Za-z0-9][A-Za-z0-9_./:-]{0,255}$/u.test(id) &&
	!id.split("/").includes("..");
const idValid = (id) =>
	typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id);
export function validateRoutingRunId(id) {
	if (!idValid(id)) fail("invalid_routing_run_id");
}
export function canonicalRoutingProject(project) {
	if (
		typeof project !== "string" ||
		!isAbsolute(project) ||
		project.length > 4096 ||
		hasControls(project)
	)
		fail("invalid_routing_project");
	try {
		const path = realpathSync(project);
		if (!lstatSync(path).isDirectory()) fail("invalid_routing_project");
		return path;
	} catch {
		fail("invalid_routing_project");
	}
}
function getRoutingStateRoot() {
	return join(getStateRoot(), "routing-runs");
}
const iso = (value) =>
	typeof value === "string" &&
	/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) &&
	Number.isFinite(Date.parse(value));
function exact(value, keys) {
	return (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).sort().join() === [...keys].sort().join()
	);
}
const allocationKeys = [
	"attemptId",
	"taskId",
	"runId",
	"targetId",
	"capability",
	"startedAt",
];
function allocation(value) {
	return (
		exact(value, allocationKeys) &&
		[value.attemptId, value.taskId, value.runId].every(idValid) &&
		TARGETS.has(value.targetId) &&
		CAPABILITIES.has(value.capability) &&
		iso(value.startedAt)
	);
}
function ackValid(ack, project, runId) {
	return (
		exact(ack, [
			"project",
			"routingRunId",
			"taskId",
			"invocationId",
			"route",
			"capability",
			"evidenceKind",
		]) &&
		ack.project === project &&
		ack.routingRunId === runId &&
		idValid(ack.taskId) &&
		invocationValid(ack.invocationId) &&
		CAPABILITIES.has(ack.capability) &&
		ack.route === `native/${ack.capability}` &&
		ack.evidenceKind === "actual-start"
	);
}
export function validateNativeAck(ack, project, runId) {
	if (!ackValid(ack, project, runId)) fail("receipt_identity_mismatch");
}
function validateState(state, project, runId) {
	if (
		!exact(state, [
			"schemaVersion",
			"canonicalProjectPath",
			"routingRunId",
			"createdAt",
			"updatedAt",
			"failedTargetIds",
			"attempts",
			"pendingAttempt",
			"nativeLatch",
			"nativeAck",
		]) ||
		state.schemaVersion !== 1 ||
		state.canonicalProjectPath !== project ||
		state.routingRunId !== runId ||
		!iso(state.createdAt) ||
		!iso(state.updatedAt) ||
		!Array.isArray(state.failedTargetIds) ||
		!Array.isArray(state.attempts) ||
		state.attempts.length > MAX_ATTEMPT_HISTORY ||
		typeof state.nativeLatch !== "boolean"
	)
		fail("routing_state_malformed");
	const seen = new Set();
	const failures = new Set();
	for (const item of state.attempts) {
		const allocated = Object.fromEntries(
			allocationKeys.map((key) => [key, item?.[key]]),
		);
		if (
			!exact(item, [
				...allocationKeys,
				"terminal",
				"reason",
				"closedAt",
				"partialWorktree",
			]) ||
			!allocation(allocated) ||
			seen.has(item.attemptId) ||
			!["succeeded", "failed", "skipped"].includes(item.terminal) ||
			!REASONS.has(item.reason) ||
			!iso(item.closedAt) ||
			!(
				item.partialWorktree === null ||
				(typeof item.partialWorktree === "string" &&
					isAbsolute(item.partialWorktree) &&
					item.partialWorktree.length <= 4096 &&
					!hasControls(item.partialWorktree))
			)
		)
			fail("routing_state_malformed");
		seen.add(item.attemptId);
		if (item.terminal === "failed") failures.add(item.targetId);
	}
	if (
		state.failedTargetIds.some((id) => !TARGETS.has(id)) ||
		new Set(state.failedTargetIds).size !== state.failedTargetIds.length ||
		JSON.stringify([...failures].sort()) !==
			JSON.stringify([...state.failedTargetIds].sort()) ||
		(state.pendingAttempt !== null &&
			(!allocation(state.pendingAttempt) ||
				seen.has(state.pendingAttempt.attemptId))) ||
		(state.nativeLatch
			? !ackValid(state.nativeAck, project, runId) ||
				state.pendingAttempt !== null
			: state.nativeAck !== null)
	)
		fail("routing_state_malformed");
}
function safeDirectories(path, create) {
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
		const st = lstatSync(current);
		if (
			st.isSymbolicLink() ||
			!st.isDirectory() ||
			(st.mode & 0o022 && !(st.mode & 0o1000))
		)
			fail("routing_unsafe_directory");
	}
	return true;
}
function safeFile(path) {
	const st = lstatSync(path);
	if (
		!st.isFile() ||
		st.isSymbolicLink() ||
		st.nlink !== 1 ||
		st.size > 512 * 1024 ||
		st.mode & 0o077 ||
		(process.getuid && st.uid !== process.getuid())
	)
		fail("routing_unsafe_file");
	return st;
}
function syncDirectory(path) {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
function writeAtomic(dir, state) {
	const target = join(dir, "state.json");
	if (existsSync(target)) safeFile(target);
	const tmp = join(dir, `.state-${randomUUID()}`);
	let fd;
	try {
		fd = openSync(tmp, "wx", 0o600);
		writeFileSync(fd, JSON.stringify(state));
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tmp, target);
		syncDirectory(dir);
	} catch {
		fail("routing_state_write_failed");
	} finally {
		if (fd !== undefined) closeSync(fd);
		if (existsSync(tmp)) unlinkSync(tmp);
	}
}
function readState(dir, project, runId) {
	const target = join(dir, "state.json");
	if (!existsSync(target)) fail("routing_state_missing");
	let fd;
	try {
		const before = safeFile(target);
		fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
		const actual = fstatSync(fd);
		if (
			before.dev !== actual.dev ||
			before.ino !== actual.ino ||
			actual.nlink !== 1
		)
			fail("routing_unsafe_file");
		const state = JSON.parse(readFileSync(fd, "utf8"));
		validateState(state, project, runId);
		return state;
	} catch (error) {
		if (error?.code?.startsWith("routing_")) throw error;
		fail("routing_state_malformed");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
function runPath(project, runId, stateRoot) {
	return join(
		stateRoot ?? getRoutingStateRoot(),
		`${createHash("sha256").update(project).digest("hex")}-${runId}`,
	);
}
/** Hold this exclusive lock through all routing attempts; stale locks are never reclaimed. */
export function openRoutingRun(
	project,
	runId,
	{ stateRoot, now = Date.now, create = true } = {},
) {
	project = canonicalRoutingProject(project);
	validateRoutingRunId(runId);
	const dir = runPath(project, runId, stateRoot);
	const existed = existsSync(dir);
	if (!existed && !create) fail("routing_run_not_found");
	safeDirectories(dir, create);
	const lock = join(dir, ".lock");
	let lockFd;
	try {
		lockFd = openSync(lock, "wx", 0o600);
		writeFileSync(lockFd, `${process.pid}\n`);
		fsyncSync(lockFd);
		syncDirectory(dir);
	} catch (error) {
		if (lockFd !== undefined) closeSync(lockFd);
		fail(
			error.code === "EEXIST"
				? "routing_run_lock_contention"
				: "routing_state_write_failed",
		);
	}
	const lockStat = fstatSync(lockFd);
	closeSync(lockFd);
	let released = false;
	let state;
	const release = () => {
		if (released) return;
		released = true;
		const st = lstatSync(lock);
		if (st.dev !== lockStat.dev || st.ino !== lockStat.ino || st.nlink !== 1)
			fail("routing_lock_identity_changed");
		unlinkSync(lock);
		syncDirectory(dir);
	};
	try {
		if (existed) state = readState(dir, project, runId);
		else {
			const time = new Date(now()).toISOString();
			state = {
				schemaVersion: 1,
				canonicalProjectPath: project,
				routingRunId: runId,
				createdAt: time,
				updatedAt: time,
				failedTargetIds: [],
				attempts: [],
				pendingAttempt: null,
				nativeLatch: false,
				nativeAck: null,
			};
			writeAtomic(dir, state);
		}
	} catch (error) {
		release();
		throw error;
	}
	return {
		get state() {
			return structuredClone(state);
		},
		runDir: dir,
		release,
		commit(patch) {
			if (released) fail("routing_run_already_released");
			const next = {
				...state,
				...patch,
				updatedAt: new Date(now()).toISOString(),
			};
			validateState(next, project, runId);
			if (
				next.createdAt !== state.createdAt ||
				next.attempts.length < state.attempts.length ||
				JSON.stringify(next.attempts.slice(0, state.attempts.length)) !==
					JSON.stringify(state.attempts) ||
				state.failedTargetIds.some(
					(id) => !next.failedTargetIds.includes(id),
				) ||
				(state.nativeLatch &&
					JSON.stringify(next.nativeAck) !== JSON.stringify(state.nativeAck)) ||
				(state.nativeLatch && !next.nativeLatch) ||
				(state.pendingAttempt &&
					JSON.stringify(next.pendingAttempt) !==
						JSON.stringify(state.pendingAttempt) &&
					!next.attempts.some((item) =>
						allocationKeys.every(
							(key) => item[key] === state.pendingAttempt[key],
						),
					))
			)
				fail("routing_state_nonmonotonic");
			safeDirectories(dir, false);
			writeAtomic(dir, next);
			state = next;
		},
	};
}
export function readRoutingRunState(project, runId, { stateRoot } = {}) {
	project = canonicalRoutingProject(project);
	validateRoutingRunId(runId);
	const dir = runPath(project, runId, stateRoot);
	if (!safeDirectories(dir, false)) return null;
	return readState(dir, project, runId);
}
export function recordAttemptOutcome(state, commit, record) {
	if (state.attempts.length >= MAX_ATTEMPT_HISTORY)
		fail("routing_attempt_history_cap_exceeded");
	if (
		!state.pendingAttempt ||
		record.attemptId !== state.pendingAttempt.attemptId
	)
		fail("routing_pending_identity_mismatch");
	const failures = new Set(state.failedTargetIds);
	if (record.terminal === "failed") failures.add(record.targetId);
	commit({
		attempts: [...state.attempts, record],
		failedTargetIds: [...failures],
		pendingAttempt: null,
	});
}
/** Only a validated actual-start acknowledgement may set the latch. */
export function latchNativeRequired(state, commit, ack) {
	validateNativeAck(ack, state.canonicalProjectPath, state.routingRunId);
	if (state.pendingAttempt) fail("pending_attempt_exists");
	if (state.nativeLatch) {
		if (JSON.stringify(state.nativeAck) !== JSON.stringify(ack))
			fail("native_ack_conflict");
		return;
	}
	commit({ nativeLatch: true, nativeAck: ack });
}
