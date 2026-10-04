import { ok, strictEqual } from "node:assert";
import { execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { projectDisposition } from "../src/switchyard/dispatch/disposition.mjs";
import {
	__dirname,
	BOOTSTRAP_PATH,
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
	it("bootstrap with host fingerprint mismatch exits 4 and records worker_fingerprint_mismatch", async () => {
		const { initializeRun, readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const fpProjectDir = join(dir, "fp-mismatch-project");
		mkdirSync(fpProjectDir, { recursive: true });
		execSync("git init", { cwd: fpProjectDir, stdio: "ignore" });
		execSync("git config user.email test@test.com", {
			cwd: fpProjectDir,
			stdio: "ignore",
		});
		execSync("git config user.name test", {
			cwd: fpProjectDir,
			stdio: "ignore",
		});
		execSync("git commit --allow-empty -m initial", {
			cwd: fpProjectDir,
			stdio: "ignore",
		});

		const runId = randomUUID();
		const nonce = "test-nonce-fp";

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: fpProjectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint:
				"git:0123456789abcdef0123456789abcdef01234567:clean",
			workerNonce: nonce,
			launchArgs: [],
		});

		const result = runBootstrap(
			["--state-root", stateRoot, "--run-id", runId, "--nonce", nonce],
			makeStateRootEnv(),
		);

		strictEqual(
			result.status,
			4,
			`expected exit 4 for fingerprint mismatch, got ${result.status}: ${result.stderr}`,
		);

		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.phase, "worker");
		strictEqual(bootFailed.event, "worker_boot_failed");
		strictEqual(bootFailed.status, "fatal");
		strictEqual(bootFailed.errorKind, "launch_failed");
		strictEqual(bootFailed.diagnosticCode, "worker_fingerprint_mismatch");
		strictEqual(bootFailed.failurePhase, "worker_boot");
		strictEqual(bootFailed.reasonCode, "launch_failed");
		strictEqual(
			bootFailed.reason,
			"The headless provider job could not be launched.",
		);
		strictEqual(bootFailed.error, undefined);
		ok(!JSON.stringify(bootFailed).includes("host fingerprint mismatch"));
		ok(!JSON.stringify(bootFailed).includes(fpProjectDir));

		const run = await readRun(runId);
		ok(run.lastFailure !== null, "lastFailure populated in run.json");
		strictEqual(run.lastFailure.errorKind, "launch_failed");
		strictEqual(run.lastFailure.diagnosticCode, "worker_fingerprint_mismatch");
		strictEqual(run.lastFailure.failurePhase, "worker_boot");
		strictEqual(run.lastFailure.reasonCode, "launch_failed");
		strictEqual(
			run.lastFailure.reason,
			"The headless provider job could not be launched.",
		);
		ok(!JSON.stringify(run.lastFailure).includes("host fingerprint mismatch"));
		ok(!JSON.stringify(run.lastFailure).includes(fpProjectDir));
	});
	it("bootstrap with uncaught boot exception persists worker_boot_exception via readRun", async () => {
		const { initializeRun, readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const nonce = "test-nonce-exception";

		await initializeRun({
			runId,
			tasksFilePath: join(dir, "non-existent-tasks.md"),
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: nonce,
			launchArgs: [],
		});

		const result = runBootstrap(
			["--state-root", stateRoot, "--run-id", runId, "--nonce", nonce],
			makeStateRootEnv(),
		);

		strictEqual(
			result.status,
			1,
			`expected exit 1 for uncaught exception, got ${result.status}: ${result.stderr}`,
		);

		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.phase, "worker");
		strictEqual(bootFailed.event, "worker_boot_failed");
		strictEqual(bootFailed.status, "fatal");
		strictEqual(bootFailed.errorKind, "launch_failed");
		strictEqual(bootFailed.diagnosticCode, "worker_boot_exception");
		strictEqual(bootFailed.failurePhase, "worker_boot");
		strictEqual(bootFailed.reasonCode, "launch_failed");
		strictEqual(
			bootFailed.reason,
			"The headless provider job could not be launched.",
		);
		strictEqual(bootFailed.error, undefined);
		ok(!JSON.stringify(bootFailed).includes("non-existent-tasks.md"));
		ok(!JSON.stringify(bootFailed).includes(projectDir));

		const run = await readRun(runId);
		strictEqual(run.state, "failed");
		ok(run.lastFailure !== null, "lastFailure populated in run.json");
		strictEqual(run.lastFailure.errorKind, "launch_failed");
		strictEqual(run.lastFailure.diagnosticCode, "worker_boot_exception");
		strictEqual(run.lastFailure.failurePhase, "worker_boot");
		strictEqual(run.lastFailure.reasonCode, "launch_failed");
		strictEqual(
			run.lastFailure.reason,
			"The headless provider job could not be launched.",
		);
		ok(!JSON.stringify(run.lastFailure).includes("non-existent-tasks.md"));
		ok(!JSON.stringify(run.lastFailure).includes(projectDir));
		const disposition = projectDisposition({
			run,
			liveness: "terminal_clean",
			optionalEvidenceValid: false,
		});
		strictEqual(disposition.action, "repair_contract");
		strictEqual(disposition.reasonCode, "worker_boot_exception");
	});
	it("persists closed backend stage codes without durable error details", async () => {
		const { initializeRun, readEvents, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const errorModulePath = resolve(
			__dirname,
			"..",
			"src",
			"switchyard",
			"adapter",
			"exec-error.mjs",
		);

		for (const diagnosticCode of [
			"clone_hardening_failed",
			"workspace_prepare_failed",
		]) {
			const runId = randomUUID();
			const nonce = randomUUID();
			const canary = `SECRET-${diagnosticCode}-${randomUUID()}`;
			await initializeRun({
				runId,
				tasksFilePath: tasksFile,
				projectPath: projectDir,
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "test-fingerprint",
				workerNonce: nonce,
				launchArgs: [],
			});
			await updateRun(runId, { dispatchContractVersion: 99 }, 1);

			const child = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`
					import { WorkerBootStageError } from ${JSON.stringify(errorModulePath)};
					process.nextTick(() => {
						const cause = Object.assign(new Error(${JSON.stringify(`${canary} /host/private/path provider output`)}), {
							path: ${JSON.stringify(`/host/private/${canary}`)},
							providerOutput: ${JSON.stringify(`raw provider output ${canary}`)},
						});
						throw new WorkerBootStageError(${JSON.stringify(diagnosticCode)}, cause);
					});
					const { runWorkerBootstrap } = await import(
						${JSON.stringify(BOOTSTRAP_PATH)}
					);
					await runWorkerBootstrap(process.argv);
					`,
					"--",
					"--state-root",
					stateRoot,
					"--run-id",
					runId,
					"--nonce",
					nonce,
				],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, ...makeStateRootEnv() },
				},
			);
			strictEqual(child.status, 1);
			strictEqual(child.stderr, "");
			ok(!child.stderr.includes(canary));
			ok(!child.stderr.includes("/host/private/path"));
			ok(!child.stderr.includes("raw provider output"));
			ok(!child.stderr.includes("providerOutput"));

			const events = await readEvents(runId);
			const bootFailed = events.find(
				(event) => event.event === "worker_boot_failed",
			);
			ok(bootFailed, `${diagnosticCode}: worker_boot_failed event recorded`);
			strictEqual(bootFailed.diagnosticCode, diagnosticCode);
			strictEqual(bootFailed.errorKind, "launch_failed");
			strictEqual(bootFailed.failurePhase, "worker_boot");

			const run = await readRun(runId);
			strictEqual(run.lastFailure.diagnosticCode, diagnosticCode);
			const durableEvidence = JSON.stringify({ events, run });
			ok(!durableEvidence.includes(canary));
			ok(!durableEvidence.includes("/host/private/path"));
			ok(!durableEvidence.includes("raw provider output"));
			ok(!durableEvidence.includes("providerOutput"));
		}
	});
});
