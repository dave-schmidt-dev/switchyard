import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
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

	it("ignores a broken status sink and never exposes launcher output", async () => {
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
				reason: "raw provider stdout must not escape",
			}),
			terminal: async () => {
				terminals += 1;
				return { changed: true };
			},
		});
		strictEqual(terminals, 1);
		strictEqual(result.reason, "launcher_failed");
	});
});
