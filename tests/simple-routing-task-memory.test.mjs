import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseSimpleArgs } from "../src/switchyard/simple/args.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import {
	latchNativeRequired,
	openRoutingRun,
	recordAttemptOutcome,
} from "../src/switchyard/simple/routing-state.mjs";
import { routingTaskIdentityHash } from "../src/switchyard/simple/routing-task-identity.mjs";
import { fixture } from "./helpers/simple-routing-fixture.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

function promptFile(contents, name = "task.md") {
	const root = tempDir("routing-task-prompt-");
	const path = join(root, name);
	writeFileSync(path, contents);
	return path;
}

test("renaming a failed task run links to its original run before provider allocation", async () => {
	const promptPath = promptFile("Repair the bounded fixture.\n");
	const f = fixture({ __targets: ["codex"], codex: { status: "failed" } });
	f.options.promptPath = promptPath;
	const first = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(first.direction, "native_required");
	deepStrictEqual(f.calls, ["codex"]);

	f.options.routingRunId = "run-1-renamed";
	const replay = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(replay.direction, "stop");
	strictEqual(replay.stopReason, "task_retry_linked_to_previous_run");
	strictEqual(replay.previousRoutingRunId, "run-1");
	strictEqual(replay.result.previousRoutingRunId, "run-1");
	deepStrictEqual(f.calls, ["codex"]);
});

test("the original run preserves failed-target suppression while a completed success may use a new run", async () => {
	const failed = fixture({ __targets: ["codex"], codex: { status: "failed" } });
	failed.options.promptPath = promptFile("same task\n");
	strictEqual(
		(await runSimpleRoutingTask(failed.options, failed.deps)).direction,
		"native_required",
	);
	strictEqual(
		(await runSimpleRoutingTask(failed.options, failed.deps)).direction,
		"native_required",
	);
	deepStrictEqual(failed.calls, ["codex"]);

	const succeeded = fixture({ __targets: ["codex"] });
	succeeded.options.promptPath = promptFile("same task\n");
	strictEqual(
		(await runSimpleRoutingTask(succeeded.options, succeeded.deps)).direction,
		"complete",
	);
	succeeded.options.routingRunId = "run-2";
	strictEqual(
		(await runSimpleRoutingTask(succeeded.options, succeeded.deps)).direction,
		"complete",
	);
	deepStrictEqual(succeeded.calls, ["codex", "codex"]);
});

test("task-local failures stay sticky after fallback success without poisoning another task", async () => {
	const f = fixture({
		__targets: ["codex", "vibe"],
		codex: { status: "failed" },
	});
	f.options.promptPath = promptFile("task A\n");
	strictEqual(
		(await runSimpleRoutingTask(f.options, f.deps)).direction,
		"complete",
	);
	deepStrictEqual(f.calls, ["codex", "vibe"]);
	f.options.routingRunId = "run-2";
	const replay = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(replay.previousRoutingRunId, "run-1");
	deepStrictEqual(f.calls, ["codex", "vibe"]);

	const shared = fixture({
		__targets: ["codex", "vibe"],
		codex: { status: "failed" },
	});
	shared.options.promptPath = promptFile("task A\n");
	await runSimpleRoutingTask(shared.options, shared.deps);
	shared.options.promptPath = promptFile("task B\n");
	strictEqual(
		(await runSimpleRoutingTask(shared.options, shared.deps)).direction,
		"complete",
	);
	shared.options.routingRunId = "run-2";
	strictEqual(
		(await runSimpleRoutingTask(shared.options, shared.deps)).direction,
		"complete",
	);
	strictEqual(shared.calls[3], "codex");
});

test("prompt filename, deadline, provider pin and declared-set order do not bypass task binding", async () => {
	const f = fixture({ __targets: ["codex"], codex: { status: "failed" } });
	f.options.promptPath = promptFile("same task\n", "first.md");
	f.options.files = ["a.txt", "b.txt"];
	await runSimpleRoutingTask(f.options, f.deps);
	f.options.routingRunId = "run-2";
	f.options.promptPath = promptFile("same task\n", "renamed.md");
	f.options.deadlineMs += 20_000;
	f.options.onlyProviders = ["codex"];
	f.options.files.reverse();
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.stopReason, "task_retry_linked_to_previous_run");
	strictEqual(result.previousRoutingRunId, "run-1");
	deepStrictEqual(f.calls, ["codex"]);
});

