// @test-phase: other
import assert, { ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	CODE_CATEGORIES,
	FAILURE_REGISTRY,
	resolveFailure,
} from "../src/switchyard/diagnostics/failure-registry.mjs";
import { parseSimpleArgs } from "../src/switchyard/simple/args.mjs";
import { handleSimple } from "../src/switchyard/simple/cli.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import {
	deadlineFitDetails,
	evaluateDeadlineFit,
} from "../src/switchyard/simple/task-sizing.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const originalStore = process.env.SWITCHYARD_RUN_STORE_ROOT;
process.env.SWITCHYARD_RUN_STORE_ROOT = tempDir("switchyard-sizing-store-");
after(() => {
	if (originalStore === undefined) delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	else process.env.SWITCHYARD_RUN_STORE_ROOT = originalStore;
});

const NOW = 1_800_000_000_000;
const fit = (overrides = {}) =>
	evaluateDeadlineFit({
		estimateMinutes: 1,
		deadlineMs: NOW + 210_000,
		nowMs: NOW,
		checkCount: 1,
		...overrides,
	});

test("fit equality includes existing check reserve and 90000ms margin", () => {
	assert.equal(fit().budgetMs, 60_000);
	assert.equal(fit().fits, true);
	assert.equal(fit({ nowMs: NOW + 1 }).fits, false);
	assert.equal(fit({ checkCount: 4 }).budgetMs, 0);
	assert.equal(fit({ estimateMinutes: null }).fits, null);
	assert.equal(
		fit({ estimateMinutes: null, p80Ms: 60_000 }).source,
		"observed_p80",
	);
	assert.equal(fit({ estimateMinutes: 1, p80Ms: 1 }).source, "caller_estimate");
	assert.equal(fit().unverified, true);
	assert.equal(fit({ estimateMinutes: 19 }).splitRecommended, false);
	assert.equal(fit({ estimateMinutes: 20 }).splitRecommended, true);
});

function fixture() {
	const root = tempDir("switchyard-task-sizing-");
	const projectPath = join(root, "project");
	mkdirSync(projectPath);
	writeFileSync(join(projectPath, "a.txt"), "base\n");
	execFileSync("git", ["init", "-q"], { cwd: projectPath });
	execFileSync("git", ["add", "a.txt"], { cwd: projectPath });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Tests",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-qm",
			"base",
		],
		{ cwd: projectPath },
	);
	const promptPath = join(root, "prompt.txt");
	writeFileSync(promptPath, "Change a.txt");
	return { root, projectPath, promptPath };
}
function argv(repo) {
	return [
		repo.promptPath,
		"--project",
		repo.projectPath,
		"--capability",
		"standard",
		"--file",
		"a.txt",
		"--check",
		"true",
		"--timeout",
		"30",
	];
}

test("estimate parsing is optional, bounded and does not extend timeout cap", () => {
	const repo = fixture();
	assert.equal(
		parseSimpleArgs(argv(repo), { now: () => NOW }).estimateMinutes,
		null,
	);
	const parsed = parseSimpleArgs(
		[...argv(repo), "--estimate-minutes", "1440"],
		{ now: () => NOW },
	);
	assert.equal(parsed.deadlineMs, NOW + 1_800_000);
	assert.equal(parsed.estimateMinutes, 1440);
	for (const value of ["0", "-1", "1.5", "NaN", "1441", "01", ""]) {
		assert.throws(
			() =>
				parseSimpleArgs([...argv(repo), "--estimate-minutes", value], {
					now: () => NOW,
				}),
			/estimate-minutes/,
		);
	}
	const tooLong = argv(repo);
	tooLong[tooLong.length - 1] = "31";
	assert.throws(() => parseSimpleArgs(tooLong, { now: () => NOW }), /1 to 30/);
});

function dependencies(root, overrides = {}) {
	return {
		now: () => NOW,
		stateRoot: join(root, "state"),
		acquireProjectLock: async () => {},
		releaseProjectLock: async () => true,
		route: () => ({ provider: "codex", reason: "priority_fill" }),
		resolveTargetIdentity: () => ({ targetId: "codex", harnessKey: "codex" }),
		getInvocationDescriptor: () => ({
			target_id: "codex",
			selector: "model",
			invocation_args: [],
		}),
		assertFundedRoute: () => {},
		runCheck: async () => ({
			success: true,
			code: 0,
			writerLifecycle: "stopped",
		}),
		executeProvider: async () => {
			throw new Error("provider must not start");
		},
		...overrides,
	};
}

