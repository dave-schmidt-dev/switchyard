import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
	createBroker,
	selectBrokerRoute,
} from "../src/switchyard/broker/index.mjs";
import {
	BROKER_CONTRACT_VERSION,
	validateBrokerRequest,
	validateBrokerResult,
} from "../src/switchyard/broker/schema.mjs";

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
	});

	it("passes only real caller-available adapters to the router seam", () => {
		let options;
		const result = selectBrokerRoute(
			request(),
			dependencies({
				route(value) {
					options = value;
					return dependencies().route();
				},
			}),
		);
		deepStrictEqual(options.availableProviders, ["codex"]);
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
});
