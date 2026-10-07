import { ok, strictEqual } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	INTEGRATION_REFUSAL_KINDS,
	sanitizeFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";
import {
	executeTaskAsync,
	loadCheckpoint,
} from "../src/switchyard/runner/index.mjs";
import {
	descriptorForRoute,
	runnerTestDir,
	runQueueAsync,
	TASK_BASE,
	withExplicitSwitchyardExecutor,
} from "./helpers/async-runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
function writeTasksFile(content) {
	mkdirSync(TEST_DIR, { recursive: true });
	const tasksPath = join(TEST_DIR, "tasks.md");
	writeFileSync(tasksPath, withExplicitSwitchyardExecutor(content), "utf8");
	return tasksPath;
}
// Async-only single-task context: the broker seam is stubbed and the
// descriptor is derived from the routed provider/model so executeTaskAsync
// can run without the synchronous router.
function singleTaskContext(gateResult) {
	let latestDescriptor = null;
	return {
		broker: {
			selectAndReserve: async (request) => {
				const routed = {
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 70,
					reason: "spread",
				};
				latestDescriptor = descriptorForRoute(routed);
				return {
					provider: routed.provider,
					model: routed.model,
					resolvedTarget: routed.provider,
					harness: routed.provider,
					capability: request.capability,
					reason: routed.reason,
					reservation: { id: "test-reservation" },
					snapshotIdentity: { status: "fresh", mtime: null, ageMs: 0 },
				};
			},
			launcherIdentity: () => ({}),
			execute: async () => ({ success: true, output: "ok" }),
			release: async () => {},
		},
		resolveDescriptor: () => latestDescriptor,
		recordDispatch: () => {},
		recordDispatchIntent: () => {},
		integrationGate: () => gateResult,
		adapters: {
			claude: {
				executeAsync: async () => ({ success: true, output: "ok" }),
				captureDiffAsync: async () => "diff --git a/src/a.mjs b/src/a.mjs",
			},
		},
		queueBackend: {
			captureTaskBase: () => TASK_BASE,
			validateTaskBase: (_workspaceId, base) => base,
			releaseTaskBase: () => {},
		},
		projectPath: TEST_DIR,
		workingContainerName: "fake-container",
	};
}
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("preserve closed integration rejection codes (Task 1.3)", () => {
	const CLOSED_INTEGRATION_FIXTURES = [
		{
			name: "empty_required_diff",
			code: "empty_required_diff",
			gateResult: { success: false, message: "empty_required_diff" },
		},
		{
			name: "required_paths_missing",
			code: "required_paths_missing",
			gateResult: { success: false, message: "required_paths_missing" },
		},
		{
			name: "undeclared_paths_touched",
			code: "undeclared_paths_touched",
			gateResult: { success: false, message: "undeclared_paths_touched" },
		},
		{
			name: "no_op_diff",
			code: "no_op_diff",
			gateResult: { success: false, message: "no_op_diff" },
		},
		{
			name: "empty_diff",
			code: "empty_diff",
			gateResult: {
				success: false,
				message: "empty diff",
				reasonKind: "empty_diff",
			},
		},
		{
			name: "path_escapes_project_root",
			code: "path_escapes_project_root",
			gateResult: {
				success: false,
				message: "path escapes project root: /outside",
				reasonKind: "path_escapes_project_root",
			},
		},
		{
			name: "git_internals_touched",
			code: "git_internals_touched",
			gateResult: {
				success: false,
				message: "diff touches .git directory",
				reasonKind: "git_internals_touched",
			},
		},
		{
			name: "credential_path_touched",
			code: "credential_path_touched",
			gateResult: {
				success: false,
				message: "diff touches credential file: .env",
				reasonKind: "credential_path_touched",
				credentialFlagged: true,
			},
		},
		{
			name: "symlink_creation_refused",
			code: "symlink_creation_refused",
			gateResult: {
				success: false,
				message: "refusing to create symlink: link",
				reasonKind: "symlink_creation_refused",
			},
		},
		{
			name: "executable_file_refused",
			code: "executable_file_refused",
			gateResult: {
				success: false,
				message: "refusing executable mode: bin.sh",
				reasonKind: "executable_file_refused",
			},
		},
		{
			name: "manifest_review_required",
			code: "manifest_review_required",
			gateResult: {
				success: false,
				message:
					"diff touches a build/execution manifest file and requires AllowManifests: true",
				reasonKind: "manifest_review_required",
			},
		},
		{
			name: "corrupt_patch",
			code: "corrupt_patch",
			gateResult: {
				success: false,
				message: "diff could not be parsed by git apply",
				reasonKind: "corrupt_patch",
			},
		},
		{
			name: "conflict",
			code: "conflict",
			gateResult: {
				success: false,
				message: "Diff apply failed",
				reasonKind: "conflict",
			},
		},
		{
			name: "integration_state_unknown",
			code: "integration_state_unknown",
			gateResult: {
				success: false,
				message: "Diff apply failed",
				reasonKind: "integration_state_unknown",
			},
		},
		{
			name: "ambiguous_combined_rename_spelling",
			code: "ambiguous_combined_rename_spelling",
			gateResult: {
				success: false,
				message: "ambiguous_combined_rename_spelling",
				reasonKind: "ambiguous_combined_rename_spelling",
			},
		},
	];
	it("contains fixtures for every closed integration rejection code", () => {
		const expectedCodes = new Set([
			"empty_required_diff",
			"required_paths_missing",
			"undeclared_paths_touched",
			"no_op_diff",
			...INTEGRATION_REFUSAL_KINDS,
		]);
		strictEqual(CLOSED_INTEGRATION_FIXTURES.length, expectedCodes.size);
		strictEqual(CLOSED_INTEGRATION_FIXTURES.length, 15);
		for (const fixture of CLOSED_INTEGRATION_FIXTURES) {
			ok(
				expectedCodes.has(fixture.code),
				`${fixture.code} is not an expected closed integration code`,
			);
		}
	});
	for (const fixture of CLOSED_INTEGRATION_FIXTURES) {
		it(`preserves closed rejection '${fixture.name}' across result, event, checkpoint, lastFailure, and caller projection in runQueue`, async () => {
			const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Integration rejection task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Test preservation of ${fixture.name}
`);
			const checkpointPath = `${tasksPath}.checkpoint.json`;
			const events = [];
			const dispatches = [];

			const queueResult = await runQueueAsync({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				checkpointPath,
				dependencies: {
					onStatus: (e) => events.push(e),
					route: () => ({
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 70,
						reason: "spread",
					}),
					recordDispatch: (entry) => dispatches.push(entry),
					integrationGate: () => fixture.gateResult,
					adapters: {
						claude: {
							executeAsync: async () => ({ success: true, output: "ok" }),
							captureDiffAsync: async () =>
								"diff --git a/src/a.mjs b/src/a.mjs",
						},
					},
				},
			});

			// 1. Caller projection / result
			strictEqual(queueResult.results.length, 1);
			const [taskResult] = queueResult.results;
			strictEqual(taskResult.success, false);
			strictEqual(taskResult.result, "integration_failed");
			strictEqual(taskResult.diagnosticCode, fixture.code);

			// 2. BLOCKED (Task 5.5): the async queue emits no "gate_validated"
			// or "task_failed" onStatus events (those projections moved to the
			// typed outcome channel), so the event assertions cannot be ported
			// to runQueueAsync.

			// 3. Checkpoint (in-memory and durable JSON file)
			const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
			strictEqual(checkpoint.results[0].success, false);
			strictEqual(checkpoint.results[0].diagnosticCode, fixture.code);

			const durableCheckpoint = JSON.parse(
				readFileSync(checkpointPath, "utf8"),
			);
			strictEqual(durableCheckpoint.results[0].diagnosticCode, fixture.code);

			// 4. lastFailure projection
			const lastFailure = sanitizeFailureMetadata(taskResult);
			strictEqual(lastFailure.diagnosticCode, fixture.code);
			strictEqual(lastFailure.errorKind, "integration_failed");
			strictEqual(lastFailure.reasonCode, "integration_failed");

			// 5. Caller projection via executeTaskAsync
			const singleResult = await executeTaskAsync(
				{
					id: "1.1",
					title: "task",
					description: "test",
					requiredPaths: ["src/a.mjs"],
				},
				singleTaskContext(fixture.gateResult),
			);
			strictEqual(singleResult.diagnosticCode, fixture.code);
		});
	}
});
