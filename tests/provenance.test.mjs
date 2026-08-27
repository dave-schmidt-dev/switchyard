// Task 1.6 (roster-unification plan), M7/M8: dispatch provenance.
//
// Every dispatch record carries six provenance fields — roster_schema_version,
// roster_sha256, resolved_target, resolved_harness, resolved_selector,
// resolved_credential_profile — so a ledger entry is self-describing: which
// roster (identity + version) routed it, and to which concrete
// target/harness/selector/credential profile. It also carries the resolved
// required capability. This suite proves:
//   1. computeRosterSha is a PURE function that EXCLUDES the mutable
//      qualifications block (PM-12/SR-4) but still reflects real catalog/target
//      changes — tested by comparing two in-memory objects, not by fighting the
//      loader cache (advisor guidance);
//   2. executeTask attaches all six fields to EVERY dispatch record, on both
//      the success and the unsupported_provider paths (no record can omit them);
//   3. the roster sha is stable across a simulated `roster smoke` write-back at
//      the loader level (flip a qualification -> same sha), and moves for a real
//      change (control);
//   4. recordDispatchToStore preserves the provenance fields for parity with the
//      default file ledger.

import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	describeExecError,
	sanitizeFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";
import {
	readLedger,
	readLedgerFromStore,
	recordDispatchToStore,
} from "../src/switchyard/ledger/index.mjs";
import {
	__resetRosterCacheForTests,
	computeRosterSha,
	getInvocationDescriptorIdentity,
	getRosterProvenance,
	resolveRouteProvenance,
	resolveTargetProvenance,
	validateInvocationDescriptor,
} from "../src/switchyard/roster/index.mjs";
import {
	executeTask,
	executeTaskWithOrchestrator,
	runQueue,
	runQueueWithOrchestrator,
} from "../src/switchyard/runner/index.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures", "roster.fixture.json");

const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
const previousHomeDir = process.env.HOME;
const previousLegacyLedgerPath = process.env.SWITCHYARD_LEDGER_PATH;
const previousRunStoreRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
let tmpDir;

function setRosterPath(value) {
	if (value === undefined) delete process.env.SWITCHYARD_ROSTER_PATH;
	else process.env.SWITCHYARD_ROSTER_PATH = value;
	__resetRosterCacheForTests();
}

function setHomeDir(value) {
	if (value === undefined) delete process.env.HOME;
	else process.env.HOME = value;
	__resetRosterCacheForTests();
}

before(() => {
	setRosterPath(FIXTURE_PATH);
});

afterEach(() => {
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
	setRosterPath(FIXTURE_PATH);
	setHomeDir(previousHomeDir);
});

after(() => {
	if (previousRosterPath === undefined)
		delete process.env.SWITCHYARD_ROSTER_PATH;
	else process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
	setHomeDir(previousHomeDir);
	__resetRosterCacheForTests();
});

const PROVENANCE_KEYS = [
	"roster_schema_version",
	"roster_sha256",
	"resolved_target",
	"resolved_harness",
	"resolved_selector",
	"resolved_credential_profile",
];

function makeContext({ provider, model, adapters }) {
	const dispatches = [];
	const targetId =
		provider === "OpenCode Go"
			? "opencode-go"
			: provider === "Claude"
				? "claude-code"
				: provider;
	const harness = provider === "OpenCode Go" ? "opencode" : "claude";
	const descriptor = syntheticDescriptor({ targetId, model, harness });
	return {
		context: {
			route: () => ({
				provider,
				model,
				resolvedTargetId: targetId,
				resolved_harness: harness,
				invocationDescriptor: descriptor,
				percentLeft: 50,
				reason: "spread",
				log: [],
			}),
			resolveDescriptor: () => descriptor,
			adapters: adapters ?? {},
			recordDispatch: (d) => dispatches.push(d),
			recordDispatchIntent: () => {},
			integrationGate: () => ({ success: true }),
			projectPath: "/tmp/does-not-matter",
			workingContainerName: "test-container",
			exclude: [],
		},
		dispatches,
	};
}

function syntheticDescriptor({ targetId, model, harness }) {
	const core = {
		target_id: targetId,
		model_ref: model,
		selector: model,
		effort: null,
		variant: null,
		invocation_args: [],
	};
	return validateInvocationDescriptor(
		{
			...core,
			descriptor_identity: getInvocationDescriptorIdentity(core, harness),
		},
		harness,
	);
}

const TASK = {
	id: "T-1",
	title: "trivial task",
	description: "trivial task",
	prompt: "do the thing",
	requiredCapability: "low",
	requiredCapabilityJustification: "The task is a bounded mechanical change.",
	requiredPaths: null,
};

describe("computeRosterSha — pure, excludes qualifications (PM-12/SR-4)", () => {
	// Two rosters identical except for the mutable qualifications block.
	const base = {
		schema_version: 1,
		models: { "p/m": { selector: "p-m", status: "active" } },
		targets: {
			t: {
				harness: "p",
				enabled: true,
				slots: { low: [{ model_ref: "p/m", priority: 1 }] },
				qualifications: { "p-m": { status: "untested" } },
			},
		},
	};

	it("returns the SAME hash when only qualifications differ (smoke write-back is invisible)", () => {
		const flipped = structuredClone(base);
		flipped.targets.t.qualifications["p-m"].status = "qualified";
		flipped.targets.t.qualifications["p-m"].last_smoke = "2026-07-31T00:00:00Z";
		strictEqual(computeRosterSha(base), computeRosterSha(flipped));
	});

	it("returns a DIFFERENT hash when a real (non-qualification) field changes", () => {
		const changed = structuredClone(base);
		changed.targets.t.slots.low[0].priority = 2; // a genuine routing change
		notStrictEqual(computeRosterSha(base), computeRosterSha(changed));
	});

	it("is order-independent over object keys (canonicalized) but not over arrays", () => {
		const reordered = {
			targets: base.targets,
			schema_version: 1,
			models: base.models,
		};
		strictEqual(computeRosterSha(base), computeRosterSha(reordered));
	});

	it("produces a 64-char hex sha256 string", () => {
		const sha = computeRosterSha(base);
		strictEqual(typeof sha, "string");
		ok(/^[0-9a-f]{64}$/.test(sha), `expected 64-char hex, got ${sha}`);
	});
});

