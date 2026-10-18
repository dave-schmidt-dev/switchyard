// @test-phase: other
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
	parseQualificationArgs,
	productionDispatch,
	spawnBounded,
} from "../scripts/provider-qualification.mjs";
import { HANG_GUARD_MS } from "./helpers/hang-guard.mjs";
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
		lane: null,
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

test("CLI parser accepts only the simple lane, bound to an explicit target", () => {
	assert.equal(
		parseQualificationArgs([
			"--target",
			"vibe-code",
			"--capability",
			"low",
			"--lane",
			"simple",
		]).lane,
		"simple",
	);
	assert.throws(
		() =>
			parseQualificationArgs([
				"--target",
				"vibe-code",
				"--capability",
				"low",
				"--lane",
				"bogus",
			]),
		/invalid_lane/u,
	);
	// The retired VM lane is now just another unknown value.
	assert.throws(
		() =>
			parseQualificationArgs([
				"--target",
				"vibe-code",
				"--capability",
				"low",
				"--lane",
				"vm",
			]),
		/invalid_lane/u,
	);
	assert.throws(
		() => parseQualificationArgs(["--lane", "simple"]),
		/target_and_capability_required/u,
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
		// The deadline only has to outlast a loaded host's launch stalls; the
		// overflow, not the clock, must decide this case.
		spawnBounded(["-e", "process.stdout.write('x'.repeat(2_100_000));"], {
			timeoutMs: HANG_GUARD_MS,
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
	assert.equal(args[args.indexOf("--origin") + 1], "qualification");
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

test("CLI dispatch fails closed before spawning for a slot without the simple lane", async () => {
	const calls = [];
	await assert.rejects(
		productionDispatch({
			plan: {
				...plan,
				lane: null,
				laneReadiness: "simple_adapter_unavailable",
			},
			fixture: { projectPath: "/unused", promptPath: "/unused/task.prompt" },
			allowedFiles: ["src/summary.mjs", "tests/summary.test.mjs"],
			deadlineAt,
			spawnCommand: async (args) => {
				calls.push(args);
				return {};
			},
		}),
		(error) =>
			error.code === "provider_lane_unavailable" &&
			error.providerNeverStarted === true,
	);
	assert.deepEqual(calls, []);
});
