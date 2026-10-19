// @test-phase: other
import {
	deepStrictEqual,
	notStrictEqual,
	rejects,
	strictEqual,
} from "node:assert";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { withStateRoot } from "../src/switchyard/dispatch/cli-args.mjs";
import { initializeRun } from "../src/switchyard/run-store/index.mjs";
import { handleRoutingRun } from "../src/switchyard/simple/routing-cli.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import {
	openRoutingRun,
	readRoutingRunState,
	recordAttemptOutcome,
} from "../src/switchyard/simple/routing-state.mjs";
import { routingTaskIdentityHash } from "../src/switchyard/simple/routing-task-identity.mjs";
import { simpleQuarantinePath } from "../src/switchyard/simple/worktree-cleanup.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const MARKER = ".switchyard-cleanup-owner.json";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const quarantines = new Set();

afterEach(() => {
	for (const path of quarantines) {
		try {
			rmSync(path, { recursive: true, force: true });
		} catch {
			// A quarantine that survived the test is already failure evidence.
		}
	}
	quarantines.clear();
});

function createClaimRoot(parent, runId, nonce) {
	const root = join(parent, `switchyard-simple-${randomUUID()}`);
	mkdirSync(root, { mode: 0o700 });
	const markerPath = join(root, MARKER);
	writeFileSync(markerPath, JSON.stringify({ runId, nonce }), {
		flag: "wx",
		mode: 0o600,
	});
	chmodSync(markerPath, 0o600);
	return { root, identity: lstatSync(root, { bigint: true }) };
}

function makeClaim(parent, nonce, root, identity, writerStopped) {
	return {
		canonicalParent: parent,
		candidateChild: root.slice(parent.length + 1),
		path: root,
		state: "retained",
		reason: "salvage_retained",
		retainedAt: new Date().toISOString(),
		device: identity.dev.toString(),
		inode: identity.ino.toString(),
		nonce,
		writerStopped,
	};
}

function recordPartial(stateRoot, project, pending, partialWorktree) {
	const handle = openRoutingRun(project, "run-1", { stateRoot });
	handle.commit({ pendingAttempt: pending });
	recordAttemptOutcome(handle.state, handle.commit, {
		...pending,
		terminal: "failed",
		reason: "execution_failed",
		closedAt: new Date().toISOString(),
		partialWorktree,
	});
	handle.release();
}

// callerTaskId: the --task-id a caller passed to simple. Routing state then
// persists the identity hash simple bound for it, never the caller's value.
function fixture({
	writerStopped = true,
	worktreeChild = false,
	callerTaskId = null,
	origin = "work",
} = {}) {
	const project = realpathSync(tempDir("release-partial-project-"));
	const stateRoot = realpathSync(tempDir("release-partial-state-"));
	const parent = realpathSync(tempDir("release-partial-parent-"));
	const taskId = callerTaskId
		? routingTaskIdentityHash({ taskId: callerTaskId }, project, origin)
		: "task-1";
	const runId = `simple-${randomUUID()}`;
	const nonce = randomUUID();
	const { root, identity } = createClaimRoot(parent, runId, nonce);
	const claim = makeClaim(parent, nonce, root, identity, writerStopped);
	const record = { runId, projectPath: project, worktree: claim };
	const pending = {
		attemptId: `attempt-${randomUUID()}`,
		taskId,
		runId,
		targetId: "codex",
		capability: "standard",
		startedAt: new Date().toISOString(),
	};
	// Production records the claim root while routing state records the
	// clone at `<root>/worktree`.
	const partial = worktreeChild ? join(root, "worktree") : root;
	if (worktreeChild) mkdirSync(partial, { mode: 0o700 });
	recordPartial(stateRoot, project, pending, partial);
	return {
		project,
		stateRoot,
		taskId,
		runId,
		claim,
		record,
		root,
		argv: [
			"release-partial",
			"--project",
			project,
			"--routing-run-id",
			"run-1",
			"--task-id",
			callerTaskId ?? taskId,
		],
		deps: {
			stateRoot,
			readRun: async () => record,
			isProjectLockHeld: () => false,
			writeResult: () => {},
		},
	};
}

