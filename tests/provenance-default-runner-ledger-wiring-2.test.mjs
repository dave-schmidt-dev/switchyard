import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
	readLedger,
	readLedgerFromStore,
} from "../src/switchyard/ledger/index.mjs";
import {
	__resetRosterCacheForTests,
	getInvocationDescriptorIdentity,
	validateInvocationDescriptor,
} from "../src/switchyard/roster/index.mjs";
import {
	runQueue,
	runQueueWithOrchestrator,
} from "../src/switchyard/runner/index.mjs";
import {
	FIXTURE_PATH,
	previousHomeDir,
	previousRosterPath,
	setHomeDir,
	setRosterPath,
} from "./helpers/provenance-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const previousLegacyLedgerPath = process.env.SWITCHYARD_LEDGER_PATH;
const previousRunStoreRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
let tmpDir;
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
function fixtureTaskBase(taskId = "1.1") {
	return {
		ref: `refs/switchyard/task-base/provenance/${taskId}`,
		tree: "5".repeat(40),
	};
}
function taskBaseDependencies() {
	return {
		backendFactory: () => ({
			readiness: () => ({ inventoryCount: 0 }),
			create: () => "test-container",
			destroy: () => {},
			seed: () => {},
			commit: () => {},
			reset: () => {},
			captureTaskBase: (_workspaceId, { taskId }) => fixtureTaskBase(taskId),
			validateTaskBase: (_workspaceId, base) => base,
			releaseTaskBase: () => {},
		}),
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
const REVIEW_OUTPUT = JSON.stringify({ verdict: "clean" });
function restoreLedgerPaths() {
	if (previousLegacyLedgerPath === undefined)
		delete process.env.SWITCHYARD_LEDGER_PATH;
	else process.env.SWITCHYARD_LEDGER_PATH = previousLegacyLedgerPath;
	if (previousRunStoreRoot === undefined)
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRunStoreRoot;
}
function makeDefaultWiringFixture(taskId) {
	tmpDir = tempDir("switchyard-ledger-wiring-");
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
const NOOP_QUEUE_PREFLIGHT = () => ({ ok: true, eligible: true });
function defaultSyncDependencies(overrides = {}) {
	return {
		...taskBaseDependencies(),
		route: defaultRoute,
		resolveDescriptor: () =>
			syntheticDescriptor({
				targetId: "opencode-go",
				model: "fixture/opencode-low",
				harness: "opencode",
			}),
		adapters: {
			opencode: {
				execute: () => ({ success: true, output: REVIEW_OUTPUT }),
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
		...taskBaseDependencies(),
		route: defaultRoute,
		resolveDescriptor: () =>
			syntheticDescriptor({
				targetId: "opencode-go",
				model: "fixture/opencode-low",
				harness: "opencode",
			}),
		adapters: { opencode: { captureDiffAsync: async () => "" } },
		orchestrator: {
			launch: async () => "job-default-ledger",
			status: async () => ({ state: "done" }),
			result: async () => ({ success: true, diff: "", output: REVIEW_OUTPUT }),
		},
		recordDispatchIntent: () => {},
		queuePreflight: NOOP_QUEUE_PREFLIGHT,
		...overrides,
	};
}
describe("default runner ledger wiring", () => {
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
			strictEqual(result.results[0].result, "review_completed");
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
			strictEqual(result.results[0].result, "review_completed");
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
			strictEqual(result.results[0].result, "review_completed");

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
});
