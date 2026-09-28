import { ok, strictEqual } from "node:assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import {
	__resetRosterCacheForTests,
	getImplementorPriority,
	PROVIDER_CAPABILITIES,
	passesCapabilityFilter,
} from "../src/switchyard/roster/index.mjs";
import {
	evaluateCandidateEligibility,
	preflightMacosQueue,
	route,
	routeBlind,
} from "../src/switchyard/router/index.mjs";
import {
	FIXTURE_PATH,
	HEALTH_ROOT,
	HEALTH_RUN_ROOT,
	previousRosterPath,
	previousRunStoreRoot,
	ROUTER_ROSTER_PATH,
	SNAPSHOT_PATH,
	withDispatchQualifiedDescriptors,
} from "./helpers/router-fixtures.mjs";

before(() => {
	rmSync(HEALTH_ROOT, { recursive: true, force: true });
	rmSync(HEALTH_RUN_ROOT, { recursive: true, force: true });
	process.env.SWITCHYARD_RUN_STORE_ROOT = HEALTH_RUN_ROOT;
	process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = SNAPSHOT_PATH;
	writeFileSync(
		ROUTER_ROSTER_PATH,
		JSON.stringify(
			withDispatchQualifiedDescriptors(
				JSON.parse(readFileSync(FIXTURE_PATH, "utf8")),
			),
		),
		"utf8",
	);
	process.env.SWITCHYARD_ROSTER_PATH = ROUTER_ROSTER_PATH;
	__resetRosterCacheForTests();
});

after(() => {
	delete process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;
	if (previousRosterPath === undefined) {
		delete process.env.SWITCHYARD_ROSTER_PATH;
	} else {
		process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
	}
	__resetRosterCacheForTests();
	try {
		rmSync(SNAPSHOT_PATH, { force: true });
		rmSync(ROUTER_ROSTER_PATH, { force: true });
		rmSync(HEALTH_ROOT, { recursive: true, force: true });
		rmSync(HEALTH_RUN_ROOT, { recursive: true, force: true });
		if (previousRunStoreRoot === undefined)
			delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRunStoreRoot;
	} catch {
		// Ignore
	}
});

describe("route-health selection gate", () => {
	function snapshotRead() {
		return {
			snapshot: {
				schema_version: 2,
				updated_at: new Date().toISOString(),
				providers: [
					{
						name: "codex",
						ok: true,
						windows: [{ percent_left: 80, pace_delta: 1 }],
					},
				],
			},
			snapshotStatus: "fresh",
			snapshotMtime: 1,
			snapshotAgeMsAtRoute: 0,
		};
	}

	it("records shadow decisions but changes no ordinary routing path", () => {
		const decisions = [];
		const healthDecision = () => ({
			available: true,
			state: "repair-hold",
			mode: "shadow",
			suppress: false,
		});
		strictEqual(
			route({
				requiredCapability: "standard",
				snapshotRead: snapshotRead(),
				healthDecision,
				onHealthDecision: (decision) => decisions.push(decision),
			}).provider,
			"codex",
		);
		strictEqual(decisions[0].state, "repair-hold");
		strictEqual(
			routeBlind(["codex"], [], "standard", { healthDecision }).provider,
			"codex",
		);
	});

	it("subtracts a held route identically from preflight, ranked, and blind selection", () => {
		const healthDecision = () => ({
			available: true,
			state: "repair-hold",
			mode: "enforce",
			suppress: true,
		});
		strictEqual(
			route({
				requiredCapability: "standard",
				snapshotRead: snapshotRead(),
				healthDecision,
			}).provider,
			null,
		);
		strictEqual(
			routeBlind(["codex"], [], "standard", { healthDecision }).provider,
			null,
		);
		const result = preflightMacosQueue({
			tasks: [{ id: "4.2", status: "pending", requiredCapability: "standard" }],
			goldenImageVerifiedProviders: ["codex"],
			readSnapshot: snapshotRead,
			healthDecision,
		});
		strictEqual(result.ok, false);
		strictEqual(
			result.capabilityResults[0].excludedReasons.codex,
			"route_health_suppressed",
		);
	});

	it("does not allow unavailable health storage to suppress or create a trial", () => {
		const healthDecision = () => ({
			available: false,
			state: "health-unavailable",
			mode: "enforce",
			suppress: false,
		});
		strictEqual(
			route({
				requiredCapability: "standard",
				snapshotRead: snapshotRead(),
				healthDecision,
			}).provider,
			"codex",
		);
	});
});

