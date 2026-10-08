import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	latchNativeRequired,
	openRoutingRun,
	recordAttemptOutcome,
} from "../src/switchyard/simple/routing-state.mjs";
import { acquireRoutingFileLock } from "../src/switchyard/simple/routing-state-storage.mjs";
import { beginRoutingTaskBinding } from "../src/switchyard/simple/routing-task-state.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const setup = () => ({
	project: realpathSync(tempDir("routing-task-project-")),
	stateRoot: realpathSync(tempDir("routing-task-state-")),
	identityHash: "a".repeat(64),
});

function createRun(project, stateRoot, runId = "run-1") {
	const handle = openRoutingRun(project, runId, { stateRoot });
	handle.release();
}

function bind({
	project,
	stateRoot,
	identityHash,
	runId = "run-1",
	status = "failed",
}) {
	const binding = beginRoutingTaskBinding({
		project,
		origin: "work",
		identityHash,
		routingRunId: runId,
		stateRoot,
	});
	binding.finish(status);
	binding.release();
}

function routingLockReplacementProbe(scenario) {
	const root = realpathSync(tempDir("routing-lock-replacement-"));
	const storageUrl = new URL(
		"../src/switchyard/simple/routing-state-storage.mjs",
		import.meta.url,
	).href;
	const script = `
		import { spawnSync } from "node:child_process";
		import fs from "node:fs";
		import { syncBuiltinESMExports } from "node:module";
		import { join } from "node:path";
		import { acquireRoutingFileLock } from ${JSON.stringify(storageUrl)};
		const root = ${JSON.stringify(root)};
		const scenario = ${JSON.stringify(scenario)};
		const lockPath = join(root, ".lock");
		fs.mkdirSync(root, { recursive: true, mode: 0o700 });
		fs.chmodSync(root, 0o700);
		let replacementIdentity;
		let injected = false;
		let errorCode = null;
		let contenderCode = null;
		const checkContender = () => {
			const contenderScript = "import { acquireRoutingFileLock } from " +
				JSON.stringify(${JSON.stringify(storageUrl)}) +
				"; try { acquireRoutingFileLock(" + JSON.stringify(root) +
				", { contentionCode: 'test_lock_contention' }); process.stdout.write('acquired'); } catch (error) { process.stdout.write(error.code); }";
			const contender = spawnSync(
				process.execPath,
				["--input-type=module", "-e", contenderScript],
				{ cwd: process.cwd(), encoding: "utf8", timeout: 3_000 },
			);
			contenderCode = contender.stdout.trim();
		};
		const installInjection = () => {
			const originalRenameSync = fs.renameSync;
			const originalUnlinkSync = fs.unlinkSync;
			const replace = () => {
				originalUnlinkSync(lockPath);
				const content = scenario === "release"
					? "foreign-release\\n"
					: String(process.pid) + "\\n";
				fs.writeFileSync(lockPath, content, { mode: 0o600 });
				const stat = fs.lstatSync(lockPath);
				replacementIdentity = { dev: stat.dev, ino: stat.ino };
				injected = true;
			};
			fs.renameSync = (source, destination, ...args) => {
				if (
					!injected &&
					source === lockPath &&
					destination.startsWith(lockPath + ".routing-claim.")
				) {
					replace();
					const result = originalRenameSync(source, destination, ...args);
					checkContender();
					return result;
				}
				return originalRenameSync(source, destination, ...args);
			};
			fs.unlinkSync = (path, ...args) => {
				if (!injected && path === lockPath) {
					replace();
					checkContender();
				}
				return originalUnlinkSync(path, ...args);
			};
			syncBuiltinESMExports();
			return () => {
				fs.renameSync = originalRenameSync;
				fs.unlinkSync = originalUnlinkSync;
				syncBuiltinESMExports();
			};
		};
		if (scenario === "reclaim") {
			fs.writeFileSync(lockPath, "99999999\\n", { mode: 0o600 });
			const restore = installInjection();
			try {
				acquireRoutingFileLock(root, {
					contentionCode: "test_lock_contention",
					probePid: () => {
						throw Object.assign(new Error("dead fixture"), { code: "ESRCH" });
					},
				});
			} catch (error) {
				errorCode = error.code;
			} finally {
				restore();
			}
		} else {
			const release = acquireRoutingFileLock(root, {
				identityCode: "test_lock_identity_changed",
			});
			const restore = installInjection();
			try {
				release();
			} catch (error) {
				errorCode = error.code;
			} finally {
				restore();
			}
		}
		let body = null;
		let finalIdentity = null;
		try {
			body = fs.readFileSync(lockPath, "utf8");
			const stat = fs.lstatSync(lockPath);
			finalIdentity = { dev: stat.dev, ino: stat.ino };
		} catch {}
		process.stdout.write(JSON.stringify({
			body,
			contenderCode,
			errorCode,
			finalIdentity,
			injected,
			replacementIdentity,
		}) + "\\n");
	`;
	try {
		const child = spawnSync(
			process.execPath,
			["--input-type=module", "-e", script],
			{ cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
		);
		if (child.error) throw child.error;
		strictEqual(child.status, 0, child.stderr);
		return JSON.parse(child.stdout);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("exact-key binding links failed runs and permits only a verified success to rebind", () => {
	const f = setup();
	createRun(f.project, f.stateRoot);
	bind(f);
	const linked = beginRoutingTaskBinding({
		...f,
		origin: "work",
		routingRunId: "run-2",
		stateRoot: f.stateRoot,
	});
	deepStrictEqual(linked, {
		linked: true,
		previousRoutingRunId: "run-1",
	});

	const success = setup();
	const run = openRoutingRun(success.project, "run-1", {
		stateRoot: success.stateRoot,
	});
	const pending = {
		attemptId: "attempt-1",
		taskId: success.identityHash,
		runId: "engine-1",
		targetId: "codex",
		capability: "standard",
		startedAt: new Date().toISOString(),
	};
	run.commit({ pendingAttempt: pending });
	recordAttemptOutcome(run.state, run.commit, {
		...pending,
		terminal: "succeeded",
		reason: "succeeded",
		closedAt: new Date().toISOString(),
		partialWorktree: null,
	});
	run.release();
	bind({ ...success, status: "succeeded" });
	const rebound = beginRoutingTaskBinding({
		...success,
		origin: "work",
		routingRunId: "run-2",
		stateRoot: success.stateRoot,
	});
	strictEqual(rebound.linked, false);
	rebound.release();
});

test("prior success rebind requires task-local succeeded with no task-local failed outcomes for this identityHash", () => {
	const cross = setup();
	const runCross = openRoutingRun(cross.project, "run-1", {
		stateRoot: cross.stateRoot,
	});
	const otherPending = {
		attemptId: "attempt-1",
		taskId: "other-task-id",
		runId: "engine-1",
		targetId: "codex",
		capability: "standard",
		startedAt: new Date().toISOString(),
	};
	runCross.commit({ pendingAttempt: otherPending });
	recordAttemptOutcome(runCross.state, runCross.commit, {
		...otherPending,
		terminal: "succeeded",
		reason: "succeeded",
		closedAt: new Date().toISOString(),
		partialWorktree: null,
	});
	runCross.release();
	bind({ ...cross, status: "succeeded" });
	throws(
		() =>
			beginRoutingTaskBinding({
				...cross,
				origin: "work",
				routingRunId: "run-2",
				stateRoot: cross.stateRoot,
			}),
		{ code: "routing_task_binding_source_mismatch" },
	);

	const mixed = setup();
	const runMixed = openRoutingRun(mixed.project, "run-1", {
		stateRoot: mixed.stateRoot,
	});
	const failPending = {
		attemptId: "attempt-1",
		taskId: mixed.identityHash,
		runId: "engine-1",
		targetId: "codex",
		capability: "standard",
		startedAt: new Date().toISOString(),
	};
	runMixed.commit({ pendingAttempt: failPending });
	recordAttemptOutcome(runMixed.state, runMixed.commit, {
		...failPending,
		terminal: "failed",
		reason: "execution_failed",
		closedAt: new Date().toISOString(),
		partialWorktree: null,
	});
	const succPending = {
		attemptId: "attempt-2",
		taskId: mixed.identityHash,
		runId: "engine-2",
		targetId: "vibe",
		capability: "standard",
		startedAt: new Date().toISOString(),
	};
	runMixed.commit({ pendingAttempt: succPending });
	recordAttemptOutcome(runMixed.state, runMixed.commit, {
		...succPending,
		terminal: "succeeded",
		reason: "succeeded",
		closedAt: new Date().toISOString(),
		partialWorktree: null,
	});
	runMixed.release();
	bind({ ...mixed, status: "succeeded" });
	throws(
		() =>
			beginRoutingTaskBinding({
				...mixed,
				origin: "work",
				routingRunId: "run-2",
				stateRoot: mixed.stateRoot,
			}),
		{ code: "routing_task_binding_source_mismatch" },
	);
});

test("malformed, mismatched, symlinked, hardlinked and permissive bindings fail closed", () => {
	for (const kind of ["malformed", "mismatch", "symlink", "hardlink", "mode"]) {
		const f = setup();
		createRun(f.project, f.stateRoot);
		bind(f);
		const dir = join(f.stateRoot, "task-bindings", f.identityHash);
		const path = join(dir, "binding.json");
		if (kind === "malformed") writeFileSync(path, "{", { mode: 0o600 });
		if (kind === "mismatch") {
			const record = JSON.parse(readFileSync(path, "utf8"));
			record.origin = "qualification";
			writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
		}
		if (kind === "symlink") {
			rmSync(path);
			const target = join(f.stateRoot, "victim.json");
			writeFileSync(target, "{}", { mode: 0o600 });
			symlinkSync(target, path);
		}
		if (kind === "hardlink")
			linkSync(path, join(f.stateRoot, "binding-copy.json"));
		if (kind === "mode") chmodSync(path, 0o644);
		throws(
			() =>
				beginRoutingTaskBinding({
					...f,
					origin: "work",
					routingRunId: "run-2",
					stateRoot: f.stateRoot,
				}),
			(error) => error.code?.startsWith("routing_"),
		);
	}
});

test("only the exact task key is read and lock contention fails closed", () => {
	const f = setup();
	createRun(f.project, f.stateRoot);
	bind(f);
	const unrelated = join(f.stateRoot, "task-bindings", "b".repeat(64));
	mkdirSync(unrelated, { recursive: true, mode: 0o700 });
	writeFileSync(join(unrelated, "binding.json"), "{", { mode: 0o600 });
	const held = beginRoutingTaskBinding({
		project: f.project,
		origin: "work",
		identityHash: f.identityHash,
		routingRunId: "run-1",
		stateRoot: f.stateRoot,
	});
	strictEqual(held.linked, false);
	throws(
		() =>
			beginRoutingTaskBinding({
				project: f.project,
				origin: "work",
				identityHash: f.identityHash,
				routingRunId: "run-2",
				stateRoot: f.stateRoot,
			}),
		{ code: "routing_task_identity_lock_contention" },
	);
	held.release();
	const ready = beginRoutingTaskBinding({
		project: f.project,
		origin: "work",
		identityHash: f.identityHash,
		routingRunId: "run-1",
		stateRoot: f.stateRoot,
	});
	ready.release();
});

test("replaced lock is never released as though it were owned", () => {
	const f = setup();
	const binding = beginRoutingTaskBinding({
		...f,
		origin: "work",
		routingRunId: "run-1",
		stateRoot: f.stateRoot,
	});
	const lock = join(f.stateRoot, "task-bindings", f.identityHash, ".task-lock");
	rmSync(lock);
	writeFileSync(lock, "replacement\n", { mode: 0o600 });
	throws(() => binding.release(), {
		code: "routing_task_identity_lock_changed",
	});
	strictEqual(readFileSync(lock, "utf8"), "replacement\n");
});

test("a missing referenced routing run cannot be replaced by a renamed task", () => {
	const f = setup();
	createRun(f.project, f.stateRoot);
	bind(f);
	const runDir = join(
		f.stateRoot,
		`${createHash("sha256").update(f.project).digest("hex")}-run-1`,
	);
	rmSync(runDir, { recursive: true });
	throws(
		() =>
			beginRoutingTaskBinding({
				...f,
				origin: "work",
				routingRunId: "run-2",
				stateRoot: f.stateRoot,
			}),
		{ code: "routing_task_binding_source_unavailable" },
	);
});

test("pending, native-latched, and retained-partial source runs cannot be rebound", () => {
	for (const kind of ["pending", "native", "partial"]) {
		const f = setup();
		const handle = openRoutingRun(f.project, "run-1", {
			stateRoot: f.stateRoot,
		});
		const pending = {
			attemptId: "attempt-1",
			taskId: "logical-1",
			runId: "engine-1",
			targetId: "codex",
			capability: "standard",
			startedAt: new Date().toISOString(),
		};
		if (kind === "pending") handle.commit({ pendingAttempt: pending });
		if (kind === "native")
			latchNativeRequired(handle.state, handle.commit, {
				project: f.project,
				routingRunId: "run-1",
				taskId: "native-1",
				invocationId: "/root/native_recovery",
				route: "native/high",
				capability: "high",
				evidenceKind: "actual-start",
			});
		if (kind === "partial") {
			handle.commit({ pendingAttempt: pending });
			recordAttemptOutcome(handle.state, handle.commit, {
				...pending,
				terminal: "failed",
				reason: "execution_failed",
				closedAt: new Date().toISOString(),
				partialWorktree: join(f.project, "retained"),
			});
		}
		handle.release();
		bind({ ...f, status: "succeeded" });
		const result = beginRoutingTaskBinding({
			...f,
			origin: "work",
			routingRunId: "run-2",
			stateRoot: f.stateRoot,
		});
		deepStrictEqual(result, {
			linked: true,
			previousRoutingRunId: "run-1",
		});
	}
});

test("dead task lock holder is automatically reclaimed while live lock remains fail-closed", () => {
	const f = setup();
	const dir = join(f.stateRoot, "task-bindings", f.identityHash);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = join(dir, ".task-lock");
	const res = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
	});
	writeFileSync(lock, `${res.pid}\n`, { mode: 0o600 });
	const binding = beginRoutingTaskBinding({
		...f,
		origin: "work",
		routingRunId: "run-1",
		stateRoot: f.stateRoot,
	});
	strictEqual(binding.linked, false);
	throws(
		() =>
			beginRoutingTaskBinding({
				...f,
				origin: "work",
				routingRunId: "run-2",
				stateRoot: f.stateRoot,
			}),
		{ code: "routing_task_identity_lock_contention" },
	);
	binding.release();
});

test("routing lock reclaim and release preserve a replacement installed at the take boundary", () => {
	for (const scenario of ["reclaim", "release"]) {
		const result = routingLockReplacementProbe(scenario);
		strictEqual(result.injected, true, JSON.stringify(result));
		strictEqual(
			result.contenderCode,
			"test_lock_contention",
			JSON.stringify({ scenario, result }),
		);
		strictEqual(
			result.errorCode,
			scenario === "reclaim"
				? "test_lock_contention"
				: "test_lock_identity_changed",
		);
		deepStrictEqual(result.finalIdentity, result.replacementIdentity);
		strictEqual(
			scenario === "reclaim"
				? /^\d+\n$/u.test(result.body)
				: result.body === "foreign-release\n",
			true,
		);
	}
});

test("dead reclaimer claims restore live lock owners and discard only proven-dead ones", () => {
	const deadProbe = () => {
		throw Object.assign(new Error("dead fixture"), { code: "ESRCH" });
	};
	const deadOwner = setup();
	const liveOwner = setup();
	try {
		const deadDir = join(deadOwner.stateRoot, "claims");
		mkdirSync(deadDir, { mode: 0o700 });
		const deadPath = join(deadDir, ".lock");
		const deadClaim = `${deadPath}.routing-claim.99999999.${randomUUID()}`;
		writeFileSync(deadClaim, "99999998\n", { mode: 0o600 });
		const deadRelease = acquireRoutingFileLock(deadDir, {
			probePid: deadProbe,
		});
		strictEqual(existsSync(deadClaim), false);
		deadRelease();

		const liveDir = join(liveOwner.stateRoot, "claims");
		mkdirSync(liveDir, { mode: 0o700 });
		const livePath = join(liveDir, ".lock");
		const liveClaim = `${livePath}.routing-claim.99999999.${randomUUID()}`;
		writeFileSync(liveClaim, `${process.pid}\n`, { mode: 0o600 });
		const before = lstatSync(liveClaim);
		throws(() => acquireRoutingFileLock(liveDir), {
			code: "routing_run_lock_contention",
		});
		strictEqual(readFileSync(livePath, "utf8"), `${process.pid}\n`);
		const restored = lstatSync(livePath);
		deepStrictEqual(
			{ dev: restored.dev, ino: restored.ino },
			{ dev: before.dev, ino: before.ino },
		);
		strictEqual(existsSync(liveClaim), false);
	} finally {
		rmSync(deadOwner.stateRoot, { recursive: true, force: true });
		rmSync(deadOwner.project, { recursive: true, force: true });
		rmSync(liveOwner.stateRoot, { recursive: true, force: true });
		rmSync(liveOwner.project, { recursive: true, force: true });
	}
});
