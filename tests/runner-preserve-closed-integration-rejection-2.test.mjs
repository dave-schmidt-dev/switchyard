import { ok, strictEqual } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	INTEGRATION_REFUSAL_KINDS,
	sanitizeFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";
import {
	integrationFailureMetadata,
	loadCheckpoint,
} from "../src/switchyard/runner/index.mjs";
import {
	descriptorForRoute,
	executeTaskAsync,
	executeTaskWithOrchestrator,
	runnerTestDir,
	runQueue,
	withExplicitSwitchyardExecutor,
} from "./helpers/runner-fixtures.mjs";

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
	it("projects reasonKind first when both reasonKind and allowlisted message are present", () => {
		const result = integrationFailureMetadata("t-1", "", false, {
			success: false,
			reasonKind: "conflict",
			message: "no_op_diff",
		});
		strictEqual(result.diagnosticCode, "conflict");
	});
	it("accepts allowlisted structural codes via message when reasonKind is absent", () => {
		for (const kind of [
			"empty_required_diff",
			"required_paths_missing",
			"undeclared_paths_touched",
			"no_op_diff",
			...INTEGRATION_REFUSAL_KINDS.filter(
				(kind) => kind !== "integration_state_unknown",
			),
		]) {
			const result = integrationFailureMetadata("t-1", "", false, {
				success: false,
				message: kind,
			});
			strictEqual(result.diagnosticCode, kind);
		}
	});
	it("prefers reasonKind over an allowlisted message for diagnostic projection", () => {
		const result = integrationFailureMetadata("t-1", "", false, {
			success: false,
			reasonKind: "conflict",
			message: "empty_required_diff",
			diagnosticCode: "required_paths_missing",
		});
		strictEqual(result.diagnosticCode, "conflict");
	});
	it("does not infer integration_state_unknown from message text", () => {
		const result = integrationFailureMetadata("t-1", "", false, {
			success: false,
			message: "integration_state_unknown",
		});
		strictEqual(result.diagnosticCode, undefined);
	});
	it("discards untrusted diagnosticCode values when reasonKind/message are untrusted", () => {
		const arbitraryCode = "PROSE_CANARY_untrusted_diagnostic_code_abc_42";
		const result = integrationFailureMetadata("t-1", "", false, {
			success: false,
			message: arbitraryCode,
			diagnosticCode: arbitraryCode,
		});
		strictEqual(result.diagnosticCode, undefined);
	});
	it("arbitrary gate prose produces no match in durable and JSON fixtures", () => {
		const arbitraryProse = "PROSE_CANARY_arbitrary_untrusted_gate_prose_xyz_42";
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Arbitrary prose task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Test discarding arbitrary gate prose
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		const queueResult = runQueue({
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
				recordDispatch: () => {},
				integrationGate: () => ({
					success: false,
					message: arbitraryProse,
					diagnosticCode: arbitraryProse,
				}),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/src/a.mjs b/src/a.mjs",
					},
				},
			},
		});

		const [taskResult] = queueResult.results;
		strictEqual(taskResult.diagnosticCode, undefined);
		strictEqual(taskResult.errorKind, "integration_failed");
		strictEqual(taskResult.reasonCode, "integration_failed");

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results[0].diagnosticCode, undefined);

		const gateValidatedEvent = events.find((e) => e.event === "gate_validated");
		ok(gateValidatedEvent);
		strictEqual(gateValidatedEvent.diagnosticCode, undefined);

		const taskFailedEvent = events.find((e) => e.event === "task_failed");
		ok(taskFailedEvent);
		strictEqual(taskFailedEvent.diagnosticCode, undefined);

		const lastFailure = sanitizeFailureMetadata(taskResult);
		strictEqual(lastFailure.diagnosticCode, undefined);

		// Assert that arbitrary prose text is NEVER matched in any serialized/durable fixture
		ok(!JSON.stringify(taskResult).includes(arbitraryProse));
		ok(!JSON.stringify(checkpoint).includes(arbitraryProse));
		ok(!JSON.stringify(events).includes(arbitraryProse));
		ok(!JSON.stringify(lastFailure).includes(arbitraryProse));
		const rawCheckpointOnDisk = readFileSync(checkpointPath, "utf8");
		ok(!rawCheckpointOnDisk.includes(arbitraryProse));
	});
	it("preserves every closed rejection code in executeTaskAsync and executeTaskWithOrchestrator", async () => {
		for (const fixture of CLOSED_INTEGRATION_FIXTURES) {
			const invocationDescriptor = descriptorForRoute({
				provider: "claude",
				model: "claude-sonnet-5",
			});
			const selectedRoute = {
				reservation: { id: "res-1" },
				provider: "claude",
				model: "claude-sonnet-5",
				resolvedTarget: "claude",
				harness: "claude",
				capability: "standard",
				effort: null,
				percentLeft: 70,
				reason: "spread",
				snapshotIdentity: {
					status: "fresh",
					mtime: new Date().toISOString(),
					ageMs: 0,
				},
			};
			const asyncResult = await executeTaskAsync(
				{
					id: "1.1",
					title: "task",
					description: "test",
					requiredPaths: ["src/a.mjs"],
				},
				{
					broker: {
						selectAndReserve: async () => selectedRoute,
						launcherIdentity: () => ({
							provider: selectedRoute.provider,
							resolvedTarget: selectedRoute.resolvedTarget,
							harness: selectedRoute.harness,
							model: selectedRoute.model,
							effort: selectedRoute.effort,
							descriptorIdentity: invocationDescriptor.descriptor_identity,
							reservationId: selectedRoute.reservation.id,
						}),
						execute: async () => ({ success: true }),
						release: async () => {},
					},
					resolveDescriptor: () => invocationDescriptor,
					recordDispatch: async () => {},
					recordDispatchIntent: async () => {},
					integrationGate: () => fixture.gateResult,
					adapters: {
						claude: {
							executeAsync: async () => ({ success: true, output: "ok" }),
							captureDiffAsync: async () =>
								"diff --git a/src/a.mjs b/src/a.mjs",
						},
					},
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
				},
			);
			strictEqual(
				asyncResult.diagnosticCode,
				fixture.code,
				`executeTaskAsync failed to preserve ${fixture.code}`,
			);

			const orchEvents = [];
			const orchResult = await executeTaskWithOrchestrator(
				{
					id: "1.1",
					title: "task",
					description: "test",
					requiredPaths: ["src/a.mjs"],
				},
				{
					route: () => ({
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 70,
						reason: "spread",
					}),
					recordDispatch: async () => {},
					recordDispatchIntent: () => {},
					integrationGate: () => fixture.gateResult,
					orchestrator: {
						launch: async () => "job-1",
						status: async () => ({ state: "done" }),
						result: async () => ({
							success: true,
							diff: "diff --git a/src/a.mjs b/src/a.mjs",
						}),
					},
					onStatus: (e) => orchEvents.push(e),
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
				},
			);
			strictEqual(
				orchResult.diagnosticCode,
				fixture.code,
				`executeTaskWithOrchestrator failed to preserve ${fixture.code}`,
			);
			const orchGateValidated = orchEvents.find(
				(e) => e.event === "gate_validated",
			);
			ok(orchGateValidated);
			strictEqual(orchGateValidated.diagnosticCode, fixture.code);
		}
	});
});
