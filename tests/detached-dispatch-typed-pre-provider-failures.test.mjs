import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { projectDisposition } from "../src/switchyard/dispatch/disposition.mjs";
import {
	__dirname,
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
describe("typed pre-provider failures on the detached terminal path", () => {
	it("preserves exported task-selection, queue-preflight, and lock triples", async () => {
		const runnerUrl = `${pathToFileURL(resolve(__dirname, "..", "src", "switchyard", "runner", "index.mjs")).href}?typed-terminalization`;
		const runStoreUrl = pathToFileURL(
			resolve(__dirname, "..", "src", "switchyard", "run-store", "index.mjs"),
		).href;
		const cases = [
			{
				name: "task-selection",
				source: `import { TaskSelectionError } from ${JSON.stringify(runnerUrl)}; throw new TaskSelectionError("9.9", "external-blocked:private-canary");`,
				diagnosticCode: "task_selection_failed",
				errorKind: "task_selection_failed",
				failurePhase: "task_selection",
				action: "repair_contract",
				direction: "repair_input",
			},
			{
				name: "queue-preflight",
				source: `import { QueuePreflightError } from ${JSON.stringify(runnerUrl)}; throw new QueuePreflightError("/private/canary raw provider output", { reason: "no_eligible", rejections: [{ capability: "standard", reason: "no_provider", excludedProviders: ["claude"], excludedReasons: { claude: "no_invocation_descriptor" } }] });`,
				diagnosticCode: "environment_incomplete",
				errorKind: "environment_incomplete",
				failurePhase: "queue_preflight",
				action: "repair_contract",
				direction: "repair_input",
			},
			{
				name: "project-lock",
				source: `import { LockError } from ${JSON.stringify(runStoreUrl)}; throw new LockError("/private/canary lock detail", { code: "PROJECT_LOCK_OWNERSHIP_FAILED" });`,
				diagnosticCode: "project_lock_ownership_failed",
				errorKind: "project_lock_failed",
				failurePhase: "project_lock",
				action: "stop",
				direction: "retry_launch",
			},
		];

		for (const testCase of cases) {
			const { initializeRun, readEvents, readRun } = await import(
				"../src/switchyard/run-store/index.mjs"
			);
			const runId = randomUUID();
			const nonce = randomUUID();
			const loaderPath = join(dir, `${testCase.name}-loader.mjs`);
			writeFileSync(
				loaderPath,
				`export async function load(url, context, nextLoad) {
					if (url.endsWith("/src/switchyard/runner/index.mjs")) {
						return { format: "module", shortCircuit: true, source: ${JSON.stringify(testCase.source)} };
					}
					return nextLoad(url, context);
				}`,
				"utf8",
			);
			await initializeRun({
				runId,
				tasksFilePath: tasksFile,
				projectPath: projectDir,
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "test-fingerprint",
				workerNonce: nonce,
				launchArgs: [],
			});

			const result = runBootstrap(
				["--state-root", stateRoot, "--run-id", runId, "--nonce", nonce],
				{
					...makeStateRootEnv(),
					NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
				},
			);
			strictEqual(result.status, 1, `${testCase.name}: ${result.stderr}`);
			const event = (await readEvents(runId)).find(
				(entry) => entry.event === "worker_boot_failed",
			);
			ok(event, `${testCase.name}: terminal event missing`);
			const run = await readRun(runId);
			for (const evidence of [event, run.lastFailure]) {
				strictEqual(evidence.diagnosticCode, testCase.diagnosticCode);
				strictEqual(evidence.errorKind, testCase.errorKind);
				strictEqual(evidence.failurePhase, testCase.failurePhase);
				strictEqual(evidence.reasonCode, testCase.errorKind);
				const durable = JSON.stringify(evidence, (key, value) =>
					key === "timestamp" ? undefined : value,
				);
				ok(!durable.includes("9.9"));
				ok(!durable.includes("private-canary"));
				ok(!durable.includes("/private/canary"));
				ok(!durable.includes("raw provider output"));
			}
			if (testCase.name === "queue-preflight") {
				deepStrictEqual(run.preflightDetail, {
					reason: "no_eligible",
					rejections: [
						{
							capability: "standard",
							reason: "no_provider",
							excludedProviders: ["claude"],
							excludedReasons: { claude: "no_invocation_descriptor" },
						},
					],
				});
			}
			const disposition = projectDisposition({
				run,
				liveness: "terminal_clean",
				optionalEvidenceValid: false,
			});
			strictEqual(disposition.action, testCase.action);
			strictEqual(disposition.direction, testCase.direction);
			strictEqual(disposition.reasonCode, testCase.diagnosticCode);
		}
	});
});
