/** Task 3.11: the next waterfall attempt continues from a retained partial. */
import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readRun } from "../src/switchyard/run-store/index.mjs";
import { snapshotGitControl } from "../src/switchyard/simple/git-control.mjs";
import { buildGuardedPrompt } from "../src/switchyard/simple/guarded-prompt.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import {
	CONTINUATION_SKIP_REASONS,
	continuationFields,
	planContinuation,
	seedContinuation,
	sourceSuperseded,
} from "../src/switchyard/simple/partial-continuation.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import {
	openRoutingRun,
	readRoutingRunState,
	releasePartialAttempt,
} from "../src/switchyard/simple/routing-state.mjs";
import { fixture } from "./helpers/simple-routing-fixture.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const originalTmpdir = process.env.TMPDIR;
const originalRunStore = process.env.SWITCHYARD_RUN_STORE_ROOT;
const SUITE_TMPDIR = realpathSync(tempDir("switchyard-continuation-"));
process.env.TMPDIR = SUITE_TMPDIR;
process.env.SWITCHYARD_RUN_STORE_ROOT = join(SUITE_TMPDIR, "run-store");
after(() => {
	if (originalTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpdir;
	if (originalRunStore === undefined)
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	else process.env.SWITCHYARD_RUN_STORE_ROOT = originalRunStore;
	rmSync(SUITE_TMPDIR, { recursive: true, force: true });
});

const git = (cwd, args) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const commit = (cwd, message) =>
	git(cwd, [
		"-c",
		"user.name=Switchyard Tests",
		"-c",
		"user.email=switchyard@example.invalid",
		"commit",
		"-qm",
		message,
	]);

function makeRepo() {
	const root = realpathSync(tempDir("continuation-repo-"));
	const projectPath = join(root, "project");
	mkdirSync(join(projectPath, "src"), { recursive: true });
	writeFileSync(join(projectPath, "src", "a.txt"), "base a\n");
	writeFileSync(join(projectPath, "src", "b.txt"), "base b\n");
	writeFileSync(join(projectPath, "package.json"), "{}\n");
	git(projectPath, ["init", "-q"]);
	git(projectPath, ["add", "-A"]);
	commit(projectPath, "base");
	const promptPath = join(root, "prompt.txt");
	writeFileSync(promptPath, "Change files");
	return {
		root,
		projectPath,
		promptPath,
		base: git(projectPath, ["rev-parse", "HEAD"]),
	};
}

/** A diff produced the way the engine captures it, from a scratch clone. */
function diffFor(repo, edits) {
	const clone = join(tempDir("continuation-diff-"), "clone");
	git(repo.root, ["clone", "-q", repo.projectPath, clone]);
	for (const [path, text] of Object.entries(edits))
		writeFileSync(join(clone, path), text);
	git(clone, ["add", "-A"]);
	return {
		diff: execFileSync(
			"git",
			["diff", "--cached", "--binary", "--full-index", repo.base],
			{ cwd: clone, encoding: "utf8" },
		),
		changedFiles: Object.keys(edits),
		baseRevision: repo.base,
	};
}

function freshClone(repo) {
	const clone = join(tempDir("continuation-seed-"), "clone");
	git(repo.root, ["clone", "-q", "--shared", repo.projectPath, clone]);
	return clone;
}

const stoppedSource = (captured, extra = {}) => ({
	attemptId: "attempt-a",
	partialWorktree: "/retained/attempt-a",
	result: { recovery: { cleanup: { writer: { state: "stopped" } } } },
	record: {
		worktree: { writerStopped: true, path: "/retained/attempt-a" },
	},
	captured,
	...extra,
});

describe("planContinuation", () => {
	const repo = makeRepo();
	const options = { files: ["src/a.txt", "src/b.txt", "package.json"] };

	it("carries an in-scope partial", () => {
		const captured = diffFor(repo, { "src/a.txt": "partial\n" });
		const plan = planContinuation({
			source: stoppedSource(captured),
			options,
			projectPath: repo.projectPath,
		});
		strictEqual(plan.skipped, undefined);
		strictEqual(plan.sourceAttemptId, "attempt-a");
		deepStrictEqual(plan.files, ["src/a.txt"]);
		strictEqual(plan.baseRevision, repo.base);
	});

	it("does not carry an out-of-scope partial", () => {
		const captured = diffFor(repo, { "src/b.txt": "partial\n" });
		const plan = planContinuation({
			source: stoppedSource(captured),
			options: { files: ["src/a.txt"] },
			projectPath: repo.projectPath,
		});
		strictEqual(plan.skipped, "out_of_scope");
		strictEqual(plan.diff, undefined);
	});

	it("does not carry a manifest change even when it is declared", () => {
		const captured = diffFor(repo, {
			"src/a.txt": "partial\n",
			"package.json": '{"x":1}\n',
		});
		const plan = planContinuation({
			source: stoppedSource(captured),
			options,
			projectPath: repo.projectPath,
		});
		strictEqual(plan.skipped, "manifest_changed");
	});

	it("does not carry a read-only input change", () => {
		const captured = diffFor(repo, { "src/b.txt": "partial\n" });
		const plan = planContinuation({
			source: stoppedSource(captured),
			options: { files: ["src/a.txt"], readOnlyInputs: ["src/b.txt"] },
			projectPath: repo.projectPath,
		});
		strictEqual(plan.skipped, "read_only_input_changed");
	});

	it("never carries from a writer that is not proven stopped", () => {
		const captured = diffFor(repo, { "src/a.txt": "partial\n" });
		for (const source of [
			stoppedSource(captured, {
				result: { recovery: { cleanup: { writer: { state: "unknown" } } } },
			}),
			stoppedSource(captured, {
				record: { worktree: { writerStopped: false } },
			}),
			stoppedSource(captured, {
				record: { worktree: { writerStopped: true, path: "/elsewhere" } },
			}),
		])
			strictEqual(
				planContinuation({ source, options, projectPath: repo.projectPath })
					.skipped,
				"writer_not_stopped",
			);
	});

	it("does not carry without a verified capture", () => {
		const plan = planContinuation({
			source: stoppedSource(null),
			options,
			projectPath: repo.projectPath,
		});
		strictEqual(plan.skipped, "diff_unavailable");
	});
});

describe("seedContinuation", () => {
	it("applies the carried diff to the index on the same base", () => {
		const repo = makeRepo();
		const captured = diffFor(repo, { "src/a.txt": "partial\n" });
		const plan = planContinuation({
			source: stoppedSource(captured),
			options: { files: ["src/a.txt"] },
			projectPath: repo.projectPath,
		});
		const clone = freshClone(repo);
		const seeded = seedContinuation({
			plan,
			worktreePath: clone,
			baseRevision: repo.base,
			worktreeBaseRevision: repo.base,
			gitControl: snapshotGitControl(clone),
		});
		deepStrictEqual(seeded, {
			sourceAttemptId: "attempt-a",
			carried: true,
			files: ["src/a.txt"],
		});
		strictEqual(readFileSync(join(clone, "src", "a.txt"), "utf8"), "partial\n");
		strictEqual(git(clone, ["diff", "--cached", "--name-only"]), "src/a.txt");
	});

	it("starts clean with apply_failed when the diff does not apply", () => {
		const repo = makeRepo();
		const captured = diffFor(repo, { "src/a.txt": "partial\n" });
		const plan = planContinuation({
			source: stoppedSource(captured),
			options: { files: ["src/a.txt"] },
			projectPath: repo.projectPath,
		});
		const clone = freshClone(repo);
		// Same base revision, but the preimage no longer matches.
		writeFileSync(join(clone, "src", "a.txt"), "drifted\n");
		git(clone, ["add", "-A"]);
		commit(clone, "drift");
		const head = git(clone, ["rev-parse", "HEAD"]);
		const seeded = seedContinuation({
			plan: { ...plan, baseRevision: head },
			worktreePath: clone,
			baseRevision: head,
			worktreeBaseRevision: head,
			gitControl: snapshotGitControl(clone),
		});
		deepStrictEqual(seeded, {
			sourceAttemptId: "attempt-a",
			skipped: "apply_failed",
		});
		strictEqual(git(clone, ["status", "--porcelain"]), "");
	});

	it("starts clean when the base revision changed", () => {
		const repo = makeRepo();
		const plan = {
			sourceAttemptId: "attempt-a",
			diff: "x",
			files: ["src/a.txt"],
			baseRevision: "0".repeat(40),
		};
		const clone = freshClone(repo);
		deepStrictEqual(
			seedContinuation({
				plan,
				worktreePath: clone,
				baseRevision: repo.base,
				worktreeBaseRevision: repo.base,
				gitControl: snapshotGitControl(clone),
			}),
			{ sourceAttemptId: "attempt-a", skipped: "base_changed" },
		);
		strictEqual(git(clone, ["status", "--porcelain"]), "");
	});
});

describe("engine seeding", () => {
	const engineOptions = (repo) => ({
		promptPath: repo.promptPath,
		projectPath: repo.projectPath,
		capability: "standard",
		files: ["src/a.txt", "src/b.txt"],
		checks: [],
		deadlineMs: 10_000,
	});
	const engineDeps = (overrides) => ({
		now: () => 1_000,
		acquireProjectLock: async () => {},
		releaseProjectLock: async () => true,
		route: () => ({ provider: "Codex (Spark)", reason: "priority_fill" }),
		resolveTargetIdentity: () => ({
			targetId: "codex",
			harnessKey: "codex",
			ambiguous: false,
		}),
		getInvocationDescriptor: () => ({
			target_id: "codex",
			selector: "gpt-5.3-codex-spark",
			invocation_args: [],
		}),
		assertFundedRoute: () => {},
		...overrides,
	});

	it("carried in-scope partial reaches the second provider's worktree", async () => {
		const repo = makeRepo();
		let captured = null;
		const first = await runSimpleTask(
			engineOptions(repo),
			engineDeps({
				taskId: "continuation-a",
				attemptId: "attempt-a",
				onVerifiedDiff: (value) => {
					captured = value;
				},
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(join(worktreePath, "src", "a.txt"), "partial a\n");
					return {
						success: false,
						timedOut: true,
						code: null,
						writerLifecycle: "stopped",
					};
				},
			}),
		);
		strictEqual(first.status, "failed");
		ok(first.partialWorktree, "first attempt retains its partial");
		deepStrictEqual(captured.changedFiles, ["src/a.txt"]);
		strictEqual(captured.baseRevision, repo.base);

		// The real persisted run record proves the writer stopped.
		const plan = planContinuation({
			source: {
				attemptId: "attempt-a",
				partialWorktree: first.partialWorktree,
				result: first,
				record: await readRun(first.runId),
				captured,
			},
			options: engineOptions(repo),
			projectPath: repo.projectPath,
		});
		strictEqual(plan.skipped, undefined);
		let seeded = null;
		let seen = null;
		const second = await runSimpleTask(
			engineOptions(repo),
			engineDeps({
				taskId: "continuation-b",
				attemptId: "attempt-b",
				continuation: plan,
				onContinuation: (value) => {
					seeded = value;
				},
				executeProvider: async ({ worktreePath, prompt }) => {
					seen = {
						text: readFileSync(join(worktreePath, "src", "a.txt"), "utf8"),
						prompt,
					};
					writeFileSync(join(worktreePath, "src", "b.txt"), "finished b\n");
					return {
						success: false,
						code: 1,
						writerLifecycle: "stopped",
					};
				},
			}),
		);
		strictEqual(seeded?.carried, true);
		// The continuation's own partial holds the carried work plus its own.
		ok(second.partialWorktree, "second attempt retains its partial");
		deepStrictEqual(second.changedFiles, ["src/a.txt", "src/b.txt"]);
		strictEqual(seen.text, "partial a\n");
		ok(
			seen.prompt.includes(
				"unfinished work carried from an earlier attempt in: src/a.txt.",
			),
		);
	});
});

