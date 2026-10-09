import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { validateInvocationDescriptor } from "../src/switchyard/roster/index.mjs";
import { inspectRouteHealth } from "../src/switchyard/router/health.mjs";
import { COOLDOWN_MS } from "../src/switchyard/router/health-schema.mjs";
import {
	isProjectLockHeld,
	readEvents,
	readRun,
} from "../src/switchyard/run-store/index.mjs";
import { createSimpleRouteHealthController } from "../src/switchyard/simple/health.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { createSimpleProviderReliabilityDiagnostic } from "../src/switchyard/simple/reliability.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import { tempDir } from "./helpers/tempdir.mjs";
import {
	cleanupHealthFixture,
	healthIdentity,
	seedVmQuotaCooldown,
	setupHealthFixture,
} from "./provider-reliability-health-fixture.mjs";

const suiteRoot = tempDir("switchyard-provider-reliability-");
const suiteTmp = join(suiteRoot, "tmp");
mkdirSync(suiteTmp, { recursive: true });
process.env.TMPDIR = suiteTmp;
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suiteRoot, "run-store");
const retained = [];

function makeRepo() {
	const projectPath = join(
		suiteRoot,
		`project-${Math.random().toString(16).slice(2)}`,
	);
	mkdirSync(join(projectPath, "src"), { recursive: true });
	writeFileSync(join(projectPath, "src", "a.txt"), "base\n", "utf8");
	execFileSync("git", ["init", "-q"], { cwd: projectPath });
	execFileSync("git", ["add", "-A"], { cwd: projectPath });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Switchyard Tests",
			"-c",
			"user.email=switchyard@example.invalid",
			"commit",
			"-qm",
			"base",
		],
		{ cwd: projectPath },
	);
	const promptPath = join(projectPath, "task.txt");
	writeFileSync(promptPath, "Change src/a.txt\n", "utf8");
	return { projectPath, promptPath };
}

function taskOptions(repo, overrides = {}) {
	return {
		promptPath: repo.promptPath,
		projectPath: repo.projectPath,
		capability: "standard",
		files: ["src/a.txt"],
		checks: ["test -f src/a.txt"],
		deadlineMs: Date.now() + 240_000,
		...overrides,
	};
}

function dependencies(_repo, overrides = {}) {
	const taskId = `provider-reliability-${Date.now()}-${Math.random()}`;
	const descriptor = validateInvocationDescriptor(
		{
			target_id: "codex",
			model_ref: "fixture/codex-standard",
			selector: "fixture-codex-standard",
			effort: null,
			variant: null,
			invocation_args: [],
		},
		"codex",
	);
	return {
		taskId,
		attemptId: "attempt-primary",
		tmpdir: suiteTmp,
		route: () => ({ provider: "Codex", reason: "priority_fill" }),
		resolveTargetIdentity: () => ({
			targetId: "codex",
			harnessKey: "codex",
			ambiguous: false,
		}),
		getInvocationDescriptor: () => descriptor,
		assertFundedRoute: () => {},
		executeProvider: async ({ worktreePath }) => {
			writeFileSync(join(worktreePath, "src", "a.txt"), "provider\n", "utf8");
			return { success: true, code: 0, writerLifecycle: "stopped" };
		},
		runCheck: async () => ({
			success: true,
			code: 0,
			writerLifecycle: "stopped",
		}),
		integrate: async () => ({ success: true }),
		// Route health is untracked unless a test injects its own decision;
		// the route-health trials below do.
		healthDecision: UNTRACKED_HEALTH,
		...overrides,
	};
}

const UNTRACKED_HEALTH = Object.assign(
	() => ({ available: false, mode: "enforce", suppress: false }),
	{ mode: "enforce" },
);

function remember(result, projectPath) {
	if (result.partialWorktree) retained.push({ result, projectPath });
}

after(() => {
	for (const { result } of retained) {
		const root = result.partialWorktree
			? join(result.partialWorktree, "..")
			: null;
		if (root) rmSync(root, { recursive: true, force: true });
	}
	rmSync(suiteRoot, { recursive: true, force: true });
});