test("meaningful prompt changes remain independent and qualification identity is isolated", async () => {
	const f = fixture({ __targets: ["codex"], codex: { status: "failed" } });
	f.options.promptPath = promptFile("task one\n");
	await runSimpleRoutingTask(f.options, f.deps);
	f.options.routingRunId = "run-2";
	f.options.promptPath = promptFile("task two\n");
	strictEqual(
		(await runSimpleRoutingTask(f.options, f.deps)).direction,
		"native_required",
	);
	f.options.routingRunId = "run-3";
	f.options.origin = "qualification";
	strictEqual(
		(await runSimpleRoutingTask(f.options, f.deps)).direction,
		"native_required",
	);
	deepStrictEqual(f.calls, ["codex", "codex", "codex"]);
});

test("explicit task id survives changed prompt and scope without persisting prompt or task text", async () => {
	const f = fixture({ __targets: ["codex"], codex: { status: "failed" } });
	f.options.promptPath = promptFile("private prompt phrase\n");
	f.options.taskId = "release-13";
	await runSimpleRoutingTask(f.options, f.deps);
	const identity = routingTaskIdentityHash(
		f.options,
		f.options.projectPath,
		"work",
	);
	const bindingPath = join(
		f.deps.stateRoot,
		"task-bindings",
		identity,
		"binding.json",
	);
	const persisted = readFileSync(bindingPath, "utf8");
	strictEqual(persisted.includes("private prompt phrase"), false);
	strictEqual(persisted.includes("release-13"), false);
	f.options.routingRunId = "run-2";
	f.options.promptPath = promptFile("revised private prompt phrase\n");
	f.options.files = ["new-scope.txt"];
	f.options.checks = ["different-check"];
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.previousRoutingRunId, "run-1");
	deepStrictEqual(f.calls, ["codex"]);
});

