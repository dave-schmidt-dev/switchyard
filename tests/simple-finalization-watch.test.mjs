import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createFinalizationWatch } from "../src/switchyard/simple/finalization-watch.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const originalTmpdirEnv = process.env.TMPDIR;
const originalRunStoreEnv = process.env.SWITCHYARD_RUN_STORE_ROOT;
const SUITE_TMPDIR = realpathSync(tempDir("switchyard-finalize-suite-"));
process.env.TMPDIR = SUITE_TMPDIR;
process.env.SWITCHYARD_RUN_STORE_ROOT = join(SUITE_TMPDIR, "run-store");

after(() => {
	if (originalTmpdirEnv === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpdirEnv;
	if (originalRunStoreEnv === undefined)
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	else process.env.SWITCHYARD_RUN_STORE_ROOT = originalRunStoreEnv;
	rmSync(SUITE_TMPDIR, { recursive: true, force: true });
});

function manualWatch(options = {}) {
	let time = 0;
	let tick = null;
	const lines = [];
	const watch = createFinalizationWatch({
		warn: (line) => lines.push(line),
		clock: () => time,
		tickMs: 1_000,
		waitReportMs: 5_000,
		blockedReportMs: 3_000,
		fsProbe: null,
		timers: {
			setInterval: (fn) => {
				tick = fn;
				return {};
			},
			clearInterval: () => {
				tick = null;
			},
		},
		...options,
	});
	const advance = (ms) => {
		time += ms;
	};
	return { watch, lines, advance, fire: () => tick?.() };
}

describe("finalization watch", () => {
	it("reports a waiting step once per report period", () => {
		const { watch, lines, advance, fire } = manualWatch();
		watch.step("project_lock_release");
		for (let i = 0; i < 11; i++) {
			advance(1_000);
			fire();
		}
		deepStrictEqual(lines, [
			"dispatch: simple finalization step=project_lock_release waiting_ms=5000",
			"dispatch: simple finalization step=project_lock_release waiting_ms=10000",
		]);
		deepStrictEqual(watch.stop(), {
			step: "project_lock_release",
			kind: "waiting",
			durationMs: 10_000,
		});
	});

	it("flags a filesystem probe that has not returned while a step waits", async () => {
		let probes = 0;
		let settleProbe = null;
		const { watch, lines, advance, fire } = manualWatch({
			fsProbe: () => {
				probes += 1;
				return new Promise((resolve) => {
					settleProbe = resolve;
				});
			},
		});
		watch.step("project_lock_release");
		for (let i = 0; i < 5; i++) {
			advance(1_000);
			fire();
		}
		strictEqual(probes, 1);
		deepStrictEqual(lines, [
			"dispatch: simple finalization step=project_lock_release waiting_ms=5000 fs_probe_pending_ms=4000",
		]);
		settleProbe();
		await new Promise((resolve) => setImmediate(resolve));
		for (let i = 0; i < 5; i++) {
			advance(1_000);
			fire();
		}
		strictEqual(probes, 2);
		strictEqual(
			lines[1],
			"dispatch: simple finalization step=project_lock_release waiting_ms=10000 fs_probe_pending_ms=4000",
		);
		watch.stop();
	});

	it("names the step in flight when a late tick shows a blocked loop", () => {
		const { watch, lines, advance, fire } = manualWatch();
		watch.step("pending_durability");
		advance(1_000);
		fire();
		advance(40_000);
		fire();
		deepStrictEqual(lines, [
			"dispatch: simple finalization step=pending_durability event_loop_blocked_ms=39000",
		]);
		deepStrictEqual(watch.stop(), {
			step: "pending_durability",
			kind: "event_loop_blocked",
			durationMs: 39_000,
		});
	});

	it("charges a block that ends right before the next step to the prior step", () => {
		const { watch, lines, advance, fire } = manualWatch();
		watch.step("check_session_remove");
		advance(20_000);
		watch.step("worktree_remove");
		fire();
		deepStrictEqual(lines, [
			"dispatch: simple finalization step=check_session_remove event_loop_blocked_ms=19000",
		]);
		strictEqual(watch.stop().step, "check_session_remove");
	});

	it("reports nothing for a quick finalization and survives a failing writer", () => {
		const quiet = manualWatch();
		quiet.watch.step("pending_durability");
		quiet.advance(500);
		quiet.watch.step("failure_disposition");
		quiet.advance(500);
		strictEqual(quiet.watch.stop(), null);
		deepStrictEqual(quiet.lines, []);
		const failing = manualWatch({
			warn: () => {
				throw new Error("stderr closed");
			},
		});
		failing.watch.step("project_lock_release");
		failing.advance(30_000);
		failing.fire();
		strictEqual(failing.watch.stop().kind, "event_loop_blocked");
	});
});

function makeRepo() {
	const root = tempDir("switchyard-finalize-test-");
	const projectPath = join(root, "project");
	mkdirSync(join(projectPath, "src"), { recursive: true });
	writeFileSync(join(projectPath, "src", "a.txt"), "base\n", "utf8");
	execFileSync("git", ["init", "-q"], { cwd: projectPath });
	execFileSync("git", ["add", "-A"], { cwd: projectPath });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Switchyard Tests",
			"-c",
			"user.email=switchyard@example.invalid",
			"commit",
			"-qm",
			"base",
		],
		{ cwd: projectPath },
	);
	const promptPath = join(root, "prompt.txt");
	writeFileSync(promptPath, "Change files", "utf8");
	return { projectPath, promptPath };
}

async function failedRun(releaseProjectLock) {
	const repo = makeRepo();
	const warnings = [];
	const result = await runSimpleTask(
		{
			promptPath: repo.promptPath,
			projectPath: repo.projectPath,
			capability: "standard",
			files: ["src/a.txt"],
			checks: ["test -f src/a.txt"],
			deadlineMs: 10_000,
		},
		{
			now: () => 1_000,
			taskId: "simple-finalize-test",
			attemptId: "attempt-1",
			acquireProjectLock: async () => {},
			releaseProjectLock,
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
			executeProvider: async () => ({
				success: false,
				code: 1,
				writerLifecycle: "stopped",
			}),
			onRoutingWarning: (line) => warnings.push(line),
			finalizationWatch: {
				tickMs: 20,
				waitReportMs: 150,
				blockedReportMs: 200,
			},
		},
	);
	return { result, warnings };
}

// Regression (2026-10-15 hermes): an attempt sat 11.4 hours after its
// terminal milestone with no output while its finalization was blocked.
describe("engine finalization stalls are never silent", () => {
	it("names the lock release when it blocks the event loop", async () => {
		const { result, warnings } = await failedRun(async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			const until = Date.now() + 400;
			while (Date.now() < until) {}
			await new Promise((resolve) => setTimeout(resolve, 30));
			return true;
		});
		strictEqual(result.status, "failed");
		ok(
			warnings.some((line) =>
				/^dispatch: simple finalization step=project_lock_release event_loop_blocked_ms=\d+$/u.test(
					line,
				),
			),
			`no blocked line in ${JSON.stringify(warnings)}`,
		);
	});

	it("reports a lock release that keeps waiting", async () => {
		const { result, warnings } = await failedRun(async () => {
			await new Promise((resolve) => setTimeout(resolve, 400));
			return true;
		});
		strictEqual(result.status, "failed");
		ok(
			warnings.some((line) =>
				/^dispatch: simple finalization step=project_lock_release waiting_ms=\d+$/u.test(
					line,
				),
			),
			`no waiting line in ${JSON.stringify(warnings)}`,
		);
	});
});