test("closed refusal reaches caller, run record and progress without routing or health penalty", async () => {
	const repo = fixture();
	const old = process.env.SWITCHYARD_RUN_STORE_ROOT;
	process.env.SWITCHYARD_RUN_STORE_ROOT = join(repo.root, "runs-store");
	const events = [];
	let routeCalls = 0;
	let healthCalls = 0;
	try {
		const result = await runSimpleTask(
			{
				...repo,
				capability: "standard",
				files: ["a.txt"],
				checks: ["true"],
				deadlineMs: NOW + 1_800_000,
				estimateMinutes: 30,
			},
			dependencies(repo.root, {
				route: () => {
					routeCalls++;
					throw new Error("route must not run");
				},
				onStatus: (event) => events.push(event),
				createSimpleRouteHealthController: () => ({
					prepare: () => {
						healthCalls++;
					},
					terminal: () => {
						healthCalls++;
					},
				}),
			}),
		);
		assert.equal(result.failureReason, "task_estimate_exceeds_budget");
		assert.equal(result.errorKind, "validation_failed");
		assert.equal(result.providerStarted, false);
		assert.equal(routeCalls, 0);
		assert.equal(healthCalls, 0);
		for (const key of [
			"deadlineMs",
			"estimateMs",
			"remainingMs",
			"checkReserveMs",
			"marginMs",
			"budgetMs",
		]) {
			const field = `deadlineFit${key[0].toUpperCase()}${key.slice(1)}`;
			assert.equal(typeof result.failureDetails[field], "string");
			assert.equal(
				Number(result.failureDetails[field]),
				result.deadlineFit[key],
			);
		}
		assert.equal(
			result.failureDetails.deadlineFitEncoding,
			"decimal_milliseconds",
		);
		assert.equal(
			result.deadlineFit.budgetMs,
			Number(result.failureDetails.deadlineFitBudgetMs),
		);
		assert.equal(result.failureDetails.deadlineFitUnverified, true);
		assert.equal(result.failureDetails.deadlineFitSplitRecommended, true);
		assert.equal(Number(result.failureDetails.deadlineFitBudgetMs), 1_650_000);
		const record = JSON.parse(
			readFileSync(
				join(
					process.env.SWITCHYARD_RUN_STORE_ROOT,
					"runs",
					result.runId,
					"run.json",
				),
				"utf8",
			),
		);
		assert.deepEqual(record.failureDetails, result.failureDetails);
		assert.equal(
			events.find((event) => event.milestone === "failed").deadlineFitSource,
			"caller_estimate",
		);
	} finally {
		if (old === undefined) delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		else process.env.SWITCHYARD_RUN_STORE_ROOT = old;
	}
});

test("start fence rechecks original deadline after setup and releases unstarted admission", async () => {
	const repo = fixture();
	let clock = NOW;
	let cancelled = 0;
	let started = 0;
	const result = await runSimpleTask(
		{
			...repo,
			capability: "standard",
			files: ["a.txt"],
			checks: ["true"],
			deadlineMs: NOW + 300_000,
			estimateMinutes: 2,
		},
		dependencies(repo.root, {
			now: () => clock,
			onStatus: (event) => {
				if (event.milestone === "provider_starting") clock += 60_000;
			},
			createSimpleRouteHealthController: () => ({
				decision: () => ({}),
				prepare: async () => ({ allowed: true }),
				start: async () => ({ allowed: true }),
				startPrepared: () => {
					started++;
					return { allowed: true };
				},
				cancelUnstarted: async () => {
					cancelled++;
					return { released: true };
				},
			}),
		}),
	);
	assert.equal(result.failureReason, "task_estimate_exceeds_budget");
	assert.equal(result.providerStarted, false);
	assert.equal(
		Number(result.failureDetails.deadlineFitDeadlineMs),
		NOW + 300_000,
	);
	assert.equal(Number(result.failureDetails.deadlineFitBudgetMs), 90_000);
	assert.equal(cancelled, 1);
	assert.equal(started, 0);
});

test("registry makes fit refusal a non-provider validation failure", () => {
	const row = resolveFailure({
		reason: "task_estimate_exceeds_budget",
		phase: "route",
	});
	assert.equal(row.causeCode, "task_estimate_exceeds_budget");
	assert.equal(row.providerCaused, false);
	assert.equal(row.severity, "hard");
	assert.ok(row.detailFields.includes("deadlineFitBudgetMs"));
	assert.equal(
		resolveFailure({ reason: "task_estimate_exceeds_budget", cancelled: true })
			.causeCode,
		"cancelled",
	);
});

