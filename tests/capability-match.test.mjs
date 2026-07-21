// INV-5 gate test: capability filter + model right-sizing
// Tests: high-tier task never yields under-capable provider, model matches tier

import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	CAPABILITY_CLASS,
	filterByCapability,
	getCapabilityClass,
	getModelForTier,
	getRightSizedModel,
	PROVIDER_CAPABILITIES,
	passesCapabilityFilter,
	TIER_ORDER,
} from "../src/switchyard/roster/index.mjs";

describe("capability match", () => {
	it("should define capability classes", () => {
		strictEqual(CAPABILITY_CLASS.high, "high");
		strictEqual(CAPABILITY_CLASS.standard, "standard");
		strictEqual(CAPABILITY_CLASS.low, "low");
	});

	it("should define tier ordering", () => {
		strictEqual(TIER_ORDER.high, 3);
		strictEqual(TIER_ORDER.standard, 2);
		strictEqual(TIER_ORDER.low, 1);
	});

	it("should have provider capabilities defined", () => {
		strictEqual(
			PROVIDER_CAPABILITIES.claude.capability_class,
			CAPABILITY_CLASS.high,
		);
		strictEqual(
			PROVIDER_CAPABILITIES.codex.capability_class,
			CAPABILITY_CLASS.high,
		);
		strictEqual(
			PROVIDER_CAPABILITIES.agy.capability_class,
			CAPABILITY_CLASS.standard,
		);
		strictEqual(
			PROVIDER_CAPABILITIES.vibe.capability_class,
			CAPABILITY_CLASS.low,
		);
	});

	it("should get capability class for provider", () => {
		strictEqual(getCapabilityClass("claude"), CAPABILITY_CLASS.high);
		strictEqual(getCapabilityClass("codex"), CAPABILITY_CLASS.high);
		strictEqual(getCapabilityClass("vibe"), CAPABILITY_CLASS.low);
		strictEqual(getCapabilityClass("unknown"), null);
	});

	it("should get model for provider and tier", () => {
		strictEqual(getModelForTier("claude", "high"), "claude-opus-4-8");
		strictEqual(getModelForTier("claude", "standard"), "claude-sonnet-5");
		strictEqual(getModelForTier("claude", "low"), "claude-haiku");
	});

	it("should get right-sized model", () => {
		strictEqual(getRightSizedModel("claude", "high"), "claude-opus-4-8");
		strictEqual(getRightSizedModel("codex", "standard"), "gpt-5.6-terra");
	});

	it("should pass capability filter for sufficient providers", () => {
		// High-tier task should pass for claude (high capability)
		strictEqual(passesCapabilityFilter("claude", "high"), true);
		strictEqual(passesCapabilityFilter("codex", "high"), true);

		// Standard-tier task should pass for claude and agy
		strictEqual(passesCapabilityFilter("claude", "standard"), true);
		strictEqual(passesCapabilityFilter("agy", "standard"), true);

		// Low-tier task should pass for all
		strictEqual(passesCapabilityFilter("claude", "low"), true);
		strictEqual(passesCapabilityFilter("vibe", "low"), true);
	});

	it("should fail capability filter for insufficient providers", () => {
		// High-tier task should NOT pass for vibe (low capability)
		strictEqual(passesCapabilityFilter("vibe", "high"), false);
		strictEqual(passesCapabilityFilter("vibe", "standard"), false);

		// Standard-tier task should NOT pass for vibe
		strictEqual(passesCapabilityFilter("vibe", "standard"), false);
	});

	it("should filter providers by capability", () => {
		const allProviders = ["claude", "codex", "agy", "cursor", "vibe"];

		// High-tier: only claude and codex have high capability
		const highTierProviders = filterByCapability(allProviders, "high");
		strictEqual(highTierProviders.sort().join(","), "claude,codex");

		// Standard-tier: claude, codex, agy, cursor
		const standardTierProviders = filterByCapability(allProviders, "standard");
		strictEqual(
			standardTierProviders.sort().join(","),
			"agy,claude,codex,cursor",
		);

		// Low-tier: all providers
		const lowTierProviders = filterByCapability(allProviders, "low");
		strictEqual(
			lowTierProviders.sort().join(","),
			allProviders.sort().join(","),
		);
	});
});