describe("resolveTargetProvenance / resolveRouteProvenance — target resolution", () => {
	it("resolves the enabled target, harness, and tier-right-sized selector", () => {
		deepStrictEqual(resolveTargetProvenance("OpenCode Go", "low"), {
			resolved_target: "opencode-go",
			resolved_harness: "opencode",
			resolved_selector: "fixture/opencode-low",
			// credential_profile is carried as metadata (M1b) but never passed to
			// the adapter — the fixture's opencode-go target uses profile "go".
			resolved_credential_profile: "go",
		});
	});

	it("returns a null target/selector but the normalized harness for an unbacked provider", () => {
		deepStrictEqual(resolveTargetProvenance("Totally Unknown", "low"), {
			resolved_target: null,
			resolved_harness: "totally unknown",
			resolved_selector: null,
			resolved_credential_profile: null,
		});
	});

	it("resolveRouteProvenance returns all six fields with the roster identity", () => {
		const prov = resolveRouteProvenance("OpenCode Go", "low");
		strictEqual(prov.roster_schema_version, 1);
		ok(/^[0-9a-f]{64}$/.test(prov.roster_sha256));
		strictEqual(prov.resolved_target, "opencode-go");
		strictEqual(prov.resolved_harness, "opencode");
		strictEqual(prov.resolved_selector, "fixture/opencode-low");
	});

	it("resolves the ENABLED target when two targets share one harness (production shape: opencode-go/opencode-zen)", () => {
		// findTargetEntryForHarness's whole reason for existing: the real roster
		// has exactly this shape (opencode-go enabled, opencode-zen disabled, both
		// harness "opencode"), and its docstring cites that case directly. The
		// committed fixture never models two same-harness targets, so nothing
		// proves resolveTargetProvenance actually picks the enabled one rather
		// than, say, the first one found by object-key order (which would be
		// wrong if the disabled target happened to be declared first).
		tmpDir = mkdtempSync(join(tmpdir(), "switchyard-provenance-"));
		const path = join(tmpDir, "shared-harness.json");
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					"fixture/opencode-zen-low": {
						selector: "fixture-opencode-zen-low",
						status: "active",
					},
					"fixture/opencode-go-low": {
						selector: "fixture-opencode-go-low",
						status: "active",
					},
				},
				targets: {
					// Declared BEFORE the enabled target, so a naive "first match wins"
					// implementation would pick this one and fail the assertion below.
					"opencode-zen": {
						harness: "opencode",
						enabled: false,
						credential_profile: "zen",
						qualifications: {
							"fixture-opencode-zen-low": { status: "qualified" },
						},
						slots: {
							low: [{ model_ref: "fixture/opencode-zen-low", priority: 1 }],
						},
					},
					"opencode-go": {
						harness: "opencode",
						enabled: true,
						credential_profile: "go",
						qualifications: {
							"fixture-opencode-go-low": { status: "qualified" },
						},
						slots: {
							low: [{ model_ref: "fixture/opencode-go-low", priority: 1 }],
						},
					},
				},
			}),
			"utf8",
		);
		setRosterPath(path);

		deepStrictEqual(resolveTargetProvenance("OpenCode", "low"), {
			resolved_target: "opencode-go",
			resolved_harness: "opencode",
			resolved_selector: "fixture-opencode-go-low",
			resolved_credential_profile: "go",
		});
	});

	it("degrades every field to null (never throws) when the roster is unavailable", () => {
		// Task 4.1: with SWITCHYARD_ROSTER_PATH unset the loader now resolves
		// the canonical ~/.agent/roster.json default — which EXISTS on dev
		// machines, so unsetting alone no longer makes the roster unavailable.
		// Point HOME at an empty temp dir so the canonical default is guaranteed
		// missing, keeping this case hermetic and independent of the real roster.
		tmpDir = mkdtempSync(join(tmpdir(), "switchyard-provenance-"));
		setHomeDir(tmpDir);
		setRosterPath(undefined); // env unset -> canonical default is a missing file
		const prov = resolveRouteProvenance("OpenCode Go", "low");
		deepStrictEqual(prov, {
			roster_schema_version: null,
			roster_sha256: null,
			resolved_target: null,
			resolved_harness: null,
			resolved_selector: null,
			resolved_credential_profile: null,
		});
	});
});