test("CLI preserves refusal and emits actionable unverified split diagnostic", async () => {
	const repo = fixture();
	const output = [];
	const stderr = [];
	const signals = new EventEmitter();
	const refusal = {
		schemaVersion: 1,
		status: "failed",
		failureReason: "task_estimate_exceeds_budget",
		providerStarted: false,
		failureDetails: deadlineFitDetails(fit({ estimateMinutes: 30 })),
	};
	await handleSimple([...argv(repo), "--estimate-minutes", "30"], {
		...dependencies(repo.root),
		signalProcess: signals,
		writeResult: (value) => output.push(JSON.parse(value)),
		stderr: { write: (value) => stderr.push(value) },
		runSimpleTask: async (_options, deps) => {
			deps.onStatus({
				taskId: "size",
				phase: "terminal",
				milestone: "failed",
				...refusal.failureDetails,
			});
			return refusal;
		},
		onStatus: (event) => stderr.push(event),
	});
	assert.equal(output[0].failureReason, "task_estimate_exceeds_budget");
	assert.equal(output[0].providerStarted, false);
	assert.equal(output[0].attempts.length, 0);
	assert.equal(signals.exitCode, 1);
	assert.equal(
		stderr.find((event) => event.milestone === "failed").deadlineFitUnverified,
		true,
	);
});

test("selected target sizing reaches success caller, progress and durable summary", async () => {
	for (const successes of [4, 5, 6]) {
		const repo = fixture();
		const project = repo.projectPath;
		const runs = join(process.env.SWITCHYARD_RUN_STORE_ROOT, "runs");
		for (let index = 0; index < 12; index++) {
			const dir = join(runs, `history-${successes}-${index}`);
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "run.json"),
				JSON.stringify({
					state: "succeeded",
					projectPath:
						index < successes || index % 2 === 0 ? project : `${project}-other`,
					resolvedTargetId:
						index < successes || index % 2 !== 0 ? "codex" : "other-target",
					createdAt: new Date(NOW).toISOString(),
					finishedAt: new Date(NOW + 10000).toISOString(),
				}),
			);
		}
		const events = [];
		const result = await runSimpleTask(
			{
				...repo,
				capability: "standard",
				files: ["a.txt"],
				checks: ["true"],
				deadlineMs: NOW + 300_000,
				estimateMinutes: successes === 6 ? 1 : null,
			},
			dependencies(repo.root, {
				onStatus: (event) => events.push(event),
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(join(worktreePath, "a.txt"), "changed\n");
					return { success: true, code: 0, writerLifecycle: "stopped" };
				},
			}),
		);
		assert.equal(result.status, "succeeded", result.failureReason);
		assert.equal(
			result.deadlineFit.source,
			successes === 6
				? "caller_estimate"
				: successes === 5
					? "observed_p80"
					: "unknown",
		);
		assert.equal(result.deadlineFit.p80Ms, successes === 5 ? 10000 : null);
		const progress = events.find((event) => event.milestone === "task_sizing");
		assert.equal(progress.deadlineFitSource, result.deadlineFit.source);
		assert.equal(progress.deadlineFitUnverified, successes === 6);
		const record = JSON.parse(
			readFileSync(join(runs, result.runId, "run.json"), "utf8"),
		);
		assert.equal(
			record.terminalSummary.deadlineFit.deadlineFitSource,
			result.deadlineFit.source,
		);
		assert.equal(
			record.terminalSummary.deadlineFit.deadlineFitEncoding,
			"decimal_milliseconds",
		);
		assert.equal(
			Number(record.terminalSummary.deadlineFit.deadlineFitBudgetMs),
			result.deadlineFit.budgetMs,
		);
	}
});

const MATRIX_PHASES = [
	"route",
	"prepare",
	"baseline",
	"execute",
	"provider",
	"diff",
	"checks",
	"integrate",
];

test("task_estimate_exceeds_budget is a closed non-provider input refusal", () => {
	const reason = "task_estimate_exceeds_budget";
	const row = FAILURE_REGISTRY.get(reason);
	ok(row, "estimate refusal row exists");
	strictEqual(CODE_CATEGORIES.get(reason), "input");
	for (const phase of MATRIX_PHASES) {
		const resolved = resolveFailure({ reason, phase });
		strictEqual(resolved.causeCode, reason);
		strictEqual(resolved.causeCategory, "input");
		strictEqual(resolved.errorKind, "validation_failed");
		strictEqual(resolved.severity, "hard");
		strictEqual(resolved.providerCaused, false);
		strictEqual(resolved.diffCategory, null);
		strictEqual(resolved.timedOut, false);
		strictEqual(resolved.cancelled, false);
	}
	for (const field of [
		"failureReason",
		"deadlineFitSource",
		"deadlineFitEncoding",
		"deadlineFitBudgetMs",
		"deadlineFitDeadlineMs",
		"deadlineFitUnverified",
		"deadlineFitSplitRecommended",
	])
		ok(row.detailFields.includes(field), field);
});
