import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	createExecutionBackend,
	hostBackendDefaults,
	resolveExecutionBackendKind,
} from "../src/switchyard/lifecycle/backend-selection.mjs";

function withEnv(overrides, fn) {
	const saved = new Map();
	for (const [key, value] of Object.entries(overrides)) {
		saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

describe("execution backend selection", () => {
	it("resolves the macOS substrate until a second one is qualified", () => {
		strictEqual(resolveExecutionBackendKind(), "macos");
	});

	it("reads host options from the environment", () => {
		withEnv(
			{
				SWITCHYARD_PARALLELS_GOLDEN_IMAGE: "golden",
				SWITCHYARD_PARALLELS_AQUA_UID: "501",
				SWITCHYARD_PARALLELS_PROVIDER_USER: "someone",
			},
			() => {
				const defaults = hostBackendDefaults();
				strictEqual(defaults.goldenImage, "golden");
				strictEqual(defaults.aquaUid, "501");
				strictEqual(defaults.providerUser, "someone");
			},
		);
	});

	it("lets an explicit value win over the environment", () => {
		withEnv({ SWITCHYARD_PARALLELS_GOLDEN_IMAGE: "golden" }, () => {
			strictEqual(
				hostBackendDefaults({ goldenImage: "supplied" }).goldenImage,
				"supplied",
			);
		});
	});

	it("falls back to the switchyard provider user, not to undefined", () => {
		// The queue names guest paths off this value, so an absent environment
		// must not produce "/Users/undefined".
		withEnv({ SWITCHYARD_PARALLELS_PROVIDER_USER: undefined }, () => {
			strictEqual(hostBackendDefaults().providerUser, "switchyard");
		});
	});

	it("builds a backend that satisfies the execution seam", () => {
		const backend = createExecutionBackend({ execFn: () => "" });
		for (const method of [
			"preflight",
			"create",
			"execArgv",
			"pushTar",
			"pullTar",
			"destroy",
			"listManaged",
			"inspectProcess",
			"execGuest",
		]) {
			strictEqual(
				typeof backend[method],
				"function",
				`backend is missing ${method}`,
			);
		}
	});
});
