import { strictEqual } from "node:assert";
import { rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createReservationLedger } from "../src/switchyard/broker/reservations.mjs";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import {
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
test("production async runner isolates selection failures and releases early reservations", async () => {
	const root = await tempDirAsync("switchyard-production-broker-failure-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: First\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** first\n\n### Task 1.2: Second\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** second\n",
	);
	const ledger = createReservationLedger({ root: join(root, "ledger") });
	let routeCalls = 0;
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		checkpointPath,
		stopOnFailure: false,
		workingContainerName: "broker-production-worker",
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			adapters: {
				claude: {
					executeAsync: async () => REVIEW_SUCCESS,
					captureDiffAsync: async () => null,
				},
			},
			brokerReservations: ledger,
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			route: ({ requiredCapability }) => {
				routeCalls += 1;
				if (routeCalls === 1) throw new Error("identity disagreement");
				return {
					provider: "Cheap",
					resolvedTargetId: "cheap",
					resolved_harness: "claude",
					model: `cheap-${requiredCapability}`,
					reason: "ranked",
				};
			},
			resolveTargetIdentity: () => ({
				targetId: "cheap",
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: (_target, capability) =>
				descriptor("cheap", `cheap-${capability}`),
		},
	});
	strictEqual(result.results.length, 2);
	strictEqual(result.results[0].success, false);
	strictEqual(result.results[1].success, true);
	strictEqual((await ledger.inspect()).reservations.length, 1);
	strictEqual((await ledger.inspect()).reservations[0].state, "reconciled");
});
test("production async runner clears route state after a successful task before selection fails", async () => {
	const root = await tempDirAsync(
		"switchyard-production-broker-state-isolation-",
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: First\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** succeeds\n\n### Task 1.2: Second\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** selection fails\n",
	);
	const dispatches = [];
	let routeCalls = 0;
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-production-worker",
		checkpointPath,
		stopOnFailure: false,
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
			route: ({ requiredCapability }) => {
				routeCalls += 1;
				if (routeCalls === 2) throw new Error("selection failed");
				return {
					provider: "Cheap",
					resolvedTargetId: "cheap",
					resolved_harness: "claude",
					model: `cheap-${requiredCapability}`,
					reason: "ranked",
				};
			},
			resolveTargetIdentity: () => ({
				targetId: "cheap",
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: (_target, capability) =>
				descriptor("cheap", `cheap-${capability}`),
		},
	});
	strictEqual(result.results[0].success, true);
	strictEqual(result.results[1].success, false);
	strictEqual(result.results[1].provider, null);
	strictEqual(result.results[1].model, null);
	strictEqual(result.results[1].errorKind, "unknown_failure");
	strictEqual(dispatches.at(-1).provider, "none");
});
test("production async runner does not write a fallback intent for a generic failure", async () => {
	const root = await tempDirAsync(
		"switchyard-production-broker-fallback-intent-",
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Fallback intent\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** intent must precede fallback\n",
	);
	const ledger = createReservationLedger({ root: join(root, "ledger") });
	const calls = [];
	let intentCalls = 0;
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-production-worker",
		checkpointPath,
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			adapters: {
				claude: {
					executeAsync: async (_prompt, _container, options) => {
						calls.push(options.resolvedTargetId);
						return { success: false };
					},
					captureDiffAsync: async () => null,
				},
			},
			brokerReservations: ledger,
			recordDispatch: () => {},
			recordDispatchIntent: () => {
				intentCalls += 1;
			},
			route: ({ exclude, requiredCapability }) => {
				const target = exclude.some(
					(identifier) => identifier.toLowerCase() === "cheap",
				)
					? "expensive"
					: "cheap";
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
	strictEqual(result.results[0].result, "execution_failed");
	strictEqual(result.results[0].provider, "Cheap");
	strictEqual(calls.length, 1);
	strictEqual(intentCalls, 1);
	strictEqual((await ledger.inspect()).reservations.length, 1);
	strictEqual(
		(await ledger.inspect()).reservations.every(
			(entry) => entry.state === "released",
		),
		true,
	);
});
test("production async runner preserves a generic broker failure without retry", async () => {
	const root = await tempDirAsync("switchyard-production-broker-precondition-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Retry precondition\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** preserve bounded ledger identity\n",
	);
	const dispatches = [];
	let calls = 0;
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		checkpointPath,
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			backendFactory: () => ({
				executionBackend: {},
				create: () => "owned-broker-precondition-worker",
				destroy: () => {},
				seed: () => {},
				commit: () => {},
				reset: () => {},
			}),
			adapters: {
				claude: {
					executeAsync: async (_prompt, _container, options) => {
						calls += 1;
						if (calls === 2) {
							return {
								success: false,
								errorKind: "quota_exhausted",
								resolvedTargetId: options.resolvedTargetId,
							};
						}
						return { success: false };
					},
					captureDiffAsync: async () => null,
				},
			},
			recordDispatch: (entry) => dispatches.push(entry),
			recordDispatchIntent: () => {},
			route: ({ exclude, requiredCapability }) => {
				const excluded = exclude.map((entry) => entry.toLowerCase());
				const target = excluded.includes("expensive") ? "cheap" : "expensive";
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
	strictEqual(result.results[0].errorKind, "execution_failed");
	strictEqual(dispatches.length, 1);
	strictEqual(dispatches[0].result, "execution_failed");
	strictEqual(calls, 1);
});
test("production async runner does not fallback a typed nonretryable failure", async () => {
	const root = await tempDirAsync("switchyard-production-broker-nonretryable-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Auth failure\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** no fallback\n",
	);
	const ledger = createReservationLedger({ root: join(root, "ledger") });
	const calls = [];
	const dispatches = [];
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-production-worker",
		checkpointPath,
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			adapters: {
				claude: {
					executeAsync: async (_prompt, _container, options) => {
						calls.push(options.resolvedTargetId);
						return { success: false, errorKind: "auth_expired" };
					},
					captureDiffAsync: async () => null,
				},
			},
			brokerReservations: ledger,
			recordDispatch: (entry) => dispatches.push(entry),
			recordDispatchIntent: () => {},
			route: ({ requiredCapability }) => ({
				provider: "Cheap",
				resolvedTargetId: "cheap",
				resolved_harness: "claude",
				model: `cheap-${requiredCapability}`,
				reason: "ranked",
			}),
			resolveTargetIdentity: () => ({
				targetId: "cheap",
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: (_target, capability) =>
				descriptor("cheap", `cheap-${capability}`),
		},
	});
	strictEqual(result.results[0].success, false);
	strictEqual(result.results[0].errorKind, "auth_expired");
	strictEqual(calls.length, 1);
	strictEqual(dispatches[0].errorKind, "auth_expired");
	strictEqual((await ledger.inspect()).reservations[0].state, "released");
});
test("production async runner records the routed provider when post-execution capture throws", async () => {
	const root = await tempDirAsync(
		"switchyard-production-broker-postexecution-",
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Capture failure\n- **Status:** pending\n- **Type:** implementation\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Quick checks:** none\n- **Description:** preserve route identity\n",
	);
	const dispatches = [];
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-production-worker",
		checkpointPath,
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			adapters: {
				claude: {
					executeAsync: async () => ({ success: true }),
					captureDiffAsync: async () => {
						throw new Error("capture failed");
					},
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
	strictEqual(result.results[0].success, false);
	strictEqual(result.results[0].provider, "Cheap");
	strictEqual(result.results[0].model, "cheap-standard");
	strictEqual(dispatches.at(-1).result, "execution_failed");
	strictEqual(dispatches.at(-1).provider, "Cheap");
});
