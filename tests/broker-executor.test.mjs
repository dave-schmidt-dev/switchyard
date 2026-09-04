import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { executeBrokerRoute } from "../src/switchyard/broker/executor.mjs";
import { BROKER_CONTRACT_VERSION } from "../src/switchyard/broker/schema.mjs";
import { getInvocationDescriptorIdentity } from "../src/switchyard/roster/index.mjs";

function fixture() {
	const core = {
		target_id: "claude",
		model_ref: "claude-standard",
		selector: "claude-standard",
		effort: null,
		variant: null,
		invocation_args: [],
	};
	const descriptor = {
		...core,
		descriptor_identity: getInvocationDescriptorIdentity(core, "claude"),
	};
	const request = {
		schemaVersion: BROKER_CONTRACT_VERSION,
		capability: "standard",
		dataClass: "repository",
		estimatedConsumption: 2,
		runId: "run-1",
		taskId: "TASK-001",
		snapshotSource: "gradus-v2",
		availableAdapters: ["claude"],
	};
	const route = {
		schemaVersion: BROKER_CONTRACT_VERSION,
		runId: "run-1",
		taskId: "TASK-001",
		capability: "standard",
		provider: "Claude",
		resolvedTarget: "claude",
		harness: "claude",
		model: "claude-standard",
		effort: null,
		snapshotIdentity: {
			source: "gradus-v2",
			status: "fresh",
			mtime: 1,
			ageMs: 2,
		},
		reservation: {
			id: "reservation-1",
			provider: "Claude",
			runId: "run-1",
			taskId: "TASK-001",
			amount: 2,
		},
		reason: "ranked",
	};
	const launcherIdentity = {
		provider: "Claude",
		resolvedTarget: "claude",
		harness: "claude",
		model: "claude-standard",
		effort: null,
		descriptorIdentity: descriptor.descriptor_identity,
		reservationId: "reservation-1",
		snapshotIdentity: route.snapshotIdentity,
	};
	return { request, route, descriptor, launcherIdentity };
}