describe("guarded prompt note", () => {
	it("lists only carried file names, bounded", () => {
		const files = Array.from({ length: 20 }, (_, i) => `f${i}.js`);
		const prompt = buildGuardedPrompt({
			promptText: "Do it",
			files,
			checks: ["npm test"],
			carriedFiles: files,
		});
		ok(prompt.includes("f15.js and 4 more."));
		const note = prompt.slice(prompt.indexOf("unfinished work"));
		ok(!note.includes("f16.js"));
		ok(prompt.indexOf("unfinished work") < prompt.indexOf("acceptance checks"));
		strictEqual(
			buildGuardedPrompt({ promptText: "Do it", files }).includes("unfinished"),
			false,
		);
	});
});

describe("routing waterfall continuation", () => {
	const repo = makeRepo();
	const captured = diffFor(repo, { "src/a.txt": "partial\n" });

	/** A fixture whose first target retains a partial with a verified diff. */
	function waterfall({
		diff = captured,
		second = {},
		files = ["src/a.txt"],
		removes = true,
	}) {
		const f = fixture({
			"antigravity-claude": { status: "failed", retained: true },
			codex: second,
		});
		f.options.dirtyOverlay = false;
		f.options.files = files;
		const engine = f.deps.runSimpleTask;
		const seen = [];
		const cleanups = [];
		const warnings = [];
		f.deps.isProjectLockHeld = () => false;
		f.deps.onRoutingWarning = (message) => warnings.push(message);
		f.deps.cleanupSimpleWorktree = async (runId, claim, { writerStopped }) => {
			cleanups.push({ runId, path: claim.path, writerStopped });
			if (!removes) return { removed: false };
			rmSync(claim.path, { recursive: true, force: true });
			return { removed: true };
		};
		f.deps.runSimpleTask = async (opts, context) => {
			const call = f.calls.length;
			if (call === 1) {
				seen.push({
					continuation: context.continuation,
					state: readRoutingRunState(opts.projectPath, "run-1", {
						stateRoot: f.deps.stateRoot,
					}),
				});
				second.onSecond?.(context);
			}
			const result = await engine(opts, context);
			if (call === 0) {
				context.onVerifiedDiff(diff);
				// Production shape: the claim names the root, the partial is
				// its worktree child.
				const root = result.partialWorktree;
				mkdirSync(join(root, "worktree"), { recursive: true });
				result.partialWorktree = join(root, "worktree");
				result.recovery.cleanup.worktree.path = result.partialWorktree;
				Object.assign(f.records.get(context.runId).worktree, {
					path: root,
					nonce: randomUUID(),
					device: "1",
					inode: "1",
				});
			}
			return result;
		};
		return { f, seen, cleanups, warnings };
	}

	it("carries the partial and releases the source only after the continuation is terminal", async () => {
		const { f, seen, cleanups } = waterfall({
			second: {
				status: "succeeded",
				onSecond: (context) =>
					context.onContinuation({
						sourceAttemptId: context.continuation.sourceAttemptId,
						carried: true,
						files: ["src/a.txt"],
					}),
			},
		});
		const result = await runSimpleRoutingTask(f.options, f.deps);
		strictEqual(result.direction, "complete");
		const [source, continuation] = result.attempts;
		deepStrictEqual(seen[0].continuation.files, ["src/a.txt"]);
		// While the continuation ran, the source partial was still retained.
		strictEqual(
			typeof seen[0].state.attempts[0].partialWorktree,
			"string",
			"source partial must survive until the continuation is terminal",
		);
		strictEqual(continuation.continuedFromAttemptId, source.attemptId);
		strictEqual(source.partialWorktree, null);
		deepStrictEqual(result.retainedPartials, []);
		strictEqual(result.releasedPartials[0].attemptId, source.attemptId);
		// The source clone is discarded through its root claim.
		strictEqual(cleanups.length, 1);
		strictEqual(cleanups[0].runId, source.runId);
		strictEqual(cleanups[0].writerStopped, true);
		strictEqual(existsSync(cleanups[0].path), false);
	});

	it("keeps the source recorded with a warning when cleanup cannot remove it", async () => {
		const { f, cleanups, warnings } = waterfall({
			removes: false,
			second: {
				status: "succeeded",
				onSecond: (context) =>
					context.onContinuation({
						sourceAttemptId: context.continuation.sourceAttemptId,
						carried: true,
						files: ["src/a.txt"],
					}),
			},
		});
		const result = await runSimpleRoutingTask(f.options, f.deps);
		strictEqual(result.direction, "complete");
		strictEqual(cleanups.length, 1);
		strictEqual(typeof result.attempts[0].partialWorktree, "string");
		strictEqual(result.releasedPartials, undefined);
		ok(warnings.some((w) => w.includes("cleanup_retained")));
	});

	it("keeps the source when the continuation fails without its own partial", async () => {
		const { f } = waterfall({
			second: {
				status: "failed",
				onSecond: (context) =>
					context.onContinuation({
						sourceAttemptId: context.continuation.sourceAttemptId,
						carried: true,
						files: ["src/a.txt"],
					}),
			},
		});
		const result = await runSimpleRoutingTask(f.options, f.deps);
		const [source, continuation] = result.attempts;
		strictEqual(continuation.continuedFromAttemptId, source.attemptId);
		strictEqual(typeof source.partialWorktree, "string");
		strictEqual(result.releasedPartials, undefined);
	});

	it("does not carry an out-of-scope or manifest-touching partial", async () => {
		for (const [diff, files, reason] of [
			[captured, ["src/b.txt"], "out_of_scope"],
			[
				diffFor(repo, { "src/a.txt": "p\n", "package.json": "[]\n" }),
				["src/a.txt", "package.json"],
				"manifest_changed",
			],
		]) {
			const { f, seen } = waterfall({ diff, files });
			const result = await runSimpleRoutingTask(f.options, f.deps);
			strictEqual(result.direction, "complete");
			strictEqual(seen[0].continuation, undefined);
			strictEqual(result.attempts[1].continuationSkipped, reason);
			strictEqual(typeof result.attempts[0].partialWorktree, "string");
		}
	});

	it("records apply_failed and keeps the source when the carried diff does not apply", async () => {
		const { f } = waterfall({
			second: {
				status: "succeeded",
				onSecond: (context) =>
					context.onContinuation({
						sourceAttemptId: context.continuation.sourceAttemptId,
						skipped: "apply_failed",
					}),
			},
		});
		const result = await runSimpleRoutingTask(f.options, f.deps);
		strictEqual(result.attempts[1].continuationSkipped, "apply_failed");
		strictEqual(result.attempts[1].continuedFromAttemptId, undefined);
		strictEqual(typeof result.attempts[0].partialWorktree, "string");
	});

	it("records attempt_not_started when the engine never reached seeding", async () => {
		const { f } = waterfall({ second: { status: "succeeded" } });
		const result = await runSimpleRoutingTask(f.options, f.deps);
		strictEqual(result.attempts[1].continuationSkipped, "attempt_not_started");
	});
});

