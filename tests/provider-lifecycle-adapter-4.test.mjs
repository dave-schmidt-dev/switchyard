import { deepStrictEqual, strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
	completeSynchronousProviderExit,
	executeProviderInvocation,
	getWorkspaceExecution,
	reconcileSynchronousProviderExit,
} from "../src/switchyard/adapter/provider-lifecycle.mjs";

const TASK_BASE = {
	ref: "refs/switchyard/task-base/test-run/1.1",
	tree: "1".repeat(40),
};

function _taskBaseValidationCommand(argv) {
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
	it("falls back to the adapter's cleanup when the backend's cleanupProviderProcess throws", async () => {
		const child = fakeChild();
		let adapterCleanups = 0;
		const executionBackend = {
			cleanupProviderProcess: () => {
				const error = new Error("guest unreachable");
				error.cleanupStage = "tree_terminated";
				throw error;
			},
		};
		const result = await executeProviderInvocation("fake", [], {
			spawnFn: () => child,
			timeoutMs: 1,
			termGraceMs: 1,
			executionBackend,
			cleanup: () => {
				adapterCleanups += 1;
			},
		});
		strictEqual(result.timedOut, true);
		strictEqual(result.cleanupFailed, true);
		strictEqual(result.cleanupStage, "tree_terminated");
		strictEqual(
			result.diagnosticCode,
			"provider_cleanup_after_tree_terminated",
		);
		strictEqual(result.failurePhase, "provider_cleanup");
		strictEqual(
			adapterCleanups,
			1,
			"adapter cleanup must still run as a backstop when the backend's cleanup fails",
		);
	});

	it("retains a cleanup failure stage through cancellation", async () => {
		const child = fakeChild();
		const controller = new AbortController();
		const executionBackend = {
			cleanupProviderProcess: () => {
				const error = new Error("guest unreachable");
				error.cleanupStage = "pid_observed";
				throw error;
			},
		};
		const resultPromise = executeProviderInvocation("fake", [], {
			spawnFn: () => child,
			termGraceMs: 1,
			signal: controller.signal,
			executionBackend,
		});
		controller.abort();
		const result = await resultPromise;
		strictEqual(result.cancelled, true);
		strictEqual(result.cleanupFailed, true);
		strictEqual(result.errorKind, "provider_cleanup_failed");
		strictEqual(result.cleanupStage, "pid_observed");
		strictEqual(result.diagnosticCode, "provider_cleanup_after_pid_observed");
		strictEqual(result.failurePhase, "provider_cleanup");
		strictEqual(result.diagnosticEvidence.stdoutBytes, 0);
		strictEqual(result.diagnosticEvidence.stderrBytes, 0);
		strictEqual(Object.hasOwn(result.diagnosticEvidence, "stdout"), false);
	});

	it("runs the adapter's cleanup when no backend cleanupProviderProcess is available", async () => {
		const child = fakeChild();
		let adapterCleanups = 0;
		const result = await executeProviderInvocation("fake", [], {
			spawnFn: () => child,
			timeoutMs: 1,
			termGraceMs: 1,
			cleanup: () => {
				adapterCleanups += 1;
			},
		});
		strictEqual(result.timedOut, true);
		strictEqual(adapterCleanups, 1);
	});

	it("writes an EOF when input is an empty string", async () => {
		const stdinEndArgs = [];
		const child = fakeChild();
		child.stdin = {
			end(...args) {
				stdinEndArgs.push(args);
			},
		};
		const spawnFn = () => {
			queueMicrotask(() => child.emit("close", 0, null));
			return child;
		};
		const result = await executeProviderInvocation("fake", [], {
			spawnFn,
			input: "",
		});
		strictEqual(result.success, true);
		strictEqual(stdinEndArgs.length, 1);
		deepStrictEqual(stdinEndArgs[0], [""]);
	});

	it("mints CLI misuse only from an explicit launcher diagnostic", async () => {
		const invoke = async (options = {}) => {
			const child = fakeChild();
			const promise = executeProviderInvocation("fake", [], {
				spawnFn: () => child,
				...options,
			});
			child.stdout.emit("data", "task prose: usage: helper --example\n");
			child.emit("close", options.exitCode ?? 255, null);
			return promise;
		};

		const observedExit = await invoke({ exitCode: 255 });
		strictEqual(observedExit.diagnosticCode, "provider_exit_nonzero");
		strictEqual(observedExit.diagnosticOrigin, "adapter");
		strictEqual(observedExit.diagnosticEvidenceAvailable, false);

		const launcherUsage = await invoke({
			exitCode: 2,
			launcherDiagnosticCode: "cli_usage_error",
		});
		strictEqual(launcherUsage.diagnosticCode, "cli_usage_error");
		strictEqual(launcherUsage.diagnosticOrigin, "launcher");
		strictEqual(launcherUsage.diagnosticEvidenceAvailable, false);
	});

	it("reconciles a legacy transport exit 255 from exact terminal evidence without replay", async () => {
		const child = fakeChild();
		let descriptorBuilds = 0;
		let providerSpawns = 0;
		let reads = 0;
		let removals = 0;
		const cleanupContext = {
			runId: "legacy-run",
			taskId: "48",
			attemptId: "attempt-1",
			descriptorIdentity: "descriptor-1",
			workspaceId: "legacy-vm",
			operation: "provider",
		};
		const executionBackend = {
			execArgv() {
				descriptorBuilds += 1;
				return {
					command: "fake",
					args: [],
					terminalEvidence: {
						token: "11111111-1111-4111-8111-111111111111",
					},
				};
			},
			readProviderTerminalEvidence(_workspaceId, _context, { token }) {
				reads += 1;
				strictEqual(token, "11111111-1111-4111-8111-111111111111");
				return { status: "confirmed", exitCode: 17 };
			},
			clearProviderTerminalEvidence() {
				removals += 1;
				return { status: "removed" };
			},
		};
		const execution = getWorkspaceExecution("legacy-vm", {
			executionBackend,
			argv: ["codex", "exec"],
			recordPid: true,
			cleanupContext,
		});
		const promise = executeProviderInvocation(
			execution.command,
			execution.args,
			{
				provider: "codex",
				executionBackend,
				cleanupContext,
				spawnFn: () => {
					providerSpawns += 1;
					queueMicrotask(() => child.emit("close", 255, null));
					return child;
				},
			},
		);
		const result = await promise;
		strictEqual(result.success, false);
		strictEqual(result.exitCode, 17);
		strictEqual(result.terminalEvidenceStatus, "confirmed");
		strictEqual(result.terminalEvidenceCleanupStatus, "removed");
		strictEqual(reads, 1);
		strictEqual(removals, 1);
		strictEqual(descriptorBuilds, 1);
		strictEqual(
			providerSpawns,
			1,
			"the provider process must spawn exactly once",
		);
	});

	it("accepts a confirmed zero provider exit after a legacy transport exit 255", async () => {
		const child = fakeChild();
		let providerSpawns = 0;
		const cleanupContext = {
			runId: "legacy-run",
			taskId: "48-zero",
			attemptId: "attempt-1",
			descriptorIdentity: "descriptor-1",
			workspaceId: "legacy-vm",
			operation: "provider",
		};
		const executionBackend = {
			execArgv: () => ({
				command: "fake",
				args: [],
				terminalEvidence: {
					token: "11111111-1111-4111-8111-111111111111",
				},
			}),
			readProviderTerminalEvidence: () => ({
				status: "confirmed",
				exitCode: 0,
			}),
			clearProviderTerminalEvidence: () => ({ status: "removed" }),
		};
		const execution = getWorkspaceExecution("legacy-vm", {
			executionBackend,
			argv: ["codex", "exec"],
			recordPid: true,
			cleanupContext,
		});
		const result = await executeProviderInvocation(
			execution.command,
			execution.args,
			{
				provider: "codex",
				executionBackend,
				cleanupContext,
				spawnFn: () => {
					providerSpawns += 1;
					queueMicrotask(() => child.emit("close", 255, null));
					return child;
				},
			},
		);
		strictEqual(result.success, true);
		strictEqual("exitCode" in result, false);
		strictEqual(result.terminalEvidenceStatus, "confirmed");
		strictEqual(result.terminalEvidenceCleanupStatus, "removed");
		strictEqual(providerSpawns, 1);
	});

	it("reconciles synchronous legacy transport loss without replay", () => {
		const cleanupContext = {
			runId: "legacy-run",
			taskId: "48-sync",
			attemptId: "attempt-1",
			descriptorIdentity: "descriptor-1",
			workspaceId: "legacy-vm",
			operation: "provider",
		};
		for (const exitCode of [0, 23]) {
			let reads = 0;
			let removals = 0;
			const executionBackend = {
				execArgv: () => ({
					command: "fake",
					args: [],
					terminalEvidence: {
						token: "11111111-1111-4111-8111-111111111111",
					},
				}),
				readProviderTerminalEvidence: () => {
					reads += 1;
					return { status: "confirmed", exitCode };
				},
				clearProviderTerminalEvidence: () => {
					removals += 1;
					return { status: "removed" };
				},
			};
			const execution = getWorkspaceExecution("legacy-vm", {
				executionBackend,
				argv: ["codex", "exec"],
				recordPid: true,
				cleanupContext,
			});
			const result = reconcileSynchronousProviderExit(
				{ status: 255, signal: null, stdout: "provider output" },
				execution.args,
				{ provider: "codex", executionBackend, cleanupContext },
			);
			strictEqual(result.success, exitCode === 0);
			strictEqual(result.terminalEvidenceStatus, "confirmed");
			strictEqual(result.terminalEvidenceCleanupStatus, "removed");
			if (exitCode !== 0) strictEqual(result.exitCode, exitCode);
			strictEqual(reads, 1);
			strictEqual(removals, 1);
		}
	});

	it("removes terminal evidence after a direct synchronous success", () => {
		let removals = 0;
		const cleanupContext = {
			runId: "legacy-run",
			taskId: "48-sync-success",
			attemptId: "attempt-1",
			descriptorIdentity: "descriptor-1",
			workspaceId: "legacy-vm",
			operation: "provider",
		};
		const executionBackend = {
			execArgv: () => ({
				command: "fake",
				args: [],
				terminalEvidence: {
					token: "11111111-1111-4111-8111-111111111111",
				},
			}),
			clearProviderTerminalEvidence: () => {
				removals += 1;
				return { status: "removed" };
			},
		};
		const execution = getWorkspaceExecution("legacy-vm", {
			executionBackend,
			argv: ["codex", "exec"],
			recordPid: true,
			cleanupContext,
		});
		const result = completeSynchronousProviderExit("done", execution.args, {
			executionBackend,
			cleanupContext,
		});
		strictEqual(result.success, true);
		strictEqual(result.terminalEvidenceCleanupStatus, "removed");
		strictEqual(removals, 1);
	});

	it("reports terminal evidence removal after a direct asynchronous success", async () => {
		const child = fakeChild();
		let removals = 0;
		const cleanupContext = {
			runId: "legacy-run",
			taskId: "48-async-success",
			attemptId: "attempt-1",
			descriptorIdentity: "descriptor-1",
			workspaceId: "legacy-vm",
			operation: "provider",
		};
		const executionBackend = {
			execArgv: () => ({
				command: "fake",
				args: [],
				terminalEvidence: {
					token: "11111111-1111-4111-8111-111111111111",
				},
			}),
			readProviderTerminalEvidence: () => ({ status: "uncertain" }),
			clearProviderTerminalEvidence: () => {
				removals += 1;
				return { status: "removed" };
			},
		};
		const execution = getWorkspaceExecution("legacy-vm", {
			executionBackend,
			argv: ["codex", "exec"],
			recordPid: true,
			cleanupContext,
		});
		const promise = executeProviderInvocation(
			execution.command,
			execution.args,
			{
				provider: "codex",
				executionBackend,
				cleanupContext,
				spawnFn: () => child,
			},
		);
		child.emit("close", 0, null);
		const result = await promise;
		strictEqual(result.success, true);
		strictEqual(result.terminalEvidenceCleanupStatus, "removed");
		strictEqual(removals, 1);
	});
});
