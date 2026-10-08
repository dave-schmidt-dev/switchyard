import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	linkSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	latchNativeRequired,
	openRoutingRun,
	readRoutingRunState,
	recordAttemptOutcome,
	validateRoutingRunId,
} from "../src/switchyard/simple/routing-state.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const fixture = () => ({
	project: realpathSync(tempDir("routing-project-")),
	stateRoot: realpathSync(tempDir("routing-state-")),
});
const allocation = () => ({
	attemptId: "attempt-1",
	taskId: "task-1",
	runId: "simple-1",
	targetId: "codex",
	capability: "standard",
	startedAt: new Date().toISOString(),
});
const closed = (pending, terminal = "failed") => ({
	...pending,
	terminal,
	reason: terminal === "failed" ? "execution_failed" : "succeeded",
	closedAt: new Date().toISOString(),
	partialWorktree: null,
});
const ack = (project) => ({
	project,
	routingRunId: "run-1",
	taskId: "task-native",
	invocationId: "/root/native_routing_recovery",
	route: "native/high",
	capability: "high",
	evidenceKind: "actual-start",
});
test("IDs reject controls, paths, traversal and arbitrary secret-shaped payloads without echo", () => {
	for (const id of ["", "a/b", "..", "bad\nsecret", "a b", "x".repeat(129)])
		throws(() => validateRoutingRunId(id), {
			message: "invalid_routing_run_id",
		});
	validateRoutingRunId("run-1");
});
test("state retains failure evidence, supports success reuse, canonical project aliases and isolates runs", () => {
	const { project, stateRoot } = fixture();
	const h = openRoutingRun(project, "run-1", { stateRoot });
	const pending = allocation();
	h.commit({ pendingAttempt: pending });
	recordAttemptOutcome(h.state, h.commit, closed(pending));
	h.release();
	const alias = join(stateRoot, "project-alias");
	symlinkSync(project, alias);
	deepStrictEqual(
		readRoutingRunState(alias, "run-1", { stateRoot }).failedTargetIds,
		["codex"],
	);
	const fresh = openRoutingRun(project, "run-2", { stateRoot });
	deepStrictEqual(fresh.state.failedTargetIds, []);
	fresh.release();
});
test("exclusive lock persists until release and missing existing state never creates an ACK run", () => {
	const { project, stateRoot } = fixture();
	const h = openRoutingRun(project, "run-1", { stateRoot });
	throws(() => openRoutingRun(project, "run-1", { stateRoot }), {
		code: "routing_run_lock_contention",
	});
	h.release();
	throws(
		() => openRoutingRun(project, "missing", { stateRoot, create: false }),
		{ code: "routing_run_not_found" },
	);
});
test("pending evidence cannot be replaced or cleared without exact closed allocation", () => {
	const { project, stateRoot } = fixture();
	const h = openRoutingRun(project, "run-1", { stateRoot });
	h.commit({ pendingAttempt: allocation() });
	throws(() => h.commit({ pendingAttempt: null }), {
		code: "routing_state_nonmonotonic",
	});
	throws(
		() =>
			h.commit({ pendingAttempt: { ...allocation(), attemptId: "changed" } }),
		{ code: "routing_state_nonmonotonic" },
	);
	h.release();
	strictEqual(
		readRoutingRunState(project, "run-1", { stateRoot }).pendingAttempt
			.attemptId,
		"attempt-1",
	);
});
test("unknown fields, malformed bounded schemas and missing state fail closed", () => {
	const { project, stateRoot } = fixture();
	const h = openRoutingRun(project, "run-1", { stateRoot });
	const path = join(h.runDir, "state.json");
	h.release();
	const state = JSON.parse(readFileSync(path));
	for (const mutate of [
		(s) => {
			s.arbitrary = "secret";
		},
		(s) => {
			s.failedTargetIds = ["codex"];
		},
		(s) => {
			s.nativeLatch = true;
		},
		(s) => {
			s.pendingAttempt = {};
		},
		(s) => {
			s.attempts = Array(257).fill({});
		},
	]) {
		const next = structuredClone(state);
		mutate(next);
		writeFileSync(path, JSON.stringify(next));
		throws(() => readRoutingRunState(project, "run-1", { stateRoot }), {
			code: "routing_state_malformed",
		});
	}
	unlinkSync(path);
	throws(() => openRoutingRun(project, "run-1", { stateRoot }), {
		code: "routing_state_missing",
	});
});
test("symlink roots, ancestor symlinks, hardlinked state and unsafe modes are rejected", () => {
	const { project, stateRoot } = fixture();
	const linked = join(project, "linked-state");
	symlinkSync(stateRoot, linked);
	throws(() => openRoutingRun(project, "run-1", { stateRoot: linked }), {
		code: "routing_unsafe_directory",
	});
	throws(
		() =>
			openRoutingRun(project, "run-1", { stateRoot: join(linked, "child") }),
		{ code: "routing_unsafe_directory" },
	);
	const h = openRoutingRun(project, "run-1", { stateRoot });
	const path = join(h.runDir, "state.json");
	h.release();
	linkSync(path, join(project, "hardlink"));
	throws(() => readRoutingRunState(project, "run-1", { stateRoot }), {
		code: "routing_unsafe_file",
	});
	unlinkSync(join(project, "hardlink"));
	chmodSync(path, 0o644);
	throws(() => readRoutingRunState(project, "run-1", { stateRoot }), {
		code: "routing_unsafe_file",
	});
});
test("native acknowledgement is identity-bound, idempotent and monotonic", () => {
	const { project, stateRoot } = fixture();
	const h = openRoutingRun(project, "run-1", { stateRoot });
	const identity = ack(project);
	latchNativeRequired(h.state, h.commit, identity);
	latchNativeRequired(h.state, h.commit, identity);
	throws(
		() =>
			latchNativeRequired(h.state, h.commit, {
				...identity,
				invocationId: "different",
			}),
		{ code: "native_ack_conflict" },
	);
	throws(() => h.commit({ nativeLatch: false, nativeAck: null }), {
		code: "routing_state_nonmonotonic",
	});
	h.release();
	strictEqual(
		readRoutingRunState(project, "run-1", { stateRoot }).nativeLatch,
		true,
	);
});

