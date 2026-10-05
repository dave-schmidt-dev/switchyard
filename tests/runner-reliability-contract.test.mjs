import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { integrationGate } from "../src/switchyard/integrate/index.mjs";
import { getInvocationDescriptorIdentity } from "../src/switchyard/roster/index.mjs";
import { parseQuickChecks } from "../src/switchyard/runner/check-contract.mjs";
import { runQuickChecks } from "../src/switchyard/runner/checks.mjs";
import {
	loadCheckpoint,
	runQueue,
	runQueueAsync,
} from "../src/switchyard/runner/index.mjs";
import {
	acceptanceCheckDiagnostic,
	runCommand,
} from "../src/switchyard/runner/reliability.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const TEST_DIR = tempDir("switchyard-queue-reliability-");
function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}
function projectAt(name) {
	const project = join(TEST_DIR, name);
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, "a.mjs"), "export const a = 1;\n");
	writeFileSync(join(project, "broken.mjs"), "export const = ;\n");
	git(project, ["init", "-q"]);
	git(project, ["add", "."]);
	git(project, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"base",
	]);
	return { project, base: git(project, ["rev-parse", "HEAD^{tree}"]) };
}
function tasksFile(path, baseline) {
	writeFileSync(
		path,
		`### Task 51: Queue baseline\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** a.mjs\n- **Quick checks:** none\n- **Baseline checks:** ${baseline}\n- **Description:** Leave the committed source unchanged\n`,
	);
}
function backend(base) {
	return {
		create: () => "fake",
		destroy: () => {},
		seed: () => {},
		commit: () => {},
		reset: () => {},
		readiness: () => ({}),
		captureTaskBase: () => ({
			ref: "refs/switchyard/task-base/test/51",
			tree: base,
		}),
		validateTaskBase: (_id, value) => value,
		releaseTaskBase: () => {},
	};
}
function descriptor() {
	const core = {
		target_id: "claude",
		model_ref: "claude-sonnet-5-5",
		selector: "claude-sonnet-5-5",
		effort: null,
		variant: null,
		invocation_args: [],
	};
	return {
		...core,
		descriptor_identity: getInvocationDescriptorIdentity(core, "claude"),
	};
}

function fixturePreflightReadSnapshot({ ok = true, percentLeft = 80 } = {}) {
	// Keep the real queue preflight deterministic without reading host quota.
	return () => ({
		snapshot: {
			schema_version: 2,
			updated_at: new Date().toISOString(),
			providers: [
				{
					name: "claude",
					ok,
					windows: [{ percent_left: percentLeft, pace_delta: 1 }],
				},
			],
		},
		snapshotStatus: "fresh",
		snapshotMtime: 1,
		snapshotAgeMsAtRoute: 0,
	});
}

