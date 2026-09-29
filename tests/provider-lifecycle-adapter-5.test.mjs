import { deepStrictEqual, strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
	executeProviderInvocation,
	getWorkspaceExecution,
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
	it("does not let terminal evidence override timeout or cancellation", async () => {
		const child = fakeChild();
		child.kill = () => {
			queueMicrotask(() => child.emit("close", 255, null));
			return true;
		};
		let reads = 0;
		let removals = 0;
		const cleanupContext = {
			runId: "legacy-run",
			taskId: "48-timeout",
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
			cleanupProviderProcess: () => {},
			readProviderTerminalEvidence: () => {
				reads += 1;
				return { status: "confirmed", exitCode: 0 };
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
		const result = await executeProviderInvocation(
			execution.command,
			execution.args,
			{
				provider: "codex",
				executionBackend,
				cleanupContext,
				spawnFn: () => child,
				timeoutMs: 1,
				termGraceMs: 1,
			},
		);
		strictEqual(result.success, false);
		strictEqual(result.timedOut, true);
		strictEqual(reads, 0);
		strictEqual(removals, 0);

		const cancelledChild = fakeChild();
		cancelledChild.kill = () => {
			queueMicrotask(() => cancelledChild.emit("close", 255, null));
			return true;
		};
		const cancelledExecution = getWorkspaceExecution("legacy-vm", {
			executionBackend,
			argv: ["codex", "exec"],
			recordPid: true,
			cleanupContext,
		});
		const controller = new AbortController();
		const cancelledPromise = executeProviderInvocation(
			cancelledExecution.command,
			cancelledExecution.args,
			{
				provider: "codex",
				executionBackend,
				cleanupContext,
				spawnFn: () => cancelledChild,
				signal: controller.signal,
				termGraceMs: 1,
			},
		);
		controller.abort();
		const cancelled = await cancelledPromise;
		strictEqual(cancelled.success, false);
		strictEqual(cancelled.cancelled, true);
		strictEqual(reads, 0);
		strictEqual(removals, 0);
	});

	it("keeps a lost legacy result uncertain when terminal evidence is missing", async () => {
		const child = fakeChild();
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
			execArgv: () => ({
				command: "fake",
				args: [],
				terminalEvidence: {
					token: "11111111-1111-4111-8111-111111111111",
				},
			}),
			readProviderTerminalEvidence: () => ({
				status: "uncertain",
				reason: "evidence_missing_or_unreadable",
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
		const promise = executeProviderInvocation(
			execution.command,
			execution.args,
			{
				provider: "codex",
				executionBackend,
				cleanupContext,
				spawnFn: () => {
					queueMicrotask(() => child.emit("close", 255, null));
					return child;
				},
			},
		);
		const result = await promise;
		strictEqual(result.success, false);
		strictEqual(result.terminalEvidenceStatus, "uncertain");
		strictEqual(removals, 0);
	});

	it("keeps text-derived auth and quota labels informational", async () => {
		for (const [provider, output, expectedKind] of [
			[
				"codex",
				"Test expectation: authentication failed should be displayed",
				"auth_expired",
			],
			[
				"agy",
				"Task fixture: Individual quota reached after the child exits",
				"quota_exhausted",
			],
		]) {
			const child = fakeChild();
			const promise = executeProviderInvocation("fake", [], {
				provider,
				spawnFn: () => child,
			});
			child.stdout.emit("data", output);
			child.emit("close", 1, null);
			const result = await promise;
			strictEqual(result.errorKind, expectedKind);
			strictEqual(result.diagnosticCode, "provider_exit_nonzero");
			strictEqual(result.diagnosticOrigin, "adapter");
			strictEqual(result.diagnosticEvidenceAvailable, false);
		}
	});

	it("accepts a closed provider diagnostic only through the explicit adapter seam", async () => {
		const child = fakeChild();
		const promise = executeProviderInvocation("fake", [], {
			provider: "agy",
			adapterDiagnosticCode: "quota_exhausted",
			spawnFn: () => child,
		});
		child.emit("close", 1, null);
		const result = await promise;
		strictEqual(result.diagnosticCode, "quota_exhausted");
		strictEqual(result.diagnosticOrigin, "adapter");
		strictEqual(result.diagnosticEvidenceAvailable, false);
	});

	it("keeps silence observational and uses the absolute deadline", async () => {
		const child = fakeChild();
		child.kill = (signal) => {
			child.signals.push(signal);
			if (signal === "SIGKILL")
				queueMicrotask(() => child.emit("close", 0, signal));
		};
		const result = await executeProviderInvocation("fake", [], {
			provider: "vibe",
			idleExitCode: 0,
			silenceTimeoutMs: 1,
			timeoutMs: 5,
			termGraceMs: 1,
			cleanup: () => ({ cleanupFailed: false, postcondition: true }),
			spawnFn: () => child,
		});
		strictEqual(result.success, false);
		strictEqual(result.silenceTimedOut, false);
		strictEqual(result.timedOut, true);
		strictEqual(result.diagnosticCode, "execution_timed_out");
	});

	it("classifies real provider/binary bindings from separate lifecycle streams", async () => {
		for (const [provider, binary] of [
			["claude", "claude"],
			["codex", "codex"],
			["agy", "agy"],
			["cursor", "cursor-agent"],
			["copilot", "copilot"],
			["opencode", "opencode"],
			["vibe", "vibe"],
		]) {
			const child = fakeChild();
			const promise = executeProviderInvocation(`/usr/bin/${binary}`, [], {
				provider,
				spawnFn: () => child,
			});
			child.stdout.emit("data", "Error: Session expired\n");
			child.stderr.emit("data", "Session expired\n");
			child.emit("close", 1, null);
			const result = await promise;
			strictEqual(
				result.diagnosticCode,
				"auth_expired",
				`${provider}/${binary}`,
			);
			strictEqual(result.diagnosticEvidenceAvailable, false);
			strictEqual(result.diagnosticEvidence.diagnosticKind, "auth_required");
			strictEqual(result.diagnosticEvidence.diagnosticCode, undefined);
			strictEqual(Object.hasOwn(result.diagnosticEvidence, "stdout"), false);
			strictEqual(Object.hasOwn(result.diagnosticEvidence, "stderr"), false);
		}
	});

	it("awaits the durable process-completed callback before returning", async () => {
		const child = fakeChild();
		const order = [];
		const pending = executeProviderInvocation("fake", [], {
			provider: "codex",
			spawnFn: () => child,
			onProcessCompleted: async (fact) => {
				order.push(["persist", fact.success, fact.cleanupFailed]);
				await new Promise((resolve) => setTimeout(resolve, 2));
				order.push("persisted");
			},
		});
		child.emit("close", 0, null);
		const result = await pending;
		deepStrictEqual(order, [["persist", true, false], "persisted"]);
		strictEqual(result.success, true);
	});
});
