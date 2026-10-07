import { ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadCheckpoint } from "../src/switchyard/runner/index.mjs";
import {
	descriptorForRoute,
	runnerTestDir,
	runQueueAsync,
	withExplicitSwitchyardExecutor,
} from "./helpers/async-runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
function writeTasksFile(content) {
	mkdirSync(TEST_DIR, { recursive: true });
	const tasksPath = join(TEST_DIR, "tasks.md");
	writeFileSync(tasksPath, withExplicitSwitchyardExecutor(content), "utf8");
	return tasksPath;
}
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("runQueue non-timeout rejection diff persistence (Task D.4)", () => {
	it("persists a non-timeout, non-credential integrationGate rejection's diff to disk, same as the timeout path", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Rejected task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** produces a diff the gate rejects for a non-credential reason
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const diffText =
			"diff --git a/wip.mjs b/wip.mjs\n+SECRET_CANARY_rejected_marker";
		const dispatches = [];
		const events = [];

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				onStatus: (event) => events.push(event),
				integrationGate: () => ({
					success: false,
					message: "SECRET_CANARY_gate_message",
				}),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						executeAsync: async () => ({
							success: true,
							output: "",
							error: null,
						}),
						captureDiffAsync: async () => diffText,
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		const [taskResult] = result.results;
		strictEqual(taskResult.success, false);
		strictEqual(taskResult.result, "integration_failed");
		strictEqual(taskResult.errorKind, "integration_failed");
		strictEqual(taskResult.reasonCode, "integration_failed");
		strictEqual(
			taskResult.reason,
			"The reviewed integration gate rejected the task result.",
		);
		strictEqual(taskResult.artifactRef, undefined);
		strictEqual(
			taskResult.partialDiff,
			undefined,
			"raw diff text must not ride along in the in-memory result once persisted",
		);
		ok(taskResult.partialDiffPath, "result carries the artifact path");
		ok(existsSync(taskResult.partialDiffPath));
		strictEqual(readFileSync(taskResult.partialDiffPath, "utf8"), diffText);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results[0].partialDiffPath, null);
		strictEqual(checkpoint.results[0].errorKind, "integration_failed");
		strictEqual(checkpoint.results[0].reasonCode, "integration_failed");
		strictEqual(
			checkpoint.results[0].reason,
			"The reviewed integration gate rejected the task result.",
		);
		strictEqual(checkpoint.results[0].artifactRef, undefined);
		// BLOCKED (Task 5.9b): the async queue loop has no `task_failed` status
		// event; only the synchronous settlement path emits one.
		strictEqual(dispatches.length, 1);
		strictEqual(dispatches[0].errorKind, "integration_failed");
		strictEqual(dispatches[0].reasonCode, "integration_failed");
		strictEqual(dispatches[0].artifactRef, undefined);
		ok(
			!JSON.stringify({ dispatches, events, checkpoint }).includes(
				"SECRET_CANARY_gate_message",
			),
		);

		const rawCheckpointJson = readFileSync(checkpointPath, "utf8");
		ok(
			!rawCheckpointJson.includes("SECRET_CANARY_rejected_marker"),
			"checkpoint.json must reference the artifact by path only, never embed the diff text",
		);
		ok(
			!rawCheckpointJson.includes(taskResult.partialDiffPath),
			"checkpoint.json must not persist the host artifact path",
		);
	});

	it("records execution identity as a bounded verification flag, never the served string", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Verified task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** the adapter reads back which model actually served the run
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const baseDependencies = {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 72,
				reason: "spread",
			}),
			resolveDescriptor: () =>
				descriptorForRoute({
					provider: "claude",
					model: "claude-sonnet-5",
				}),
			recordDispatch: () => {},
			integrationGate: () => ({ success: true, message: "ok" }),
			ensureAgentContainer: () => {},
			createWorkingContainer: () => "generated-working-container",
			provisionCredentials: () => {},
			seedProject: () => {},
			commitWorkingTree: () => {},
			resetWorkingTree: () => {},
			wipeWorkingContainer: () => {},
		};
		const run = (executeAsync) =>
			runQueueAsync({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath: `${checkpointPath}.${randomUUID()}`,
				dependencies: {
					...baseDependencies,
					adapters: {
						claude: {
							executeAsync,
							captureDiffAsync: async () =>
								"diff --git a/src/a.mjs b/src/a.mjs\n+ok",
						},
					},
				},
			});

		const verified = await run(async () => ({
			success: true,
			output: "",
			error: null,
			servedModel: "claude-sonnet-5",
		}));
		strictEqual(verified.results[0].servedModelVerified, true);

		const unreadable = await run(async () => ({
			success: true,
			output: "",
			error: null,
			servedModel: null,
		}));
		strictEqual(unreadable.results[0].servedModelVerified, false);

		// Absent, not false: an adapter that cannot report one has not failed a
		// check, and recording `false` would say it had.
		const unsupported = await run(async () => ({
			success: true,
			output: "",
			error: null,
		}));
		strictEqual(unsupported.results[0].servedModelVerified, undefined);
		ok(!("servedModelVerified" in unsupported.results[0]));

		// The guest-supplied string itself never reaches a result.
		const echoed = await run(async () => ({
			success: true,
			output: "",
			error: null,
			servedModel: "SECRET_CANARY_served_model",
		}));
		ok(
			!JSON.stringify(echoed.results[0]).includes("SECRET_CANARY_served_model"),
		);
	});

	it("does not persist a provider transcript when the gate rejects an empty diff", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Empty-diff task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** the provider explains itself but changes nothing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const transcript =
			"I inspected src/a.mjs and concluded no change was required.";

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						executeAsync: async () => ({
							success: true,
							output: transcript,
							error: null,
						}),
						captureDiffAsync: async () => "",
					},
				},
			},
		});

		const [taskResult] = result.results;
		strictEqual(taskResult.success, false);
		strictEqual(
			taskResult.diagnosticCode ?? taskResult.reasonCode,
			"empty_required_diff",
		);
		const artifactPath = `${checkpointPath}.partial-diffs/1.1.output`;
		ok(!existsSync(artifactPath), "raw provider output must not be retained");
		strictEqual(taskResult.artifactRef, undefined);
		strictEqual(
			taskResult.gateEvidence,
			null,
			"raw transcript must not ride along in the result handed to onResult",
		);

		const rawCheckpointJson = readFileSync(checkpointPath, "utf8");
		ok(
			!rawCheckpointJson.includes(transcript),
			"checkpoint.json must reference the artifact, never embed the transcript",
		);
		ok(
			!rawCheckpointJson.includes(taskResult.gateEvidencePath),
			"checkpoint.json must not persist the host artifact path",
		);
	});

	it("keeps no transcript for a credential-flagged empty-diff rejection", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Empty-diff task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** the gate flags the rejection as credential-bearing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({
					success: false,
					message: "empty_required_diff",
					credentialFlagged: true,
				}),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						executeAsync: async () => ({
							success: true,
							output: "SECRET_CANARY_transcript",
							error: null,
						}),
						captureDiffAsync: async () => "",
					},
				},
			},
		});

		const artifactsDir = `${checkpointPath}.partial-diffs`;
		ok(
			!existsSync(artifactsDir) || readdirSync(artifactsDir).length === 0,
			"a credential-flagged rejection must keep no transcript either",
		);
	});

	it("NEVER persists a credential-flagged rejection's diff to disk (security property)", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Credential-flagged task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** produces a diff the gate rejects for touching a credential-convention path
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const diffText =
			"diff --git a/.env b/.env\n+SECRET_CANARY_must_never_touch_disk";

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({
					success: false,
					message: "diff touches a credential-convention path: .env",
					credentialFlagged: true,
				}),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						executeAsync: async () => ({
							success: true,
							output: "",
							error: null,
						}),
						captureDiffAsync: async () => diffText,
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		const [taskResult] = result.results;
		strictEqual(taskResult.success, false);
		strictEqual(
			taskResult.partialDiff,
			undefined,
			"credential-flagged diff must never even ride along in the in-memory result",
		);
		strictEqual(
			taskResult.partialDiffPath,
			undefined,
			"credential-flagged rejection must never produce an artifact path",
		);

		const artifactsDir = `${checkpointPath}.partial-diffs`;
		ok(
			!existsSync(artifactsDir) || readdirSync(artifactsDir).length === 0,
			"no artifact file may exist under .partial-diffs for a credential-flagged rejection",
		);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results[0].partialDiffPath, null);

		const rawCheckpointJson = readFileSync(checkpointPath, "utf8");
		ok(
			!rawCheckpointJson.includes("SECRET_CANARY_must_never_touch_disk"),
			"checkpoint.json must never embed a credential-flagged diff's text",
		);
	});
});
