import { deepStrictEqual, rejects, strictEqual, throws } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createBroker,
	selectBrokerRoute,
} from "../src/switchyard/broker/index.mjs";
import { createExecutionOutcome } from "../src/switchyard/broker/outcome.mjs";
import {
	BROKER_CONTRACT_VERSION,
	validateBrokerExecutionOutcome,
	validateBrokerRequest,
	validateBrokerResult,
} from "../src/switchyard/broker/schema.mjs";
import {
	acquireRunLock,
	activateOutcomeWriter,
	appendOutcomeEvent,
	initializeRun,
	readEvents,
	recoverExecutionOutcome,
	releaseRunLock,
} from "../src/switchyard/run-store/index.mjs";
import { prepareOutcomeWriter } from "../src/switchyard/runner/index.mjs";

function request(overrides = {}) {
	return {
		schemaVersion: BROKER_CONTRACT_VERSION,
		capability: "standard",
		dataClass: "repository",
		estimatedConsumption: 2,
		runId: "run-1",
		taskId: "TASK-001",
		snapshotSource: "gradus-v2",
		availableAdapters: ["codex"],
		...overrides,
	};
}

function dependencies(overrides = {}) {
	return {
		adapters: { codex: { execute() {} } },
		route: () => ({
			provider: "Codex",
			model: "codex-standard",
			resolvedTargetId: "codex",
			reason: "spread",
			snapshotStatus: "fresh",
			snapshotMtime: 123,
			snapshotAgeMsAtRoute: 10,
		}),
		resolveTargetIdentity: () => ({
			targetId: "codex",
			harnessKey: "codex",
			ambiguous: false,
		}),
		getInvocationDescriptor: () => ({
			target_id: "codex",
			selector: "codex-standard",
			effort: "high",
			variant: null,
		}),
		...overrides,
	};
}