describe("broker async executor", () => {
	it("rejects identity drift before launch and reconciles failure", async () => {
		const value = fixture();
		let launches = 0;
		let terminals = 0;
		const result = await executeBrokerRoute({
			request: value.request,
			route: value.route,
			invocationDescriptor: value.descriptor,
			launcherIdentity: { ...value.launcherIdentity, model: "drifted" },
			launch: async () => {
				launches += 1;
			},
			terminal: async () => {
				terminals += 1;
			},
		});
		strictEqual(launches, 0);
		strictEqual(terminals, 1);
		strictEqual(result.reason, "identity_drift");
	});

	it("emits progress and reconciles success once", async () => {
		const value = fixture();
		const events = [];
		const terminals = [];
		const result = await executeBrokerRoute({
			request: value.request,
			route: value.route,
			invocationDescriptor: value.descriptor,
			launcherIdentity: value.launcherIdentity,
			onStatus: (event) => events.push(event),
			launch: async ({ onStatus }) => {
				onStatus({ stage: "working", elapsedMs: 5 });
				return { success: true, actualConsumption: 1 };
			},
			terminal: async (terminal) => {
				terminals.push(terminal);
				return { changed: true };
			},
		});
		strictEqual(result.success, true);
		deepStrictEqual(terminals, [{ outcome: "success", actualConsumption: 1 }]);
		deepStrictEqual(
			events.map(({ event }) => event),
			[
				"execution_waiting",
				"execution_started",
				"execution_progress",
				"terminal_reconciling",
				"execution_succeeded",
			],
		);
	});

	it("reconciles failure and cancellation exactly once", async () => {
		for (const scenario of ["failure", "cancel"]) {
			const value = fixture();
			const terminals = [];
			const controller = new AbortController();
			if (scenario === "cancel") controller.abort();
			const result = await executeBrokerRoute({
				request: value.request,
				route: value.route,
				invocationDescriptor: value.descriptor,
				launcherIdentity: value.launcherIdentity,
				signal: controller.signal,
				launch: async () => {
					throw new Error("provider failed");
				},
				terminal: async (terminal) => {
					terminals.push(terminal);
					return { changed: true };
				},
			});
			strictEqual(result.outcome, scenario);
			strictEqual(terminals.length, 1);
			strictEqual(terminals[0].outcome, scenario);
		}
	});

	it("preserves bounded timeout metadata from the launcher", async () => {
		const value = fixture();
		const result = await executeBrokerRoute({
			request: value.request,
			route: value.route,
			invocationDescriptor: value.descriptor,
			launcherIdentity: value.launcherIdentity,
			launch: async () => ({
				success: false,
				timedOut: true,
				cleanupFailed: true,
			}),
			terminal: async () => ({ changed: true }),
		});
		strictEqual(result.reason, "provider execution timed out");
		strictEqual(result.timedOut, true);
		strictEqual(result.cleanupFailed, true);
	});

	it("retains safe structured diagnostics without exposing launcher output", async () => {
		const value = fixture();
		let terminals = 0;
		const result = await executeBrokerRoute({
			request: value.request,
			route: value.route,
			invocationDescriptor: value.descriptor,
			launcherIdentity: value.launcherIdentity,
			onStatus: () => {
				throw new Error("status sink failed");
			},
			launch: async () => ({
				success: false,
				reason: "SECRET_CANARY_raw provider stdout must not escape",
				errorKind: "execution_failed",
				diagnosticCode: "cli_usage_error",
				exitCode: 2,
				failurePhase: "provider_execution",
			}),
			terminal: async () => {
				terminals += 1;
				return { changed: true };
			},
		});
		strictEqual(terminals, 1);
		strictEqual(result.reason, "launcher_failed");
		strictEqual(result.errorKind, "execution_failed");
		strictEqual(result.diagnosticCode, "cli_usage_error");
		strictEqual(result.exitCode, 2);
		strictEqual(result.failurePhase, "provider_execution");
		strictEqual(JSON.stringify(result).includes("SECRET_CANARY"), false);
	});

	// Regression: the frozen return shapes above are allowlists, so a field the
	// launcher sets and nothing here names is dropped in silence. That is what
	// happened to servedModelVerified — every production dispatch goes through
	// this boundary, so the adapter's served-model read-back reached a result
	// only in the synchronous test path and never in a real run.
	it("carries the launcher's served-model verification across both terminal shapes", async () => {
		for (const verified of [true, false]) {
			const value = fixture();
			const success = await executeBrokerRoute({
				request: value.request,
				route: value.route,
				invocationDescriptor: value.descriptor,
				launcherIdentity: value.launcherIdentity,
				launch: async () => ({
					success: true,
					actualConsumption: 1,
					servedModelVerified: verified,
				}),
				terminal: async () => ({ changed: true }),
			});
			strictEqual(success.servedModelVerified, verified);

			const failed = await executeBrokerRoute({
				request: value.request,
				route: value.route,
				invocationDescriptor: value.descriptor,
				launcherIdentity: value.launcherIdentity,
				launch: async () => ({
					success: false,
					errorKind: "execution_failed",
					servedModelVerified: verified,
				}),
				terminal: async () => ({ changed: true }),
			});
			strictEqual(failed.servedModelVerified, verified);
		}
	});

	it("reports a null verification for a launcher that cannot read one back", async () => {
		const value = fixture();
		const result = await executeBrokerRoute({
			request: value.request,
			route: value.route,
			invocationDescriptor: value.descriptor,
			launcherIdentity: value.launcherIdentity,
			launch: async () => ({ success: true, actualConsumption: 1 }),
			terminal: async () => ({ changed: true }),
		});
		strictEqual(result.servedModelVerified, null);
	});
	// The two regressions above were the same defect twice: a field the runner
	// reads off the broker's result, that nothing in the frozen shapes named.
	// Rather than pin one field at a time, derive the read set from the runner
	// itself, so a field added there fails here until the executor forwards it.
	it("forwards every broker field the runner reads off the result", async () => {
		const runnerSource = readFileSync(
			fileURLToPath(
				new URL("../src/switchyard/runner/index.mjs", import.meta.url),
			),
			"utf8",
		);
		const readFields = new Set(
			Array.from(
				runnerSource.matchAll(/brokerExecution\.([A-Za-z_][A-Za-z0-9_]*)/g),
				(match) => match[1],
			),
		);
		ok(
			readFields.size > 0,
			"the runner must read fields off the broker result",
		);

		// Every launcher field the executor is expected to relay, set to a value
		// its own bounding accepts so a dropped field cannot pass as a defaulted one.
		const launcherResult = {
			success: false,
			timedOut: true,
			cleanupFailed: true,
			cleanupStage: "tree_terminated",
			reason: "provider execution timed out",
			errorKind: "execution_timed_out",
			diagnosticCode: "execution_timed_out",
			exitCode: 7,
			signal: "SIGKILL",
			failurePhase: "provider_cleanup",
			failureKind: "provider",
			servedModelVerified: true,
		};
		const value = fixture();
		const failed = await executeBrokerRoute({
			request: value.request,
			route: value.route,
			invocationDescriptor: value.descriptor,
			launcherIdentity: value.launcherIdentity,
			launch: async () => launcherResult,
			terminal: async () => ({ changed: true }),
		});
		const missing = [...readFields].filter(
			(field) => !Object.hasOwn(failed, field),
		);
		deepStrictEqual(
			missing,
			[],
			`the executor's failure shape drops fields the runner reads: ${missing.join(", ")}`,
		);
		strictEqual(failed.cleanupStage, "tree_terminated");
		strictEqual(failed.cleanupFailed, true);

		// A task can succeed while the kill of its provider process fails, so
		// the cleanup facts have to survive the success shape too.
		const succeeded = await executeBrokerRoute({
			request: value.request,
			route: value.route,
			invocationDescriptor: value.descriptor,
			launcherIdentity: value.launcherIdentity,
			launch: async () => ({
				success: true,
				actualConsumption: 1,
				cleanupFailed: true,
				cleanupStage: "pid_marker_removed",
				servedModelVerified: false,
			}),
			terminal: async () => ({ changed: true }),
		});
		strictEqual(succeeded.cleanupFailed, true);
		strictEqual(succeeded.cleanupStage, "pid_marker_removed");
		strictEqual(succeeded.servedModelVerified, false);
	});

	it("refuses a cleanup stage outside the backend-owned vocabulary", async () => {
		const value = fixture();
		const result = await executeBrokerRoute({
			request: value.request,
			route: value.route,
			invocationDescriptor: value.descriptor,
			launcherIdentity: value.launcherIdentity,
			launch: async () => ({
				success: true,
				actualConsumption: 1,
				cleanupStage: "rm -rf /etc/passwd",
			}),
			terminal: async () => ({ changed: true }),
		});
		strictEqual(result.cleanupStage, null);
	});
});