function readState(f) {
	return readRoutingRunState(f.project, "run-1", { stateRoot: f.stateRoot });
}

test("an already-removed root is released without --discard", async () => {
	const f = fixture();
	rmSync(f.root, { recursive: true, force: true });
	let output;
	await handleRoutingRun(f.argv, {
		...f.deps,
		writeResult: (value) => {
			output = JSON.parse(value);
		},
	});
	strictEqual(output.ok, true);
	strictEqual(output.released, true);
	strictEqual(output.discarded, false);
	strictEqual(output.path, f.root);
	strictEqual(readState(f).attempts[0].partialWorktree, null);
});

test("an existing root is removed only with --discard", async () => {
	const refused = fixture();
	const before = readState(refused);
	await rejects(handleRoutingRun(refused.argv, refused.deps), {
		code: "discard_required",
	});
	strictEqual(existsSync(refused.root), true);
	deepStrictEqual(readState(refused), before);

	const f = fixture();
	const quarantine = simpleQuarantinePath(f.claim.nonce);
	quarantines.add(quarantine);
	let output;
	await handleRoutingRun([...f.argv, "--discard"], {
		...f.deps,
		writeResult: (value) => {
			output = JSON.parse(value);
		},
	});
	strictEqual(output.discarded, true);
	strictEqual(existsSync(f.root), false);
	strictEqual(existsSync(quarantine), false);
	strictEqual(readState(f).attempts[0].partialWorktree, null);
});

test("a quarantine-only root is removed with --discard", async () => {
	const f = fixture();
	const quarantine = simpleQuarantinePath(f.claim.nonce);
	quarantines.add(quarantine);
	renameSync(f.root, quarantine);
	let output;
	await handleRoutingRun([...f.argv, "--discard"], {
		...f.deps,
		writeResult: (value) => {
			output = JSON.parse(value);
		},
	});
	strictEqual(output.discarded, true);
	strictEqual(existsSync(quarantine), false);
	strictEqual(readState(f).attempts[0].partialWorktree, null);
});

test("both roots present is refused as cleanup_state_ambiguous", async () => {
	const f = fixture();
	const quarantine = simpleQuarantinePath(f.claim.nonce);
	quarantines.add(quarantine);
	mkdirSync(quarantine, { mode: 0o700 });
	const before = readState(f);
	await rejects(handleRoutingRun([...f.argv, "--discard"], f.deps), {
		code: "cleanup_state_ambiguous",
	});
	strictEqual(existsSync(f.root), true);
	strictEqual(existsSync(quarantine), true);
	deepStrictEqual(readState(f), before);
});

test("a retained discard keeps the recorded partial in routing state", async () => {
	const f = fixture({ writerStopped: false });
	const before = readState(f);
	await rejects(handleRoutingRun([...f.argv, "--discard"], f.deps), {
		code: "cleanup_retained",
	});
	strictEqual(existsSync(f.root), true);
	strictEqual(readState(f).attempts[0].partialWorktree, f.root);
	deepStrictEqual(readState(f), before);
});

