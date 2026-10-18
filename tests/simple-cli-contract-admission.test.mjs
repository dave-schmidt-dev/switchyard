import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CLI_CONTRACT_FAILURE_REASON } from "../src/switchyard/cli-contract/canary.mjs";
import { validateInvocationDescriptor } from "../src/switchyard/roster/index.mjs";
import { readEvents, readRun } from "../src/switchyard/run-store/index.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { prepareSimpleProviderStart } from "../src/switchyard/simple/launcher-preflight.mjs";
import { REQUEST_END_PREFIX } from "../src/switchyard/simple/request-evidence.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import { fixture as routingFixture } from "./helpers/simple-routing-fixture.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const root = tempDir("cli-contract-admission-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(root, "runs");
const clean = async () => ({ success: true, writerLifecycle: "stopped" });
const end = `${REQUEST_END_PREFIX}${JSON.stringify({ requests: 0 })}\n`;
const drifted = Object.freeze({
	cli: "vibe",
	binary: "/fixture/vibe",
	resolvedPath: "/fixture/vibe",
	version: "3.0.0",
	status: "flags_missing",
	missingFlags: Object.freeze(["--trust"]),
	detail: null,
});

test("a drifted CLI fails admission before the probe, recorder or health fence", async () => {
	const order = [];
	const seen = [];
	const controller = new AbortController();
	const onProgress = () => {};
	const result = await prepareSimpleProviderStart({
		targetId: "vibe",
		deadlineMs: 50_000,
		now: () => 40_000,
		signal: controller.signal,
		onProgress,
		checkCliContract: async (context) => {
			seen.push(context);
			return drifted;
		},
		runProbe: async () => {
			order.push("probe");
			return clean();
		},
		recorderPath: join(root, "never.jsonl"),
		createRecorder: () => {
			order.push("recorder");
			throw Error("recorder must not open");
		},
		healthController: {
			start: async () => {
				order.push("health");
				return { allowed: true };
			},
		},
	});
	deepStrictEqual(order, []);
	strictEqual(result.success, false);
	strictEqual(result.failureReason, CLI_CONTRACT_FAILURE_REASON);
	strictEqual(result.providerStarted, false);
	strictEqual(result.writerLifecycle, "never_started");
	strictEqual(result.cliContract, drifted);
	strictEqual(seen.length, 1);
	strictEqual(seen[0].targetId, "vibe");
	strictEqual(seen[0].deadlineMs, 50_000);
	strictEqual(seen[0].now(), 40_000);
	strictEqual(seen[0].signal, controller.signal);
	strictEqual(seen[0].onProgress, onProgress);
});

test("a passing or inconclusive canary admits through the usual order", async () => {
	for (const status of ["ok", "unavailable"]) {
		const order = [];
		const result = await prepareSimpleProviderStart({
			targetId: "vibe",
			deadlineMs: Date.now() + 10_000,
			checkCliContract: async () => {
				order.push("canary");
				return { ...drifted, status, missingFlags: [] };
			},
			runProbe: async () => {
				order.push("probe");
				return clean();
			},
			healthController: {
				start: async () => {
					order.push("health");
					return { allowed: true, tracked: false };
				},
			},
		});
		deepStrictEqual(order, ["canary", "probe", "health"], status);
		strictEqual(result.cliContract.status, status);
	}
});

function engineFixture() {
	const projectPath = tempDir("cli-contract-project-");
	mkdirSync(join(projectPath, "src"));
	writeFileSync(join(projectPath, "src", "a.txt"), "base\n");
	execFileSync("git", ["init", "-q"], { cwd: projectPath });
	execFileSync("git", ["add", "-A"], { cwd: projectPath });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-qm",
			"base",
		],
		{ cwd: projectPath },
	);
	const promptPath = join(projectPath, "task.txt");
	writeFileSync(promptPath, "Change src/a.txt");
	const order = [];
	const statuses = [];
	const descriptor = validateInvocationDescriptor(
		{
			target_id: "vibe",
			model_ref: "fixture/vibe",
			selector: "glm-5-3",
			effort: null,
			variant: null,
			invocation_args: [],
		},
		"vibe",
	);
	const options = {
		projectPath,
		promptPath,
		capability: "standard",
		files: ["src/a.txt"],
		checks: [],
		deadlineMs: Date.now() + 240_000,
		onlyProviders: ["vibe"],
	};
	const deps = {
		tmpdir: () => root,
		onStatus: (status) => statuses.push(status),
		route: ({ availableProviders }) => ({
			provider: availableProviders[0],
			reason: "priority_fill",
		}),
		resolveTargetIdentity: (target) => ({
			targetId: target,
			harnessKey: "vibe",
			ambiguous: false,
		}),
		getInvocationDescriptor: () => descriptor,
		assertFundedRoute: () => {},
		runLauncherProbe: async () => {
			order.push("probe");
			return clean();
		},
		createSimpleRouteHealthController: () => ({
			prepare: async () => ({ allowed: true }),
			start: async () => {
				order.push("health");
				return { allowed: true, tracked: false };
			},
			terminal: async () => ({ settled: true }),
		}),
		executeProvider: async ({ worktreePath, onStderrChunk }) => {
			order.push("execute");
			writeFileSync(join(worktreePath, "src", "a.txt"), "candidate\n");
			onStderrChunk?.(Buffer.from(end));
			return { success: true, code: 0, writerLifecycle: "stopped" };
		},
		runCheck: async () => ({
			success: true,
			code: 0,
			writerLifecycle: "stopped",
		}),
		integrate: async () => ({ success: true }),
	};
	return { options, deps, order, statuses };
}

