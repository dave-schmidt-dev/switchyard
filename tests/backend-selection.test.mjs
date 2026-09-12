import { strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
	createExecutionBackend,
	hostBackendDefaults,
	resolveExecutionBackendKind,
} from "../src/switchyard/lifecycle/backend-selection.mjs";
import { ExecutionBackend } from "../src/switchyard/lifecycle/execution-backend.mjs";

const SEAM_METHODS = [
	"preflight",
	"create",
	"execArgv",
	"pushTar",
	"pullTar",
	"destroy",
	"listManaged",
	"inspectProcess",
	"execGuest",
	"guestHomePath",
];

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

	it("builds a backend that implements every seam method itself", () => {
		// `typeof backend[method] === "function"` would pass for a subclass that
		// implements nothing, because the base class declares each method as an
		// abstract that throws. Identity against the prototype is what proves the
		// backend actually overrides it.
		const backend = createExecutionBackend({ execFn: () => "" });
		for (const method of SEAM_METHODS) {
			strictEqual(
				backend[method] === ExecutionBackend.prototype[method],
				false,
				`backend does not implement ${method}`,
			);
		}
	});

	it("declares the substrate it runs on, where the base class declares none", () => {
		// Adapters read `kind` to refuse a guest whose credential lookup has not
		// been measured, so a backend that leaves it undeclared is treated as
		// macOS -- the built backend has to say so itself.
		strictEqual(createExecutionBackend({ execFn: () => "" }).kind, "macos");
		strictEqual(new (class extends ExecutionBackend {})().kind, null);
	});

	it("fails at the seam when a backend omits execGuest", () => {
		// The declaration is the whole point of the change: without it, every
		// adapter's `try { execGuest(...) } catch { return false }` reports each
		// provider as unauthenticated instead of surfacing a missing method.
		class Incomplete extends ExecutionBackend {}
		throws(
			() => new Incomplete().execGuest("workspace", ["true"]),
			/ExecutionBackend\.execGuest\(\) must be implemented/,
		);
	});
});
