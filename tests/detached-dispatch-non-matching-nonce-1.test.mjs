import { ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	ROSTER_FIXTURE_PATH,
	runBootstrap,
} from "./helpers/detached-dispatch-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let dir;
let tasksFile;
let projectDir;
let stateRoot;
let detachedCleanupPending;
let detachedCleanupRunId;
function makeStateRootEnv() {
	return { SWITCHYARD_RUN_STORE_ROOT: stateRoot };
}
beforeEach(async () => {
	dir = tempDir("switchyard-detached-dispatch-");
	detachedCleanupPending = false;
	detachedCleanupRunId = null;
	stateRoot = join(dir, "state-root");
	tasksFile = join(dir, "tasks.md");
	writeFileSync(
		tasksFile,
		"### Task 1.1: Test task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Quick checks:** none\n- **Description:** A test\n",
		"utf8",
	);
	projectDir = join(dir, "project");
	mkdirSync(join(projectDir, ".git"), { recursive: true });

	process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;
	process.env.SWITCHYARD_ROSTER_PATH = ROSTER_FIXTURE_PATH;
	// Real dispatch subprocesses go through the real, unmocked ledger writer —
	// redirect it so this suite never writes to the real dispatch-ledger.jsonl.
	process.env.SWITCHYARD_LEDGER_PATH = join(dir, "dispatch-ledger.jsonl");
});
afterEach(() => {
	delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	delete process.env.SWITCHYARD_ROSTER_PATH;
	delete process.env.SWITCHYARD_LEDGER_PATH;
	if (detachedCleanupPending) {
		console.error(
			`detached cleanup was not confirmed for run ${detachedCleanupRunId ?? "unknown"}; preserving fixture ${dir}`,
		);
		return;
	}
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
describe("non-matching nonce", () => {
	it("bootstrap with wrong nonce exits 3 and records worker_boot_failed", async () => {
		const { initializeRun, readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const correctNonce = "correct-nonce-value";

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: correctNonce,
			launchArgs: [],
		});

		const result = runBootstrap(
			[
				"--state-root",
				stateRoot,
				"--run-id",
				runId,
				"--nonce",
				"wrong-nonce-value",
			],
			makeStateRootEnv(),
		);

		strictEqual(
			result.status,
			3,
			`expected exit 3 for nonce mismatch, got ${result.status}: ${result.stderr}`,
		);

		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.phase, "worker");
		strictEqual(bootFailed.event, "worker_boot_failed");
		strictEqual(bootFailed.status, "fatal");
		strictEqual(bootFailed.errorKind, "launch_failed");
		strictEqual(bootFailed.diagnosticCode, "worker_nonce_mismatch");
		strictEqual(bootFailed.failurePhase, "worker_boot");
		strictEqual(bootFailed.reasonCode, "launch_failed");
		strictEqual(
			bootFailed.reason,
			"The headless provider job could not be launched.",
		);
		strictEqual(bootFailed.error, undefined);
		ok(!JSON.stringify(bootFailed).includes("wrong-nonce-value"));
		ok(!JSON.stringify(bootFailed).includes("nonce mismatch"));
		ok(!JSON.stringify(bootFailed).includes(projectDir));

		const run = await readRun(runId);
		ok(run.lastFailure !== null, "lastFailure populated in run.json");
		strictEqual(run.lastFailure.errorKind, "launch_failed");
		strictEqual(run.lastFailure.diagnosticCode, "worker_nonce_mismatch");
		strictEqual(run.lastFailure.failurePhase, "worker_boot");
		strictEqual(run.lastFailure.reasonCode, "launch_failed");
		strictEqual(
			run.lastFailure.reason,
			"The headless provider job could not be launched.",
		);
		ok(!JSON.stringify(run.lastFailure).includes("wrong-nonce-value"));
		ok(!JSON.stringify(run.lastFailure).includes("nonce mismatch"));
		ok(!JSON.stringify(run.lastFailure).includes(projectDir));
	});
	it("bootstrap with a secret-canary-bearing nonce redacts it from the persisted worker_boot_failed event", async () => {
		const { initializeRun, readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const correctNonce = "correct-nonce-value";

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: correctNonce,
			launchArgs: [],
		});

		const result = runBootstrap(
			[
				"--state-root",
				stateRoot,
				"--run-id",
				runId,
				"--nonce",
				"SECRET_CANARY_leaked_nonce_value",
			],
			makeStateRootEnv(),
		);

		strictEqual(
			result.status,
			3,
			`expected exit 3 for nonce mismatch, got ${result.status}: ${result.stderr}`,
		);

		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.phase, "worker");
		strictEqual(bootFailed.event, "worker_boot_failed");
		strictEqual(bootFailed.status, "fatal");
		strictEqual(bootFailed.errorKind, "launch_failed");
		strictEqual(bootFailed.diagnosticCode, "worker_nonce_mismatch");
		strictEqual(bootFailed.failurePhase, "worker_boot");
		strictEqual(bootFailed.error, undefined);
		assertNoSecretCanary(runId);

		const run = await readRun(runId);
		ok(run.lastFailure !== null, "lastFailure populated in run.json");
		strictEqual(run.lastFailure.errorKind, "launch_failed");
		strictEqual(run.lastFailure.diagnosticCode, "worker_nonce_mismatch");
		strictEqual(run.lastFailure.failurePhase, "worker_boot");
	});
	it("bootstrap with unsupported dispatch contract version exits 5 and records worker_contract_unsupported", async () => {
		const { initializeRun, readEvents, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const nonce = "test-nonce-contract";

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: nonce,
			launchArgs: [],
		});

		const current = await readRun(runId);
		await updateRun(runId, { dispatchContractVersion: 2 }, current.revision);

		const result = runBootstrap(
			["--state-root", stateRoot, "--run-id", runId, "--nonce", nonce],
			makeStateRootEnv(),
		);

		strictEqual(
			result.status,
			5,
			`expected exit 5 for contract version mismatch, got ${result.status}: ${result.stderr}`,
		);

		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.phase, "worker");
		strictEqual(bootFailed.event, "worker_boot_failed");
		strictEqual(bootFailed.status, "fatal");
		strictEqual(bootFailed.errorKind, "launch_failed");
		strictEqual(bootFailed.diagnosticCode, "worker_contract_unsupported");
		strictEqual(bootFailed.failurePhase, "worker_boot");
		strictEqual(bootFailed.reasonCode, "launch_failed");
		strictEqual(
			bootFailed.reason,
			"The headless provider job could not be launched.",
		);
		strictEqual(bootFailed.error, undefined);
		ok(
			!JSON.stringify(bootFailed).includes(
				"unsupported dispatch descriptor contract version",
			),
		);
		ok(!JSON.stringify(bootFailed).includes(projectDir));

		const run = await readRun(runId);
		ok(run.lastFailure !== null, "lastFailure populated in run.json");
		strictEqual(run.lastFailure.errorKind, "launch_failed");
		strictEqual(run.lastFailure.diagnosticCode, "worker_contract_unsupported");
		strictEqual(run.lastFailure.failurePhase, "worker_boot");
		strictEqual(run.lastFailure.reasonCode, "launch_failed");
		strictEqual(
			run.lastFailure.reason,
			"The headless provider job could not be launched.",
		);
		ok(
			!JSON.stringify(run.lastFailure).includes(
				"unsupported dispatch descriptor contract version",
			),
		);
		ok(!JSON.stringify(run.lastFailure).includes(projectDir));
	});
});
function assertNoSecretCanary(runId) {
	const runDir = resolve(stateRoot, "runs", runId);
	const runJsonRaw = readFileSync(resolve(runDir, "run.json"), "utf8");
	ok(
		!runJsonRaw.includes("SECRET_CANARY_"),
		"run.json must not contain SECRET_CANARY_",
	);

	try {
		const eventsRaw = readFileSync(resolve(runDir, "events.jsonl"), "utf8");
		ok(
			!eventsRaw.includes("SECRET_CANARY_"),
			"events.jsonl must not contain SECRET_CANARY_",
		);
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}

	try {
		const bootLogRaw = readFileSync(resolve(runDir, "boot-stderr.log"), "utf8");
		ok(
			!bootLogRaw.includes("SECRET_CANARY_"),
			"boot-stderr.log must not contain SECRET_CANARY_",
		);
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}

	try {
		const artifactsDir = resolve(runDir, "artifacts");
		const entries = readdirSync(artifactsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isFile()) {
				const content = readFileSync(resolve(artifactsDir, entry.name), "utf8");
				ok(
					!content.includes("SECRET_CANARY_"),
					`artifact ${entry.name} must not contain SECRET_CANARY_`,
				);
			}
		}
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
}