describe("simple provider reliability contract", () => {
	// Route health resolves identities through the roster; use the qualified
	// fixture roster, never the host one (checks run under an isolated HOME).
	before(setupHealthFixture);
	after(cleanupHealthFixture);
	it("falls back to the provider exit code when the failure exit code is null", () => {
		strictEqual(
			createSimpleProviderReliabilityDiagnostic({
				failureReason: "provider_exit_nonzero",
				failurePhase: "execute",
				exitCode: null,
				providerResult: { code: 1 },
			}).exitCode,
			1,
		);
		strictEqual(
			createSimpleProviderReliabilityDiagnostic({
				failureReason: "provider_exit_nonzero",
				failurePhase: "execute",
				exitCode: 2,
				providerResult: { code: 1 },
			}).exitCode,
			2,
		);
	});

	it("records unknown provider exits without claiming a cause and binds the descriptor", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			taskOptions(repo),
			dependencies(repo, {
				runId: `simple-unknown-${Date.now()}`,
				executeProvider: async () => ({
					success: false,
					code: 1,
					output: "PRIVATE_PROVIDER_OUTPUT",
					writerLifecycle: "stopped",
				}),
			}),
		);
		remember(result, repo.projectPath);
		strictEqual(result.status, "failed");
		strictEqual(result.providerReliability.causeCode, "provider_exit_nonzero");
		strictEqual(result.providerReliability.causeCategory, "unknown");
		strictEqual(
			result.descriptorIdentity,
			result.invocationDescriptor.descriptor_identity,
		);
		strictEqual(
			JSON.stringify(result).includes("PRIVATE_PROVIDER_OUTPUT"),
			false,
		);
		const run = await readRun(result.runId);
		strictEqual(
			run.lastFailure.providerReliability.causeCode,
			"provider_exit_nonzero",
		);
		const events = await readEvents(result.runId);
		const routeSelected = events.find(
			(event) =>
				event.event === "milestone" && event.milestone === "route_selected",
		);
		ok(routeSelected, "route selection milestone is durable");
		strictEqual(routeSelected.descriptorIdentity, result.descriptorIdentity);
		deepStrictEqual(
			routeSelected.invocationDescriptor,
			result.invocationDescriptor,
		);
		const terminal = events.find((event) => event.event === "task_failed");
		ok(terminal, JSON.stringify(events));
		strictEqual(terminal.providerReliability.causeCategory, "unknown");
	});

	it("preserves provider deadline cause and process evidence in durable diagnostics", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			taskOptions(repo),
			dependencies(repo, {
				runId: `simple-deadline-${Date.now()}`,
				executeProvider: async () => ({
					success: false,
					code: null,
					timedOut: true,
					signal: "SIGKILL",
					writerLifecycle: "stopped",
				}),
			}),
		);
		remember(result, repo.projectPath);
		strictEqual(result.failureReason, "provider_deadline_exceeded");
		const run = await readRun(result.runId);
		const events = await readEvents(result.runId);
		const terminal = events.find((event) => event.event === "task_failed");
		for (const diagnostic of [
			result.providerReliability,
			run.lastFailure.providerReliability,
			terminal.providerReliability,
		]) {
			strictEqual(diagnostic.causeCode, "provider_deadline_exceeded");
			strictEqual(diagnostic.causeCategory, "provider");
			strictEqual(diagnostic.timedOut, true);
			strictEqual(diagnostic.signal, "SIGKILL");
		}
		const checkTimeout = createSimpleProviderReliabilityDiagnostic({
			failureReason: "check_deadline_exceeded",
			failurePhase: "checks",
			timedOut: true,
		});
		strictEqual(checkTimeout.causeCode, "acceptance_check_timeout");
		strictEqual(checkTimeout.causeCategory, "check");
	});

	it("records a routed wall-clock deadline as a task-scoped skip", async () => {
		const repo = makeRepo();
		const stateRoot = realpathSync(tempDir("simple-routing-deadline-state-"));
		const answer = await runSimpleRoutingTask(
			taskOptions(repo, { routingRunId: `deadline-scope-${Date.now()}` }),
			{
				...dependencies(repo, {
					executeProvider: async () => ({
						success: false,
						code: null,
						timedOut: true,
						signal: "SIGKILL",
						writerLifecycle: "stopped",
					}),
					route: ({ availableProviders }) =>
						availableProviders.length > 0
							? { provider: availableProviders[0], reason: "priority_fill" }
							: { provider: null, reason: "no_eligible" },
				}),
				runSimpleTask,
				stateRoot,
				getImplementorPriority: () => 1,
			},
		);
		const attempt = answer.attempts.find((item) => item.targetId === "codex");
		ok(attempt, JSON.stringify(answer));
		strictEqual(attempt.terminal, "skipped");
		strictEqual(attempt.reason, "execution_failed");
		deepStrictEqual(answer.failedTargetIds, []);
		const run = await readRun(attempt.runId);
		strictEqual(
			run.lastFailure.providerReliability.causeCode,
			"provider_deadline_exceeded",
		);
	});

	it("fails a requested baseline before provider launch and preserves its exit code", async () => {
		const repo = makeRepo();
		let providerStarts = 0;
		const result = await runSimpleTask(
			taskOptions(repo, { baselineChecks: ["baseline command"] }),
			dependencies(repo, {
				runId: `simple-baseline-${Date.now()}`,
				runCheck: async () => ({
					success: false,
					code: 7,
					writerLifecycle: "stopped",
				}),
				executeProvider: async () => {
					providerStarts += 1;
					return { success: true, writerLifecycle: "stopped" };
				},
			}),
		);
		remember(result, repo.projectPath);
		strictEqual(result.failureReason, "baseline_check_failed");
		strictEqual(result.providerReliability.phase, "baseline");
		strictEqual(result.providerReliability.exitCode, 7);
		strictEqual(result.providerReliability.baselineStatus, "failed");
		strictEqual(providerStarts, 0);
	});

	it("rejects baseline mutation before provider launch", async () => {
		const repo = makeRepo();
		let providerStarts = 0;
		const result = await runSimpleTask(
			taskOptions(repo, { baselineChecks: ["mutates tracked input"] }),
			dependencies(repo, {
				runId: `simple-baseline-mutation-${Date.now()}`,
				runCheck: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"changed by baseline\n",
					);
					return { success: true, code: 0, writerLifecycle: "stopped" };
				},
				executeProvider: async () => {
					providerStarts += 1;
					return { success: true, writerLifecycle: "stopped" };
				},
			}),
		);
		remember(result, repo.projectPath);
		strictEqual(result.failureReason, "baseline_mutation");
		strictEqual(result.providerReliability.baselineStatus, "mutation_detected");
		strictEqual(providerStarts, 0);
	});

	it("retains the checkout when baseline writer shutdown is unknown", async () => {
		const repo = makeRepo();
		let providerStarts = 0;
		const result = await runSimpleTask(
			taskOptions(repo, { baselineChecks: ["unknown writer"] }),
			dependencies(repo, {
				runId: `simple-baseline-unknown-${Date.now()}`,
				runCheck: async () => ({
					success: true,
					code: 0,
					writerLifecycle: "unavailable",
				}),
				executeProvider: async () => {
					providerStarts += 1;
					return { success: true, writerLifecycle: "stopped" };
				},
			}),
		);
		remember(result, repo.projectPath);
		strictEqual(result.failureReason, "baseline_check_unavailable");
		strictEqual(result.providerReliability.baselineStatus, "unknown");
		ok(result.partialWorktree);
		strictEqual(providerStarts, 0);
	});

	it("allows one same-checkout correction and reruns all acceptance checks", async () => {
		const repo = makeRepo();
		let providerCalls = 0;
		let acceptanceCalls = 0;
		let correctionPrompt = "";
		const result = await runSimpleTask(
			taskOptions(repo, { repairChecks: true, checks: ["check a", "check b"] }),
			dependencies(repo, {
				runId: `simple-repair-${Date.now()}`,
				executeProvider: async ({ worktreePath, prompt }) => {
					providerCalls += 1;
					if (providerCalls === 2) correctionPrompt = prompt;
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						providerCalls === 1 ? "first attempt\n" : "corrected\n",
					);
					return { success: true, code: 0, writerLifecycle: "stopped" };
				},
				runCheck: async () => {
					acceptanceCalls += 1;
					if (acceptanceCalls === 1)
						return { success: false, code: 2, writerLifecycle: "stopped" };
					return { success: true, code: 0, writerLifecycle: "stopped" };
				},
			}),
		);
		remember(result, repo.projectPath);
		strictEqual(
			result.status,
			"succeeded",
			JSON.stringify({
				result,
				providerCalls,
				acceptanceCalls,
				correctionPrompt,
			}),
		);
		strictEqual(providerCalls, 2);
		strictEqual(acceptanceCalls, 3);
		ok(
			correctionPrompt.includes(
				"Acceptance check 1 failed with acceptance_check_failed",
			),
		);
		ok(!correctionPrompt.includes("PRIVATE"));
		strictEqual(result.providerReliability.repairCount, 1);
		strictEqual(result.providerReliability.repairStatus, "passed");
		const run = await readRun(result.runId);
		strictEqual(run.terminalSummary.providerReliability.repairCount, 1);
	});

	it("retains dependency-unverified as an environment cause without spending repair budget", async () => {
		const repo = makeRepo();
		let providerCalls = 0;
		const result = await runSimpleTask(
			taskOptions(repo, { repairChecks: true }),
			dependencies(repo, {
				runId: `simple-dependencies-${Date.now()}`,
				executeProvider: async ({ worktreePath }) => {
					providerCalls += 1;
					writeFileSync(join(worktreePath, "src", "a.txt"), "provider\n");
					return { success: true, code: 0, writerLifecycle: "stopped" };
				},
				runCheck: async () => ({
					success: false,
					code: 1,
					diagnosticCode: "check_dependencies_unverified",
					writerLifecycle: "never_started",
				}),
			}),
		);
		remember(result, repo.projectPath);
		strictEqual(providerCalls, 1);
		strictEqual(result.failureReason, "check_dependencies_unverified");
		strictEqual(result.errorKind, "environment_failure");
		const run = await readRun(result.runId);
		const events = await readEvents(result.runId);
		const terminal = events.find((event) => event.event === "task_failed");
		for (const diagnostic of [
			result.providerReliability,
			run.lastFailure.providerReliability,
			terminal.providerReliability,
		]) {
			strictEqual(diagnostic.causeCode, "check_dependencies_unverified");
			strictEqual(diagnostic.causeCategory, "environment");
			strictEqual(diagnostic.repairCount, 0);
			strictEqual(diagnostic.repairStatus, "ineligible");
		}
	});

	it("refuses correction when provider writer lifecycle is unknown", async () => {
		const repo = makeRepo();
		let providerCalls = 0;
		const result = await runSimpleTask(
			taskOptions(repo, { repairChecks: true }),
			dependencies(repo, {
				runId: `simple-repair-unknown-${Date.now()}`,
				executeProvider: async ({ worktreePath }) => {
					providerCalls += 1;
					writeFileSync(join(worktreePath, "src", "a.txt"), "provider\n");
					return {
						success: true,
						writerLifecycle: providerCalls === 1 ? "unavailable" : "stopped",
					};
				},
				runCheck: async () => ({
					success: false,
					code: 2,
					writerLifecycle: "stopped",
				}),
			}),
		);
		remember(result, repo.projectPath);
		strictEqual(result.status, "failed");
		strictEqual(result.failureReason, "check_failed");
		strictEqual(providerCalls, 1);
		strictEqual(result.providerReliability.repairStatus, "ineligible");
	});

	it("does not correct after the failing check changes an undeclared path", async () => {
		const repo = makeRepo();
		let providerCalls = 0;
		const result = await runSimpleTask(
			taskOptions(repo, { repairChecks: true }),
			dependencies(repo, {
				runId: `simple-repair-scope-${Date.now()}`,
				executeProvider: async ({ worktreePath }) => {
					providerCalls += 1;
					writeFileSync(join(worktreePath, "src", "a.txt"), "provider\n");
					return { success: true, writerLifecycle: "stopped" };
				},
				runCheck: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "other.txt"),
						"check mutation\n",
					);
					return { success: false, code: 2, writerLifecycle: "stopped" };
				},
			}),
		);
		remember(result, repo.projectPath);
		strictEqual(result.failurePhase, "diff");
		strictEqual(result.failureReason, "undeclared_paths_changed");
		strictEqual(result.providerReliability.repairCount, 0);
		strictEqual(providerCalls, 1);
	});

	it("does not correct when the original deadline lacks repair and full recheck budget", async () => {
		const repo = makeRepo();
		let providerCalls = 0;
		let currentTime = 1_000;
		const result = await runSimpleTask(
			taskOptions(repo, {
				repairChecks: true,
				deadlineMs: 120_000,
			}),
			dependencies(repo, {
				runId: `simple-repair-budget-${Date.now()}`,
				now: () => currentTime,
				executeProvider: async ({ worktreePath }) => {
					providerCalls += 1;
					writeFileSync(join(worktreePath, "src", "a.txt"), "provider\n");
					return { success: true, writerLifecycle: "stopped" };
				},
				runCheck: async () => {
					currentTime = 90_000;
					return { success: false, code: 2, writerLifecycle: "stopped" };
				},
			}),
		);
		remember(result, repo.projectPath);
		strictEqual(result.failureReason, "check_failed");
		strictEqual(result.providerReliability.repairStatus, "ineligible");
		strictEqual(providerCalls, 1);
	});

	it("stops after the one allowed correction when acceptance still fails", async () => {
		const repo = makeRepo();
		let providerCalls = 0;
		let checkCalls = 0;
		const result = await runSimpleTask(
			taskOptions(repo, { repairChecks: true }),
			dependencies(repo, {
				runId: `simple-repair-second-fail-${Date.now()}`,
				executeProvider: async ({ worktreePath }) => {
					providerCalls += 1;
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						`provider ${providerCalls}\n`,
					);
					return { success: true, writerLifecycle: "stopped" };
				},
				runCheck: async () => {
					checkCalls += 1;
					return { success: false, code: 2, writerLifecycle: "stopped" };
				},
			}),
		);
		remember(result, repo.projectPath);
		strictEqual(result.failureReason, "check_repair_failed");
		strictEqual(result.providerReliability.repairCount, 1);
		strictEqual(result.providerReliability.repairStatus, "failed");
		strictEqual(providerCalls, 2);
		strictEqual(checkCalls, 2);
		ok(result.partialWorktree);
		ok(existsSync(result.partialWorktree));
		strictEqual(
			readFileSync(join(result.partialWorktree, "src/a.txt"), "utf8"),
			"provider 2\n",
		);
		strictEqual(result.recovery.cleanup.worktree.state, "retained");
		strictEqual(result.recovery.cleanup.projectLock.state, "released");
		strictEqual(await isProjectLockHeld(repo.projectPath), false);
		const run = await readRun(result.runId);
		strictEqual(
			run.lastFailure.providerReliability.causeCode,
			"check_repair_failed",
		);
		strictEqual(run.worktree.state, "retained");
		strictEqual(join(run.worktree.path, "worktree"), result.partialWorktree);
		strictEqual(run.worktree.writerStopped, true);
		strictEqual(run.cleanupState, "pending");
		const continuation = await runSimpleRoutingTask(
			{ projectPath: repo.projectPath, routingRunId: "repair-retained" },
			{
				openRoutingRun: () => ({
					state: {
						attempts: [{ partialWorktree: result.partialWorktree }],
						failedTargetIds: [],
					},
					release: () => {},
				}),
				runSimpleTask: async () => {
					throw Error("retained work must not dispatch");
				},
			},
		);
		strictEqual(continuation.direction, "stop");
		strictEqual(continuation.stopReason, "partial_work_retained");
	});

	it("uses a fresh enforce-mode health invocation before correction", async () => {
		const repo = makeRepo();
		let providerCalls = 0;
		let checkCalls = 0;
		let invocation = 0;
		const calls = [];
		const result = await runSimpleTask(
			taskOptions(repo, { repairChecks: true }),
			dependencies(repo, {
				runId: `simple-repair-health-${Date.now()}`,
				createSimpleRouteHealthController: () => ({
					decision: () => ({
						mode: "enforce",
						available: true,
						suppress: false,
					}),
					prepare: async () => {
						invocation += 1;
						calls.push(`prepare-${invocation}`);
						return {
							allowed: true,
							tracked: true,
							attempt: `provider-${invocation}`,
						};
					},
					start: async () => {
						calls.push(`start-${invocation}`);
						return { allowed: true, tracked: true, trial: true };
					},
					terminal: async ({ providerResult }) => {
						calls.push(`terminal-${invocation}-${providerResult.success}`);
						return { settled: true, binding: null };
					},
				}),
				executeProvider: async ({ worktreePath }) => {
					providerCalls += 1;
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						`provider ${providerCalls}\n`,
					);
					return { success: true, writerLifecycle: "stopped" };
				},
				runCheck: async () => {
					checkCalls += 1;
					return checkCalls === 1
						? { success: false, code: 2, writerLifecycle: "stopped" }
						: { success: true, code: 0, writerLifecycle: "stopped" };
				},
			}),
		);
		remember(result, repo.projectPath);
		strictEqual(result.status, "succeeded");
		deepStrictEqual(calls, [
			"prepare-1",
			"start-1",
			"terminal-1-true",
			"prepare-2",
			"start-2",
			"terminal-2-true",
		]);
		strictEqual(providerCalls, 2);
	});

	for (const interruption of [
		"deadline",
		"abort",
		"callback",
		"start",
		"prepare",
	]) {
		it(`fences a real half-open trial for ${interruption} admission`, async () => {
			const repo = makeRepo();
			const deps = dependencies(repo, {
				runId: `simple-halfopen-${interruption}-${Date.now()}`,
			});
			const descriptor = deps.getInvocationDescriptor();
			const healthStateRoot = join(suiteRoot, `half-open-${interruption}`);
			const seed = await seedVmQuotaCooldown({ healthStateRoot, descriptor });
			let clock = seed.at + COOLDOWN_MS[0] + 1_000;
			const deadline = clock + 240_000;
			const abort = new AbortController();
			let calls = 0;
			let reservedTrial = false;
			let realController;
			const decision = () => ({
				available: true,
				mode: "enforce",
				state: "cooldown",
				suppress: false,
				repairEpoch: 0,
				trialAvailable: true,
			});
			Object.defineProperties(decision, {
				mode: { value: "enforce" },
				publicConfigurationEpoch: { value: seed.epoch },
				identityFor: {
					value: () => ({
						targetId: descriptor.target_id,
						descriptorIdentity: descriptor.descriptor_identity,
						publicConfigurationEpoch: seed.epoch,
					}),
				},
			});
			deps.now = () => clock;
			deps.signal = abort.signal;
			deps.healthDecision = decision;
			deps.healthStateRoot = healthStateRoot;
			deps.healthMode = "enforce";
			deps.executeProvider = async () => {
				calls += 1;
				return { success: false, code: 1, writerLifecycle: "stopped" };
			};
			deps.createSimpleRouteHealthController = (options) => {
				const controller = createSimpleRouteHealthController(options);
				realController = controller;
				return {
					...controller,
					start: async (input) => {
						const result = await controller.start(input);
						reservedTrial = result.allowed && result.trial;
						if (interruption === "deadline") clock = deadline;
						if (interruption === "abort") abort.abort();
						if (interruption === "prepare")
							await controller.prepare({
								provider: "codex",
								targetId: "codex",
								capability: "standard",
								descriptor: {},
							});
						return result;
					},
				};
			};
			deps.onStatus = (event) => {
				if (
					interruption === "callback" &&
					event.milestone === "provider_starting"
				)
					abort.abort();
			};
			const result = await runSimpleTask(
				taskOptions(repo, { checks: [], deadlineMs: deadline }),
				deps,
			);
			remember(result, repo.projectPath);
			strictEqual(reservedTrial, true, JSON.stringify(result));
			const started = interruption === "start";
			strictEqual(calls, started ? 1 : 0);
			strictEqual(result.providerStarted, started);
			strictEqual(
				result.recovery.cleanup.writer.state,
				started ? "stopped" : "never_started",
			);
			strictEqual(
				result.failureReason,
				started
					? "provider_exit_nonzero"
					: interruption === "deadline"
						? "deadline_expired"
						: interruption === "prepare"
							? "route_health_blocked"
							: "provider_cancelled",
			);
			strictEqual(realController.startPrepared().allowed, false);
			strictEqual((await realController.cancelUnstarted()).released, !started);
			strictEqual((await realController.cancelUnstarted()).released, !started);
			if (!started && interruption !== "prepare") {
				const terminal = await realController.terminal();
				strictEqual(terminal.settled, true);
				deepStrictEqual(await realController.terminal(), terminal);
			}
			const state = await inspectRouteHealth({
				...healthIdentity(healthStateRoot, descriptor, seed.epoch),
				nowMs: clock,
			});
			// The run is terminal and cleaned up, so a started trial's claim is
			// reclaimed and the next dispatch may take a fresh trial.
			strictEqual(state.state, "cooldown");
			strictEqual(state.trialAvailable, true);
			if (interruption === "callback") {
				strictEqual(result.partialWorktree, null);
				const run = await readRun(result.runId);
				strictEqual(run.state, "failed");
				strictEqual(run.worktree.state, "removed");
				strictEqual(run.cleanupState, "complete");
			}
			const events = await readEvents(result.runId);
			strictEqual(
				events.some((event) => event.event === "provider_attempt_terminal"),
				false,
			);
		});
	}
});