function commandFromScript(
	script,
	{ timeout = 15_000, maxBuffer = 1024 } = {},
) {
	mkdirSync(TEST_DIR, { recursive: true });
	return runCommand(TEST_DIR, process.env, ["node", "--version"], 100, {
		sandbox: false,
		spawnSync: (_command, _args, options) =>
			spawnSync(process.execPath, ["-e", script], {
				...options,
				timeout,
				maxBuffer,
			}),
	});
}
after(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("queue reliability contract", () => {
	it("distinguishes an outer timeout from worker overflow and nonzero exit", () => {
		const timeout = commandFromScript("setTimeout(() => {}, 60_000)", {
			timeout: 50,
		});
		strictEqual(timeout.timedOut, true);
		strictEqual(timeout.groupCleanup, "unknown");

		const overflow = commandFromScript(
			'process.stdout.write("x".repeat(100_000))',
		);
		strictEqual(overflow.timedOut, false);
		strictEqual(overflow.groupCleanup, "unknown");

		const nonzero = commandFromScript("process.exitCode = 7");
		strictEqual(nonzero.timedOut, false);
		strictEqual(nonzero.groupCleanup, "unknown");
	});

	it("accepts only closed worker receipts and keeps malformed checks ineligible", () => {
		const value = {
			exitCode: null,
			signal: "SIGTERM",
			timedOut: true,
			groupCleanup: "complete",
		};
		const closed = runCommand(
			TEST_DIR,
			process.env,
			["node", "--version"],
			100,
			{
				sandbox: false,
				spawnSync: () => ({ status: 0, stdout: JSON.stringify(value) }),
			},
		);
		deepStrictEqual(closed, value);

		const malformed = runCommand(
			TEST_DIR,
			process.env,
			["node", "--version"],
			100,
			{
				sandbox: false,
				spawnSync: () => ({
					status: 0,
					stdout: JSON.stringify({
						...value,
						transcript: "private worker output",
					}),
				}),
			},
		);
		deepStrictEqual(malformed, {
			exitCode: null,
			signal: null,
			timedOut: false,
			groupCleanup: "unknown",
		});
		strictEqual(
			JSON.stringify(malformed).includes("private worker output"),
			false,
		);

		const command = ["node", "--check", "a.mjs"];
		const decision = acceptanceCheckDiagnostic(
			{ quickChecks: { checks: [command], repairChecks: [command] } },
			{
				status: "failed",
				cleanup: { status: malformed.groupCleanup },
				checks: [
					{
						...malformed,
						index: 0,
						commandSha256: "a".repeat(64),
					},
				],
			},
		);
		strictEqual(decision.causeCode, "acceptance_check_failed");
		strictEqual(decision.eligible, false);
	});

	it("parses optional direct-exec baseline and repair checks without changing absent defaults", () => {
		const plain = parseQuickChecks("- **Quick checks:** none", "51");
		deepStrictEqual(plain, { checks: [], setup: null, declared: true });
		const configured = parseQuickChecks(
			"- **Quick checks:** node --check a.mjs\n- **Baseline checks:** node --check broken.mjs\n- **Repair checks:** node --check a.mjs",
			"51",
		);
		deepStrictEqual(configured.baselineChecks, [
			["node", "--check", "broken.mjs"],
		]);
		deepStrictEqual(configured.repairChecks, [["node", "--check", "a.mjs"]]);
		throws(
			() =>
				parseQuickChecks(
					"- **Quick checks:** none\n- **Baseline checks:** npm run lint && echo unsafe",
					"51",
				),
			/Quick check/i,
		);
	});

	it("fails a baseline before sync or production async provider invocation and binds its receipt", async () => {
		const { project, base } = projectAt("baseline-failure");
		const tasksPath = join(TEST_DIR, "tasks.md");
		tasksFile(tasksPath, "node --check broken.mjs");
		let syncStarts = 0;
		const sync = runQueue({
			tasksFilePath: tasksPath,
			projectPath: project,
			workingContainerName: "fake",
			checkpointPath: `${tasksPath}.sync.checkpoint.json`,
			stopOnFailure: false,
			dependencies: {
				backendFactory: () => backend(base),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5-5",
					reason: "fixture",
				}),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				goldenImageVerifiedProviders: ["claude"],
				preflightReadSnapshot: fixturePreflightReadSnapshot(),
				integrationGate,
				adapters: {
					claude: {
						execute: () => {
							syncStarts += 1;
							return { success: true, output: "done" };
						},
						captureDiff: () => null,
					},
				},
			},
		});
		strictEqual(sync.results[0].result, "baseline_check_failed");
		strictEqual(sync.results[0].providerLifecycle, null);
		strictEqual(syncStarts, 0);
		const checkpointPath = `${tasksPath}.sync.checkpoint.json`;
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		const receipt = checkpoint.results[0].baselineCheckReceipt;
		strictEqual(receipt.taskId, "51");
		strictEqual(receipt.attempt, checkpoint.results[0].attempt);
		strictEqual(receipt.checks[0].exitCode, 1);
		strictEqual(receipt.cleanup, "complete");
		ok(!JSON.stringify(receipt).includes("broken.mjs"));
		const tampered = JSON.parse(readFileSync(checkpointPath, "utf8"));
		tampered.results[0].baselineCheckReceipt.attempt += 1;
		writeFileSync(checkpointPath, JSON.stringify(tampered));
		throws(
			() => loadCheckpoint(checkpointPath, tasksPath),
			/baseline receipt/i,
		);

		let asyncStarts = 0;
		const asyncPath = `${tasksPath}.async.checkpoint.json`;
		const asyncResult = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: project,
			workingContainerName: "fake",
			checkpointPath: asyncPath,
			stopOnFailure: false,
			dependencies: {
				backendFactory: () => backend(base),
				integrationGate,
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				goldenImageVerifiedProviders: ["claude"],
				preflightReadSnapshot: fixturePreflightReadSnapshot(),
				resolveDescriptor: descriptor,
				broker: {
					selectAndReserve: async () => ({
						provider: "claude",
						model: "claude-sonnet-5-5",
						resolvedTarget: "claude",
						harness: "claude",
						capability: "standard",
						reason: "fixture",
						snapshotIdentity: { status: "fresh", mtime: null, ageMs: 0 },
					}),
					launcherIdentity: () => ({}),
					execute: async () => {
						asyncStarts += 1;
						return { success: true };
					},
					release: async () => {},
				},
				adapters: {
					claude: {
						executeAsync: async () => {
							asyncStarts += 1;
							return { success: true };
						},
						captureDiffAsync: async () => null,
						captureDiff: async () => null,
					},
				},
			},
		});
		strictEqual(
			asyncResult.results[0].result,
			"baseline_check_failed",
			JSON.stringify(asyncResult.results[0]),
		);
		strictEqual(asyncResult.results[0].providerLifecycle, null);
		strictEqual(asyncStarts, 0);
		const asyncCheckpoint = loadCheckpoint(asyncPath, tasksPath);
		strictEqual(
			asyncCheckpoint.results[0].baselineCheckReceipt.attempt,
			asyncCheckpoint.results[0].attempt,
		);
	});

	it("rejects exhausted and unavailable synthetic providers before launch", () => {
		for (const scenario of [
			{
				name: "exhausted-quota",
				snapshot: { percentLeft: 0 },
				reason: "no_quota_headroom",
			},
			{
				name: "unavailable-provider",
				snapshot: { ok: false },
				reason: "provider_unavailable",
			},
		]) {
			const { project, base } = projectAt(scenario.name);
			const tasksPath = join(TEST_DIR, `${scenario.name}.tasks.md`);
			tasksFile(tasksPath, "node --check a.mjs");
			let launches = 0;
			throws(
				() =>
					runQueue({
						tasksFilePath: tasksPath,
						projectPath: project,
						checkpointPath: `${tasksPath}.checkpoint.json`,
						stopOnFailure: false,
						dependencies: {
							backendFactory: () => ({
								...backend(base),
								create: () => {
									launches += 1;
									return "fake";
								},
							}),
							adapters: { claude: { execute: () => ({ success: true }) } },
							goldenImageVerifiedProviders: ["claude"],
							preflightReadSnapshot: fixturePreflightReadSnapshot(
								scenario.snapshot,
							),
							hostPowerPolicyEnabled: false,
							route: () => {
								launches += 1;
								return {
									provider: "claude",
									model: "claude-sonnet-5-5",
								};
							},
							recordDispatch: () => {},
							recordDispatchIntent: () => {},
							integrationGate,
						},
					}),
				(error) => {
					strictEqual(error.name, "QueuePreflightError", error.message);
					strictEqual(
						error.preflightDetail.rejections[0].excludedReasons.claude,
						scenario.reason,
					);
					return true;
				},
			);
			strictEqual(launches, 0);
		}
	});

	it("rejects a baseline check that mutates tracked candidate files", () => {
		const { project, base } = projectAt("baseline-mutation");
		writeFileSync(
			join(project, "package.json"),
			JSON.stringify({ scripts: { mutate: "node mutate.mjs" } }),
		);
		writeFileSync(
			join(project, "mutate.mjs"),
			"import { writeFileSync } from 'node:fs'; writeFileSync('a.mjs', 'export const a = 2;\\n');\n",
		);
		git(project, ["add", "."]);
		git(project, [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-qm",
			"mutator",
		]);
		const mutationBase = git(project, ["rev-parse", "HEAD^{tree}"]);
		const receipt = runQuickChecks({
			projectPath: project,
			taskId: "51",
			attempt: 1,
			baseTree: mutationBase || base,
			diff: null,
			checks: [["npm", "run", "mutate"]],
			setup: null,
			baseline: true,
		});
		strictEqual(receipt.status, "failed");
		strictEqual(receipt.failureCode, "baseline_mutation");
		strictEqual(receipt.checks[0].exitCode, 0);
		strictEqual(receipt.cleanup.status, "complete");
	});

	it("bounds repair acceptance checks to the pinned absolute deadline", () => {
		const { project, base } = projectAt("repair-deadline");
		writeFileSync(join(project, "a.mjs"), "export const a = 2;\n");
		const diff = git(project, ["diff", "--", "a.mjs"]);
		writeFileSync(join(project, "a.mjs"), "export const a = 1;\n");
		const receipt = runQuickChecks({
			projectPath: project,
			taskId: "51",
			attempt: 1,
			baseTree: base,
			diff,
			checks: [["node", "--check", "a.mjs"]],
			allowedPaths: ["a.mjs"],
			deadline: new Date(Date.now() - 1_000).toISOString(),
		});
		strictEqual(receipt.status, "failed");
		strictEqual(receipt.checks[0].exitCode, null);
		strictEqual(receipt.checks[0].timedOut, true);
		strictEqual(receipt.checks[0].groupCleanup, "complete");
		strictEqual(receipt.cleanup.status, "complete");
	});
});
