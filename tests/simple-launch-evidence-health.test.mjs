// @test-phase: other
import { ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	readRun,
	updateRunWithRetry,
} from "../src/switchyard/run-store/index.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const suite = tempDir("switchyard-launch-evidence-health-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suite, "runs");

function git(path, args) {
	return execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
}

function repoFixture() {
	const root = tempDir("switchyard-launch-evidence-health-repo-");
	const projectPath = join(root, "project");
	mkdirSync(projectPath);
	writeFileSync(join(projectPath, "a.txt"), "base\n");
	git(projectPath, ["init", "-q"]);
	git(projectPath, ["add", "."]);
	git(projectPath, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"fixture",
	]);
	const promptPath = join(root, "prompt");
	writeFileSync(promptPath, "Change a.txt");
	return { root, projectPath, promptPath };
}

function lifecycle(writerLifecycle = "stopped") {
	return {
		schemaVersion: 1,
		terminalStatus: writerLifecycle === "stopped" ? "exited" : "unobserved",
		terminationReason: writerLifecycle === "stopped" ? "completed" : "none",
		exitCode: writerLifecycle === "stopped" ? 0 : null,
		signal: null,
		writerLifecycle,
		cleanupStatus: writerLifecycle === "stopped" ? "succeeded" : "uncertain",
		cleanupStage: null,
	};
}

function healthDouble(terminalResults = []) {
	let prepared = 0;
	const started = [];
	const terminals = [];
	return {
		started,
		terminals,
		create: () => ({
			decision: () => ({ available: true }),
			prepare: async () => {
				prepared += 1;
				return {
					allowed: true,
					tracked: true,
					attempt: `provider-${prepared}`,
				};
			},
			start: async () => ({
				allowed: true,
				tracked: true,
				attempt: `provider-${prepared}`,
			}),
			startPrepared: () => {
				started.push(prepared);
				return {
					allowed: true,
					tracked: true,
					attempt: `provider-${prepared}`,
				};
			},
			cancelUnstarted: async () => ({ released: true }),
			terminal: async (input) => {
				terminals.push(input);
				return terminalResults.shift() ?? { settled: true };
			},
		}),
	};
}

function dependencies(
	repo,
	{
		failPhase = "execute",
		writerLifecycle = "stopped",
		terminalResults = [],
		failFinalPersistence = false,
	} = {},
) {
	const health = healthDouble(terminalResults);
	let providerCalls = 0;
	let failedLaunchWrites = 0;
	let failedTerminalWrites = 0;
	return {
		health,
		get failedLaunchWrites() {
			return failedLaunchWrites;
		},
		get failedTerminalWrites() {
			return failedTerminalWrites;
		},
		deps: {
			tmpdir: repo.root,
			route: () => ({ provider: "Codex (Spark)", reason: "priority_fill" }),
			resolveTargetIdentity: () => ({
				targetId: "codex",
				harnessKey: "codex",
				ambiguous: false,
			}),
			getInvocationDescriptor: () => ({
				target_id: "codex",
				selector: "gpt-5.3-codex-spark",
				invocation_args: [],
			}),
			assertFundedRoute: () => {},
			createSimpleRouteHealthController: health.create,
			updateRunWithRetry: async (runId, patch) => {
				const publication = patch.providerLaunches?.at(-1);
				if (
					publication?.phase === failPhase &&
					publication.publication === "observed"
				) {
					failedLaunchWrites += 1;
					throw Object.assign(new Error("injected run-store failure"), {
						code: "EIO",
					});
				}
				if (failFinalPersistence && patch.state === "failed") {
					failedTerminalWrites += 1;
					throw Object.assign(
						new Error("injected terminal persistence failure"),
						{
							code: "EIO",
						},
					);
				}
				return updateRunWithRetry(runId, patch);
			},
			executeProvider: async ({ worktreePath, onProviderLaunch }) => {
				providerCalls += 1;
				const phase = providerCalls === 1 ? "execute" : "repair";
				if (phase === failPhase) {
					try {
						await onProviderLaunch({
							pid: 123,
							processGroupId: 123,
							processStart: {
								source: "ps_lstart",
								precision: "seconds",
								stamp: "Mon Oct 20 01:00:00 2026",
							},
						});
					} catch (error) {
						strictEqual(error.code, "run_store_write_failed");
						return {
							success: false,
							code: null,
							launchEvidenceFailed: true,
							writerLifecycle,
							providerLifecycle: lifecycle(writerLifecycle),
						};
					}
					throw new Error("the injected publication failure was not reached");
				}
				await onProviderLaunch({
					pid: 124,
					processGroupId: 124,
					processStart: {
						source: "ps_lstart",
						precision: "seconds",
						stamp: "Mon Oct 20 01:00:01 2026",
					},
				});
				writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
				return {
					success: true,
					writerLifecycle: "stopped",
					providerLifecycle: lifecycle("stopped"),
				};
			},
			runCheck: async () => ({
				success: failPhase !== "repair",
				exitCode: failPhase !== "repair" ? 0 : 1,
				writerLifecycle: "stopped",
			}),
		},
	};
}

