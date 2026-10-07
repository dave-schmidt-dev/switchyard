import { deepStrictEqual, strictEqual } from "node:assert";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
	readLedger,
	readLedgerFromStore,
	recordDispatchToStore,
} from "../src/switchyard/ledger/index.mjs";
import {
	__resetRosterCacheForTests,
	getInvocationDescriptorIdentity,
	validateInvocationDescriptor,
} from "../src/switchyard/roster/index.mjs";
import { runQueue } from "../src/switchyard/runner/index.mjs";
import {
	FIXTURE_PATH,
	PROVENANCE_KEYS,
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
			strictEqual(result.results[0].result, "review_completed");

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
			strictEqual(result.results[0].result, "review_completed");

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
});