describe("executeTask — every dispatch record carries all six provenance fields", () => {
	it("carries provenance on the SUCCESS path (opencode-go via its adapter)", () => {
		let executed = 0;
		const { context, dispatches } = makeContext({
			provider: "OpenCode Go",
			model: "fixture/opencode-low",
			adapters: {
				opencode: {
					execute: () => {
						executed += 1;
						return { success: true };
					},
					captureDiff: () => "",
				},
			},
		});

		const result = executeTask(TASK, context);
		strictEqual(executed, 1);
		strictEqual(result.result, "success_no_diff");

		strictEqual(dispatches.length, 1);
		const rec = dispatches[0];
		for (const key of PROVENANCE_KEYS) ok(key in rec, `record missing ${key}`);
		strictEqual(rec.requiredCapability, "low");
		strictEqual(result.requiredCapability, "low");
		strictEqual(rec.roster_schema_version, 1);
		ok(/^[0-9a-f]{64}$/.test(rec.roster_sha256));
		strictEqual(rec.resolved_target, "opencode-go");
		strictEqual(rec.resolved_harness, "opencode");
		// credential_profile metadata (M1b) is recorded on the dispatch, not
		// passed to the adapter.
		strictEqual(rec.resolved_credential_profile, "go");
	});

	it("carries provenance on the UNSUPPORTED_PROVIDER path too (no record can omit it)", () => {
		// Claude normalizes to harness "claude" but no adapter is registered ->
		// unsupported_provider. The record must still carry provenance.
		const { context, dispatches } = makeContext({
			provider: "Claude",
			model: "fixture-claude-high",
			adapters: {},
		});

		const result = executeTask(TASK, context);
		strictEqual(result.result, "unsupported_provider");

		const rec = dispatches[0];
		for (const key of PROVENANCE_KEYS) ok(key in rec, `record missing ${key}`);
		strictEqual(rec.resolved_target, "claude-code");
		strictEqual(rec.resolved_harness, "claude");
		// claude-code is qualified at every tier, so the selector is a real claude
		// selector regardless of the classified tier.
		ok(
			typeof rec.resolved_selector === "string" &&
				rec.resolved_selector.startsWith("fixture-claude-"),
			`expected a claude selector, got ${rec.resolved_selector}`,
		);
	});

	it("attaches the six fields onto routeResult itself", () => {
		// Hold a reference to the exact object route() returns; executeTask does
		// Object.assign(routeResult, provenance) on it, so after the call the
		// provenance must be visible on this same object.
		const routeResultObj = {
			provider: "OpenCode Go",
			model: "fixture/opencode-low",
			resolvedTargetId: "opencode-go",
			resolved_harness: "opencode",
			invocationDescriptor: syntheticDescriptor({
				targetId: "opencode-go",
				model: "fixture/opencode-low",
				harness: "opencode",
			}),
			percentLeft: 50,
			reason: "spread",
			log: [],
		};
		const context = {
			route: () => routeResultObj,
			adapters: {
				opencode: {
					execute: () => ({ success: true }),
					captureDiff: () => "",
				},
			},
			recordDispatch: () => {},
			integrationGate: () => ({ success: true }),
			projectPath: "/tmp/x",
			workingContainerName: "c",
			exclude: [],
		};
		context.resolveDescriptor = () => routeResultObj.invocationDescriptor;
		executeTask(TASK, context);
		for (const key of PROVENANCE_KEYS) {
			ok(key in routeResultObj, `routeResult missing ${key}`);
		}
		strictEqual(routeResultObj.resolved_target, "opencode-go");
		strictEqual(routeResultObj.resolved_harness, "opencode");
		strictEqual(routeResultObj.resolved_credential_profile, "go");
		strictEqual(routeResultObj.requiredCapability, "low");
	});
});

function makeOrchestratorContext({
	provider,
	model,
	orchestratorOverrides = {},
}) {
	const dispatches = [];
	const targetId =
		provider === "OpenCode Go"
			? "opencode-go"
			: provider === "Claude"
				? "claude-code"
				: provider;
	const harness = provider === "OpenCode Go" ? "opencode" : "claude";
	const descriptor = syntheticDescriptor({ targetId, model, harness });
	return {
		context: {
			route: () => ({
				provider,
				model,
				resolvedTargetId: targetId,
				resolved_harness: harness,
				invocationDescriptor: descriptor,
				percentLeft: 50,
				reason: "spread",
				log: [],
			}),
			resolveDescriptor: () => descriptor,
			recordDispatch: (d) => dispatches.push(d),
			recordDispatchIntent: () => {},
			integrationGate: () => ({ success: true }),
			projectPath: "/tmp/does-not-matter",
			workingContainerName: "test-container",
			exclude: [],
			orchestrator: {
				launch: async () => "job-1",
				status: async () => ({ state: "done" }),
				result: async () => ({ success: true, diff: "" }),
				...orchestratorOverrides,
			},
		},
		dispatches,
	};
}

function restoreLedgerPaths() {
	if (previousLegacyLedgerPath === undefined)
		delete process.env.SWITCHYARD_LEDGER_PATH;
	else process.env.SWITCHYARD_LEDGER_PATH = previousLegacyLedgerPath;
	if (previousRunStoreRoot === undefined)
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRunStoreRoot;
}

function makeDefaultWiringFixture(taskId) {
	tmpDir = mkdtempSync(join(tmpdir(), "switchyard-ledger-wiring-"));
	const tasksFilePath = join(tmpDir, `${taskId}.md`);
	writeFileSync(
		tasksFilePath,
		"### Task 1.1: Default ledger wiring\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **RequiredCapability:** low\n- **RequiredCapabilityJustification:** The review is a bounded mechanical check.\n- **Description:** write matching ledger records\n",
		"utf8",
	);

	const legacyLedgerPath = join(tmpDir, "legacy-dispatch-ledger.jsonl");
	const storeRoot = join(tmpDir, "run-store");
	process.env.SWITCHYARD_LEDGER_PATH = legacyLedgerPath;
	process.env.SWITCHYARD_RUN_STORE_ROOT = storeRoot;

	return {
		taskId: "1.1",
		tasksFilePath,
		checkpointPath: join(tmpDir, `${taskId}.checkpoint.json`),
		legacyLedgerPath,
		storeRoot,
	};
}

function defaultRoute() {
	const descriptor = syntheticDescriptor({
		targetId: "opencode-go",
		model: "fixture/opencode-low",
		harness: "opencode",
	});
	return {
		provider: "OpenCode Go",
		model: "fixture/opencode-low",
		resolvedTargetId: "opencode-go",
		resolved_harness: "opencode",
		invocationDescriptor: descriptor,
		percentLeft: 50,
		reason: "spread",
		log: [],
	};
}

