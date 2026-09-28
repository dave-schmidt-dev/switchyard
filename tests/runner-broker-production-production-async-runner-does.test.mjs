import { ok, rejects, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createReservationLedger } from "../src/switchyard/broker/reservations.mjs";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import { route as productionRoute } from "../src/switchyard/router/index.mjs";
import {
	BOUNDED_QUOTA_EVIDENCE,
	descriptor,
	previousRosterPath,
	REVIEW_SUCCESS,
	runQueueAsync,
	writeDispatchQualifiedRosterFixture,
} from "./helpers/runner-broker-production-fixtures.mjs";
import { tempDirAsync } from "./helpers/tempdir.mjs";

const QUOTA_DIAGNOSTIC_REF = `diagnostic:${"a".repeat(32)}`;
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
test("production async runner does not retry before post-execution capture", async () => {
	const root = await tempDirAsync(
		"switchyard-production-broker-fallback-postexecution-",
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Fallback capture failure\n- **Status:** pending\n- **Type:** implementation\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Quick checks:** none\n- **Description:** record both provider outcomes\n",
	);
	const dispatches = [];
	let executions = 0;
	let captures = 0;
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-production-worker",
		checkpointPath,
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			adapters: {
				claude: {
					executeAsync: async () => {
						executions += 1;
						return executions === 1 ? { success: false } : { success: true };
					},
					captureDiffAsync: async () => {
						captures += 1;
						throw new Error("fallback capture failed");
					},
				},
			},
			recordDispatch: (entry) => dispatches.push(entry),
			recordDispatchIntent: () => {},
			route: ({ exclude, requiredCapability }) => {
				const fallback = exclude.some(
					(identifier) => identifier.toLowerCase() === "cheap",
				);
				const target = fallback ? "expensive" : "cheap";
				return {
					provider: target === "cheap" ? "Cheap" : "Expensive",
					resolvedTargetId: target,
					resolved_harness: "claude",
					model: `${target}-${requiredCapability}`,
					reason: "ranked",
				};
			},
			resolveTargetIdentity: (provider) => ({
				targetId: provider.toLowerCase(),
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: (target, capability) =>
				descriptor(
					target.toLowerCase(),
					`${target.toLowerCase()}-${capability}`,
				),
		},
	});
	strictEqual(result.results[0].success, false);
	strictEqual(executions, 1);
	strictEqual(captures, 1);
	strictEqual(dispatches.length, 1);
	strictEqual(dispatches[0].provider, "Cheap");
	strictEqual(dispatches[0].result, "execution_failed");
});
test("production async runner releases a reservation before an adapter precondition failure", async () => {
	const root = await tempDirAsync("switchyard-production-broker-release-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Missing adapter lifecycle\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** fail before launch\n",
	);
	const ledger = createReservationLedger({ root: join(root, "ledger") });
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-production-worker",
		checkpointPath,
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			adapters: { claude: { captureDiffAsync: async () => null } },
			brokerReservations: ledger,
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
	strictEqual(result.results[0].result, "execution_failed");
	strictEqual((await ledger.inspect()).reservations[0].state, "released");
});
test("production async runner cleans up when broker construction fails closed", async () => {
	const root = await tempDirAsync("switchyard-production-broker-construction-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Missing project\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** fail closed\n",
	);
	let destroyed = 0;
	await rejects(
		runQueueAsync({
			tasksFilePath,
			projectPath: "",
			checkpointPath,
			projectRevision: "fixed",
			dependencies: {
				queuePreflight: () => ({ ok: true, eligible: true }),
				backendFactory: () => ({
					executionBackend: {},
					create: () => "owned-broker-construction-worker",
					destroy: () => {
						destroyed += 1;
					},
					seed: () => {},
					commit: () => {},
					reset: () => {},
				}),
			},
		}),
		/requires projectPath/,
	);
	strictEqual(destroyed, 1);
});
test("production router path coordinates the requested snapshot source", async () => {
	const root = await tempDirAsync("switchyard-production-broker-real-router-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Real router\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** use production router\n",
	);
	let seenSource = null;
	let calls = 0;
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-production-worker",
		checkpointPath,
		only: ["claude-code"],
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			goldenImageVerifiedProviders: ["claude-code"],
			adapters: {
				claude: {
					executeAsync: async () => {
						calls += 1;
						return REVIEW_SUCCESS;
					},
					captureDiffAsync: async () => null,
				},
			},
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			route: productionRoute,
			readSnapshot: ({ source, nowMs }) => {
				seenSource = source;
				return {
					snapshot: {
						schema_version: 2,
						updated_at: new Date(nowMs).toISOString(),
						providers: [
							{
								name: "Claude",
								ok: true,
								windows: [
									{
										id: "weekly",
										percent_left: 90,
										reset_iso: new Date(nowMs + 86_400_000).toISOString(),
										window_hours: 168,
										pace_delta: 0,
									},
								],
							},
						],
					},
					snapshotMtime: 1,
				};
			},
		},
	});
	strictEqual(
		result.results[0].success,
		true,
		JSON.stringify(result.results[0]),
	);
	strictEqual(calls, 1);
	strictEqual(seenSource, "gradus-v2");
});
test("production router path rejects an unknown snapshot source", async () => {
	const root = await tempDirAsync(
		"switchyard-production-broker-unknown-source-",
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Unknown source\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** fail closed\n",
	);
	let calls = 0;
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-production-worker",
		checkpointPath,
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			adapters: {
				claude: {
					executeAsync: async () => {
						calls += 1;
						return { success: true };
					},
					captureDiffAsync: async () => null,
				},
			},
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			route: productionRoute,
			snapshotSource: "not-configured",
		},
	});
	strictEqual(result.results[0].success, false);
	strictEqual(result.results[0].errorKind, "unknown_failure");
	strictEqual(calls, 0);
});
test("production async runner writes a real diagnostic artifact for a failed launch", async () => {
	const root = await tempDirAsync("switchyard-production-broker-artifact-");
	const stateRoot = join(root, "state-root");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Artifact\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** fail once\n",
	);
	const previousStateRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
	process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;
	try {
		const runStore = await import("../src/switchyard/run-store/index.mjs");
		const runId = randomUUID();
		await runStore.initializeRun({
			runId,
			tasksFilePath,
			projectPath: root,
			orderedTaskIds: ["1.1"],
		});
		const result = await runQueueAsync({
			tasksFilePath,
			projectPath: root,
			checkpointPath,
			dependencies: {
				queuePreflight: () => ({ ok: true, eligible: true }),
				persistDiagnosticArtifact: (evidence) =>
					runStore.persistDiagnosticArtifact(runId, evidence),
				backendFactory: () => ({
					executionBackend: {},
					create: () => "owned-async-artifact-worker",
					destroy: () => {},
					seed: () => {},
					commit: () => {},
					reset: () => {},
				}),
				adapters: {
					claude: {
						executeAsync: async () => ({
							success: false,
							errorKind: "execution_failed",
							diagnosticCode: "provider_exit_nonzero",
							diagnosticOrigin: "adapter",
							diagnosticEvidenceAvailable: false,
							diagnosticEvidence: BOUNDED_QUOTA_EVIDENCE,
							failurePhase: "provider_execution",
							exitCode: 1,
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
					model: "cheap-review",
					reason: "ranked",
				}),
				resolveTargetIdentity: () => ({
					targetId: "cheap",
					harnessKey: "claude",
					ambiguous: false,
				}),
				resolveDescriptor: () => descriptor("cheap", "cheap-review"),
			},
		});
		strictEqual(result.results[0].success, false);
		const diagnosticRef = result.results[0].diagnosticRef;
		ok(
			/^diagnostic:[a-f0-9]{32}$/u.test(diagnosticRef ?? ""),
			`expected a diagnostic reference on the failed result, got ${diagnosticRef}`,
		);
		strictEqual(result.results[0].diagnosticEvidenceAvailable, true);
		const artifactPath = join(
			runStore.getRunRoot(runId),
			"resources",
			`provider-diagnostic-${diagnosticRef.slice("diagnostic:".length)}.json`,
		);
		ok(existsSync(artifactPath), `expected ${artifactPath} on disk`);
		const stored = JSON.parse(await readFile(artifactPath, "utf8"));
		strictEqual(stored.kind, "provider_diagnostic");
		strictEqual(stored.stdoutDigest, BOUNDED_QUOTA_EVIDENCE.stdoutDigest);
		// The raw streams stay producer-local: the durable record carries sizes
		// and digests only, and the result never carries the evidence itself.
		strictEqual(result.results[0].diagnosticEvidence, undefined);
	} finally {
		if (previousStateRoot === undefined)
			delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		else process.env.SWITCHYARD_RUN_STORE_ROOT = previousStateRoot;
	}
});
