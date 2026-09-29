import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	parseQualificationArgs,
	productionDispatch,
	spawnBounded,
	taskMarkdown,
} from "../scripts/provider-qualification.mjs";
import { getInvocationDescriptorIdentity } from "../src/switchyard/roster/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const deadlineAt = new Date(Date.now() + 60_000).toISOString();
const descriptor = {
	target_id: "codex",
	model_ref: "fixture/codex/standard",
	selector: "gpt-5.6-terra",
	effort: "high",
	variant: null,
	invocation_args: ["-c", "model_reasoning_effort=high"],
	descriptor_identity: `sha256:${"a".repeat(64)}`,
};
const plan = {
	lane: "simple",
	targetId: "codex",
	capability: "standard",
	selector: descriptor.selector,
	descriptorIdentity: descriptor.descriptor_identity,
	descriptor,
};

test("CLI parser requires an explicit bounded deadline and has no implicit execution mode", () => {
	assert.deepEqual(parseQualificationArgs([]), {
		help: false,
		targetId: null,
		capability: null,
		descriptorIdentity: null,
		execute: false,
		deadlineMs: null,
	});
	assert.throws(
		() =>
			parseQualificationArgs([
				"--target",
				"codex",
				"--capability",
				"standard",
				"--execute",
			]),
		/deadline_required_for_execute/u,
	);
	assert.throws(
		() =>
			parseQualificationArgs([
				"--target",
				"codex",
				"--capability",
				"standard",
				"--deadline",
				deadlineAt,
			]),
		/deadline_requires_execute/u,
	);
	assert.equal(
		parseQualificationArgs([
			"--target",
			"codex",
			"--capability",
			"standard",
			"--execute",
			"--deadline",
			deadlineAt,
		]).execute,
		true,
	);
});