function options(repo, overrides = {}) {
	return {
		...repo,
		capability: "standard",
		files: ["a.txt"],
		checks: ["test -f a.txt"],
		deadlineMs: Date.now() + 180_000,
		...overrides,
	};
}

for (const failPhase of ["execute", "repair"])
	test(`tracked ${failPhase} launch-evidence failure settles with host evidence`, async () => {
		const repo = repoFixture();
		const configured = dependencies(repo, { failPhase });
		const result = await runSimpleTask(
			options(repo, { repairChecks: failPhase === "repair" }),
			configured.deps,
		);
		strictEqual(result.failureReason, "run_store_write_failed");
		strictEqual(configured.failedLaunchWrites, 1);
		strictEqual(
			configured.health.started.length,
			failPhase === "execute" ? 1 : 2,
		);
		strictEqual(
			configured.health.terminals.length,
			failPhase === "execute" ? 1 : 2,
		);
		const terminal = configured.health.terminals.at(-1);
		strictEqual(terminal.providerResult.launchEvidenceFailed, true);
		strictEqual(
			terminal.providerReliability.causeCode,
			"run_store_write_failed",
		);
		strictEqual(terminal.providerReliability.causeCategory, "environment");
		strictEqual(terminal.providerLifecycle.writerLifecycle, "stopped");
		strictEqual(terminal.providerLifecycle.cleanupStatus, "succeeded");
		strictEqual(result.accountability.providerMemoryEligible, false);
	});

test("unconfirmed tracked settlement retains the worktree when final persistence fails", async () => {
	const repo = repoFixture();
	const configured = dependencies(repo, {
		terminalResults: [{ settled: false, reason: "health-store-unavailable" }],
		failFinalPersistence: true,
	});
	const result = await runSimpleTask(options(repo), configured.deps);
	strictEqual(result.failureReason, "run_store_write_failed");
	strictEqual(configured.health.terminals.length, 1);
	ok(
		result.partialWorktree,
		"unconfirmed health settlement must retain the worktree",
	);
	ok(existsSync(result.partialWorktree));
	strictEqual(result.accountability.providerMemoryEligible, false);
	ok(configured.failedTerminalWrites > 0);
	const record = await readRun(result.runId);
	strictEqual(record.state, "created");
});

test("an unavailable writer retains the worktree even when final persistence fails", async () => {
	const repo = repoFixture();
	const configured = dependencies(repo, {
		writerLifecycle: "unavailable",
		failFinalPersistence: true,
	});
	const result = await runSimpleTask(options(repo), configured.deps);
	strictEqual(configured.health.terminals.length, 1);
	strictEqual(
		configured.health.terminals[0].providerLifecycle.writerLifecycle,
		"unavailable",
	);
	ok(
		result.partialWorktree,
		"an unavailable writer must fail closed and retain the worktree",
	);
	ok(existsSync(result.partialWorktree));
	strictEqual(result.accountability.providerMemoryEligible, false);
	ok(configured.failedTerminalWrites > 0);
});
