import { ok, strictEqual } from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import {
	descriptor,
	previousRosterPath,
	REVIEW_SUCCESS,
	runQueueAsync,
	writeDispatchQualifiedRosterFixture,
} from "./helpers/runner-broker-production-fixtures.mjs";
import { tempDirAsync } from "./helpers/tempdir.mjs";

let qualifiedRosterPath = null;
before(() => {
	qualifiedRosterPath = writeDispatchQualifiedRosterFixture();
	process.env.SWITCHYARD_ROSTER_PATH = qualifiedRosterPath;
	__resetRosterCacheForTests();
});
after(() => {
	if (previousRosterPath === undefined) {
		delete process.env.SWITCHYARD_ROSTER_PATH;
	} else {
		process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
	}
	__resetRosterCacheForTests();
	if (qualifiedRosterPath) {
		try {
			rmSync(qualifiedRosterPath, { force: true });
		} catch {}
	}
});
test("production async runner records the adapter's served-model verification", async () => {
	for (const [servedModel, expected] of [
		["cheap-standard", true],
		[null, false],
		[undefined, undefined],
	]) {
		const root = await tempDirAsync("switchyard-broker-served-");
		const tasksFilePath = join(root, "TASKS.md");
		const checkpointPath = join(root, "checkpoint.json");
		const typedOutcomes = [];
		await writeFile(
			tasksFilePath,
			"### Task 1.1: Served model\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** carry the served-model fact\n",
		);
		const result = await runQueueAsync({
			tasksFilePath,
			projectPath: root,
			workingContainerName: "broker-served-worker",
			checkpointPath,
			dependencies: {
				recordOutcomeEvent: (outcome) => typedOutcomes.push(outcome),
				outcomeWriterEpoch: "epoch-1",
				queuePreflight: () => ({ ok: true, eligible: true }),
				backendFactory: () => ({
					executionBackend: {},
					create: () => "broker-served-worker",
					destroy: () => {},
					seed: () => {},
					commit: () => {},
					reset: () => {},
				}),
				adapters: {
					claude: {
						executeAsync: async () => ({
							success: true,
							output: "done",
							...(servedModel === undefined ? {} : { servedModel }),
						}),
						captureDiffAsync: async () => null,
					},
				},
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				route: () => ({
					provider: "Cheap",
					resolvedTargetId: "cheap",
					resolved_harness: "claude",
					model: "cheap-standard",
					reason: "ranked",
				}),
				resolveTargetIdentity: () => ({
					targetId: "cheap",
					harnessKey: "claude",
					ambiguous: false,
				}),
				resolveDescriptor: () => descriptor("cheap", "cheap-standard"),
			},
		});
		const record = result.results[0];
		strictEqual(typedOutcomes.length, 1);
		strictEqual(record.executionOutcome.outcomeId, typedOutcomes[0].outcomeId);
		strictEqual(record.executionOutcome.detail.targetId, "cheap");
		if (expected === undefined) {
			strictEqual(
				Object.hasOwn(record, "servedModelVerified"),
				false,
				"an adapter that cannot report a served model must leave the field absent",
			);
		} else {
			strictEqual(record.servedModelVerified, expected);
		}
		const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
		strictEqual(
			checkpoint.results[0].servedModelVerified,
			expected,
			"the checkpoint entry must agree with the result record",
		);
		strictEqual(
			JSON.stringify(result).includes("cheap-standard-served"),
			false,
		);
	}
});
test("production async runner fails closed when typed outcome persistence fails", async () => {
	const root = await tempDirAsync("switchyard-broker-outcome-write-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Outcome write\n- **Status:** pending\n- **Type:** implementation\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Quick checks:** none\n- **Description:** fail closed on outcome persistence\n",
	);
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-outcome-write-worker",
		checkpointPath,
		dependencies: {
			recordOutcomeEvent: () => {
				throw new Error("outcome store unavailable");
			},
			outcomeWriterEpoch: "epoch-1",
			queuePreflight: () => ({ ok: true, eligible: true }),
			backendFactory: () => ({
				executionBackend: {},
				create: () => "broker-outcome-write-worker",
				destroy: () => {},
				seed: () => {},
				commit: () => {},
				reset: () => {},
			}),
			adapters: {
				claude: {
					executeAsync: async (_prompt, options) => {
						await options.onProcessCompleted({ success: true });
						return { success: true, output: "done" };
					},
					captureDiffAsync: async () => null,
				},
			},
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			route: () => ({
				provider: "Cheap",
				resolvedTargetId: "cheap",
				resolved_harness: "claude",
				model: "cheap-standard",
				reason: "ranked",
			}),
			resolveTargetIdentity: () => ({
				targetId: "cheap",
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: () => descriptor("cheap", "cheap-standard"),
		},
	});
	strictEqual(result.results[0].success, false);
	strictEqual(result.results[0].result, "recovery_required");
	strictEqual(result.results[0].errorKind, "recovery_incomplete");
	strictEqual(result.results[0].failurePhase, "terminal_reconciliation");
	strictEqual(result.results[0].executionOutcome.status, "failed");
	strictEqual(result.results[0].executionOutcome.causedBy, null);
});
test("production async runner records which cleanup stage failed", async () => {
	const root = await tempDirAsync("switchyard-broker-cleanup-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Cleanup stage\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** carry the cleanup stage\n",
	);
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-cleanup-worker",
		checkpointPath,
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			backendFactory: () => ({
				executionBackend: {},
				create: () => "broker-cleanup-worker",
				destroy: () => {},
				seed: () => {},
				commit: () => {},
				reset: () => {},
			}),
			adapters: {
				claude: {
					// A provider that outlived its kill: the stage is the only
					// fact that says how far cleanup got before it gave up.
					executeAsync: async () => ({
						success: false,
						output: "",
						error: "provider cleanup failed after timeout",
						timedOut: true,
						cleanupFailed: true,
						cleanupStage: "tree_terminated",
						diagnosticCode: "provider_cleanup_after_tree_terminated",
						failurePhase: "provider_cleanup",
						diagnosticOrigin: "adapter",
						diagnosticEvidenceAvailable: true,
					}),
					captureDiffAsync: async () => null,
				},
			},
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			route: () => ({
				provider: "Cheap",
				resolvedTargetId: "cheap",
				resolved_harness: "claude",
				model: "cheap-standard",
				reason: "ranked",
			}),
			resolveTargetIdentity: () => ({
				targetId: "cheap",
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: () => descriptor("cheap", "cheap-standard"),
		},
	});
	const record = result.results[0];
	strictEqual(record.result, "execution_timed_out_cleanup_failed");
	strictEqual(record.errorKind, "provider_cleanup_failed");
	strictEqual(
		record.diagnosticCode,
		"provider_cleanup_after_tree_terminated",
		"the diagnostic code is derived from the stage, so a dropped stage degrades it",
	);
	const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
	strictEqual(
		checkpoint.results[0].diagnosticCode,
		"provider_cleanup_after_tree_terminated",
	);
});
test("production async runner omits the provider transcript when the broker gate rejects an empty diff", async () => {
	const root = await tempDirAsync("switchyard-broker-gate-evidence-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	const transcript =
		"I inspected src/a.mjs and concluded no change was required.";
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Empty-diff task\n- **Status:** pending\n- **Type:** implementation\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Quick checks:** none\n- **Description:** the provider explains itself but changes nothing\n",
	);
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-gate-evidence-worker",
		checkpointPath,
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			backendFactory: () => ({
				executionBackend: {},
				create: () => "broker-gate-evidence-worker",
				destroy: () => {},
				seed: () => {},
				commit: () => {},
				reset: () => {},
			}),
			adapters: {
				claude: {
					executeAsync: async () => ({
						success: true,
						output: transcript,
						error: null,
					}),
					captureDiffAsync: async () => "",
				},
			},
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			route: () => ({
				provider: "Cheap",
				resolvedTargetId: "cheap",
				resolved_harness: "claude",
				model: "cheap-standard",
				reason: "ranked",
			}),
			resolveTargetIdentity: () => ({
				targetId: "cheap",
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: () => descriptor("cheap", "cheap-standard"),
		},
	});
	const record = result.results[0];
	strictEqual(record.success, false);
	strictEqual(
		record.diagnosticCode ?? record.reasonCode,
		"empty_required_diff",
	);
	strictEqual(record.artifactRef, undefined);
	const artifactPath = `${checkpointPath}.partial-diffs/1.1.output`;
	ok(!existsSync(artifactPath), "raw provider output must not be retained");
	strictEqual(
		record.gateEvidence,
		null,
		"raw transcript must not ride along in the result",
	);

	const rawCheckpointJson = await readFile(checkpointPath, "utf8");
	ok(
		!rawCheckpointJson.includes(transcript),
		"checkpoint.json must not retain the transcript",
	);
	ok(!rawCheckpointJson.includes(".output"));
});
test("production async runner halts on cleanup uncertainty after a successful provider result", async () => {
	const root = await tempDirAsync("switchyard-broker-cleanup-success-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Surviving provider\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** succeed while cleanup fails\n",
	);
	const dispatches = [];
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-cleanup-success-worker",
		checkpointPath,
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			adapters: {
				claude: {
					executeAsync: async () => ({
						success: true,
						output: "",
						cleanupFailed: true,
						cleanupStage: "tree_terminated",
					}),
					captureDiffAsync: async () => null,
				},
			},
			recordDispatch: (entry) => dispatches.push(entry),
			recordDispatchIntent: () => {},
			route: () => ({
				provider: "Cheap",
				resolvedTargetId: "cheap",
				resolved_harness: "claude",
				model: "cheap-standard",
				reason: "ranked",
			}),
			resolveTargetIdentity: () => ({
				targetId: "cheap",
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: () => descriptor("cheap", "cheap-standard"),
		},
	});
	const record = result.results[0];
	strictEqual(record.result, "provider_cleanup_failed");
	strictEqual(record.success, false);
	strictEqual(
		record.cleanupFailed,
		true,
		"a success that left a process running is not an unqualified success",
	);
	strictEqual(record.cleanupStage, "tree_terminated");
	const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
	strictEqual(checkpoint.results[0].cleanupFailed, true);
	strictEqual(checkpoint.results[0].cleanupStage, "tree_terminated");
	strictEqual(checkpoint.providerCleanupUncertain.taskId, "1.1");
	ok(checkpoint.taskBases["1.1"], "the immutable base remains anchored");
	strictEqual(
		result.results.at(-1).result,
		"halted_after_provider_cleanup_failure",
	);
	// The ledger is the record an operator greps to find hosts with orphaned
	// provider processes, so it has to carry the stage too.
	strictEqual(dispatches.at(-1).result, "provider_cleanup_failed");
	strictEqual(dispatches.at(-1).cleanupStage, "tree_terminated");
});
test("production async runner adds no cleanup fields when cleanup succeeded", async () => {
	const root = await tempDirAsync("switchyard-broker-cleanup-clean-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Clean exit\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** succeed with cleanup intact\n",
	);
	const dispatches = [];
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-cleanup-clean-worker",
		checkpointPath,
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			adapters: {
				claude: {
					executeAsync: async () => REVIEW_SUCCESS,
					captureDiffAsync: async () => null,
				},
			},
			recordDispatch: (entry) => dispatches.push(entry),
			recordDispatchIntent: () => {},
			route: () => ({
				provider: "Cheap",
				resolvedTargetId: "cheap",
				resolved_harness: "claude",
				model: "cheap-standard",
				reason: "ranked",
			}),
			resolveTargetIdentity: () => ({
				targetId: "cheap",
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: () => descriptor("cheap", "cheap-standard"),
		},
	});
	strictEqual(result.results[0].success, true);
	strictEqual(
		Object.hasOwn(result.results[0], "cleanupFailed"),
		false,
		"a clean run must not carry a cleanupFailed key at all",
	);
	strictEqual(Object.hasOwn(result.results[0], "cleanupStage"), false);
	strictEqual(Object.hasOwn(dispatches.at(-1), "cleanupFailed"), false);
});