test("the CLI exits nonzero with cleanup_retained when cleanup is retained", async () => {
	const storeRoot = realpathSync(tempDir("release-partial-store-"));
	const project = realpathSync(tempDir("release-partial-project-"));
	const parent = realpathSync(tempDir("release-partial-parent-"));
	const taskId = "task-1";
	const runId = `simple-${randomUUID()}`;
	const nonce = randomUUID();
	const { root, identity } = createClaimRoot(parent, runId, nonce);
	const claim = makeClaim(parent, nonce, root, identity, false);
	await withStateRoot(storeRoot, () =>
		initializeRun({
			runId,
			tasksFilePath: join(project, "prompt.txt"),
			projectPath: project,
			orderedTaskIds: [taskId],
			initialHostFingerprint: "simple",
			worktree: claim,
		}),
	);
	const routingStateRoot = join(storeRoot, "routing-runs");
	const pending = {
		attemptId: `attempt-${randomUUID()}`,
		taskId,
		runId,
		targetId: "codex",
		capability: "standard",
		startedAt: new Date().toISOString(),
	};
	recordPartial(routingStateRoot, project, pending, root);
	const result = spawnSync(
		process.execPath,
		[
			"src/switchyard/dispatch/index.mjs",
			"routing-run",
			"release-partial",
			"--project",
			project,
			"--routing-run-id",
			"run-1",
			"--task-id",
			taskId,
			"--discard",
		],
		{
			cwd: REPO_ROOT,
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, SWITCHYARD_RUN_STORE_ROOT: storeRoot },
		},
	);
	strictEqual(result.status, 1);
	strictEqual(
		`${result.stdout}${result.stderr}`.includes("cleanup_retained"),
		true,
	);
	strictEqual(existsSync(root), true);
	strictEqual(
		readRoutingRunState(project, "run-1", {
			stateRoot: routingStateRoot,
		}).attempts[0].partialWorktree,
		root,
	);
});

test("a release lets the next invocation pass the partial_work_retained guard", async () => {
	const f = fixture();
	const options = {
		projectPath: f.project,
		routingRunId: "run-1",
		capability: "standard",
		files: ["a.txt"],
		checks: [],
	};
	let engineCalls = 0;
	const deps = {
		...f.deps,
		getImplementorPriority: () => 1,
		assertFundedRoute: () => {},
		route: ({ availableProviders }) => ({
			provider: availableProviders[0] ?? null,
			reason: "no_eligible",
		}),
		runSimpleTask: async (_taskOptions, context) => {
			engineCalls += 1;
			context.route({ availableProviders: ["codex"] });
			return {
				status: "failed",
				failurePhase: "route",
				failureReason: "no_eligible_provider",
			};
		},
	};
	const blocked = await runSimpleRoutingTask(options, deps);
	strictEqual(blocked.stopReason, "partial_work_retained");
	strictEqual(engineCalls, 0);
	rmSync(f.root, { recursive: true, force: true });
	await handleRoutingRun(f.argv, f.deps);
	const resumed = await runSimpleRoutingTask(options, deps);
	strictEqual(resumed.stopReason !== "partial_work_retained", true);
	strictEqual(engineCalls, 1);
});

test("a root claim releases its <root>/worktree partial (production shape)", async () => {
	const f = fixture({ worktreeChild: true });
	const quarantine = simpleQuarantinePath(f.claim.nonce);
	quarantines.add(quarantine);
	let output;
	await handleRoutingRun([...f.argv, "--discard"], {
		...f.deps,
		writeResult: (value) => {
			output = JSON.parse(value);
		},
	});
	strictEqual(output.released, true);
	strictEqual(output.discarded, true);
	strictEqual(output.path, join(f.root, "worktree"));
	strictEqual(existsSync(f.root), false);
	strictEqual(existsSync(quarantine), false);
	strictEqual(readState(f).attempts[0].partialWorktree, null);
});

test("a claim whose root is not the partial or its worktree parent is refused", async () => {
	const f = fixture({ worktreeChild: true });
	const before = readState(f);
	await rejects(
		handleRoutingRun([...f.argv, "--discard"], {
			...f.deps,
			readRun: async () => ({
				...f.record,
				worktree: { ...f.claim, path: join(f.root, "worktree", "worktree") },
			}),
		}),
		{ code: "partial_worktree_claim_mismatch" },
	);
	strictEqual(existsSync(f.root), true);
	deepStrictEqual(readState(f), before);
});