// This describe block proves ledger dual-write/legacy-projection/outcome-
// projection behavior, not real macOS provider admission — so its fixtures
// stub out queuePreflight via the dependency-injection seam runner/index.mjs
// documents as "(tests only)" (see createQueueBackend's
// dependencies.queuePreflight), rather than needing their synthetic
// opencode-go route to satisfy the real GOLDEN_IMAGE_VERIFIED_PROVIDERS
// allowlist.
const NOOP_QUEUE_PREFLIGHT = () => ({ ok: true, eligible: true });

function defaultSyncDependencies(overrides = {}) {
	return {
		route: defaultRoute,
		resolveDescriptor: () =>
			syntheticDescriptor({
				targetId: "opencode-go",
				model: "fixture/opencode-low",
				harness: "opencode",
			}),
		adapters: {
			opencode: {
				execute: () => ({ success: true }),
				captureDiff: () => "",
			},
		},
		recordDispatchIntent: () => {},
		queuePreflight: NOOP_QUEUE_PREFLIGHT,
		...overrides,
	};
}

function defaultOrchestratorDependencies(overrides = {}) {
	return {
		route: defaultRoute,
		resolveDescriptor: () =>
			syntheticDescriptor({
				targetId: "opencode-go",
				model: "fixture/opencode-low",
				harness: "opencode",
			}),
		adapters: { opencode: {} },
		orchestrator: {
			launch: async () => "job-default-ledger",
			status: async () => ({ state: "done" }),
			result: async () => ({ success: true, diff: "" }),
		},
		recordDispatchIntent: () => {},
		queuePreflight: NOOP_QUEUE_PREFLIGHT,
		...overrides,
	};
}

/**
 * Poll `check` until it returns a truthy value or `timeoutMs` elapses, then
 * return whatever the last attempt produced.
 *
 * A `setImmediate` loop bounded by an attempt count is not a wait: the event
 * loop can burn 50 turns in well under a millisecond, so under the loaded
 * parallel test phase a pending write has not necessarily landed by the final
 * attempt. That is a load-sensitive false failure, not a real ordering bug —
 * observed 2026-08-27 as `["1.1"]` vs `["1.1", "1.2"]` in a pre-push gate that
 * passed on every isolated rerun. Bound on elapsed time instead, and return
 * the last value rather than throwing so callers keep their own assertion
 * diffs.
 */
async function waitFor(check, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	let value = await check();
	while (!value && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
		value = await check();
	}
	return value;
}

async function waitForStoreRecord(storeRoot, taskId) {
	const record = await waitFor(async () =>
		(await readLedgerFromStore(storeRoot)).find(
			(entry) => entry.taskId === taskId,
		),
	);
	if (!record) {
		throw new Error(
			`timed out waiting for project-local ledger record ${taskId}`,
		);
	}
	return record;
}

function assertMatchingLedgerRecords(legacyRecord, storeRecord) {
	for (const key of [
		"provider",
		"model",
		"taskId",
		"result",
		"reason",
		"percentLeft",
		"requiredCapability",
		...PROVENANCE_KEYS,
	]) {
		strictEqual(storeRecord[key], legacyRecord[key], `matching ${key}`);
	}
	strictEqual(storeRecord.storeBacked, true);
}

// executeTaskWithOrchestrator (Task 1.6, M7/M8) duplicates executeTask's
// provenance-wiring shape verbatim (resolve once via resolveRouteProvenance,
// Object.assign onto routeResult, route every record() call through it) but
// is a fully separate code path — nothing above exercises it. A regression
// that broke provenance ONLY on the orchestrator path (e.g. someone editing
// one record() wrapper but not the other) would pass every test above and
// go undetected without this.
describe("executeTaskWithOrchestrator — every dispatch record carries all six provenance fields", () => {
	it("carries provenance on the SUCCESS path (opencode-go via the orchestrator)", async () => {
		const { context, dispatches } = makeOrchestratorContext({
			provider: "OpenCode Go",
			model: "fixture/opencode-low",
		});

		const result = await executeTaskWithOrchestrator(TASK, context);
		strictEqual(result.result, "success_no_diff");
		strictEqual(result.requiredCapability, "low");

		strictEqual(dispatches.length, 1);
		const rec = dispatches[0];
		for (const key of PROVENANCE_KEYS) ok(key in rec, `record missing ${key}`);
		strictEqual(rec.requiredCapability, "low");
		strictEqual(rec.roster_schema_version, 1);
		ok(/^[0-9a-f]{64}$/.test(rec.roster_sha256));
		strictEqual(rec.resolved_target, "opencode-go");
		strictEqual(rec.resolved_harness, "opencode");
		strictEqual(rec.resolved_credential_profile, "go");
	});

	it("carries provenance on the launch_failed path (an early record() call site)", async () => {
		// The orchestrator path has record() call sites the adapter path doesn't
		// (launch/poll/result failures). This is the earliest one — proves
		// provenance is resolved and attached BEFORE the launch is even attempted,
		// not bolted on only at the success tail.
		const { context, dispatches } = makeOrchestratorContext({
			provider: "Claude",
			model: "fixture-claude-high",
			orchestratorOverrides: {
				launch: async () => {
					throw new Error("orchestrator unreachable");
				},
			},
		});

		const result = await executeTaskWithOrchestrator(TASK, context);
		strictEqual(result.result, "launch_failed");
		strictEqual(result.requiredCapability, "low");

		strictEqual(dispatches.length, 1);
		const rec = dispatches[0];
		for (const key of PROVENANCE_KEYS) ok(key in rec, `record missing ${key}`);
		strictEqual(rec.requiredCapability, "low");
		strictEqual(rec.resolved_target, "claude-code");
		strictEqual(rec.resolved_harness, "claude");
		ok(
			typeof rec.resolved_selector === "string" &&
				rec.resolved_selector.startsWith("fixture-claude-"),
			`expected a claude selector, got ${rec.resolved_selector}`,
		);
		ok(
			typeof rec.resolved_credential_profile === "string" &&
				rec.resolved_credential_profile.length > 0,
			`expected a credential profile, got ${rec.resolved_credential_profile}`,
		);
	});
});

