import { strictEqual, throws } from "node:assert";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	__resetRosterCacheForTests,
	getCapabilityClass,
	getConfiguredInvocationDescriptor,
	getInvocationDescriptor,
	getInvocationDescriptorIdentity,
	getRightSizedModel,
	passesCapabilityFilter,
	validateInvocationDescriptor,
} from "../src/switchyard/roster/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures", "roster.fixture.json");
let tmpDir;
const previousEnv = {};
function setRosterPath(value) {
	if (!("SWITCHYARD_ROSTER_PATH" in previousEnv)) {
		previousEnv.SWITCHYARD_ROSTER_PATH = process.env.SWITCHYARD_ROSTER_PATH;
	}
	if (value === undefined) {
		delete process.env.SWITCHYARD_ROSTER_PATH;
	} else {
		process.env.SWITCHYARD_ROSTER_PATH = value;
	}
	__resetRosterCacheForTests();
}
afterEach(() => {
	if ("SWITCHYARD_ROSTER_PATH" in previousEnv) {
		if (previousEnv.SWITCHYARD_ROSTER_PATH === undefined) {
			delete process.env.SWITCHYARD_ROSTER_PATH;
		} else {
			process.env.SWITCHYARD_ROSTER_PATH = previousEnv.SWITCHYARD_ROSTER_PATH;
		}
		delete previousEnv.SWITCHYARD_ROSTER_PATH;
	}
	if ("HOME" in previousEnv) {
		if (previousEnv.HOME === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousEnv.HOME;
		}
		delete previousEnv.HOME;
	}
	__resetRosterCacheForTests();
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
});
describe("roster loader — a retired catalog model never counts toward the ceiling", () => {
	it("a 'qualified' slot referencing a retired model is excluded, even though nothing else disqualifies it", () => {
		// autoRoutingCeiling/resolveSlotModel both gate on
		// `modelEntry?.status !== "active"` before ever consulting
		// qualifications. The committed fixture's one retired model
		// ("fixture/retired-model") is never referenced by any target slot, so
		// that filter is exercised only incidentally (never on a slot that would
		// otherwise qualify) by the rest of the suite. This proves it directly:
		// an enabled target, a fully-qualified slot, whose only problem is that
		// its catalog model has status "retired" — must still resolve to no
		// capability.
		tmpDir = tempDir("switchyard-roster-loader-");
		const path = join(tmpDir, "retired-slot.json");
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					"fixture/claude-retired": {
						selector: "fixture-claude-retired",
						status: "retired",
					},
				},
				targets: {
					"claude-code": {
						harness: "claude",
						enabled: true,
						qualifications: {
							"fixture-claude-retired": { status: "qualified" },
						},
						slots: {
							high: [{ model_ref: "fixture/claude-retired", priority: 1 }],
						},
					},
				},
			}),
			"utf8",
		);
		setRosterPath(path);
		strictEqual(getCapabilityClass("claude"), null);
		strictEqual(passesCapabilityFilter("claude", "high"), false);
		strictEqual(getRightSizedModel("claude", "high"), null);
	});
});
describe("roster loader — invocation descriptor identity", () => {
	function writeInvocationArgsRoster(path, invocation_args) {
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					"openai/fixture": { selector: "fixture-codex", status: "active" },
				},
				targets: {
					codex: {
						harness: "codex",
						enabled: true,
						slots: {
							high: [{ model_ref: "openai/fixture", invocation_args }],
						},
					},
				},
			}),
			"utf8",
		);
	}

	it("freezes every descriptor field and changes identity when argv changes", () => {
		const descriptor = validateInvocationDescriptor(
			{
				target_id: "codex",
				model_ref: "openai/gpt-5.6-sol",
				selector: "gpt-5.6-sol",
				effort: "xhigh",
				invocation_args: ["-c", "model_reasoning_effort=xhigh"],
			},
			"codex",
		);
		strictEqual(Object.isFrozen(descriptor), true);
		strictEqual(Object.isFrozen(descriptor.invocation_args), true);
		strictEqual(
			descriptor.descriptor_identity,
			getInvocationDescriptorIdentity(descriptor, "codex"),
		);
		strictEqual(
			getInvocationDescriptorIdentity(
				{
					...descriptor,
					effort: "high",
					invocation_args: ["-c", "model_reasoning_effort=high"],
				},
				"codex",
			) === descriptor.descriptor_identity,
			false,
		);
	});

	it("requires an explicit target-bound harness and never lets argv choose it", () => {
		const descriptor = {
			target_id: "claude",
			model_ref: "anthropic/fixture",
			selector: "fixture-claude",
			effort: "xhigh",
			invocation_args: ["-c", "model_reasoning_effort=xhigh"],
		};
		throws(
			() => validateInvocationDescriptor(descriptor, "claude"),
			/must be|claude invocation_args/,
		);
		throws(
			() => getInvocationDescriptorIdentity(descriptor, "claude"),
			/must be|claude invocation_args/,
		);
		throws(
			() => getInvocationDescriptorIdentity(descriptor),
			/harness is required/,
		);
	});

	it("binds descriptor identity to the canonical harness", () => {
		const core = {
			target_id: "antigravity",
			model_ref: "google/fixture",
			selector: "fixture-gemini",
			effort: null,
			variant: null,
			invocation_args: [],
		};
		const agyIdentity = getInvocationDescriptorIdentity(core, "Antigravity");
		const claudeIdentity = getInvocationDescriptorIdentity(core, "Claude");
		strictEqual(agyIdentity === claudeIdentity, false);

		const agyReceipt = validateInvocationDescriptor(
			{ ...core, descriptor_identity: agyIdentity },
			"agy",
		);
		throws(
			() => validateInvocationDescriptor(agyReceipt, "claude"),
			/descriptor_identity|invocation descriptor argv/,
		);
	});

	it("selector-only qualification remains readable but cannot authorize a descriptor", () => {
		tmpDir = tempDir("switchyard-roster-descriptor-");
		const path = join(tmpDir, "legacy-qualification.json");
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					"openai/fixture": { selector: "fixture-codex", status: "active" },
				},
				targets: {
					codex: {
						harness: "codex",
						enabled: true,
						qualifications: { "fixture-codex": { status: "qualified" } },
						slots: { high: [{ model_ref: "openai/fixture", priority: 1 }] },
					},
				},
			}),
			"utf8",
		);
		setRosterPath(path);
		strictEqual(getRightSizedModel("codex", "high"), "fixture-codex");
		strictEqual(getInvocationDescriptor("codex", "high"), null);
		strictEqual(
			getConfiguredInvocationDescriptor("codex", "high")?.selector,
			"fixture-codex",
		);
	});

	it("authorizes only the exact descriptor identity", () => {
		tmpDir = tempDir("switchyard-roster-descriptor-");
		const path = join(tmpDir, "exact-qualification.json");
		const descriptor = {
			target_id: "codex",
			model_ref: "openai/fixture",
			selector: "fixture-codex",
			effort: "xhigh",
			invocation_args: ["-c", "model_reasoning_effort=xhigh"],
		};
		const identity = getInvocationDescriptorIdentity(descriptor, "codex");
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					"openai/fixture": { selector: "fixture-codex", status: "active" },
				},
				targets: {
					codex: {
						harness: "codex",
						enabled: true,
						qualifications: {
							[identity]: {
								status: "dispatch_qualified",
								selector: descriptor.selector,
								descriptor_identity: identity,
								tested_at: new Date().toISOString(),
							},
						},
						slots: {
							high: [
								{
									model_ref: descriptor.model_ref,
									priority: 1,
									effort: descriptor.effort,
									invocation_args: descriptor.invocation_args,
								},
							],
						},
					},
				},
			}),
			"utf8",
		);
		setRosterPath(path);
		const resolved = getInvocationDescriptor("codex", "high");
		strictEqual(resolved?.descriptor_identity, identity);
		strictEqual(Object.isFrozen(resolved), true);
	});

	it("does not authorize qualifications whose descriptor identity changes", () => {
		tmpDir = tempDir("switchyard-roster-descriptor-");
		const path = join(tmpDir, "mismatch.json");
		const base = {
			target_id: "codex",
			model_ref: "openai/fixture",
			selector: "fixture-codex",
			effort: "xhigh",
			invocation_args: ["-c", "model_reasoning_effort=xhigh"],
		};
		const variants = [
			["target_id", { ...base, target_id: "codex-alt" }],
			["model_ref", { ...base, model_ref: "openai/other" }],
			["selector", { ...base, selector: "fixture-other" }],
			[
				"effort",
				{
					...base,
					effort: "high",
					invocation_args: ["-c", "model_reasoning_effort=high"],
				},
			],
			[
				"variant",
				{
					...base,
					effort: null,
					variant: "high",
					invocation_args: ["--variant", "high"],
				},
			],
			[
				"argv",
				{
					...base,
					effort: "high",
					invocation_args: ["-c", "model_reasoning_effort=high"],
				},
			],
		];
		for (const [field, variant] of variants) {
			const identity = getInvocationDescriptorIdentity(
				variant,
				variant.variant !== undefined ? "opencode" : "codex",
			);
			writeFileSync(
				path,
				JSON.stringify({
					schema_version: 1,
					models: {
						"openai/fixture": { selector: "fixture-codex", status: "active" },
					},
					targets: {
						codex: {
							harness: "codex",
							enabled: true,
							qualifications: { [identity]: { status: "qualified" } },
							slots: {
								high: [
									{
										model_ref: base.model_ref,
										effort: base.effort,
										invocation_args: base.invocation_args,
									},
								],
							},
						},
					},
				}),
				"utf8",
			);
			setRosterPath(path);
			strictEqual(getInvocationDescriptor("codex", "high"), null, field);
		}
	});

	it("rejects unapproved invocation flags, values, and positions at roster load", () => {
		tmpDir = tempDir("switchyard-roster-descriptor-");
		const path = join(tmpDir, "unsafe-invocation.json");
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					"openai/fixture": { selector: "fixture-codex", status: "active" },
				},
				targets: {
					codex: {
						harness: "codex",
						enabled: true,
						slots: {
							high: [
								{
									model_ref: "openai/fixture",
									invocation_args: ["--dangerously-bypass", "yes"],
								},
							],
						},
					},
				},
			}),
			"utf8",
		);
		setRosterPath(path);
		throws(
			() => getRightSizedModel("codex", "high"),
			/invocation_args invalid/,
		);
		const descriptor = {
			target_id: "codex",
			model_ref: "openai/fixture",
			selector: "fixture-codex",
			effort: "xhigh",
		};
		for (const invocation_args of [
			["--dangerously-bypass", "yes"],
			["-c", "model_reasoning_effort=turbo"],
			["model_reasoning_effort=xhigh", "-c"],
		]) {
			throws(
				() =>
					getInvocationDescriptorIdentity(
						{
							...descriptor,
							invocation_args,
						},
						"codex",
					),
				/invalid|unapproved|must be/,
			);
		}
	});

	it("rejects an approved invocation flag with a bad value at roster load", () => {
		tmpDir = tempDir("switchyard-roster-descriptor-");
		const path = join(tmpDir, "bad-value.json");
		writeInvocationArgsRoster(path, ["-c", "model_reasoning_effort=turbo"]);
		setRosterPath(path);
		throws(
			() => getRightSizedModel("codex", "high"),
			/invocation_args invalid/,
		);
	});

	it("rejects a correctly-shaped invocation pair in reversed positions at roster load", () => {
		tmpDir = tempDir("switchyard-roster-descriptor-");
		const path = join(tmpDir, "reversed-pair.json");
		writeInvocationArgsRoster(path, ["model_reasoning_effort=xhigh", "-c"]);
		setRosterPath(path);
		throws(
			() => getRightSizedModel("codex", "high"),
			/invocation_args invalid/,
		);
	});
});
