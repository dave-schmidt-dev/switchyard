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
import { CHECK_ENVIRONMENT_SIGNATURES } from "./check-environment.mjs";

export const MAX_ATTEMPT_HISTORY = 256;
export const MAX_BROKEN_CHECKS = 32;
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
	"lifecycle_recovered",
	"check_failed",
	"environment_failure",
	"policy_rejected",
	"baseline_failed",
]);
/** Closed reasons a waterfall attempt records for a partial it did not carry (Task 3.11). */
export const CONTINUATION_SKIP_REASONS = Object.freeze([
	"writer_not_stopped",
	"diff_unavailable",
	"read_only_input_changed",
	"manifest_changed",
	"unsafe_diff",
	"out_of_scope",
	"base_changed",
	"dirty_overlay_base",
	"apply_failed",
	"attempt_not_started",
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
const ATTEMPT_KEYS = [
	...allocationKeys,
	"terminal",
	"reason",
	"closedAt",
	"partialWorktree",
];
// Optional continuation fields are omitted when absent, so attempts recorded
// before Task 3.11 keep their exact key set.
const OPTIONAL_ATTEMPT_KEYS = ["continuedFromAttemptId", "continuationSkipped"];
function attemptKeysFor(item) {
	return item && typeof item === "object" && !Array.isArray(item)
		? [
				...ATTEMPT_KEYS,
				...OPTIONAL_ATTEMPT_KEYS.filter((key) => Object.hasOwn(item, key)),
			]
		: ATTEMPT_KEYS;
}
// A continuation names one earlier attempt; a skip names one closed reason.
function continuationValid(item, earlier) {
	const from = item.continuedFromAttemptId;
	const skipped = item.continuationSkipped;
	if (from !== undefined && skipped !== undefined) return false;
	if (from !== undefined && !(idValid(from) && earlier.has(from))) return false;
	return skipped === undefined || CONTINUATION_SKIP_REASONS.includes(skipped);
}

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
const STATE_KEYS = [
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
];
// brokenChecks is optional: absence is the empty list, and a fresh state file
// stays identical to the pre-brokenChecks shape so older readers keep
// accepting it without a schemaVersion bump.
const STATE_KEYS_WITH_BROKEN_CHECKS = [...STATE_KEYS, "brokenChecks"];
const BROKEN_CHECK_KEYS = [
	"checkIdentity",
	"causeCode",
	"signature",
	"outputPath",
	"at",
];
const BROKEN_CHECK_SIGNATURES = new Set(CHECK_ENVIRONMENT_SIGNATURES);
function brokenCheckValid(entry) {
	return (
		exact(entry, BROKEN_CHECK_KEYS) &&
		typeof entry.checkIdentity === "string" &&
		/^[a-f0-9]{64}$/u.test(entry.checkIdentity) &&
		entry.causeCode === "check_environment_failed" &&
		BROKEN_CHECK_SIGNATURES.has(entry.signature) &&
		(entry.outputPath === null ||
			(typeof entry.outputPath === "string" &&
				isAbsolute(entry.outputPath) &&
				entry.outputPath.length <= 4096 &&
				!hasControls(entry.outputPath))) &&
		iso(entry.at)
	);
}
function stateKeysValid(state) {
	return (
		exact(state, STATE_KEYS) || exact(state, STATE_KEYS_WITH_BROKEN_CHECKS)
	);
}
function validateState(state, project, runId) {
	if (
		!stateKeysValid(state) ||
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
			!exact(item, attemptKeysFor(item)) ||
			!allocation(allocated) ||
			!continuationValid(item, seen) ||
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
		state.brokenChecks !== undefined &&
		(!Array.isArray(state.brokenChecks) ||
			state.brokenChecks.length > MAX_BROKEN_CHECKS ||
			state.brokenChecks.some((entry) => !brokenCheckValid(entry)))
	)
		fail("routing_state_malformed");
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
// The attempt history is prefix-immutable. The one explicit in-place
// transition is release_partial: exactly one attempt changes, only its
// recorded partialWorktree goes from a string to null, and the changed
// attempt must be the one the transition names. Every other field change is
// rejected.
function releasePartialAccepted(state, next, attemptId) {
	if (next.attempts.length !== state.attempts.length) return false;
	let changed = 0;
	for (const [index, before] of state.attempts.entries()) {
		const after = next.attempts[index];
		if (JSON.stringify(after) === JSON.stringify(before)) continue;
		if (
			++changed > 1 ||
			before.attemptId !== attemptId ||
			typeof before.partialWorktree !== "string" ||
			after?.partialWorktree !== null ||
			Object.keys(after).sort().join() !== Object.keys(before).sort().join() ||
			Object.keys(before).some(
				(key) => key !== "partialWorktree" && after[key] !== before[key],
			)
		)
			return false;
	}
	return changed === 1;
}
function attemptsMonotonic(state, next, transition) {
	if (transition?.transition === "release_partial")
		return releasePartialAccepted(state, next, transition.attemptId);
	return (
		JSON.stringify(next.attempts.slice(0, state.attempts.length)) ===
		JSON.stringify(state.attempts)
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
			// A fresh run's brokenChecks is the empty list; the field stays
			// absent until the first remembered entry so the file on disk keeps
			// the exact pre-brokenChecks key set.
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
		commit(patch, transition) {
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
				!attemptsMonotonic(state, next, transition) ||
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
					)) ||
				// brokenChecks is append-only: earlier entries never change.
				(state.brokenChecks ?? []).some(
					(entry, index) =>
						JSON.stringify(next.brokenChecks?.[index]) !==
						JSON.stringify(entry),
				)
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
/**
 * Explicit release_partial transition: clear one attempt's recorded
 * partialWorktree by building a new attempts array, so the commit guard can
 * verify that exactly that one field changed and nothing else did.
 */
export function releasePartialAttempt(state, commit, attemptId) {
	const attempt = state.attempts.find(
		(item) => item.attemptId === attemptId && item.partialWorktree !== null,
	);
	if (!attempt) fail("partial_worktree_not_recorded");
	commit(
		{
			attempts: state.attempts.map((item) =>
				item.attemptId === attemptId
					? { ...item, partialWorktree: null }
					: item,
			),
		},
		{ transition: "release_partial", attemptId },
	);
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
