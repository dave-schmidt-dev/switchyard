import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getInvocationDescriptorIdentity } from "../src/switchyard/roster/index.mjs";
import {
	ROSTER_FIXTURE_PATH,
	runDispatch,
} from "./helpers/dispatch-cli-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

function writeLegacyCheckpoint(path, checkpoint) {
	writeFileSync(path, JSON.stringify(checkpoint, null, 2), "utf8");
}
function exactFailureEvidence(targetId, harness, model, taskId = "1.1") {
	const descriptorCore = {
		target_id: targetId,
		model_ref: model,
		selector: model,
		effort: null,
		variant: null,
		invocation_args: [],
	};
	const descriptorIdentity = getInvocationDescriptorIdentity(
		descriptorCore,
		harness,
	);
	return {
		taskId,
		success: false,
		provider: harness,
		model,
		resolvedTargetId: targetId,
		invocationDescriptor: {
			...descriptorCore,
			descriptor_identity: descriptorIdentity,
		},
		descriptorIdentity,
		descriptorHarness: harness,
		result: "execution_failed",
		errorKind: "execution_failed",
		reasonCode: "execution_failed",
		reason: "Provider execution failed before a reviewed integration.",
		diagnosticCode: "provider_exit_nonzero",
		diagnosticOrigin: "adapter",
		diagnosticEvidenceAvailable: true,
		exitCode: 1,
		failurePhase: "provider_execution",
	};
}
let dir;
let tasksFile;
let projectDir;
let stateRoot;
function makeStateRootEnv() {
	return { SWITCHYARD_RUN_STORE_ROOT: stateRoot };
}
beforeEach(async () => {
	dir = tempDir("switchyard-dispatch-cli-");
	stateRoot = join(dir, "state-root");
	tasksFile = join(dir, "tasks.md");
	writeFileSync(
		tasksFile,
		"### Task 1.1: Test task\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** A test\n",
		"utf8",
	);
	projectDir = join(dir, "project");
	mkdirSync(join(projectDir, ".git"), { recursive: true });

	// Set env var so direct run-store calls in tests target the temp dir
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
	rmSync(dir, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});
describe("envelope format", () => {
	it("keeps legacy untrusted descriptor evidence from ejecting a target", async () => {
		const { initializeRun, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const runId = "legacy-untrusted-descriptor-evidence";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});
		const trustedFixture = exactFailureEvidence(
			"opencode-go",
			"opencode",
			"fixture/opencode-standard",
		);
		const legacyUntrustedFixture = { ...trustedFixture };
		delete legacyUntrustedFixture.diagnosticCode;
		delete legacyUntrustedFixture.diagnosticOrigin;
		delete legacyUntrustedFixture.diagnosticEvidenceAvailable;
		delete legacyUntrustedFixture.exitCode;
		writeLegacyCheckpoint(`${tasksFile}.checkpoint.json`, {
			version: 1,
			tasksFilePath: tasksFile,
			completedTaskIds: [],
			lastTaskId: "1.1",
			lastUpdatedAt: new Date().toISOString(),
			results: [legacyUntrustedFixture],
		});
		const current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "failed",
				cleanupState: "complete",
				lastFailure: {
					errorKind: "execution_failed",
					reasonCode: "execution_failed",
					reason: "Provider execution failed before a reviewed integration.",
					failurePhase: "provider_execution",
					resolvedTargetId: trustedFixture.resolvedTargetId,
					descriptorIdentity: trustedFixture.descriptorIdentity,
					descriptorHarness: trustedFixture.descriptorHarness,
				},
				terminalizedBy: "worker",
				terminalSummary: { processedTasks: 1 },
			},
			current.revision,
		);

		for (const [command, expectedStatus] of [
			["status", 0],
			["result", 1],
		]) {
			const response = runDispatch([command, runId], makeStateRootEnv());
			strictEqual(response.status, expectedStatus);
			const envelope = JSON.parse(response.stdout.trim());
			strictEqual(envelope.disposition.action, "stop");
			strictEqual(envelope.disposition.reasonCode, "insufficient_evidence");
			deepStrictEqual(envelope.disposition.failedTargetIds, []);
		}
	});
	it("checkpoint evidence with a mismatched diagnostic origin cannot eject a target", async () => {
		const { initializeRun, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const runId = "wrong-origin-checkpoint-evidence";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});
		const wrongOrigin = exactFailureEvidence(
			"opencode-go",
			"opencode",
			"fixture/opencode-standard",
		);
		wrongOrigin.diagnosticCode = "cli_usage_error";
		wrongOrigin.diagnosticOrigin = "adapter";
		writeLegacyCheckpoint(`${tasksFile}.checkpoint.json`, {
			version: 1,
			tasksFilePath: tasksFile,
			completedTaskIds: [],
			lastTaskId: "1.1",
			lastUpdatedAt: new Date().toISOString(),
			results: [wrongOrigin],
		});
		const current = await readRun(runId);
		const trustedTerminal = exactFailureEvidence(
			"opencode-go",
			"opencode",
			"fixture/opencode-standard",
		);
		await updateRun(
			runId,
			{
				state: "failed",
				cleanupState: "complete",
				lastFailure: {
					errorKind: trustedTerminal.errorKind,
					reasonCode: trustedTerminal.reasonCode,
					reason: trustedTerminal.reason,
					diagnosticCode: trustedTerminal.diagnosticCode,
					diagnosticOrigin: trustedTerminal.diagnosticOrigin,
					diagnosticEvidenceAvailable: true,
					exitCode: trustedTerminal.exitCode,
					failurePhase: trustedTerminal.failurePhase,
					resolvedTargetId: trustedTerminal.resolvedTargetId,
					descriptorIdentity: trustedTerminal.descriptorIdentity,
					descriptorHarness: trustedTerminal.descriptorHarness,
				},
				terminalizedBy: "worker",
				terminalSummary: { processedTasks: 1 },
			},
			current.revision,
		);

		for (const [command, expectedStatus] of [
			["status", 0],
			["result", 1],
		]) {
			const response = runDispatch([command, runId], makeStateRootEnv());
			strictEqual(response.status, expectedStatus);
			const envelope = JSON.parse(response.stdout.trim());
			strictEqual(envelope.disposition.action, "stop");
			strictEqual(envelope.disposition.reasonCode, "insufficient_evidence");
			deepStrictEqual(envelope.disposition.failedTargetIds, []);
		}
	});
	it("six sanitized OpenCode failures emit bounded target evidence without cooldown state", async () => {
		const {
			createEvent,
			initializeRun,
			persistDiagnosticArtifact,
			readRun,
			updateRun,
		} = await import("../src/switchyard/run-store/index.mjs");
		const runId = "opencode-six-failures";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});
		writeLegacyCheckpoint(`${tasksFile}.checkpoint.json`, {
			version: 1,
			tasksFilePath: tasksFile,
			completedTaskIds: [],
			lastTaskId: "1.1",
			lastUpdatedAt: new Date().toISOString(),
			results: [],
		});
		const diagnosticRef = await persistDiagnosticArtifact(runId, {
			stdoutBytes: 0,
			stderrBytes: 0,
			stdoutDigest: `sha256:${"a".repeat(64)}`,
			stderrDigest: `sha256:${"b".repeat(64)}`,
			diagnosticKind: "auth_required",
		});
		ok(diagnosticRef, "fixture must persist bounded diagnostic evidence");
		const failureEvidence = exactFailureEvidence(
			"opencode-go",
			"opencode",
			"fixture/opencode-standard",
		);
		for (let attempt = 0; attempt < 6; attempt += 1) {
			await createEvent(runId, {
				...failureEvidence,
				phase: "execution",
				event: "task_failed",
				status: "Task 1.1 failed",
				diagnosticRef,
			});
		}
		const current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "failed",
				cleanupState: "complete",
				terminalizedBy: "worker",
				terminalSummary: { processedTasks: 1 },
			},
			current.revision,
		);

		const response = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(response.status, 1);
		const envelope = JSON.parse(response.stdout.trim());
		deepStrictEqual(envelope.disposition.failedTargetIds, ["opencode-go"]);
		strictEqual(Object.hasOwn(envelope, "cooldown"), false);
		strictEqual(Object.hasOwn(envelope.disposition, "cooldown"), false);
		const persistedRun = await readRun(runId);
		strictEqual(Object.hasOwn(persistedRun, "cooldown"), false);
	});
});