describe("routing state continuation fields", () => {
	const project = realpathSync(tempDir("continuation-state-project-"));
	const at = "2026-10-07T00:00:00.000Z";
	const attempt = (attemptId, extra = {}) => ({
		attemptId,
		taskId: "task-1",
		runId: `run-${attemptId}`,
		targetId: "codex",
		capability: "standard",
		startedAt: at,
		terminal: "skipped",
		reason: "execution_failed",
		closedAt: at,
		partialWorktree: null,
		...extra,
	});
	const open = () =>
		openRoutingRun(project, `r-${Math.random().toString(36).slice(2)}`, {
			stateRoot: realpathSync(tempDir("continuation-state-")),
		});

	it("accepts a continuation of an earlier attempt and a closed skip reason", () => {
		const handle = open();
		try {
			handle.commit({
				attempts: [
					attempt("a", { partialWorktree: "/retained/a" }),
					attempt("b", { continuedFromAttemptId: "a" }),
					attempt("c", { continuationSkipped: "apply_failed" }),
				],
			});
			strictEqual(handle.state.attempts[1].continuedFromAttemptId, "a");
		} finally {
			handle.release();
		}
	});

	it("rejects unknown reasons, forward references and both fields together", () => {
		ok(CONTINUATION_SKIP_REASONS.includes("apply_failed"));
		for (const attempts of [
			[attempt("a", { continuationSkipped: "because" })],
			[attempt("a", { continuedFromAttemptId: "a" })],
			[attempt("a", { continuedFromAttemptId: "b" }), attempt("b")],
			[
				attempt("a"),
				attempt("b", {
					continuedFromAttemptId: "a",
					continuationSkipped: "apply_failed",
				}),
			],
		]) {
			const handle = open();
			try {
				throws(() => handle.commit({ attempts }), {
					code: "routing_state_malformed",
				});
			} finally {
				handle.release();
			}
		}
	});

	it("keeps continuation fields immutable, including through release_partial", () => {
		const handle = open();
		try {
			handle.commit({
				attempts: [
					attempt("a", { partialWorktree: "/retained/a" }),
					attempt("b", { continuedFromAttemptId: "a" }),
				],
			});
			throws(
				() =>
					handle.commit({
						attempts: [
							handle.state.attempts[0],
							attempt("b", { continuationSkipped: "apply_failed" }),
						],
					}),
				{ code: "routing_state_nonmonotonic" },
			);
			// A release commit that also adds a field is refused.
			throws(
				() =>
					handle.commit(
						{
							attempts: [
								attempt("a", {
									partialWorktree: null,
									continuationSkipped: "apply_failed",
								}),
								handle.state.attempts[1],
							],
						},
						{ transition: "release_partial", attemptId: "a" },
					),
				{ code: "routing_state_nonmonotonic" },
			);
			releasePartialAttempt(handle.state, handle.commit, "a");
			strictEqual(handle.state.attempts[0].partialWorktree, null);
		} finally {
			handle.release();
		}
	});
});

describe("continuation helpers", () => {
	it("maps plans and outcomes to attempt fields", () => {
		deepStrictEqual(continuationFields(null, null), {});
		deepStrictEqual(
			continuationFields({ sourceAttemptId: "a", skipped: "out_of_scope" }),
			{ continuationSkipped: "out_of_scope" },
		);
		deepStrictEqual(
			continuationFields(
				{ sourceAttemptId: "a", diff: "x" },
				{ carried: true },
			),
			{ continuedFromAttemptId: "a" },
		);
		deepStrictEqual(continuationFields({ sourceAttemptId: "a", diff: "x" }), {
			continuationSkipped: "attempt_not_started",
		});
		strictEqual(
			sourceSuperseded(
				{ continuedFromAttemptId: "a" },
				{ status: "failed", partialWorktree: "/p" },
			),
			true,
		);
		strictEqual(
			sourceSuperseded(
				{ continuedFromAttemptId: "a" },
				{ status: "failed", partialWorktree: null },
			),
			false,
		);
		strictEqual(sourceSuperseded({}, { status: "succeeded" }), false);
	});
});
