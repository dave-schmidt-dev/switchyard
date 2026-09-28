import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	captureTaskStartTree,
	captureTaskStartTreeAsync,
	releaseTaskStartTree,
	releaseTaskStartTreeAsync,
} from "../src/switchyard/lifecycle/index.mjs";
import {
	runnerTestDir,
	withExplicitSwitchyardExecutor,
} from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROSTER_FIXTURE_PATH = resolve(
	__dirname,
	"fixtures",
	"roster.fixture.json",
);
const VALID_DIAGNOSTIC_REF = `diagnostic:${"a".repeat(32)}`;
describe("task-base Parallels lost-result recovery", () => {
	const TREE = "a".repeat(40);
	const REF = "refs/switchyard/task-base/recovery/1.1";
	const lostResultCommand = () => ({
		command: process.execPath,
		args: [
			"-e",
			'process.stderr.write("PrlJob_GetResult: Invalid argument\\n"); process.exit(255)',
		],
	});
	const outputCommand = (output = "") => ({
		command: process.execPath,
		args: ["-e", `process.stdout.write(${JSON.stringify(output)})`],
	});

	it("replays only safe helpers and reconciles an already-anchored immutable ref", async () => {
		const calls = [];
		const statuses = [];
		let addAttempts = 0;
		const backend = {
			execArgv(_workspaceId, { argv }) {
				calls.push(argv);
				if (argv[1] === "add") {
					addAttempts += 1;
					return addAttempts === 1 ? lostResultCommand() : outputCommand();
				}
				if (argv[1] === "write-tree") return outputCommand(`${TREE}\n`);
				if (argv[1] === "update-ref") return lostResultCommand();
				if (argv[1] === "rev-parse") return outputCommand(`${TREE}\n`);
				throw new Error(`unexpected git helper: ${argv.join(" ")}`);
			},
		};

		const base = await captureTaskStartTreeAsync(backend, "workspace", {
			runId: "recovery",
			taskId: "1.1",
			onStatus: (status) => statuses.push(status),
		});

		deepStrictEqual(base, { ref: REF, tree: TREE });
		strictEqual(calls.filter((argv) => argv[1] === "add").length, 2);
		strictEqual(calls.filter((argv) => argv[1] === "write-tree").length, 1);
		strictEqual(calls.filter((argv) => argv[1] === "update-ref").length, 1);
		strictEqual(calls.filter((argv) => argv[1] === "rev-parse").length, 1);
		deepStrictEqual(
			statuses
				.filter(({ event }) => event === "task_base_probe_recovered")
				.map(({ stage, mode }) => [stage, mode]),
			[
				["task_base_stage", "replay"],
				["task_base_anchor", "reconcile"],
			],
		);
	});

	it("replays safe helpers and reconciles an already-anchored ref synchronously", () => {
		const calls = [];
		let addAttempts = 0;
		const backend = {
			execArgv(_workspaceId, { argv }) {
				calls.push(argv);
				if (argv[1] === "add") {
					addAttempts += 1;
					return addAttempts === 1 ? lostResultCommand() : outputCommand();
				}
				if (argv[1] === "write-tree") return outputCommand(`${TREE}\n`);
				if (argv[1] === "update-ref") return lostResultCommand();
				if (argv[1] === "rev-parse") return outputCommand(`${TREE}\n`);
				throw new Error(`unexpected git helper: ${argv.join(" ")}`);
			},
		};

		deepStrictEqual(
			captureTaskStartTree(backend, "workspace", {
				runId: "recovery",
				taskId: "1.1",
			}),
			{ ref: REF, tree: TREE },
		);
		strictEqual(calls.filter((argv) => argv[1] === "add").length, 2);
		strictEqual(calls.filter((argv) => argv[1] === "write-tree").length, 1);
		strictEqual(calls.filter((argv) => argv[1] === "update-ref").length, 1);
		strictEqual(calls.filter((argv) => argv[1] === "rev-parse").length, 1);
	});

	it("fails closed when a lost anchor result resolves to a different tree", async () => {
		const backend = {
			execArgv(_workspaceId, { argv }) {
				if (argv[1] === "add") return outputCommand();
				if (argv[1] === "write-tree") return outputCommand(`${TREE}\n`);
				if (argv[1] === "update-ref") return lostResultCommand();
				if (argv[1] === "rev-parse")
					return outputCommand(`${"b".repeat(40)}\n`);
				throw new Error(`unexpected git helper: ${argv.join(" ")}`);
			},
		};
		await rejects(
			captureTaskStartTreeAsync(backend, "workspace", {
				runId: "recovery",
				taskId: "1.1",
			}),
			/PrlJob_GetResult/,
		);
	});

	it("replays the anchor when a lost result left no ref", async () => {
		let updateAttempts = 0;
		let readAttempts = 0;
		const backend = {
			execArgv(_workspaceId, { argv }) {
				if (argv[1] === "add") return outputCommand();
				if (argv[1] === "write-tree") return outputCommand(`${TREE}\n`);
				if (argv[1] === "update-ref") {
					updateAttempts += 1;
					return updateAttempts === 1 ? lostResultCommand() : outputCommand();
				}
				if (argv[1] === "rev-parse") {
					readAttempts += 1;
					return {
						command: process.execPath,
						args: [
							"-e",
							'process.stderr.write("fatal: ref not found\\n"); process.exit(128)',
						],
					};
				}
				throw new Error(`unexpected git helper: ${argv.join(" ")}`);
			},
		};
		deepStrictEqual(
			await captureTaskStartTreeAsync(backend, "workspace", {
				runId: "recovery",
				taskId: "1.1",
			}),
			{ ref: REF, tree: TREE },
		);
		strictEqual(updateAttempts, 2);
		strictEqual(readAttempts, 1);
	});

	it("preserves the lost anchor error when replay and reconciliation both fail", async () => {
		const backend = {
			execArgv(_workspaceId, { argv }) {
				if (argv[1] === "add") return outputCommand();
				if (argv[1] === "write-tree") return outputCommand(`${TREE}\n`);
				if (argv[1] === "update-ref") return lostResultCommand();
				if (argv[1] === "rev-parse")
					return {
						command: process.execPath,
						args: [
							"-e",
							'process.stderr.write("fatal: ref not found\\n"); process.exit(128)',
						],
					};
				throw new Error(`unexpected git helper: ${argv.join(" ")}`);
			},
		};
		await rejects(
			captureTaskStartTreeAsync(backend, "workspace", {
				runId: "recovery",
				taskId: "1.1",
			}),
			/PrlJob_GetResult: Invalid argument/,
		);
	});

	for (const [mode, release] of [
		["synchronous", releaseTaskStartTree],
		["asynchronous", releaseTaskStartTreeAsync],
	]) {
		it(`${mode} reconciles a lost release result when the ref is absent`, async () => {
			const calls = [];
			const backend = {
				execArgv(_workspaceId, { argv }) {
					calls.push(argv);
					if (argv[1] === "rev-parse") return outputCommand(`${TREE}\n`);
					if (argv[1] === "update-ref") return lostResultCommand();
					if (argv[1] === "for-each-ref") return outputCommand();
					throw new Error(`unexpected git helper: ${argv.join(" ")}`);
				},
			};
			await release(backend, "workspace", { ref: REF, tree: TREE });
			strictEqual(calls.filter((argv) => argv[1] === "update-ref").length, 1);
			strictEqual(calls.filter((argv) => argv[1] === "for-each-ref").length, 1);
		});

		it(`${mode} safely replays a lost release that left the expected ref`, async () => {
			let updateAttempts = 0;
			const backend = {
				execArgv(_workspaceId, { argv }) {
					if (argv[1] === "rev-parse") return outputCommand(`${TREE}\n`);
					if (argv[1] === "update-ref") {
						updateAttempts += 1;
						return updateAttempts === 1 ? lostResultCommand() : outputCommand();
					}
					if (argv[1] === "for-each-ref") return outputCommand(`${TREE}\n`);
					throw new Error(`unexpected git helper: ${argv.join(" ")}`);
				},
			};
			await release(backend, "workspace", { ref: REF, tree: TREE });
			strictEqual(updateAttempts, 2);
		});

		// The validate probe runs FIRST in releaseTaskStartTree, ahead of the try
		// block that reconciles a lost `update-ref -d`. Every other release test
		// above lets `rev-parse` succeed, which is exactly why none of them caught
		// a misfire there: it aborted the release before any recovery could run
		// and reported `task_base_release_transport_lost` for a release that was
		// never attempted. `rev-parse --verify` is a pure read, so replaying it is
		// safe and matches every other idempotent task-base probe.
		it(`${mode} replays a lost result from the read-only validate probe`, async () => {
			let revParseAttempts = 0;
			const calls = [];
			const backend = {
				execArgv(_workspaceId, { argv }) {
					calls.push(argv);
					if (argv[1] === "rev-parse") {
						revParseAttempts += 1;
						return revParseAttempts === 1
							? lostResultCommand()
							: outputCommand(`${TREE}\n`);
					}
					if (argv[1] === "update-ref") return outputCommand();
					throw new Error(`unexpected git helper: ${argv.join(" ")}`);
				},
			};
			await release(backend, "workspace", { ref: REF, tree: TREE });
			strictEqual(revParseAttempts, 2);
			// The release itself must still have happened exactly once — the
			// retry absorbs the misfire, it does not re-run the destructive step.
			strictEqual(calls.filter((argv) => argv[1] === "update-ref").length, 1);
		});

		it(`${mode} still fails closed when the validate probe never recovers`, async () => {
			let revParseAttempts = 0;
			const backend = {
				execArgv(_workspaceId, { argv }) {
					if (argv[1] === "rev-parse") {
						revParseAttempts += 1;
						return lostResultCommand();
					}
					if (argv[1] === "update-ref")
						throw new Error("release must not be attempted");
					throw new Error(`unexpected git helper: ${argv.join(" ")}`);
				},
			};
			await rejects(
				Promise.resolve().then(() =>
					release(backend, "workspace", { ref: REF, tree: TREE }),
				),
				/PrlJob_GetResult/,
			);
			// Bounded: one replay, not an unbounded loop against a wedged host.
			strictEqual(revParseAttempts, 2);
		});

		it(`${mode} fails closed when release reconciliation finds a different ref`, async () => {
			const backend = {
				execArgv(_workspaceId, { argv }) {
					if (argv[1] === "rev-parse") return outputCommand(`${TREE}\n`);
					if (argv[1] === "update-ref") return lostResultCommand();
					if (argv[1] === "for-each-ref")
						return outputCommand(`${"b".repeat(40)}\n`);
					throw new Error(`unexpected git helper: ${argv.join(" ")}`);
				},
			};
			await rejects(
				Promise.resolve().then(() =>
					release(backend, "workspace", { ref: REF, tree: TREE }),
				),
				/PrlJob_GetResult/,
			);
		});
	}

	it("reports a synchronous backend execution failure after async probe start", async () => {
		const statuses = [];
		await rejects(
			captureTaskStartTreeAsync(
				{
					execArgv() {
						throw new Error("backend execution creation failed");
					},
				},
				"workspace",
				{
					runId: "recovery",
					taskId: "1.1",
					onStatus: (status) => statuses.push(status),
				},
			),
			/ backend execution creation failed/,
		);
		deepStrictEqual(
			statuses.map(({ event, stage }) => [event, stage]),
			[
				["task_base_probe_started", "task_base_stage"],
				["task_base_probe_failed", "task_base_stage"],
			],
		);
	});

	it("does not retry an unrelated task-base helper failure", async () => {
		let addAttempts = 0;
		const backend = {
			execArgv(_workspaceId, { argv }) {
				if (argv[1] !== "add") throw new Error("unexpected helper replay");
				addAttempts += 1;
				return {
					command: process.execPath,
					args: ["-e", "process.exit(1)"],
				};
			},
		};
		await rejects(
			captureTaskStartTreeAsync(backend, "workspace", {
				runId: "recovery",
				taskId: "1.1",
			}),
			/Command failed/,
		);
		strictEqual(addAttempts, 1);
	});

	it("does not replay an async helper after its deadline expires", async () => {
		const addLaunchesDir = join(
			tmpdir(),
			`switchyard-async-add-${randomUUID()}`,
		);
		const addLaunchesPath = join(addLaunchesDir, "launches");
		mkdirSync(addLaunchesDir, { recursive: true });
		let nowCalls = 0;
		const backend = {
			execArgv(_workspaceId, { argv }) {
				if (argv[1] !== "add") throw new Error("unexpected helper replay");
				return {
					command: process.execPath,
					args: [
						"-e",
						[
							`require("node:fs").appendFileSync(${JSON.stringify(addLaunchesPath)}, "1")`,
							'process.stderr.write("PrlJob_GetResult: Invalid argument\\n")',
							"process.exit(255)",
						].join(";"),
					],
				};
			},
		};
		try {
			await rejects(
				captureTaskStartTreeAsync(backend, "workspace", {
					runId: "recovery",
					taskId: "1.1",
					deadlineMs: 10_000,
					now: () => (nowCalls++ === 0 ? 0 : 10_001),
				}),
				/task base probe deadline exhausted/,
			);
			strictEqual(readFileSync(addLaunchesPath, "utf8"), "1");
		} finally {
			rmSync(addLaunchesDir, { recursive: true, force: true });
		}
	});
});
function writeTasksFile(content) {
	mkdirSync(TEST_DIR, { recursive: true });
	const tasksPath = join(TEST_DIR, "tasks.md");
	writeFileSync(tasksPath, withExplicitSwitchyardExecutor(content), "utf8");
	return tasksPath;
}
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