describe("default runner ledger wiring", () => {
	it("dual-writes matching records from the synchronous runner", async () => {
		const fixture = makeDefaultWiringFixture("sync-default-ledger");
		try {
			const result = runQueue({
				tasksFilePath: fixture.tasksFilePath,
				projectPath: tmpDir,
				workingContainerName: "test-container",
				platform: "macos",
				checkpointPath: fixture.checkpointPath,
				dependencies: defaultSyncDependencies(),
			});
			strictEqual(result.results[0].result, "success_no_diff");

			const storeRecord = await waitForStoreRecord(
				fixture.storeRoot,
				fixture.taskId,
			);
			const legacyRecord = await waitFor(() => {
				const last = readLedger().at(-1);
				return last?.taskId === fixture.taskId ? last : undefined;
			});
			assertMatchingLedgerRecords(legacyRecord, storeRecord);
		} finally {
			restoreLedgerPaths();
		}
	});

	it("dual-writes matching records from the orchestrator runner", async () => {
		const fixture = makeDefaultWiringFixture("orchestrator-default-ledger");
		try {
			const result = await runQueueWithOrchestrator({
				tasksFilePath: fixture.tasksFilePath,
				projectPath: tmpDir,
				workingContainerName: "test-container",
				platform: "macos",
				checkpointPath: fixture.checkpointPath,
				dependencies: defaultOrchestratorDependencies(),
			});
			strictEqual(result.results[0].result, "success_no_diff");

			const legacyRecord = readLedger().at(-1);
			const storeRecord = (await readLedgerFromStore(fixture.storeRoot)).at(-1);
			assertMatchingLedgerRecords(legacyRecord, storeRecord);
		} finally {
			restoreLedgerPaths();
		}
	});

	it("serializes synchronous store writes in dispatch order", async () => {
		const fixture = makeDefaultWiringFixture("sync-store-order");
		const tasksFilePath = join(tmpDir, "sync-store-order-tasks.md");
		writeFileSync(
			tasksFilePath,
			[
				"### Task 1.1: First ordered ledger task",
				"- **Status:** pending",
				"- **Type:** review",
				"- **Executor:** switchyard",
				"- **RequiredCapability:** low",
				"- **RequiredCapabilityJustification:** The first review is a bounded mechanical check.",
				"- **Description:** first ordered task",
				"",
				"### Task 1.2: Second ordered ledger task",
				"- **Status:** pending",
				"- **Type:** review",
				"- **Executor:** switchyard",
				"- **RequiredCapability:** low",
				"- **RequiredCapabilityJustification:** The second review is a bounded mechanical check.",
				"- **Description:** second ordered task",
				"",
			].join("\n"),
			"utf8",
		);
		let releaseFirst;
		const firstStoreWrite = new Promise((resolve) => {
			releaseFirst = resolve;
		});
		const delayedStoreWriter = async (dispatch, storeRoot) => {
			if (dispatch.taskId === "1.1") await firstStoreWrite;
			await recordDispatchToStore(dispatch, storeRoot);
		};

		try {
			const result = runQueue({
				tasksFilePath,
				projectPath: tmpDir,
				workingContainerName: "test-container",
				platform: "macos",
				checkpointPath: fixture.checkpointPath,
				dependencies: defaultSyncDependencies({
					recordDispatchToStore: delayedStoreWriter,
				}),
			});
			strictEqual(result.results.length, 2);

			releaseFirst();
			const storeRecords =
				(await waitFor(async () => {
					const entries = await readLedgerFromStore(fixture.storeRoot);
					return entries.length === 2 ? entries : undefined;
				})) ?? (await readLedgerFromStore(fixture.storeRoot));
			deepStrictEqual(
				storeRecords.map((record) => record.taskId),
				["1.1", "1.2"],
			);
			const legacyRecords =
				(await waitFor(() => {
					const entries = readLedger();
					return entries.length === 2 ? entries : undefined;
				})) ?? readLedger();
			deepStrictEqual(
				legacyRecords.map((record) => record.taskId),
				["1.1", "1.2"],
			);
		} finally {
			restoreLedgerPaths();
		}
	});

	// runQueue is synchronous and its project-local outcome write is not, so the
	// write is queued onto a chain the function itself cannot await. Ordering was
	// already preserved (the test above); durability before return was not. A
	// caller that terminates on return -- the case this drain exists for -- had
	// no way to know a record was still in flight.
	it("exposes a drain boundary that settles the outcome write a terminal caller would drop", async () => {
		const fixture = makeDefaultWiringFixture("sync-drain-boundary");
		let releaseWrite;
		const gate = new Promise((resolve) => {
			releaseWrite = resolve;
		});
		// Blocked until released, then real filesystem work: mkdir + append.
		// A caller that merely yields a microtask still misses it; only awaiting
		// the returned chain is sufficient.
		const gatedStoreWriter = async (dispatch, storeRoot) => {
			await gate;
			await recordDispatchToStore(dispatch, storeRoot);
		};

		try {
			const result = runQueue({
				tasksFilePath: fixture.tasksFilePath,
				projectPath: tmpDir,
				workingContainerName: "test-container",
				platform: "macos",
				checkpointPath: fixture.checkpointPath,
				dependencies: defaultSyncDependencies({
					recordDispatchToStore: gatedStoreWriter,
				}),
			});
			strictEqual(result.results[0].result, "success_no_diff");

			// Control: the write really is still in flight at return, so the
			// assertion after the drain below is about the drain and not about a
			// write that had already landed.
			deepStrictEqual(await readLedgerFromStore(fixture.storeRoot), []);

			releaseWrite();
			await result.ledgerWritesSettled;

			// No polling loop: after the drain the record is simply there. The
			// other tests in this suite need waitForStoreRecord precisely because
			// they do not await this.
			const storeRecords = await readLedgerFromStore(fixture.storeRoot);
			strictEqual(storeRecords.length, 1);
			strictEqual(storeRecords[0].taskId, fixture.taskId);
			// The legacy projection is sequenced behind the store write on the same
			// chain, so it is settled too.
			strictEqual(readLedger().at(-1)?.taskId, fixture.taskId);
		} finally {
			releaseWrite?.();
			restoreLedgerPaths();
		}
	});

	// Both ledger writes used to fail into bare console.warn calls, which no
	// caller could observe and no status surface ever saw. They now go through
	// the same bounded classifier the intent-receipt path uses.
	it("reports a failed outcome projection as a structured status event, not a console warning", async () => {
		const fixture = makeDefaultWiringFixture("sync-outcome-failure");
		const statuses = [];
		const projectionFailures = [];
		const denied = Object.assign(new Error("denied"), { code: "EACCES" });

		try {
			const result = runQueue({
				tasksFilePath: fixture.tasksFilePath,
				projectPath: tmpDir,
				workingContainerName: "test-container",
				platform: "macos",
				checkpointPath: fixture.checkpointPath,
				dependencies: defaultSyncDependencies({
					recordDispatchToStore: async () => {
						throw denied;
					},
					onStatus: (event) => statuses.push(event),
					onLedgerProjectionFailure: (metadata) =>
						projectionFailures.push(metadata),
				}),
			});
			// The dispatch itself is unaffected: a ledger projection failure is
			// reported, never promoted into a task failure.
			strictEqual(result.results[0].result, "success_no_diff");
			await result.ledgerWritesSettled;

			const reported = statuses.find(
				(event) => event.event === "outcome_projection_failed",
			);
			ok(
				reported,
				`expected an outcome_projection_failed status, got ${JSON.stringify(
					statuses.map((event) => event.event),
				)}`,
			);
			strictEqual(reported.phase, "ledger");
			strictEqual(reported.ledgerFailure, true);
			strictEqual(reported.ledgerFailurePhase, "outcome_projection");
			strictEqual(reported.ledgerFailureCode, "EACCES");
			deepStrictEqual(projectionFailures, [
				{
					ledgerFailure: true,
					ledgerFailurePhase: "outcome_projection",
					ledgerFailureCode: "EACCES",
				},
			]);
		} finally {
			restoreLedgerPaths();
		}
	});

	// The classifier is bounded on purpose: an errno outside the allowlist
	// becomes "unknown" rather than crossing the status/ledger boundary, so a
	// path or message embedded in an unexpected error cannot leak through it.
	it("bounds an unexpected legacy-projection errno to unknown", async () => {
		const fixture = makeDefaultWiringFixture("sync-legacy-failure");
		const statuses = [];
		// A regular file where the legacy ledger's parent directory should be, so
		// the legacy append fails with ENOTDIR -- a real errno, deliberately not
		// in SAFE_LEDGER_ERROR_CODES.
		const blocker = join(tmpDir, "blocker");
		writeFileSync(blocker, "not a directory", "utf8");
		process.env.SWITCHYARD_LEDGER_PATH = join(blocker, "ledger.jsonl");

		try {
			const result = runQueue({
				tasksFilePath: fixture.tasksFilePath,
				projectPath: tmpDir,
				workingContainerName: "test-container",
				platform: "macos",
				checkpointPath: fixture.checkpointPath,
				dependencies: defaultSyncDependencies({
					onStatus: (event) => statuses.push(event),
				}),
			});
			strictEqual(result.results[0].result, "success_no_diff");
			await result.ledgerWritesSettled;

			const reported = statuses.find(
				(event) => event.event === "legacy_projection_failed",
			);
			ok(
				reported,
				`expected a legacy_projection_failed status, got ${JSON.stringify(
					statuses.map((event) => event.event),
				)}`,
			);
			strictEqual(reported.ledgerFailurePhase, "legacy_projection");
			strictEqual(reported.ledgerFailureCode, "unknown");
			// The store-backed write is independent and still landed.
			strictEqual(
				(await readLedgerFromStore(fixture.storeRoot)).at(-1)?.taskId,
				fixture.taskId,
			);
		} finally {
			restoreLedgerPaths();
		}
	});

	// runQueueAsync and runQueueWithOrchestrator share recordDispatchToBothLedgers,
	// which had its own copy of the swallowed-warning pattern. Without this the
	// orchestrator path could regress alone while the sync tests above passed.
	it("reports a failed outcome projection on the orchestrator path too", async () => {
		const fixture = makeDefaultWiringFixture("orchestrator-outcome-failure");
		const statuses = [];
		const projectionFailures = [];

		try {
			const result = await runQueueWithOrchestrator({
				tasksFilePath: fixture.tasksFilePath,
				projectPath: tmpDir,
				workingContainerName: "test-container",
				platform: "macos",
				checkpointPath: fixture.checkpointPath,
				dependencies: defaultOrchestratorDependencies({
					recordDispatchToStore: async () => {
						throw Object.assign(new Error("read-only"), { code: "EROFS" });
					},
					onStatus: (event) => statuses.push(event),
					onLedgerProjectionFailure: (metadata) =>
						projectionFailures.push(metadata),
				}),
			});
			strictEqual(result.results[0].result, "success_no_diff");

			const reported = statuses.find(
				(event) => event.event === "outcome_projection_failed",
			);
			ok(
				reported,
				`expected an outcome_projection_failed status, got ${JSON.stringify(
					statuses.map((event) => event.event),
				)}`,
			);
			strictEqual(reported.ledgerFailureCode, "EROFS");
			deepStrictEqual(projectionFailures, [
				{
					ledgerFailure: true,
					ledgerFailurePhase: "outcome_projection",
					ledgerFailureCode: "EROFS",
				},
			]);
		} finally {
			restoreLedgerPaths();
		}
	});

	it("lets an injected recorder replace both default writers", async () => {
		const fixture = makeDefaultWiringFixture("override-sync-ledger");
		const overrides = [];
		try {
			runQueue({
				tasksFilePath: fixture.tasksFilePath,
				projectPath: tmpDir,
				workingContainerName: "test-container",
				platform: "macos",
				checkpointPath: fixture.checkpointPath,
				dependencies: {
					...defaultSyncDependencies(),
					recordDispatch: (record) => overrides.push(record),
				},
			});

			const orchestratorTaskId = "override-orchestrator-ledger";
			const orchestratorTasksFilePath = join(
				tmpDir,
				`${orchestratorTaskId}.md`,
			);
			writeFileSync(
				orchestratorTasksFilePath,
				"### Task 1.1: Override ledger wiring\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **RequiredCapability:** low\n- **RequiredCapabilityJustification:** The review is a bounded mechanical check.\n- **Description:** use the injected recorder\n",
				"utf8",
			);
			await runQueueWithOrchestrator({
				tasksFilePath: orchestratorTasksFilePath,
				projectPath: tmpDir,
				workingContainerName: "test-container",
				platform: "macos",
				checkpointPath: join(tmpDir, `${orchestratorTaskId}.checkpoint.json`),
				dependencies: {
					...defaultOrchestratorDependencies(),
					recordDispatch: (record) => overrides.push(record),
				},
			});

			strictEqual(overrides.length, 2);
			strictEqual(readLedger().length, 0);
			deepStrictEqual(await readLedgerFromStore(fixture.storeRoot), []);
		} finally {
			restoreLedgerPaths();
		}
	});

	it("warns and completes when the synchronous store write fails", async () => {
		const fixture = makeDefaultWiringFixture("sync-store-write-failure");
		writeFileSync(fixture.storeRoot, "not a directory", "utf8");
		const warnings = [];
		const originalWarn = console.warn;
		console.warn = (message) => warnings.push(message);
		try {
			const result = runQueue({
				tasksFilePath: fixture.tasksFilePath,
				projectPath: tmpDir,
				workingContainerName: "test-container",
				platform: "macos",
				checkpointPath: fixture.checkpointPath,
				dependencies: defaultSyncDependencies(),
			});
			strictEqual(result.results[0].result, "success_no_diff");

			await waitFor(() => warnings.length > 0);
			strictEqual(warnings.length, 1);
			ok(
				warnings[0].startsWith(
					"runQueue: project-local dispatch outcome projection failed",
				),
			);
		} finally {
			console.warn = originalWarn;
			restoreLedgerPaths();
		}
	});

	// The drain boundary is documented as ignorable by every caller that is not
	// about to exit, so it must never reject: an unhandled rejection here would
	// be fatal on current Node, and would be raised after runQueue had already
	// returned success. The reporters call caller-supplied code that nothing
	// guards, so a status surface that throws is the way it would happen.
	it("keeps the drain boundary settling when the status surface itself throws", async () => {
		const fixture = makeDefaultWiringFixture("sync-status-surface-throws");
		const warnings = [];
		const originalWarn = console.warn;
		console.warn = (message) => warnings.push(message);
		try {
			const result = runQueue({
				tasksFilePath: fixture.tasksFilePath,
				projectPath: tmpDir,
				workingContainerName: "test-container",
				platform: "macos",
				checkpointPath: fixture.checkpointPath,
				dependencies: defaultSyncDependencies({
					recordDispatchToStore: async () => {
						throw Object.assign(new Error("denied"), { code: "EACCES" });
					},
					// Scoped to the ledger event on purpose. A surface that throws
					// on every event dies synchronously inside runQueue on the
					// first one -- loud, and the caller's own bug. The hazard
					// this covers is narrower: a consumer that mishandles only
					// this event shape, and so throws where nothing is awaiting.
					onStatus: (event) => {
						if (event.phase === "ledger") {
							throw new Error("status surface exploded");
						}
					},
				}),
			});
			strictEqual(result.results[0].result, "success_no_diff");

			let rejected = null;
			await result.ledgerWritesSettled.catch((error) => {
				rejected = error;
			});
			strictEqual(
				rejected,
				null,
				`ledgerWritesSettled must settle, not reject: ${rejected?.message}`,
			);

			strictEqual(warnings.length, 1);
			ok(
				warnings[0].startsWith(
					"runQueue: dispatch-ledger failure reporting threw",
				),
			);
			// The thrown surface's own message is caller-controlled text and is
			// not repeated into the fallback channel.
			ok(!warnings[0].includes("status surface exploded"));
		} finally {
			console.warn = originalWarn;
			restoreLedgerPaths();
		}
	});

	it("contains an orchestrator store-write failure after the legacy record", async () => {
		const fixture = makeDefaultWiringFixture(
			"orchestrator-store-write-failure",
		);
		writeFileSync(fixture.storeRoot, "not a directory", "utf8");
		try {
			const result = await runQueueWithOrchestrator({
				tasksFilePath: fixture.tasksFilePath,
				projectPath: tmpDir,
				workingContainerName: "test-container",
				platform: "macos",
				checkpointPath: fixture.checkpointPath,
				dependencies: defaultOrchestratorDependencies(),
			});
			strictEqual(result.results[0].result, "success_no_diff");
			strictEqual(
				readLedger().filter((record) => record.taskId === fixture.taskId)
					.length,
				1,
			);
		} finally {
			restoreLedgerPaths();
		}
	});
});

