import { deepStrictEqual, strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
	captureProviderDiffDetailed,
	captureProviderDiffDetailedAsync,
	executeProviderInvocation,
} from "../src/switchyard/adapter/provider-lifecycle.mjs";

const TASK_BASE = {
	ref: "refs/switchyard/task-base/test-run/1.1",
	tree: "1".repeat(40),
};

function taskBaseValidationCommand(argv) {
	return argv[1] === "rev-parse"
		? {
				command: process.execPath,
				args: ["-e", `process.stdout.write(${JSON.stringify(TASK_BASE.tree)})`],
			}
		: null;
}

function fakeChild() {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = { end() {} };
	child.signals = [];
	child.kill = (signal) => {
		child.signals.push(signal);
		if (signal === "SIGKILL")
			queueMicrotask(() => child.emit("close", null, signal));
		return true;
	};
	return child;
}

describe("provider process lifecycle", () => {
	it("preserves timed_out when asynchronous task-base validation exhausts the budget", async () => {
		let clock = 1_000_000;
		const executionBackend = {
			execArgv(_workspaceId, { argv }) {
				if (argv[1] === "rev-parse") clock += 60_000;
				return { command: "fake", args: [...argv] };
			},
		};
		deepStrictEqual(
			await captureProviderDiffDetailedAsync("worker", {
				executionBackend,
				taskBase: TASK_BASE,
				timeoutMs: 30_000,
				now: () => clock,
				spawnFn: () => {
					const child = fakeChild();
					queueMicrotask(() => child.emit("close", 0, null));
					return child;
				},
			}),
			{ status: "timed_out", diff: null },
		);
	});

	it("still blames the task base when the anchored ref holds another tree", () => {
		// The counterpart to the two budget cases: running out of time must not
		// be reported as an invalid base, and an invalid base must still be.
		const executionBackend = {
			execArgv(_workspaceId, { argv }) {
				return argv[1] === "rev-parse"
					? {
							command: process.execPath,
							args: ["-e", 'process.stdout.write("2".repeat(40))'],
						}
					: { command: process.execPath, args: ["-e", ""] };
			},
		};
		deepStrictEqual(
			captureProviderDiffDetailed("worker", {
				executionBackend,
				taskBase: TASK_BASE,
				timeoutMs: 30_000,
			}),
			{ status: "diff_failed", diff: null, reasonCode: "task_base_invalid" },
		);
	});

	describe("lost Parallels result recovery during asynchronous diff capture", () => {
		const backend = {
			execArgv(_workspaceId, { argv }) {
				const validation = taskBaseValidationCommand(argv);
				if (validation) return validation;
				return { command: "fake", args: [...argv] };
			},
		};

		it("recovers with a one-shot replay on matching Parallels exit 255", async () => {
			const statuses = [];
			let stageSpawns = 0;
			let diffSpawns = 0;
			const result = await captureProviderDiffDetailedAsync("worker", {
				executionBackend: backend,
				taskBase: TASK_BASE,
				onStatus: (status) => statuses.push(status),
				spawnFn: (_command, args) => {
					const isCapture = args.at(-1) === TASK_BASE.tree;
					const child = fakeChild();
					if (!isCapture) {
						stageSpawns += 1;
						queueMicrotask(() => {
							if (stageSpawns === 1) {
								child.stderr.emit(
									"data",
									"PrlJob_GetResult: Invalid argument. An invalid argument was passed.\n",
								);
								child.emit("close", 255, null);
							} else {
								child.emit("close", 0, null);
							}
						});
					} else {
						diffSpawns += 1;
						queueMicrotask(() => {
							if (diffSpawns === 1) {
								child.stderr.emit(
									"data",
									"PrlJob_GetRetCode: Invalid argument\n",
								);
								child.emit("close", 255, null);
							} else {
								child.stdout.emit("data", "diff --git a/a b/a\n");
								child.emit("close", 0, null);
							}
						});
					}
					return child;
				},
			});

			strictEqual(result.status, "captured");
			strictEqual(result.diff, "diff --git a/a b/a\n");
			strictEqual(stageSpawns, 2, "stage helper must replay once");
			strictEqual(diffSpawns, 2, "diff helper must replay once");
			deepStrictEqual(
				statuses
					.filter(({ event }) => event.startsWith("diff_capture"))
					.map(({ event, stage }) => [event, stage]),
				[
					["diff_capture_probe_started", "diff_stage"],
					["diff_capture_probe_recovered", "diff_stage"],
					["diff_capture_probe_completed", "diff_stage"],
					["diff_capture_probe_started", "diff_export"],
					["diff_capture_probe_recovered", "diff_export"],
					["diff_capture_probe_completed", "diff_export"],
				],
			);
			const recoveredMilestone = statuses.find(
				(s) => s.event === "diff_capture_probe_recovered",
			);
			strictEqual(recoveredMilestone.phase, "execution");
			strictEqual(recoveredMilestone.mode, "replay");
			strictEqual(
				recoveredMilestone.status,
				"diff_stage recovered from a Parallels lost result",
			);
		});

		it("does not replay a nonmatching error or exit code", async () => {
			for (const [exitCode, stderrText] of [
				[255, "fatal: git error occurred\n"],
				[
					1,
					"PrlJob_GetResult: Invalid argument. An invalid argument was passed.\n",
				],
			]) {
				const statuses = [];
				let spawns = 0;
				const result = await captureProviderDiffDetailedAsync("worker", {
					executionBackend: backend,
					taskBase: TASK_BASE,
					onStatus: (status) => statuses.push(status),
					spawnFn: () => {
						spawns += 1;
						const child = fakeChild();
						queueMicrotask(() => {
							child.stderr.emit("data", stderrText);
							child.emit("close", exitCode, null);
						});
						return child;
					},
				});

				strictEqual(result.status, "stage_failed");
				strictEqual(spawns, 1, "nonmatching error must not be replayed");
				deepStrictEqual(
					statuses.map(({ event, stage }) => [event, stage]),
					[
						["diff_capture_probe_started", "diff_stage"],
						["diff_capture_probe_failed", "diff_stage"],
					],
				);
			}
		});

		it("bounds repeated misfires to a single replay", async () => {
			const statuses = [];
			let spawns = 0;
			const result = await captureProviderDiffDetailedAsync("worker", {
				executionBackend: backend,
				taskBase: TASK_BASE,
				onStatus: (status) => statuses.push(status),
				spawnFn: () => {
					spawns += 1;
					const child = fakeChild();
					queueMicrotask(() => {
						child.stderr.emit(
							"data",
							"PrlJob_GetResult: Invalid argument. An invalid argument was passed.\n",
						);
						child.emit("close", 255, null);
					});
					return child;
				},
			});

			strictEqual(result.status, "transport_failed");
			strictEqual(result.reasonCode, "prlctl_job_misfire");
			strictEqual(spawns, 2, "repeated misfire must be bounded to 1 replay");
			deepStrictEqual(
				statuses.map(({ event, stage }) => [event, stage]),
				[
					["diff_capture_probe_started", "diff_stage"],
					["diff_capture_probe_recovered", "diff_stage"],
					["diff_capture_probe_failed", "diff_stage"],
				],
			);
		});

		it("fails closed on deadline exhaustion before replay", async () => {
			const statuses = [];
			let clock = 1_000_000;
			let spawns = 0;
			const result = await captureProviderDiffDetailedAsync("worker", {
				executionBackend: backend,
				taskBase: TASK_BASE,
				timeoutMs: 30_000,
				now: () => clock,
				onStatus: (status) => statuses.push(status),
				spawnFn: () => {
					spawns += 1;
					clock += 60_000;
					const child = fakeChild();
					queueMicrotask(() => {
						child.stderr.emit(
							"data",
							"PrlJob_GetResult: Invalid argument. An invalid argument was passed.\n",
						);
						child.emit("close", 255, null);
					});
					return child;
				},
			});

			strictEqual(result.status, "timed_out");
			strictEqual(spawns, 1, "exhausted deadline must abort replay");
			deepStrictEqual(
				statuses.map(({ event, stage }) => [event, stage]),
				[
					["diff_capture_probe_started", "diff_stage"],
					["diff_capture_probe_recovered", "diff_stage"],
					["diff_capture_probe_failed", "diff_stage"],
				],
			);
		});
	});

	describe("lost Parallels result recovery during synchronous diff capture", () => {
		it("recovers with a one-shot replay on matching Parallels exit 255", () => {
			const statuses = [];
			let stageCalls = 0;
			let diffCalls = 0;
			const executionBackend = {
				execArgv(_workspaceId, { argv }) {
					const validation = taskBaseValidationCommand(argv);
					if (validation) return validation;
					const isCapture = argv.at(-1) === TASK_BASE.tree;
					if (!isCapture) {
						stageCalls += 1;
						if (stageCalls === 1) {
							const script =
								'process.stderr.write("PrlJob_GetResult: Invalid argument. An invalid argument was passed.\\n"); process.exit(255);';
							return { command: process.execPath, args: ["-e", script] };
						}
						return { command: process.execPath, args: ["-e", ""] };
					}
					diffCalls += 1;
					if (diffCalls === 1) {
						const script =
							'process.stderr.write("PrlJob_GetRetCode: Invalid argument\\n"); process.exit(255);';
						return { command: process.execPath, args: ["-e", script] };
					}
					return {
						command: process.execPath,
						args: ["-e", 'process.stdout.write("diff --git a/a b/a\\n")'],
					};
				},
			};

			const result = captureProviderDiffDetailed("worker", {
				executionBackend,
				taskBase: TASK_BASE,
				onStatus: (status) => statuses.push(status),
			});

			strictEqual(result.status, "captured");
			strictEqual(result.diff, "diff --git a/a b/a\n");
			strictEqual(stageCalls, 2, "sync stage helper must replay once");
			strictEqual(diffCalls, 2, "sync diff helper must replay once");
			deepStrictEqual(
				statuses
					.filter(({ event }) => event.startsWith("diff_capture"))
					.map(({ event, stage }) => [event, stage]),
				[
					["diff_capture_probe_started", "diff_stage"],
					["diff_capture_probe_recovered", "diff_stage"],
					["diff_capture_probe_completed", "diff_stage"],
					["diff_capture_probe_started", "diff_export"],
					["diff_capture_probe_recovered", "diff_export"],
					["diff_capture_probe_completed", "diff_export"],
				],
			);
			const recoveredMilestone = statuses.find(
				(s) => s.event === "diff_capture_probe_recovered",
			);
			strictEqual(recoveredMilestone.phase, "execution");
			strictEqual(recoveredMilestone.mode, "replay");
			strictEqual(
				recoveredMilestone.status,
				"diff_stage recovered from a Parallels lost result",
			);
		});

		it("does not replay a nonmatching error or exit code", () => {
			for (const [exitCode, stderrText] of [
				[255, "fatal: git add failed\n"],
				[
					1,
					"PrlJob_GetResult: Invalid argument. An invalid argument was passed.\n",
				],
			]) {
				const statuses = [];
				let calls = 0;
				const executionBackend = {
					execArgv(_workspaceId, { argv }) {
						const validation = taskBaseValidationCommand(argv);
						if (validation) return validation;
						calls += 1;
						const script = `process.stderr.write(${JSON.stringify(stderrText)}); process.exit(${exitCode});`;
						return { command: process.execPath, args: ["-e", script] };
					},
				};

				const result = captureProviderDiffDetailed("worker", {
					executionBackend,
					taskBase: TASK_BASE,
					onStatus: (status) => statuses.push(status),
				});

				strictEqual(result.status, "stage_failed");
				strictEqual(calls, 1, "nonmatching error must not be replayed");
				deepStrictEqual(
					statuses.map(({ event, stage }) => [event, stage]),
					[
						["diff_capture_probe_started", "diff_stage"],
						["diff_capture_probe_failed", "diff_stage"],
					],
				);
			}
		});

		it("bounds repeated misfires to a single replay", () => {
			const statuses = [];
			let calls = 0;
			const executionBackend = {
				execArgv(_workspaceId, { argv }) {
					const validation = taskBaseValidationCommand(argv);
					if (validation) return validation;
					calls += 1;
					const script =
						'process.stderr.write("PrlJob_GetResult: Invalid argument. An invalid argument was passed.\\n"); process.exit(255);';
					return { command: process.execPath, args: ["-e", script] };
				},
			};

			const result = captureProviderDiffDetailed("worker", {
				executionBackend,
				taskBase: TASK_BASE,
				onStatus: (status) => statuses.push(status),
			});

			strictEqual(result.status, "transport_failed");
			strictEqual(result.reasonCode, "prlctl_job_misfire");
			strictEqual(calls, 2, "repeated misfire must be bounded to 1 replay");
			deepStrictEqual(
				statuses.map(({ event, stage }) => [event, stage]),
				[
					["diff_capture_probe_started", "diff_stage"],
					["diff_capture_probe_recovered", "diff_stage"],
					["diff_capture_probe_failed", "diff_stage"],
				],
			);
		});

		it("fails closed on deadline exhaustion before replay", () => {
			const statuses = [];
			let clockReads = 0;
			let calls = 0;
			const executionBackend = {
				execArgv(_workspaceId, { argv }) {
					const validation = taskBaseValidationCommand(argv);
					if (validation) return validation;
					calls += 1;
					const script =
						'process.stderr.write("PrlJob_GetResult: Invalid argument. An invalid argument was passed.\\n"); process.exit(255);';
					return { command: process.execPath, args: ["-e", script] };
				},
			};

			const result = captureProviderDiffDetailed("worker", {
				executionBackend,
				taskBase: TASK_BASE,
				timeoutMs: 30_000,
				now: () => (++clockReads <= 2 ? 1_000_000 : 1_060_000),
				onStatus: (status) => statuses.push(status),
			});

			strictEqual(result.status, "timed_out");
			strictEqual(calls, 1, "exhausted deadline must abort replay");
			deepStrictEqual(
				statuses.map(({ event, stage }) => [event, stage]),
				[
					["diff_capture_probe_started", "diff_stage"],
					["diff_capture_probe_recovered", "diff_stage"],
					["diff_capture_probe_failed", "diff_stage"],
				],
			);
		});
	});

	it("prefers a backend's cleanupProviderProcess and skips the adapter's own cleanup on timeout", async () => {
		const child = fakeChild();
		let backendCalls = 0;
		let cleanupOptions = null;
		let adapterCleanups = 0;
		const executionBackend = {
			cleanupProviderProcess: (_command, _args, options) => {
				backendCalls += 1;
				cleanupOptions = options;
			},
		};
		const result = await executeProviderInvocation("fake", [], {
			spawnFn: () => child,
			timeoutMs: 1,
			termGraceMs: 1,
			executionBackend,
			cleanupContext: { workspaceId: "{bridge-workspace}" },
			cleanup: () => {
				adapterCleanups += 1;
			},
		});
		strictEqual(result.timedOut, true);
		strictEqual(backendCalls, 1);
		strictEqual(
			adapterCleanups,
			0,
			"adapter cleanup must not run once the backend's own cleanup succeeded",
		);
		deepStrictEqual(cleanupOptions, {
			onStatus: undefined,
			workspaceId: "{bridge-workspace}",
		});
	});
});