describe("broker contract", () => {
	it("accepts only ordinary approved-repository content", () => {
		strictEqual(validateBrokerRequest(request()).dataClass, "repository");
		for (const dataClass of [
			"restricted",
			"unknown",
			"personal",
			["repository", "restricted"],
		]) {
			throws(() => validateBrokerRequest(request({ dataClass })), /dataClass/);
		}
	});

	it("rejects missing, malformed, and unknown request fields", () => {
		throws(() => validateBrokerRequest({}), /schemaVersion/);
		throws(
			() => validateBrokerRequest(request({ capability: "extreme" })),
			/capability/,
		);
		throws(
			() => validateBrokerRequest({ ...request(), surprise: true }),
			/unknown field/,
		);
		throws(
			() =>
				validateBrokerRequest({
					...request(),
					goldenImageVerifiedProviders: ["claude"],
				}),
			/unknown field/,
		);
	});

	it("passes only real caller-available adapters to the router seam", () => {
		let options;
		const result = selectBrokerRoute(
			request(),
			dependencies({
				platform: "macos",
				goldenImageVerifiedProviders: ["codex"],
				route(value) {
					options = value;
					return dependencies().route();
				},
			}),
		);
		deepStrictEqual(options.availableProviders, ["codex"]);
		strictEqual(options.platform, "macos");
		deepStrictEqual(options.goldenImageVerifiedProviders, ["codex"]);
		strictEqual(result.harness, "codex");
		strictEqual(result.effort, "high");
	});

	it("rejects caller adapters absent from the injected registry", () => {
		throws(
			() =>
				createBroker(dependencies()).select(
					request({ availableAdapters: ["claude"] }),
				),
			/unavailable/,
		);
	});

	it("rejects route, roster, and descriptor identity disagreement", () => {
		throws(
			() =>
				createBroker(
					dependencies({
						getInvocationDescriptor: () => ({
							target_id: "other",
							selector: "codex-standard",
						}),
					}),
				).select(request()),
			/disagree/,
		);
	});

	it("validates both routed and no-route result envelopes", () => {
		const routed = createBroker(dependencies()).select(request());
		deepStrictEqual(validateBrokerResult(routed), routed);
		const none = createBroker(
			dependencies({
				route: () => ({ provider: null, reason: "no_eligible" }),
			}),
		).select(request());
		strictEqual(none.provider, null);
		throws(
			() => validateBrokerResult({ ...routed, extra: true }),
			/unknown field/,
		);
	});

	it("keeps producer and consumer on the same closed outcome schema", () => {
		const selected = createBroker(dependencies()).select(request());
		const produced = createExecutionOutcome({
			request: request(),
			route: {
				...selected,
				reservation: {
					id: "reservation-1",
					provider: selected.provider,
					runId: selected.runId,
					taskId: selected.taskId,
					amount: 1,
				},
			},
			writerEpoch: "epoch-1",
		});
		strictEqual(validateBrokerExecutionOutcome(produced), produced);
		throws(
			() =>
				validateBrokerExecutionOutcome({
					...produced,
					detail: { prompt: "secret" },
				}),
			/closed|forbidden/,
		);
	});

	it("fences the active writer and recovers a missing execution outcome", async () => {
		const root = await mkdtemp(join(tmpdir(), "switchyard-outcome-contract-"));
		const previousRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = root;
		const runId = "outcome-fencing-1";
		try {
			await initializeRun({
				runId,
				tasksFilePath: "/tmp/tasks.md",
				projectPath: "/tmp/project",
				orderedTaskIds: ["TASK-001"],
				initialHostFingerprint: "test",
				workerNonce: "nonce-1",
			});
			await acquireRunLock(runId, 401, "start-1", "nonce-1");
			await rejects(
				prepareOutcomeWriter(runId, { enableTypedOutcomes: true }),
				(error) => error.code === "OUTCOME_WRITER_LEASE_STALE",
			);
			await releaseRunLock(runId);
			await acquireRunLock(runId, process.pid, "start-1", "nonce-1");
			const siblingRunId = "outcome-fencing-sibling";
			await initializeRun({
				runId: siblingRunId,
				tasksFilePath: "/tmp/tasks.md",
				projectPath: "/tmp/project",
				orderedTaskIds: ["TASK-002"],
				initialHostFingerprint: "test",
				workerNonce: "nonce-sibling",
			});
			await acquireRunLock(
				siblingRunId,
				process.pid,
				"start-sibling",
				"nonce-sibling",
			);
			await rejects(
				activateOutcomeWriter(runId, {
					pid: process.pid,
					startToken: "start-1",
					nonce: "nonce-1",
					writerEpoch: "epoch-1",
				}),
				(error) => error.code === "OUTCOME_WRITER_COMPATIBILITY_BLOCKED",
			);
			await releaseRunLock(siblingRunId);
			const active = await activateOutcomeWriter(runId, {
				pid: process.pid,
				startToken: "start-1",
				nonce: "nonce-1",
				writerEpoch: "epoch-1",
			});
			const requestValue = request({ runId });
			const route = {
				...createBroker(dependencies()).select(requestValue),
				reservation: {
					id: "reservation-fencing",
					provider: "Codex",
					runId,
					taskId: "TASK-001",
					amount: 1,
				},
			};
			const processFact = createExecutionOutcome({
				request: requestValue,
				route,
				writerEpoch: "epoch-1",
			});
			await appendOutcomeEvent(
				runId,
				{
					...processFact,
					stage: "provider",
					detail: { code: "process_completed", targetId: "codex" },
				},
				{
					writerEpoch: active.outcomeWriterEpoch,
					owner: {
						pid: process.pid,
						startToken: "start-1",
						nonce: "nonce-1",
					},
				},
			);
			await rejects(
				appendOutcomeEvent(runId, processFact, {
					writerEpoch: "epoch-1",
					owner: { pid: process.pid, startToken: "start-1", nonce: "stale" },
				}),
				(error) => error.code === "OUTCOME_WRITER_LEASE_STALE",
			);
			await rejects(
				appendOutcomeEvent(runId, processFact, {
					writerEpoch: "epoch-1",
					minimumReaderVersion: 0,
					owner: { pid: process.pid, startToken: "start-1", nonce: "nonce-1" },
				}),
				/reader capability is stale/,
			);
			await rejects(
				appendOutcomeEvent(runId, processFact, {
					writerEpoch: "epoch-old",
					owner: { pid: process.pid, startToken: "start-1", nonce: "nonce-1" },
				}),
				(error) => error.code === "OUTCOME_WRITER_LEASE_STALE",
			);
			await releaseRunLock(runId);
			await acquireRunLock(runId, process.pid, "start-2", "nonce-2");
			const resumed = await prepareOutcomeWriter(runId, {
				enableTypedOutcomes: true,
				outcomeWriterEpoch: "epoch-2",
			});
			strictEqual(
				await recoverExecutionOutcome(runId, {
					writerEpoch: resumed.writerEpoch,
					owner: resumed.owner,
				}),
				null,
			);
			const events = await readEvents(runId);
			strictEqual(events.length, 2);
			strictEqual(events[1].status, "uncertain");
			strictEqual(events[1].causedBy, events[0].outcomeId);
			strictEqual(events[1].detail.code, "execution_outcome_unavailable");
		} finally {
			if (previousRoot === undefined)
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRoot;
			await rm(root, { recursive: true, force: true });
		}
	});
});