test("a drifted CLI ends the task typed at preflight with a bounded remedy, provider unstarted", async () => {
	const f = engineFixture();
	f.deps.checkProviderCliContract = async ({ targetId }) => {
		f.order.push(`canary:${targetId}`);
		return drifted;
	};
	const result = await runSimpleTask(f.options, f.deps);
	deepStrictEqual(f.order, ["canary:vibe"]);
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, CLI_CONTRACT_FAILURE_REASON);
	strictEqual(result.failurePhase, "preflight");
	strictEqual(result.errorKind, "environment_failure");
	strictEqual(result.providerStarted, false);
	strictEqual(result.recovery.cleanup.worktree.state, "removed");
	deepStrictEqual(result.preflightDetail, {
		code: CLI_CONTRACT_FAILURE_REASON,
		condition: "vibe 3.0.0 no longer accepts --trust",
		remedy:
			"port the adapter to the installed CLI or reinstall the qualified release; npm run cli:canary reports every adapter",
		cli: "vibe",
		status: "flags_missing",
		version: "3.0.0",
		missingFlags: ["--trust"],
	});
	const run = await readRun(result.runId);
	strictEqual(
		run.lastFailure.providerReliability.causeCode,
		"environment_failure",
	);
	strictEqual(run.lastFailure.providerReliability.phase, "preflight");
	strictEqual(run.failureDetails.failureReason, CLI_CONTRACT_FAILURE_REASON);
	const events = await readEvents(result.runId);
	strictEqual(
		events.some((event) => event.milestone === "provider_started"),
		false,
	);
});

test("an inconclusive canary admits the provider and reports the gap", async () => {
	const f = engineFixture();
	f.deps.checkProviderCliContract = async () => ({
		...drifted,
		status: "unavailable",
		missingFlags: [],
		detail: "timeout",
	});
	const result = await runSimpleTask(f.options, f.deps);
	strictEqual(result.status, "succeeded", JSON.stringify(result));
	deepStrictEqual(f.order, ["probe", "health", "execute"]);
	const unverified = f.statuses.find(
		(status) => status.milestone === "cli_contract_unverified",
	);
	ok(unverified, "no cli_contract_unverified milestone");
	strictEqual(unverified.cli, "vibe");
	strictEqual(unverified.cliContractDetail, "timeout");
	const events = await readEvents(result.runId);
	ok(events.some((event) => event.milestone === "cli_contract_unverified"));
});

test("routing excludes the drifted target without task blame and tries the next", async () => {
	const engine = engineFixture();
	engine.deps.checkProviderCliContract = async () => drifted;
	const failed = await runSimpleTask(engine.options, engine.deps);
	const record = await readRun(failed.runId);
	const f = routingFixture({
		__targets: ["vibe", "codex"],
		vibe: {
			status: "failed",
			result: {
				failureReason: failed.failureReason,
				failurePhase: failed.failurePhase,
				errorKind: failed.errorKind,
				providerReliability: failed.providerReliability,
				preflightDetail: failed.preflightDetail,
			},
			record: { lastFailure: record.lastFailure },
		},
		codex: { status: "succeeded" },
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete", JSON.stringify(result));
	deepStrictEqual(f.calls, ["vibe", "codex"]);
	const attempt = result.attempts.find((item) => item.targetId === "vibe");
	strictEqual(attempt.reason, "environment_failure");
});