describe("roster_sha256 is stable across a simulated `roster smoke` write-back", () => {
	it("flipping a qualification in the on-disk roster does not move the loader-computed sha", () => {
		// Baseline sha from the committed fixture.
		setRosterPath(FIXTURE_PATH);
		const shaBefore = getRosterProvenance().roster_sha256;

		// Simulate a smoke write-back: read the fixture, flip a qualification
		// status (and stamp a timestamp, as smoke does), write to a temp path.
		tmpDir = mkdtempSync(join(tmpdir(), "switchyard-provenance-"));
		const roster = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
		roster.targets["opencode-go"].qualifications["fixture/opencode-standard"] =
			{
				status: "qualified",
				last_smoke: "2026-07-31T12:00:00Z",
			};
		roster.targets["claude-code"].qualifications["fixture-claude-high"].status =
			"qualified";
		const writtenBack = join(tmpDir, "roster.smoke.json");
		writeFileSync(writtenBack, JSON.stringify(roster, null, 2), "utf8");

		setRosterPath(writtenBack);
		const shaAfter = getRosterProvenance().roster_sha256;

		strictEqual(
			shaAfter,
			shaBefore,
			"qualification write-back must not move the sha",
		);
	});

	it("changing a real routing field DOES move the loader-computed sha (control)", () => {
		setRosterPath(FIXTURE_PATH);
		const shaBefore = getRosterProvenance().roster_sha256;

		tmpDir = mkdtempSync(join(tmpdir(), "switchyard-provenance-"));
		const roster = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
		roster.targets["opencode-go"].slots.low[0].priority = 99; // real change
		const changed = join(tmpDir, "roster.changed.json");
		writeFileSync(changed, JSON.stringify(roster, null, 2), "utf8");

		setRosterPath(changed);
		const shaAfter = getRosterProvenance().roster_sha256;

		notStrictEqual(shaAfter, shaBefore);
	});
});

