import { ok, strictEqual } from "node:assert";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { readLedger } from "../src/switchyard/ledger/index.mjs";
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
async function waitFor(check, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	let value = await check();
	while (!value && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
		value = await check();
	}
	return value;
}
describe("default runner ledger wiring", () => {
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
			strictEqual(result.results[0].result, "review_completed");

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
			strictEqual(result.results[0].result, "review_completed");

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
			strictEqual(result.results[0].result, "review_completed");
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