describe("Task 2.1 shared candidate eligibility", () => {
	it("applies one policy table across preflight, observed routing, and blind routing", () => {
		const cases = [
			{
				label: "qualified exact codex target",
				name: "codex",
				policy: {
					platform: "macos",
					goldenImageVerifiedProviders: ["codex"],
				},
				observed: "eligible",
				unknown: "eligible",
			},
			{
				label: "below required capability",
				name: "OpenCode Go",
				availableProviders: ["opencode"],
				policy: {
					platform: "macos",
					requiredCapability: "high",
					goldenImageVerifiedProviders: ["opencode-go"],
				},
				observed: "below_required_capability",
				unknown: "below_required_capability",
			},
			{
				label: "explicit exclusion",
				name: "codex",
				policy: { platform: "macos", exclude: ["codex"] },
				observed: "explicitly_excluded",
				unknown: "explicitly_excluded",
			},
			{
				label: "only allowlist",
				name: "codex",
				policy: { platform: "macos", only: ["claude"] },
				observed: "not_in_only_allowlist",
				unknown: "not_in_only_allowlist",
			},
			{
				label: "direct routing does not inherit the macOS gate",
				name: "claude",
				policy: {
					platform: "direct",
					goldenImageVerifiedProviders: [],
				},
				observed: "eligible",
				unknown: "eligible",
			},
			{
				label: "unknown usage does not invent quota exhaustion",
				name: "codex",
				percentLeft: 0,
				policy: {
					platform: "macos",
					goldenImageVerifiedProviders: ["codex"],
				},
				observed: "no_quota_headroom",
				unknown: "eligible",
			},
		];

		for (const fixture of cases) {
			const provider = {
				name: fixture.name,
				ok: true,
				windows: [{ percent_left: fixture.percentLeft ?? 80, pace_delta: 1 }],
			};
			const policy = {
				requiredCapability: "standard",
				availableProviders: fixture.availableProviders ?? [fixture.name],
				...fixture.policy,
			};
			const snapshotRead = {
				snapshot: {
					schema_version: 2,
					updated_at: new Date().toISOString(),
					providers: [provider],
				},
				snapshotStatus: "fresh",
				snapshotMtime: 1,
				snapshotAgeMsAtRoute: 0,
			};
			const observed = evaluateCandidateEligibility(fixture.name, provider, {
				...policy,
				usageMode: "observed",
			});
			const unknown = evaluateCandidateEligibility(fixture.name, null, {
				...policy,
				usageMode: "unknown",
			});
			strictEqual(
				observed.reason,
				fixture.observed,
				`${fixture.label}: observed`,
			);
			strictEqual(unknown.reason, fixture.unknown, `${fixture.label}: unknown`);
			strictEqual(
				route({ ...policy, snapshotRead }).provider !== null,
				observed.eligible,
				`${fixture.label}: runtime`,
			);
			strictEqual(
				routeBlind(
					[fixture.name],
					policy.exclude,
					policy.requiredCapability,
					policy,
				).provider !== null,
				unknown.eligible,
				`${fixture.label}: blind`,
			);
			if (policy.platform === "macos") {
				const preflight = preflightMacosQueue({
					...policy,
					tasks: [
						{
							status: "pending",
							requiredCapability: policy.requiredCapability,
						},
					],
					readSnapshot: () => snapshotRead,
				});
				strictEqual(
					preflight.capabilityResults[0].eligible,
					observed.eligible,
					`${fixture.label}: preflight verdict`,
				);
				if (!observed.eligible) {
					strictEqual(
						preflight.capabilityResults[0].excludedReasons[fixture.name],
						observed.reason,
						`${fixture.label}: preflight reason`,
					);
				}
			}
		}
	});

	it("keeps macOS preflight, observed routing, and blind routing inside the same qualified set", () => {
		const claude = {
			name: "claude",
			ok: true,
			windows: [{ percent_left: 80, pace_delta: 1 }],
		};
		const policy = {
			requiredCapability: "standard",
			platform: "macos",
			availableProviders: ["claude"],
			goldenImageVerifiedProviders: ["codex"],
		};
		const snapshotRead = {
			snapshot: {
				schema_version: 2,
				updated_at: new Date().toISOString(),
				providers: [claude],
			},
			snapshotStatus: "fresh",
			snapshotMtime: 1,
			snapshotAgeMsAtRoute: 0,
		};
		strictEqual(
			evaluateCandidateEligibility(claude.name, claude, policy).reason,
			"not_golden_image_verified",
		);
		const preflight = preflightMacosQueue({
			tasks: [{ status: "pending", requiredCapability: "standard" }],
			availableProviders: ["claude"],
			goldenImageVerifiedProviders: ["codex"],
			readSnapshot: () => snapshotRead,
		});
		strictEqual(
			preflight.capabilityResults[0].excludedReasons.claude,
			"not_golden_image_verified",
		);
		const observed = route({
			...policy,
			snapshotRead,
		});
		strictEqual(observed.provider, null);
		strictEqual(routeBlind(["claude"], [], "standard", policy).provider, null);
	});

	it("does not treat missing usage evidence as quota exhaustion in blind mode", () => {
		const policy = {
			requiredCapability: "standard",
			platform: "macos",
			availableProviders: ["codex"],
			goldenImageVerifiedProviders: ["codex"],
		};
		strictEqual(
			evaluateCandidateEligibility("codex", null, {
				...policy,
				usageMode: "unknown",
			}).eligible,
			true,
		);
		strictEqual(
			evaluateCandidateEligibility("codex", null, {
				...policy,
				usageMode: "observed",
			}).reason,
			"provider_unavailable",
		);
	});
});