describe("recordDispatchToStore — provenance parity with the file ledger", () => {
	it("preserves the six provenance fields written into a store-backed ledger", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "switchyard-provenance-store-"));
		const provenance = {
			roster_schema_version: 1,
			roster_sha256: "a".repeat(64),
			resolved_target: "opencode-go",
			resolved_harness: "opencode",
			resolved_selector: "fixture/opencode-low",
			resolved_credential_profile: "go",
			requiredCapability: "low",
		};
		await recordDispatchToStore(
			{
				provider: "OpenCode Go",
				model: "fixture/opencode-low",
				taskId: "T-store",
				result: "success",
				...provenance,
			},
			tmpDir,
		);

		const entries = await readLedgerFromStore(tmpDir);
		strictEqual(entries.length, 1);
		for (const key of PROVENANCE_KEYS)
			ok(key in entries[0], `store entry missing ${key}`);
		strictEqual(entries[0].resolved_target, "opencode-go");
		strictEqual(entries[0].resolved_harness, "opencode");
		strictEqual(entries[0].roster_schema_version, 1);
		strictEqual(entries[0].resolved_credential_profile, "go");
	});

	it("persists static failure metadata without raw output or host paths", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "switchyard-provenance-failure-"));
		await recordDispatchToStore(
			{
				provider: "claude",
				model: "fixture-claude-high",
				taskId: "1.1",
				result: "execution_failed",
				errorKind: "provider_private_reason",
				reason: "SECRET_CANARY_provider_reason",
				error: "SECRET_CANARY_provider_error",
				output: "SECRET_CANARY_provider_output",
				partialDiffPath: "/Users/dave/project/.partial-diffs/1.1.diff",
			},
			tmpDir,
		);

		const [entry] = await readLedgerFromStore(tmpDir);
		strictEqual(entry.errorKind, "execution_failed");
		strictEqual(entry.reasonCode, "execution_failed");
		strictEqual(
			entry.reason,
			"Provider execution failed before a reviewed integration.",
		);
		ok(/^artifact:[a-f0-9]{24}$/.test(entry.artifactRef));
		for (const key of ["error", "output", "partialDiffPath"]) {
			ok(
				!(key in entry),
				`raw field ${key} must not cross the ledger boundary`,
			);
		}
		ok(!JSON.stringify(entry).includes("SECRET_CANARY"));
	});

	it("preserves integration failure diagnostics without gate content", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "switchyard-provenance-integration-"));
		await recordDispatchToStore(
			{
				provider: "claude",
				model: "fixture-claude-standard",
				taskId: "1.1",
				result: "integration_failed",
				errorKind: "integration_failed",
				reason: "SECRET_CANARY_gate_message",
				error: "SECRET_CANARY_gate_error",
				output: "SECRET_CANARY_gate_output",
				partialDiffPath: "/Users/dave/project/.partial-diffs/1.1.diff",
			},
			tmpDir,
		);

		const [entry] = await readLedgerFromStore(tmpDir);
		strictEqual(entry.errorKind, "integration_failed");
		strictEqual(entry.reasonCode, "integration_failed");
		strictEqual(
			entry.reason,
			"The reviewed integration gate rejected the task result.",
		);
		ok(/^artifact:[a-f0-9]{24}$/.test(entry.artifactRef));
		for (const key of ["error", "output", "partialDiffPath"]) {
			ok(
				!(key in entry),
				`raw field ${key} must not cross the ledger boundary`,
			);
		}
		ok(!JSON.stringify(entry).includes("SECRET_CANARY"));
	});

	it("capstone: verified provider quota classification persists safely", () => {
		// The matcher is provider-scoped and based on the approved sanitized
		// provider-boundary evidence. The transient result may retain the
		// diagnostic phrase, but the persisted projection must remain static.
		const transient = describeExecError(
			{
				message: "provider rejected the request",
				stdout: "Individual quota reached; retry after the reset window",
				stderr: "",
			},
			{ provider: "agy" },
		);
		strictEqual(transient.errorKind, "quota_exhausted");

		const persistent = sanitizeFailureMetadata({
			taskId: "1.1",
			result: "execution_failed",
			errorKind: transient.errorKind,
			partialDiffPath: "1.1.diff",
		});
		strictEqual(persistent.errorKind, "quota_exhausted");
		strictEqual(persistent.reasonCode, "quota_exhausted");
		ok(!JSON.stringify(persistent).includes("Individual quota reached"));
	});
});