test("new skipped outcomes roundtrip through the compatibility reader with exact v1 keys", async () => {
	const compatibilityRoot = process.env.SWITCHYARD_COMPATIBILITY_ROOT;
	const reader = compatibilityRoot
		? await import(
				`${compatibilityRoot}/src/switchyard/simple/routing-state.mjs`
			)
		: await import("../src/switchyard/simple/routing-state.mjs");
	const { project, stateRoot } = fixture();
	const h = openRoutingRun(project, "run-1", { stateRoot });
	const pending = allocation();
	h.commit({ pendingAttempt: pending });
	recordAttemptOutcome(h.state, h.commit, {
		...closed(pending, "skipped"),
		reason: "unsafe_failure",
	});
	h.release();
	const reloaded = reader.readRoutingRunState(project, "run-1", { stateRoot });
	strictEqual(reloaded.schemaVersion, 1);
	strictEqual(reloaded.attempts[0].terminal, "skipped");
	deepStrictEqual(reloaded.failedTargetIds, []);
	deepStrictEqual(
		Object.keys(reloaded.attempts[0]).sort(),
		[
			"attemptId",
			"taskId",
			"runId",
			"targetId",
			"capability",
			"startedAt",
			"terminal",
			"reason",
			"closedAt",
			"partialWorktree",
		].sort(),
	);
});

test("dead run lock holder is automatically reclaimed while live, malformed, and replaced locks fail closed", () => {
	const { project, stateRoot } = fixture();
	const h = openRoutingRun(project, "run-1", { stateRoot });
	const lockPath = join(h.runDir, ".lock");
	h.release();

	const res = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
	});
	writeFileSync(lockPath, `${res.pid}\n`, { mode: 0o600 });
	const reclaimed = openRoutingRun(project, "run-1", { stateRoot });
	strictEqual(reclaimed.state.routingRunId, "run-1");

	throws(() => openRoutingRun(project, "run-1", { stateRoot }), {
		code: "routing_run_lock_contention",
	});

	rmSync(lockPath);
	writeFileSync(lockPath, "replaced\n", { mode: 0o600 });
	throws(() => reclaimed.release(), {
		code: "routing_lock_identity_changed",
	});
	strictEqual(readFileSync(lockPath, "utf8"), "replaced\n");

	for (const bad of ["bad\n", "-10\n", "0\n", ""]) {
		writeFileSync(lockPath, bad, { mode: 0o600 });
		throws(() => openRoutingRun(project, "run-1", { stateRoot }), {
			code: "routing_run_lock_contention",
		});
	}

	chmodSync(lockPath, 0o644);
	throws(() => openRoutingRun(project, "run-1", { stateRoot }), {
		code: "routing_unsafe_file",
	});
	rmSync(lockPath);
});

test("persisted routing timestamps reject impossible dates without widening the canonical UTC grammar", () => {
	const { project, stateRoot } = fixture();
	const h = openRoutingRun(project, "run-1", { stateRoot });
	const path = join(h.runDir, "state.json");
	const state = JSON.parse(readFileSync(path, "utf8"));
	h.release();
	strictEqual(
		readRoutingRunState(project, "run-1", { stateRoot }).createdAt,
		state.createdAt,
	);

	for (const field of ["createdAt", "updatedAt"]) {
		for (const value of [
			"2025-02-29T00:00:00.000Z",
			"2026-10-08T24:00:00.000Z",
			"2024-02-29T00:00:00Z",
			"2024-02-29T00:00:00.000+00:00",
		]) {
			const next = structuredClone(state);
			next[field] = value;
			writeFileSync(path, JSON.stringify(next));
			throws(() => readRoutingRunState(project, "run-1", { stateRoot }), {
				code: "routing_state_malformed",
			});
		}
	}
});