describe("router (INV-4: blind fallback still respects funding/eligibility)", () => {
	it("keeps tier 1 ahead of later tiers during blind fallback", () => {
		const result = routeBlind(
			["claude", "codex", "cursor", "agy"],
			[],
			"standard",
		);
		strictEqual(result.provider, "agy");
	});

	it("handles a missing snapshot gracefully, picking the first capability-eligible roster harness", () => {
		// A missing/broken snapshot must not silently halt every task behind
		// it -- route() wires the blind fallback into the real path. The
		// expected winner is derived here from the SAME roster-backed exports
		// route() itself uses (PROVIDER_CAPABILITIES + passesCapabilityFilter),
		// not a hardcoded provider name -- so this test tracks the roster's
		// actual declared order/eligibility instead of asserting a literal
		// that only happens to match today's fixture.
		try {
			rmSync(SNAPSHOT_PATH);
		} catch {
			// Ignore
		}

		const result = route();
		strictEqual(result.reason, "blind_fallback");

		const expectedOrder = Object.keys(PROVIDER_CAPABILITIES)
			.filter((name) => passesCapabilityFilter(name, "standard"))
			.toSorted((left, right) => {
				const priority = (name) => getImplementorPriority(name) ?? 4;
				return priority(left) - priority(right);
			});
		ok(
			expectedOrder.length > 0,
			"fixture must have at least one high-capable harness for this test to mean anything",
		);
		strictEqual(
			result.provider,
			expectedOrder[0],
			"blind fallback must honor implementor tiers before legacy roster order",
		);
	});

	it("restricts blind-mode candidates to the caller's availableProviders", () => {
		try {
			rmSync(SNAPSHOT_PATH);
		} catch {
			// Ignore
		}

		const result = route({ availableProviders: ["codex"] });
		strictEqual(result.reason, "blind_fallback");
		strictEqual(result.provider, "codex");
	});

	it("blind fallback (unit-level) falls back to the first non-excluded candidate", () => {
		const result = routeBlind(["claude", "codex"], ["claude"]);
		strictEqual(
			result.provider,
			"codex",
			"Should fall back to first non-excluded",
		);
	});

	it("routeBlind excludes case-insensitively too (regression, mirrors the route() fix above)", () => {
		const result = routeBlind(["Claude", "Codex"], ["claude"]);
		strictEqual(
			result.provider,
			"Codex",
			"excluding lowercase 'claude' must exclude candidate 'Claude'",
		);
	});

	it("routeBlind skips fixture-disabled Vibe even when explicitly ordered", () => {
		const result = routeBlind(["vibe", "claude"]);
		strictEqual(result.provider, "claude");
		strictEqual(result.reason, "blind_fallback");
	});
});