test("CLI parses a bounded stable task id and rejects unsafe values without echoing them", () => {
	const root = tempDir("routing-task-cli-");
	const project = join(root, "project");
	const prompt = join(root, "prompt.md");
	mkdirSync(join(project, "src"), { recursive: true });
	writeFileSync(join(project, "src", "a.txt"), "base\n");
	writeFileSync(prompt, "task\n");
	const origGlobal = process.env.GIT_CONFIG_GLOBAL;
	const origSystem = process.env.GIT_CONFIG_SYSTEM;
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_SYSTEM = "/dev/null";
	try {
		execFileSync("git", ["init", "-q"], { cwd: project });
		execFileSync("git", ["add", "."], { cwd: project });
		execFileSync(
			"git",
			[
				"-c",
				"user.name=Task test",
				"-c",
				"user.email=task@example.invalid",
				"commit",
				"-qm",
				"base",
			],
			{ cwd: project },
		);
		const now = Date.now();
		const args = [
			prompt,
			"--project",
			project,
			"--capability",
			"standard",
			"--file",
			"src/a.txt",
			"--check",
			"true",
			"--deadline",
			new Date(now + 5 * 60_000).toISOString(),
			"--task-id",
			"release-13",
		];
		strictEqual(
			parseSimpleArgs(args, { now: () => now, onWarning: () => {} }).taskId,
			"release-13",
		);
		try {
			parseSimpleArgs(args.slice(0, -1).concat("bad\nsecret"), {
				now: () => now,
				onWarning: () => {},
			});
		} catch (error) {
			strictEqual(error.message.includes("secret"), false);
			return;
		}
		throw new Error("unsafe task id was accepted");
	} finally {
		if (origGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
		else process.env.GIT_CONFIG_GLOBAL = origGlobal;
		if (origSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
		else process.env.GIT_CONFIG_SYSTEM = origSystem;
	}
});

test("binding finish write failure preserves successful provider evidence without replay", async () => {
	const f = fixture({ __targets: ["codex"] });
	f.options.promptPath = promptFile("preserve successful apply evidence\n");
	f.options.taskId = "finish-write-fault";
	const identity = routingTaskIdentityHash(
		f.options,
		f.options.projectPath,
		"work",
	);
	const bindingPath = join(
		f.deps.stateRoot,
		"task-bindings",
		identity,
		"binding.json",
	);
	const runSimpleTask = f.deps.runSimpleTask;
	f.deps.runSimpleTask = async (...args) => {
		const result = await runSimpleTask(...args);
		strictEqual(result.status, "succeeded");
		chmodSync(bindingPath, 0o666);
		return { ...result, changedFiles: ["src/applied.txt"] };
	};
	let result;
	try {
		result = await runSimpleRoutingTask(f.options, f.deps);
	} finally {
		chmodSync(bindingPath, 0o600);
	}
	strictEqual(result.direction, "stop");
	strictEqual(result.stopReason, "task_identity_state_write_failed");
	strictEqual(result.result.status, "succeeded");
	deepStrictEqual(result.result.changedFiles, ["src/applied.txt"]);
	strictEqual(result.attempts.at(-1).terminal, "succeeded");
	deepStrictEqual(f.calls, ["codex"]);
});

test("fresh startup lock refusal then retry preserves unpoisoned task binding with no provider allocation", async () => {
	const f = fixture({ __targets: ["codex"] });
	f.options.promptPath = promptFile("fresh startup task\n");
	f.options.taskId = "startup-refusal-retry";
	const originalOpenRun = f.deps.openRoutingRun;
	f.deps.openRoutingRun = () => {
		throw Object.assign(new Error("routing_run_lock_contention"), {
			code: "routing_run_lock_contention",
		});
	};
	await rejects(() => runSimpleRoutingTask(f.options, f.deps), {
		code: "routing_run_lock_contention",
	});
	strictEqual(f.calls.length, 0);
	const identity = routingTaskIdentityHash(
		f.options,
		f.options.projectPath,
		"work",
	);
	const bindingPath = join(
		f.deps.stateRoot,
		"task-bindings",
		identity,
		"binding.json",
	);
	strictEqual(existsSync(bindingPath), false);

	f.deps.openRoutingRun = originalOpenRun;
	const retry = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(retry.direction, "complete");
	deepStrictEqual(f.calls, ["codex"]);
});

test("prior success rebind attempt with openRun failure preserves original binding without provider allocation", async () => {
	const f = fixture({ __targets: ["codex"] });
	f.options.promptPath = promptFile("prior success task\n");
	f.options.taskId = "prior-success-rebind-preserve";
	const first = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(first.direction, "complete");
	deepStrictEqual(f.calls, ["codex"]);

	const identity = routingTaskIdentityHash(
		f.options,
		f.options.projectPath,
		"work",
	);
	const bindingPath = join(
		f.deps.stateRoot,
		"task-bindings",
		identity,
		"binding.json",
	);
	const originalBinding = JSON.parse(readFileSync(bindingPath, "utf8"));
	strictEqual(originalBinding.status, "succeeded");
	strictEqual(originalBinding.routingRunId, "run-1");

	f.options.routingRunId = "run-2";
	f.deps.openRoutingRun = () => {
		throw Object.assign(new Error("routing_run_lock_contention"), {
			code: "routing_run_lock_contention",
		});
	};
	await rejects(() => runSimpleRoutingTask(f.options, f.deps), {
		code: "routing_run_lock_contention",
	});
	deepStrictEqual(f.calls, ["codex"]);
	const preservedBinding = JSON.parse(readFileSync(bindingPath, "utf8"));
	deepStrictEqual(preservedBinding, originalBinding);
});

test("predecessorReceiptPath relocation does not bypass task binding while explicit task IDs preserve revisions", async () => {
	const f = fixture({ __targets: ["codex"], codex: { status: "failed" } });
	f.options.promptPath = promptFile("receipt task\n");
	f.options.predecessorReceiptPath = "/tmp/receipt-1.json";
	const first = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(first.direction, "native_required");
	deepStrictEqual(f.calls, ["codex"]);

	f.options.routingRunId = "run-2";
	f.options.predecessorReceiptPath = "/tmp/relocated-receipt-2.json";
	const replay = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(replay.direction, "stop");
	strictEqual(replay.stopReason, "task_retry_linked_to_previous_run");
	strictEqual(replay.previousRoutingRunId, "run-1");
	deepStrictEqual(f.calls, ["codex"]);
});

test("taskBinding.release refusal after successful engine returns finite stop and preserves applied result and foreign lock", async () => {
	const f = fixture({ __targets: ["codex"] });
	f.options.promptPath = promptFile("apply result with release refusal\n");
	f.options.taskId = "release-refusal-fault";
	const identity = routingTaskIdentityHash(
		f.options,
		f.options.projectPath,
		"work",
	);
	const lockPath = join(
		f.deps.stateRoot,
		"task-bindings",
		identity,
		".task-lock",
	);
	const runSimpleTask = f.deps.runSimpleTask;
	f.deps.runSimpleTask = async (...args) => {
		const result = await runSimpleTask(...args);
		strictEqual(result.status, "succeeded");
		unlinkSync(lockPath);
		writeFileSync(lockPath, "replaced-foreign-lock\n", { mode: 0o600 });
		return { ...result, changedFiles: ["src/applied-release.txt"] };
	};
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "stop");
	strictEqual(result.stopReason, "task_identity_state_release_failed");
	strictEqual(result.result.status, "succeeded");
	deepStrictEqual(result.result.changedFiles, ["src/applied-release.txt"]);
	strictEqual(result.attempts.at(-1).terminal, "succeeded");
	deepStrictEqual(f.calls, ["codex"]);
	strictEqual(readFileSync(lockPath, "utf8"), "replaced-foreign-lock\n");
});

test("routing-run release exception survives task-binding release refusal", async () => {
	const f = fixture({ __targets: ["codex"] });
	f.options.promptPath = promptFile("apply result with two release failures\n");
	f.options.taskId = "dual-release-fault";
	const identity = routingTaskIdentityHash(
		f.options,
		f.options.projectPath,
		"work",
	);
	const lockPath = join(
		f.deps.stateRoot,
		"task-bindings",
		identity,
		".task-lock",
	);
	const openRun = f.deps.openRoutingRun ?? openRoutingRun;
	const releaseError = Object.assign(
		new Error("routing_run_release_test_failure"),
		{ code: "routing_run_release_test_failure" },
	);
	let runReleaseAttempts = 0;
	f.deps.openRoutingRun = (...args) => {
		const handle = openRun(...args);
		const release = handle.release;
		return {
			...handle,
			release() {
				runReleaseAttempts += 1;
				release();
				throw releaseError;
			},
		};
	};
	const runSimpleTask = f.deps.runSimpleTask;
	f.deps.runSimpleTask = async (...args) => {
		const result = await runSimpleTask(...args);
		strictEqual(result.status, "succeeded");
		unlinkSync(lockPath);
		writeFileSync(lockPath, "replaced-foreign-lock\n", { mode: 0o600 });
		return { ...result, changedFiles: ["src/applied-release.txt"] };
	};

	await rejects(() => runSimpleRoutingTask(f.options, f.deps), {
		code: "routing_run_release_test_failure",
	});
	strictEqual(runReleaseAttempts, 1);
	deepStrictEqual(f.calls, ["codex"]);
	strictEqual(readFileSync(lockPath, "utf8"), "replaced-foreign-lock\n");
	openRoutingRun(f.options.projectPath, "run-1", {
		stateRoot: f.deps.stateRoot,
	}).release();
});

test("reclaiming physical dead run lock preserves routing pending attempts, retained work and native latch without replay", async () => {
	for (const condition of ["pending", "native", "partial"]) {
		const f = fixture({ __targets: ["codex"] });
		f.options.promptPath = promptFile(`dead-lock ${condition}\n`);
		f.options.taskId = `dead-lock-${condition}`;
		const handle = openRoutingRun(f.options.projectPath, "run-1", {
			stateRoot: f.deps.stateRoot,
		});
		const pending = {
			attemptId: "attempt-1",
			taskId: `dead-lock-${condition}`,
			runId: "engine-1",
			targetId: "codex",
			capability: "standard",
			startedAt: new Date().toISOString(),
		};
		if (condition === "pending") {
			handle.commit({ pendingAttempt: pending });
		} else if (condition === "native") {
			latchNativeRequired(handle.state, handle.commit, {
				project: f.options.projectPath,
				routingRunId: "run-1",
				taskId: `dead-lock-${condition}`,
				invocationId: "/root/native_recovery",
				route: "native/high",
				capability: "high",
				evidenceKind: "actual-start",
			});
		} else if (condition === "partial") {
			handle.commit({ pendingAttempt: pending });
			recordAttemptOutcome(handle.state, handle.commit, {
				...pending,
				terminal: "failed",
				reason: "execution_failed",
				closedAt: new Date().toISOString(),
				partialWorktree: join(f.options.projectPath, "partial"),
			});
		}
		handle.release();

		const runDir = join(
			f.deps.stateRoot,
			`${createHash("sha256").update(f.options.projectPath).digest("hex")}-run-1`,
		);
		const lockPath = join(runDir, ".lock");
		const res = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
		});
		writeFileSync(lockPath, `${res.pid}\n`, { mode: 0o600 });

		const result = await runSimpleRoutingTask(f.options, f.deps);
		if (condition === "pending") {
			strictEqual(result.stopReason, "pending_attempt_exists");
		} else if (condition === "native") {
			strictEqual(result.direction, "native_latched");
		} else if (condition === "partial") {
			strictEqual(result.stopReason, "partial_work_retained");
		}
		strictEqual(f.calls.length, 0);
	}
});

test("valid prior binding with missing referenced run preserves previousRoutingRunId in typed stop and fails closed", async () => {
	const f = fixture({ __targets: ["codex"], codex: { status: "failed" } });
	f.options.promptPath = promptFile("missing referenced run\n");
	f.options.taskId = "missing-run-test";
	await runSimpleRoutingTask(f.options, f.deps);

	const projectHash = createHash("sha256")
		.update(f.options.projectPath)
		.digest("hex");
	const runDir = join(f.deps.stateRoot, `${projectHash}-run-1`);
	rmSync(runDir, { recursive: true, force: true });

	f.options.routingRunId = "run-2";
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "stop");
	strictEqual(result.stopReason, "task_identity_state_unavailable");
	strictEqual(result.previousRoutingRunId, "run-1");
	strictEqual(result.result.previousRoutingRunId, "run-1");
	strictEqual(result.result.stopReason, "task_identity_state_unavailable");
});