test("bounded CLI child rejects timeout and output overflow after process-group cleanup", async () => {
	await assert.rejects(
		spawnBounded(
			["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
			{ timeoutMs: 100 },
		),
		(error) => error.code === "deadline_expired",
	);
	await assert.rejects(
		spawnBounded(["-e", "process.stdout.write('x'.repeat(2_100_000));"], {
			timeoutMs: 10_000,
		}),
		(error) => error.code === "dispatch_output_invalid",
	);
});

test("simple CLI production arguments bind one selected provider and preserve only observed descriptor receipt", async () => {
	const root = tempDir("provider-qualification-cli-simple-");
	const fixture = {
		promptPath: join(root, "task.prompt"),
		projectPath: join(root, "project"),
	};
	const calls = [];
	const receipt = await productionDispatch({
		plan,
		fixture,
		allowedFiles: ["src/summary.mjs", "tests/summary.test.mjs"],
		deadlineAt,
		spawnCommand: async (args) => {
			calls.push(args);
			return {
				runId: "run-1",
				status: "succeeded",
				checks: [{ index: 1, status: "passed" }],
				invocationDescriptor: descriptor,
				descriptorIdentity: descriptor.descriptor_identity,
				changedFiles: ["src/summary.mjs", "tests/summary.test.mjs"],
			};
		},
		readRunRecord: async () => ({
			resolvedTargetId: "codex",
			activeTaskModel: "gpt-5.6-terra",
		}),
	});
	const args = calls[0];
	assert.equal(args[1], "simple");
	assert.equal(args[args.indexOf("--only-provider") + 1], "codex");
	assert.equal(args[args.indexOf("--capability") + 1], "standard");
	assert.equal(args.filter((item) => item === "--file").length, 2);
	assert.equal(
		args[args.indexOf("--check") + 1],
		"node --test tests/acceptance.test.mjs",
	);
	assert.equal(receipt.targetId, "codex");
	assert.equal(receipt.routeModel, "gpt-5.6-terra");
	assert.deepEqual(receipt.invocationDescriptor, descriptor);
	assert.equal(receipt.descriptorIdentity, descriptor.descriptor_identity);
	assert.deepEqual(receipt.checkCommands, [
		"node --test tests/acceptance.test.mjs",
	]);

	const noDescriptor = await productionDispatch({
		plan,
		fixture,
		allowedFiles: ["src/summary.mjs", "tests/summary.test.mjs"],
		deadlineAt,
		spawnCommand: async () => ({ runId: "run-2", status: "succeeded" }),
		readRunRecord: async () => ({ resolvedTargetId: "codex" }),
	});
	assert.equal(noDescriptor.invocationDescriptor, null);
	assert.equal(noDescriptor.descriptorIdentity, null);
});

test("VM CLI dispatch checks lane readiness and binds one synthetic task to its check receipt", async () => {
	const root = tempDir("provider-qualification-cli-vm-");
	const fixture = {
		projectPath: join(root, "project"),
		taskPath: join(root, "TASKS.md"),
		checkpointPath: join(root, "checkpoint.json"),
	};
	const vmDescriptor = {
		target_id: "claude-code",
		model_ref: "fixture/claude/high",
		selector: "claude-opus-5-5",
		effort: "high",
		variant: null,
		invocation_args: ["--effort", "high"],
	};
	vmDescriptor.descriptor_identity = getInvocationDescriptorIdentity(
		vmDescriptor,
		"claude",
	);
	const vmPlan = {
		...plan,
		lane: "vm",
		targetId: "claude-code",
		capability: "high",
		harness: "claude",
		selector: "claude-opus-5-5",
		descriptorIdentity: vmDescriptor.descriptor_identity,
	};
	const providerResult = {
		taskId: "1",
		success: true,
		result: "success",
		resolvedTargetId: vmPlan.targetId,
		descriptorIdentity: vmPlan.descriptorIdentity,
		invocationDescriptor: vmDescriptor,
		quickCheckReceipt: { status: "passed", taskId: "1" },
		cleanupFailed: false,
		cleanupStage: "index_lock_removed",
		providerLifecycle: {
			writerLifecycle: "stopped",
			terminalStatus: "exited",
			cleanupStatus: "succeeded",
			cleanupStage: "index_lock_removed",
		},
	};
	const calls = [];
	const receipt = await productionDispatch({
		plan: vmPlan,
		fixture,
		allowedFiles: ["src/summary.mjs", "tests/summary.test.mjs"],
		deadlineAt,
		spawnCommand: async (args) => {
			calls.push(args);
			return calls.length === 1
				? { ready: true }
				: {
						runId: "vm-run-1",
						cleanupState: "complete",
						results: [providerResult],
					};
		},
		readRunRecord: async () => ({
			cleanupState: "complete",
			worktree: { state: "removed" },
		}),
		projectLockHeld: async () => false,
	});
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0].slice(1), ["backend-health", "--json"]);
	const args = calls[1];
	assert.equal(args[1], "run");
	assert.equal(args[args.indexOf("--only-provider") + 1], "claude-code");
	assert.equal(args[args.indexOf("--max-tasks") + 1], "1");
	assert.ok(args.includes("--qualification-attempt"));
	assert.equal(receipt.targetId, "claude-code");
	assert.deepEqual(receipt.invocationDescriptor, vmDescriptor);
	assert.deepEqual(receipt.quickCheckReceipt, providerResult.quickCheckReceipt);
	assert.equal(receipt.cleanup.writer.state, "stopped");
	assert.equal(receipt.cleanup.worktree.state, "removed");
	assert.equal(receipt.cleanup.projectLock.state, "released");
	const task = readFileSync(fixture.taskPath, "utf8");
	assert.match(task, /RequiredCapability:\*\*\s*high/u);
	assert.match(
		task,
		/Quick checks:\*\*\s*node --test tests\/acceptance\.test\.mjs/u,
	);
	assert.match(taskMarkdown(vmPlan), /Do not touch any other path/u);

	await assert.rejects(
		productionDispatch({
			plan: vmPlan,
			fixture,
			allowedFiles: ["src/summary.mjs", "tests/summary.test.mjs"],
			deadlineAt,
			spawnCommand: async () => ({ ready: false }),
		}),
		(error) => error.code === "vm_lane_unavailable",
	);
});
