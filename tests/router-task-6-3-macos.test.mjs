import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createSnapshotCoordinator } from "../src/switchyard/broker/snapshots.mjs";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import { preflightMacosQueue, route } from "../src/switchyard/router/index.mjs";
import {
	buildDualCodexRoster,
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

describe("Task 6.3 macOS provider-eligibility preflight", () => {
	function snapshotFor(...providers) {
		return {
			schema_version: 2,
			updated_at: new Date().toISOString(),
			providers,
		};
	}

	function freshSnapshotReader(snapshot, calls) {
		return () => {
			calls.push("snapshot");
			return {
				snapshot,
				snapshotStatus: "fresh",
				snapshotMtime: 1,
				snapshotAgeMsAtRoute: 0,
			};
		};
	}

	// F6: preflight used to admit a stale or future snapshot that the broker
	// would refuse moments later, after the queue had already paid for workspace
	// create/provision/seed. Both now decide on one shared rule, so the two
	// cannot disagree about any generation.
	describe("snapshot admission parity with the broker", () => {
		const fundedSnapshot = () =>
			snapshotFor({
				name: "codex",
				ok: true,
				windows: [{ percent_left: 80, pace_delta: 1 }],
			});

		async function brokerAdmits(read) {
			const coordinator = createSnapshotCoordinator({ read });
			try {
				await coordinator.prepare("gradus-v2");
				return true;
			} catch {
				return false;
			}
		}

		function preflightAdmits(snapshotStatus, snapshot = fundedSnapshot()) {
			const result = preflightMacosQueue({
				tasks: [{ id: "t", status: "pending", requiredCapability: "standard" }],
				goldenImageVerifiedProviders: ["codex"],
				readSnapshot: () => ({
					snapshot,
					snapshotStatus,
					snapshotMtime: 1,
					snapshotAgeMsAtRoute: 0,
				}),
			});
			return result;
		}

		// Each case pairs the normalized status preflight sees with a raw
		// `updated_at` the broker's own normalizer classifies the same way, so
		// neither side is told the answer.
		const cases = [
			{ status: "fresh", updatedAtMs: 0, admitted: true },
			{ status: "stale", updatedAtMs: -10 * 60 * 1000, admitted: false },
			{ status: "future", updatedAtMs: 60 * 1000, admitted: false },
		];

		for (const { status, updatedAtMs, admitted } of cases) {
			it(`admits a ${status} snapshot on both sides: ${admitted}`, async () => {
				const preflight = preflightAdmits(status);
				strictEqual(preflight.eligible, admitted);
				// Assert the cause, not just the verdict: before the shared rule,
				// a stale or future snapshot that reached the eligibility loop
				// could be refused for an unrelated quota reason, which would make
				// a bare `eligible === false` assertion prove nothing.
				if (!admitted) {
					strictEqual(preflight.rejection.reason, `routing_snapshot_${status}`);
				}
				strictEqual(
					await brokerAdmits(({ nowMs }) => ({
						snapshot: {
							schema_version: 2,
							updated_at: new Date(nowMs + updatedAtMs).toISOString(),
							providers: [
								{
									name: "codex",
									ok: true,
									windows: [{ percent_left: 80, pace_delta: 1 }],
								},
							],
						},
						snapshotMtime: 1,
					})),
					admitted,
				);
			});
		}

		it("names why a refused snapshot was refused", () => {
			strictEqual(
				preflightAdmits("stale").rejection.reason,
				"routing_snapshot_stale",
			);
			strictEqual(
				preflightAdmits("future").rejection.reason,
				"routing_snapshot_future",
			);
			strictEqual(
				preflightAdmits("malformed").rejection.reason,
				"routing_snapshot_unavailable",
			);
			strictEqual(
				preflightAdmits("fresh", null).rejection.reason,
				"routing_snapshot_unavailable",
			);
		});

		it("refuses before anything is allocated", () => {
			// preflight is a pure decision; the proof that nothing was allocated
			// is that it refuses without the queue ever being entered. The runner
			// turns !ok into QueuePreflightError before backend bootstrap.
			const result = preflightAdmits("stale");
			strictEqual(result.ok, false);
			strictEqual(result.reason, "provider_eligibility_preflight_failed");
			deepStrictEqual(result.capabilityResults, []);
		});
	});

	it("reads one snapshot for all tiers and counts blocked tasks as non-terminal", () => {
		const reads = [];
		const result = preflightMacosQueue({
			tasks: [
				{
					id: "pending-standard",
					status: "pending",
					requiredCapability: "standard",
				},
				{ id: "blocked-high", status: "blocked", requiredCapability: "high" },
				{ id: "done-high", status: "done", requiredCapability: "high" },
			],
			goldenImageVerifiedProviders: ["codex"],
			readSnapshot: freshSnapshotReader(
				snapshotFor({
					name: "codex",
					ok: true,
					windows: [{ percent_left: 80, pace_delta: 1 }],
				}),
				reads,
			),
		});

		strictEqual(reads.length, 1);
		deepStrictEqual(result.checkedCapabilities, ["standard", "high"]);
		strictEqual(result.eligible, true);
		deepStrictEqual(result.rejections, []);
	});

	it("rejects an unsatisfiable blocked tier with its capability and excluded provider", () => {
		const result = preflightMacosQueue({
			tasks: [
				{ id: "blocked-high", status: "blocked", requiredCapability: "high" },
			],
			goldenImageVerifiedProviders: ["opencode"],
			readSnapshot: freshSnapshotReader(
				snapshotFor({
					name: "OpenCode Go",
					ok: true,
					windows: [{ percent_left: 80, pace_delta: 1 }],
				}),
				[],
			),
		});

		strictEqual(result.eligible, false);
		deepStrictEqual(result.rejection, {
			capability: "high",
			excludedProviders: ["OpenCode Go"],
			excludedReasons: { "OpenCode Go": "below_required_capability" },
			reason: "no_golden_image_verified_provider_with_quota_headroom",
		});
		strictEqual(
			result.capabilityResults[0].excludedReasons["OpenCode Go"],
			"below_required_capability",
		);
	});

	it("carries a provider's closed invocation-descriptor reason into its rejection", () => {
		const rosterPath = join(
			tmpdir(),
			`switchyard-preflight-no-descriptor-${process.pid}-${randomUUID()}.json`,
		);
		const previousPath = process.env.SWITCHYARD_ROSTER_PATH;
		try {
			writeFileSync(rosterPath, readFileSync(FIXTURE_PATH, "utf8"), "utf8");
			process.env.SWITCHYARD_ROSTER_PATH = rosterPath;
			__resetRosterCacheForTests();
			const result = preflightMacosQueue({
				tasks: [
					{ id: "pending-high", status: "pending", requiredCapability: "high" },
				],
				goldenImageVerifiedProviders: ["claude"],
				readSnapshot: freshSnapshotReader(
					snapshotFor({
						name: "claude",
						ok: true,
						windows: [{ percent_left: 80, pace_delta: 1 }],
					}),
					[],
				),
			});

			strictEqual(
				result.rejection.excludedReasons.claude,
				"qualification_missing",
			);
		} finally {
			if (previousPath === undefined) delete process.env.SWITCHYARD_ROSTER_PATH;
			else process.env.SWITCHYARD_ROSTER_PATH = previousPath;
			__resetRosterCacheForTests();
			rmSync(rosterPath, { force: true });
		}
	});

	it("rejects one unsatisfiable tier even when another tier is eligible", () => {
		const reads = [];
		const result = preflightMacosQueue({
			tasks: [
				{
					id: "pending-standard",
					status: "pending",
					requiredCapability: "standard",
				},
				{ id: "pending-high", status: "pending", requiredCapability: "high" },
			],
			goldenImageVerifiedProviders: ["agy"],
			readSnapshot: freshSnapshotReader(
				snapshotFor({
					name: "agy",
					ok: true,
					windows: [{ percent_left: 80, pace_delta: 1 }],
				}),
				reads,
			),
		});

		strictEqual(reads.length, 1);
		deepStrictEqual(result.checkedCapabilities, ["standard", "high"]);
		strictEqual(result.eligible, false);
		strictEqual(result.capabilityResults[0].eligible, true);
		strictEqual(result.capabilityResults[1].eligible, false);
		deepStrictEqual(result.rejections, [
			{
				capability: "high",
				excludedProviders: ["agy"],
				excludedReasons: { agy: "below_required_capability" },
				reason: "no_golden_image_verified_provider_with_quota_headroom",
			},
		]);
	});

	it("fails closed when only/exclude/availableProviders leave no eligible provider", () => {
		const calls = [];
		const result = preflightMacosQueue({
			tasks: [
				{ id: "standard", status: "pending", requiredCapability: "standard" },
			],
			only: ["codex"],
			exclude: ["claude"],
			availableProviders: ["claude"],
			readSnapshot: freshSnapshotReader(
				snapshotFor(
					{
						name: "codex",
						ok: true,
						windows: [{ percent_left: 80, pace_delta: 1 }],
					},
					{
						name: "claude",
						ok: true,
						windows: [{ percent_left: 80, pace_delta: 1 }],
					},
				),
				calls,
			),
		});

		strictEqual(calls.length, 1);
		strictEqual(result.eligible, false);
		strictEqual(result.rejection.capability, "standard");
		deepStrictEqual(result.rejection.excludedProviders, ["claude", "codex"]);
		strictEqual(
			result.rejection.reason,
			"no_golden_image_verified_provider_with_quota_headroom",
		);
	});

	it("fails closed on a non-macos platform without reading the snapshot", () => {
		// macOS/Parallels is the sole execution backend now; there is no
		// alternate platform lane with its own preflight no-op. An
		// unrecognized platform value must fail closed rather than read
		// routing state that was never scoped to it.
		let reads = 0;
		const result = preflightMacosQueue({
			platform: "docker",
			tasks: [{ status: "pending", requiredCapability: "high" }],
			readSnapshot: () => {
				reads += 1;
				throw new Error(
					"preflight for a non-macos platform must not read the macOS snapshot",
				);
			},
		});

		strictEqual(reads, 0);
		strictEqual(result.eligible, false);
		strictEqual(result.ok, false);
		strictEqual(result.reason, "invalid_platform");
	});

	it("allows a terminal-only macOS queue without snapshot or manifest evidence", () => {
		const result = preflightMacosQueue({
			tasks: [{ status: "done", requiredCapability: "high" }],
			readSnapshot: () => {
				throw new Error("terminal-only queues must not read routing state");
			},
		});

		strictEqual(result.eligible, true);
		strictEqual(result.reason, "no_non_terminal_tasks");
	});

	it("refuses an ambiguous provider selector on the same terms route() does", () => {
		// The queue-level go/no-go has to agree with the dispatches it admits.
		// route() refuses an ambiguous selector with `ambiguous_target`; before
		// the preflight guard existed, the same selector fell through to the
		// per-capability loop here and came back as a per-provider
		// `not_in_only_allowlist` -- preflight reporting "no eligible provider
		// for this tier" for a queue route() would refuse to route at all.
		//
		// "CODEX" is ambiguous for the same reason as in the route() test at the
		// bottom of this file: it matches no exact target id (case-sensitive) and
		// the harness tie-break sees two enabled codex targets.
		const rosterPath = join(
			tmpdir(),
			`switchyard-preflight-ambiguous-${process.pid}-${randomUUID()}.json`,
		);
		const previousPath = process.env.SWITCHYARD_ROSTER_PATH;
		const tasks = [
			{ id: "pending-low", status: "pending", requiredCapability: "low" },
		];
		const tarProvisionRegistry = {
			verified: true,
			providers: ["codex", "codex-spark"],
		};
		try {
			writeFileSync(
				rosterPath,
				JSON.stringify(
					buildDualCodexRoster({ incumbentSnapshotName: "Codex" }),
				),
				"utf8",
			);
			process.env.SWITCHYARD_ROSTER_PATH = rosterPath;
			__resetRosterCacheForTests();
			const snapshot = snapshotFor(
				{ name: "Codex", ok: true, windows: [{ percent_left: 40 }] },
				{ name: "Codex (Spark)", ok: true, windows: [{ percent_left: 95 }] },
			);

			// Control: the exact target id resolves, so an unambiguous selector
			// over this same roster and snapshot passes preflight. Without this, a
			// false `eligible` below could be an ineligible fixture rather than
			// the guard.
			const exact = preflightMacosQueue({
				tasks,
				only: ["codex"],
				tarProvisionRegistry,
				readSnapshot: freshSnapshotReader(snapshot, []),
			});
			strictEqual(exact.eligible, true);

			// The guard sits above the snapshot read and above the task scan, so
			// an ambiguous selector is refused without touching routing state.
			const throwingReader = () => {
				throw new Error("an ambiguous selector must not read routing state");
			};
			const ambiguous = preflightMacosQueue({
				tasks,
				only: ["CODEX"],
				tarProvisionRegistry,
				readSnapshot: throwingReader,
			});
			strictEqual(ambiguous.ok, false);
			strictEqual(ambiguous.eligible, false);
			strictEqual(ambiguous.reason, "ambiguous_target");
			strictEqual(ambiguous.rejection.selector, "CODEX");
			strictEqual(ambiguous.rejection.capability, null);
			ok(
				ambiguous.log.some((line) => line.includes("use an exact target id")),
				`expected an actionable hint, got: ${JSON.stringify(ambiguous.log)}`,
			);

			// ...and route() agrees, which is the property the guard exists for.
			strictEqual(
				route({ requiredCapability: "low", only: ["CODEX"] }).reason,
				"ambiguous_target",
			);

			// An exclude-side selector is refused identically: route() pools both
			// lists into one ambiguity check and so must this.
			strictEqual(
				preflightMacosQueue({
					tasks,
					exclude: ["CODEX"],
					tarProvisionRegistry,
					readSnapshot: throwingReader,
				}).reason,
				"ambiguous_target",
			);

			// Placement assertion: a queue with nothing left to run still fails
			// closed. Below the task scan the guard would never run here, and
			// preflight would return `no_non_terminal_tasks` for a selector that
			// cannot be routed -- the last case where the two could disagree.
			const terminalOnly = preflightMacosQueue({
				tasks: [{ id: "done-low", status: "done", requiredCapability: "low" }],
				only: ["CODEX"],
				tarProvisionRegistry,
				readSnapshot: throwingReader,
			});
			strictEqual(terminalOnly.ok, false);
			strictEqual(terminalOnly.reason, "ambiguous_target");
		} finally {
			if (previousPath === undefined) delete process.env.SWITCHYARD_ROSTER_PATH;
			else process.env.SWITCHYARD_ROSTER_PATH = previousPath;
			__resetRosterCacheForTests();
			rmSync(rosterPath, { force: true });
		}
	});

	it("does not gate native or human tasks on provider eligibility", () => {
		const result = preflightMacosQueue({
			tasks: [
				{ status: "pending", executor: "native", requiredCapability: "high" },
				{
					status: "blocked",
					executor: "human",
					requiredCapability: "standard",
				},
			],
			readSnapshot: () => {
				throw new Error("non-switchyard tasks must not read routing state");
			},
		});

		strictEqual(result.eligible, true);
		strictEqual(result.reason, "no_non_terminal_tasks");
	});
});
