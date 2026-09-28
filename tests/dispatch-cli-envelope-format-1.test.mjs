import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { createHash } from "node:crypto";
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
	it("launch envelope has required fields", () => {
		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		const envelope = JSON.parse(result.stdout.trim());
		const required = [
			"schemaVersion",
			"runId",
			"state",
			"stateRoot",
			"statusCommand",
			"resultCommand",
		];
		for (const key of required) {
			ok(key in envelope, `launch envelope missing field: ${key}`);
		}
		strictEqual(envelope.schemaVersion, 2);
		strictEqual(envelope.state, "launcher_ready");
	});
	it("status envelope has required fields", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		await initializeRun({
			runId: "env-status",
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const result = runDispatch(["status", "env-status"], makeStateRootEnv());
		const envelope = JSON.parse(result.stdout.trim());
		const required = [
			"schemaVersion",
			"runId",
			"state",
			"cleanupState",
			"activeTaskId",
			"resolvedTargetId",
			"snapshotStatus",
			"snapshotMtime",
			"snapshotAgeMsAtRoute",
			"completedCount",
			"failedCount",
			"lastFailure",
			"startedAt",
			"finishedAt",
			"updatedAt",
			"queueStartedAt",
			"elapsedMs",
			"totalTaskCount",
			"pendingCount",
			"runningCount",
			"lastCompletionAt",
			"elapsedSinceLastCompletionMs",
			"activeTaskAgeMs",
			"activeTaskRemainingMs",
		];
		for (const key of required) {
			ok(key in envelope, `status envelope missing field: ${key}`);
		}
		strictEqual(envelope.outcomeProjection.reader, "legacy");
	});
	it("result envelope has required fields", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		await initializeRun({
			runId: "env-result",
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const current = await readRun("env-result");
		await updateRun(
			"env-result",
			{
				state: "succeeded",
				cleanupState: "complete",
				terminalSummary: { completedTaskIds: ["1.1"] },
			},
			current.revision,
		);

		const result = runDispatch(["result", "env-result"], makeStateRootEnv());
		const envelope = JSON.parse(result.stdout.trim());
		const required = [
			"schemaVersion",
			"runId",
			"state",
			"cleanupState",
			"activeTaskId",
			"resolvedTargetId",
			"snapshotStatus",
			"snapshotMtime",
			"snapshotAgeMsAtRoute",
			"completedCount",
			"failedCount",
			"lastFailure",
			"startedAt",
			"finishedAt",
			"updatedAt",
			"terminalSummary",
			"artifactRefs",
			"queueStartedAt",
			"elapsedMs",
			"totalTaskCount",
			"pendingCount",
			"runningCount",
			"lastCompletionAt",
			"elapsedSinceLastCompletionMs",
			"activeTaskAgeMs",
			"activeTaskRemainingMs",
		];
		for (const key of required) {
			ok(key in envelope, `result envelope missing field: ${key}`);
		}
		strictEqual(envelope.outcomeProjection.reader, "legacy");
	});
	it("drops a lastFailure artifact ref the artifacts channel cannot resolve", async () => {
		// Run eab7d23c (2026-08-25) persisted `lastFailure.artifactRef` while
		// `artifactRefs` was `[]`: the ref is derived unconditionally from the
		// task id, but the copy into the artifacts channel is best-effort and
		// swallows its own failure. An operator then cannot tell a lost artifact
		// from a bad pointer. Report only what the run can actually produce.
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const runId = "dangling-artifact-ref";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});
		const lastFailure = {
			errorKind: "integration_failed",
			reasonCode: "integration_failed",
			reason: "The reviewed integration gate rejected the task result.",
			artifactRef: "artifact:0123456789abcdef01234567",
		};
		let current = await readRun(runId);
		await updateRun(runId, { lastFailure }, current.revision);

		const statusEnvelope = JSON.parse(
			runDispatch(["status", runId], makeStateRootEnv()).stdout.trim(),
		);

		current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				terminalSummary: { completedTaskIds: ["1.1"] },
			},
			current.revision,
		);
		const resultEnvelope = JSON.parse(
			runDispatch(["result", runId], makeStateRootEnv()).stdout.trim(),
		);

		deepStrictEqual(resultEnvelope.artifactRefs, []);
		strictEqual(resultEnvelope.lastFailure.artifactRef, undefined);
		// Both envelopes must agree, or `status` advertises a ref `result` denies.
		strictEqual(statusEnvelope.lastFailure.artifactRef, undefined);
		// Dropping the ref must not drop the diagnosis with it.
		strictEqual(resultEnvelope.lastFailure.reasonCode, "integration_failed");
		deepStrictEqual(statusEnvelope.lastFailure, resultEnvelope.lastFailure);
	});
	it("capstone: status and result preserve the same bounded route/failure projection", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const runId = "unconditional-contract-projection";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});
		// The ref must be one the artifacts channel can actually resolve, or both
		// envelopes now drop it as unresolvable. `listArtifactRefs` hashes the
		// file NAME, so seed a real artifact and derive the ref from its name.
		const { getRunRoot } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const artifactsDir = join(getRunRoot(runId), "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		writeFileSync(join(artifactsDir, "1.1.diff"), "partial\n", "utf8");
		const resolvableRef = `artifact:${createHash("sha256")
			.update("1.1.diff")
			.digest("hex")
			.slice(0, 24)}`;
		const routeAndFailure = {
			resolvedTargetId: "agy-gemini",
			snapshotStatus: "stale",
			snapshotMtime: 1_754_000_000_000,
			snapshotAgeMsAtRoute: 301_000,
			lastFailure: {
				errorKind: "integration_failed",
				reasonCode: "integration_failed",
				reason: "The reviewed integration gate rejected the task result.",
				artifactRef: resolvableRef,
			},
		};
		let current = await readRun(runId);
		await updateRun(runId, routeAndFailure, current.revision);
		const retryProjection = {
			quarantinedTargetIds: ["agy-gemini"],
			retryState: null,
			retryTransitionId: 2,
		};
		writeLegacyCheckpoint(`${tasksFile}.checkpoint.json`, {
			version: 1,
			tasksFilePath: tasksFile,
			completedTaskIds: [],
			lastTaskId: null,
			lastUpdatedAt: null,
			results: [],
			...retryProjection,
		});

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0, `stderr: ${statusResult.stderr}`);
		const statusEnvelope = JSON.parse(statusResult.stdout.trim());

		current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				terminalSummary: { completedTaskIds: ["1.1"] },
			},
			current.revision,
		);
		const resultResult = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(resultResult.status, 0, `stderr: ${resultResult.stderr}`);
		const resultEnvelope = JSON.parse(resultResult.stdout.trim());

		for (const envelope of [statusEnvelope, resultEnvelope]) {
			for (const [key, expected] of Object.entries(routeAndFailure)) {
				deepStrictEqual(envelope[key], expected, `${key} projection drifted`);
			}
			for (const [key, expected] of Object.entries(retryProjection)) {
				deepStrictEqual(
					envelope[key],
					expected,
					`${key} retry projection drifted`,
				);
			}
		}
		strictEqual(statusEnvelope.startedAt, resultEnvelope.startedAt);
		strictEqual(statusEnvelope.finishedAt, resultEnvelope.finishedAt);
		ok(
			!JSON.stringify({ statusEnvelope, resultEnvelope }).includes(
				"SECRET_CANARY",
			),
		);
	});
	it("status and result project descriptor-bound Agy-to-OpenCode checkpoint evidence", async () => {
		const { initializeRun, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const runId = "agy-opencode-attempts";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});
		const agyFailure = exactFailureEvidence(
			"antigravity",
			"agy",
			"fixture-agy-standard",
		);
		const opencodeFailure = exactFailureEvidence(
			"opencode-go",
			"opencode",
			"fixture/opencode-standard",
		);
		writeLegacyCheckpoint(`${tasksFile}.checkpoint.json`, {
			version: 1,
			tasksFilePath: tasksFile,
			completedTaskIds: [],
			lastTaskId: "1.1",
			lastUpdatedAt: new Date().toISOString(),
			results: [agyFailure, opencodeFailure],
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
					diagnosticCode: "provider_exit_nonzero",
					diagnosticOrigin: "adapter",
					diagnosticEvidenceAvailable: true,
					exitCode: 1,
					failurePhase: "provider_execution",
					resolvedTargetId: opencodeFailure.resolvedTargetId,
					descriptorIdentity: opencodeFailure.descriptorIdentity,
					descriptorHarness: opencodeFailure.descriptorHarness,
				},
				terminalizedBy: "worker",
				terminalSummary: { processedTasks: 1 },
			},
			current.revision,
		);

		const statusEnvelope = JSON.parse(
			runDispatch(["status", runId], makeStateRootEnv()).stdout.trim(),
		);
		const resultResponse = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(resultResponse.status, 1);
		const resultEnvelope = JSON.parse(resultResponse.stdout.trim());
		for (const envelope of [statusEnvelope, resultEnvelope]) {
			strictEqual(envelope.disposition.action, "target_failed");
			strictEqual(envelope.disposition.taskId, "1.1");
			deepStrictEqual(envelope.disposition.failedTargetIds, [
				"antigravity",
				"opencode-go",
			]);
		}
	});
});