test("a claim mismatch is refused without changing routing state", async () => {
	const f = fixture();
	const before = readState(f);
	await rejects(
		handleRoutingRun([...f.argv, "--discard"], {
			...f.deps,
			readRun: async () => ({
				...f.record,
				worktree: { ...f.claim, path: join(f.root, "elsewhere") },
			}),
		}),
		{ code: "partial_worktree_claim_mismatch" },
	);
	strictEqual(existsSync(f.root), true);
	deepStrictEqual(readState(f), before);
});

test("a symlinked recorded root is refused without changing routing state", async () => {
	const f = fixture();
	rmSync(f.root, { recursive: true, force: true });
	symlinkSync(f.project, f.root);
	const before = readState(f);
	await rejects(handleRoutingRun([...f.argv, "--discard"], f.deps), {
		code: "partial_worktree_symlink",
	});
	strictEqual(lstatSync(f.root).isSymbolicLink(), true);
	deepStrictEqual(readState(f), before);
});

test("a held project lock is refused without changing routing state", async () => {
	const f = fixture();
	const before = readState(f);
	await rejects(
		handleRoutingRun([...f.argv, "--discard"], {
			...f.deps,
			isProjectLockHeld: () => true,
		}),
		{ code: "project_lock_held" },
	);
	strictEqual(existsSync(f.root), true);
	deepStrictEqual(readState(f), before);
});

test("a task with no recorded partial is refused", async () => {
	const f = fixture();
	rmSync(f.root, { recursive: true, force: true });
	await handleRoutingRun(f.argv, f.deps);
	const before = readState(f);
	await rejects(handleRoutingRun(f.argv, f.deps), {
		code: "partial_worktree_not_recorded",
	});
	deepStrictEqual(readState(f), before);
});

for (const origin of ["work", "qualification"]) {
	test(`release-partial accepts the --task-id given to simple (${origin} origin)`, async () => {
		const f = fixture({ callerTaskId: "caller-task.1", origin });
		strictEqual(f.argv.at(-1), "caller-task.1");
		notStrictEqual(readState(f).attempts[0].taskId, "caller-task.1");
		let output;
		await handleRoutingRun(f.argv.concat("--discard"), {
			...f.deps,
			cleanupSimpleWorktree: async () => ({ removed: true }),
			writeResult: (value) => {
				output = JSON.parse(value);
			},
		});
		strictEqual(output.released, true);
		strictEqual(output.discarded, true);
		strictEqual(output.taskId, readState(f).attempts[0].taskId);
		strictEqual(readState(f).attempts[0].partialWorktree, null);
	});
}

test("release-partial still accepts the persisted task hash", async () => {
	const f = fixture({ callerTaskId: "caller-task.1" });
	const persisted = readState(f).attempts[0].taskId;
	rmSync(f.root, { recursive: true, force: true });
	const argv = [...f.argv.slice(0, -1), persisted];
	let output;
	await handleRoutingRun(argv, {
		...f.deps,
		writeResult: (value) => {
			output = JSON.parse(value);
		},
	});
	strictEqual(output.released, true);
	strictEqual(output.taskId, persisted);
});

test("a caller task id bound to another project or never recorded is refused", async () => {
	const f = fixture({ callerTaskId: "caller-task.1" });
	const before = readState(f);
	for (const taskId of ["other-caller-task", "bad id with spaces"]) {
		await rejects(handleRoutingRun([...f.argv.slice(0, -1), taskId], f.deps), {
			code: "partial_worktree_not_recorded",
		});
	}
	deepStrictEqual(readState(f), before);
});

test("--discard is rejected outside release-partial", async () => {
	const f = fixture();
	const argv = [
		"inspect",
		"--project",
		f.project,
		"--routing-run-id",
		"run-1",
		"--discard",
	];
	await rejects(handleRoutingRun(argv, f.deps), {
		name: "RoutingCliUsageError",
	});
});
