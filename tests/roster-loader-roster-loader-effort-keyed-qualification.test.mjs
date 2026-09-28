import { strictEqual } from "node:assert";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	__resetRosterCacheForTests,
	getCapabilityClass,
	getInvocationDescriptor,
	getInvocationDescriptorIdentity,
	getRightSizedModel,
	passesCapabilityFilter,
	QUALIFICATION_STATUS,
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
describe("roster loader — effort-keyed qualification variants (brief §4: 'qualification is keyed by invocation variant')", () => {
	// Live production pattern (~/.agent/roster.json, verified 2026-07-31):
	// claude-code's and codex's HIGH slots both carry a non-manual_only
	// `effort` field (e.g. "max"/"xhigh"), so their qualification is keyed
	// `${selector}@${effort}`, not the bare selector. The committed synthetic
	// fixture (tests/fixtures/roster.fixture.json) never happens to exercise
	// this: its only `effort`-carrying slot (cursor-pro's high slot) is also
	// `manual_only`, which short-circuits BEFORE qualificationVariantKey is
	// ever computed (see autoRoutingCeiling/resolveSlotModel in
	// src/switchyard/roster/index.mjs). So nothing anywhere proves the
	// composite key is actually used for a real, auto-routable slot — a
	// regression that dropped the `@effort` suffix (falling back to the bare
	// selector) would pass every existing test. These two cases close that
	// gap directly against a temp roster shaped like the live one.
	it("a qualification keyed 'selector@effort' gates a non-manual_only effort-carrying slot's ceiling", () => {
		tmpDir = tempDir("switchyard-roster-loader-");
		const path = join(tmpDir, "effort-variant-qualified.json");
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					"fixture/claude-high-effort": {
						selector: "fixture-claude-high-effort",
						status: "active",
					},
				},
				targets: {
					"claude-code": {
						harness: "claude",
						enabled: true,
						qualifications: {
							"fixture-claude-high-effort@xhigh": { status: "qualified" },
						},
						slots: {
							high: [
								{
									model_ref: "fixture/claude-high-effort",
									priority: 1,
									effort: "xhigh",
									invocation_args: ["--effort", "xhigh"],
								},
							],
						},
					},
				},
			}),
			"utf8",
		);
		setRosterPath(path);
		strictEqual(getCapabilityClass("claude"), "high");
		strictEqual(passesCapabilityFilter("claude", "high"), true);
		strictEqual(
			getRightSizedModel("claude", "high"),
			"fixture-claude-high-effort",
		);
	});

	it("control: a qualification keyed by the BARE selector does NOT satisfy an effort-carrying slot", () => {
		// Identical roster shape to the case above, except the qualification is
		// recorded under the bare selector instead of 'selector@effort'. If the
		// implementation ever fell back to matching on the bare selector, this
		// would incorrectly qualify — proving the composite key is load-bearing,
		// not merely present-but-unused.
		tmpDir = tempDir("switchyard-roster-loader-");
		const path = join(tmpDir, "effort-variant-bare-key.json");
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					"fixture/claude-high-effort": {
						selector: "fixture-claude-high-effort",
						status: "active",
					},
				},
				targets: {
					"claude-code": {
						harness: "claude",
						enabled: true,
						qualifications: {
							"fixture-claude-high-effort": { status: "qualified" }, // bare key, no @xhigh
						},
						slots: {
							high: [
								{
									model_ref: "fixture/claude-high-effort",
									priority: 1,
									effort: "xhigh",
								},
							],
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

	it("keeps same-selector OpenCode variants independently qualified", () => {
		tmpDir = tempDir("switchyard-roster-loader-");
		const path = join(tmpDir, "opencode-variant-qualification.json");
		const modelRef = "fixture/opencode-variant";
		const selector = "fixture-opencode-variant";
		const makeDescriptor = (variant) => ({
			target_id: "opencode-go",
			model_ref: modelRef,
			selector,
			effort: null,
			variant,
			invocation_args: ["--variant", variant],
		});
		const high = makeDescriptor("high");
		const max = makeDescriptor("max");
		const highIdentity = getInvocationDescriptorIdentity(high, "opencode");
		const maxIdentity = getInvocationDescriptorIdentity(max, "opencode");
		const qualification = (descriptor, identity) => ({
			status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
			descriptor_identity: identity,
			target_id: descriptor.target_id,
			model_ref: descriptor.model_ref,
			selector: descriptor.selector,
			effort: null,
			variant: descriptor.variant,
			invocation_args: descriptor.invocation_args,
			tested_at: new Date().toISOString(),
			credential_profile: "default",
		});
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					[modelRef]: { selector, status: "active" },
				},
				targets: {
					"opencode-go": {
						harness: "opencode",
						credential_profile: "default",
						enabled: true,
						slots: {
							low: [
								{
									model_ref: modelRef,
									priority: 1,
									variant: "high",
									invocation_args: ["--variant", "high"],
								},
							],
							standard: [
								{
									model_ref: modelRef,
									priority: 1,
									variant: "max",
									invocation_args: ["--variant", "max"],
								},
							],
							high: [],
						},
						qualifications: {
							[highIdentity]: qualification(high, highIdentity),
							[maxIdentity]: qualification(max, maxIdentity),
						},
					},
				},
			}),
			"utf8",
		);
		setRosterPath(path);
		strictEqual(getInvocationDescriptor("opencode-go", "low")?.variant, "high");
		strictEqual(
			getInvocationDescriptor("opencode-go", "standard")?.variant,
			"max",
		);
	});
});
