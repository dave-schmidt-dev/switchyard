import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { captureProviderDiffDetailedAsync } from "../src/switchyard/adapter/provider-lifecycle-diff-capture.mjs";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import {
	__resetRosterCacheForTests,
	resolveTargetIdentity,
} from "../src/switchyard/roster/index.mjs";
import {
	GOLDEN_IMAGE_VERIFIED_PROVIDERS,
	preflightMacosQueue,
} from "../src/switchyard/router/index.mjs";
import {
	createQueueBackend,
	executeTaskAsync,
	normalizeRunOptions,
	runQueue,
	runQueueAsync,
} from "../src/switchyard/runner/index.mjs";
import {
	FIXTURE_PATH,
	HEALTH_ROOT,
	HEALTH_RUN_ROOT,
	previousRosterPath,
	previousRunStoreRoot,
	ROUTER_ROSTER_PATH,
	SNAPSHOT_PATH,
	withDispatchQualifiedDescriptors,
} from "./helpers/router-fixtures.mjs";

const UNVERIFIED_PROVIDER = "unverified-provider-fixture";

function guestText(args) {
	const match = /^'eval "\$\(printf %s ([A-Za-z0-9+/=]+) \| .*\)"'$/.exec(
		args.at(-1) ?? "",
	);
	if (!match) return args.join(" ");
	const decoded = Buffer.from(match[1], "base64").toString("utf8");
	return `${args.slice(0, -1).join(" ")} ${decoded}`;
}

before(() => {
	rmSync(HEALTH_ROOT, { recursive: true, force: true });
	rmSync(HEALTH_RUN_ROOT, { recursive: true, force: true });
	process.env.SWITCHYARD_RUN_STORE_ROOT = HEALTH_RUN_ROOT;
	process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = SNAPSHOT_PATH;
	writeFileSync(
		ROUTER_ROSTER_PATH,
		JSON.stringify(
			withDispatchQualifiedDescriptors(
				JSON.parse(readFileSync(FIXTURE_PATH, "utf8")),
			),
		),
		"utf8",
	);
	process.env.SWITCHYARD_ROSTER_PATH = ROUTER_ROSTER_PATH;
	__resetRosterCacheForTests();
});

after(() => {
	delete process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;
	if (previousRosterPath === undefined) {
		delete process.env.SWITCHYARD_ROSTER_PATH;
	} else {
		process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
	}
	__resetRosterCacheForTests();
	try {
		rmSync(SNAPSHOT_PATH, { force: true });
		rmSync(ROUTER_ROSTER_PATH, { force: true });
		rmSync(HEALTH_ROOT, { recursive: true, force: true });
		rmSync(HEALTH_RUN_ROOT, { recursive: true, force: true });
		if (previousRunStoreRoot === undefined)
			delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRunStoreRoot;
	} catch {
		// Ignore
	}
});

describe("Task 4.3 timeout boundaries", () => {
	it("records Docker timeout capture failure only after capture resolves", async () => {
		const order = [];
		const dispatches = [];
		const descriptor = {
			target_id: "claude-code",
			model_ref: "fixture/claude-standard",
			selector: "fixture/claude-standard",
			invocation_args: [],
		};
		const result = await executeTaskAsync(
			{
				id: "4.3-docker",
				title: "timeout",
				description: "timeout",
				requiredPaths: null,
			},
			{
				queueBackend: {
					captureTaskBaseAsync: async () => ({
						ref: "refs/switchyard/task-base/router-timeout/4.3-docker",
						tree: "4".repeat(40),
					}),
					validateTaskBaseAsync: async (_workspaceId, base) => base,
				},
				taskBases: {},
				route: () => ({
					provider: "claude",
					resolved_harness: "claude",
					resolvedTargetId: "claude-code",
					model: descriptor.selector,
					invocationDescriptor: descriptor,
				}),
				resolveDescriptor: () => descriptor,
				recordDispatch: (entry) => {
					order.push(`record:${entry.result}`);
					dispatches.push(entry);
				},
				recordDispatchIntent: () => {},
				integrationGate: () => {
					throw new Error("timeout capture failure must not reach the gate");
				},
				adapters: {
					claude: {
						executeAsync: async () => ({
							success: false,
							timedOut: true,
							error: "provider execution timed out (ETIMEDOUT)",
						}),
						captureDiffAsync: async () => {
							order.push("capture");
							return null;
						},
					},
				},
				workingContainerName: "docker-worker",
				projectPath: process.cwd(),
			},
		);

		strictEqual(result.result, "execution_timed_out_capture_failed");
		strictEqual(result.success, false);
		strictEqual(result.timedOut, true);
		strictEqual(result.errorKind, "diff_capture_failed");
		strictEqual(result.partialDiff, undefined);
		strictEqual(dispatches[0].result, "execution_timed_out_capture_failed");
		strictEqual(
			order.join("|"),
			"capture|record:execution_timed_out_capture_failed",
		);
	});

	it("makes no guest exec on a timeout cleanup and leaves the clone for destroy", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			prlctlFn: (args) => {
				calls.push(args);
				return "ok";
			},
		});
		const result = backend.cleanupProviderProcess(
			"prlctl",
			["exec", "vm-timeout"],
			{
				workspaceId: "vm-timeout",
				runId: "run-timeout",
				taskId: "task-timeout",
				attemptId: "attempt-timeout",
				descriptorIdentity: "descriptor-timeout",
				processStartIdentity: null,
				operation: "provider",
				reason: "timeout",
			},
		);
		deepStrictEqual(result, {
			cleanupStage: "destroy_pending",
			workspaceId: "vm-timeout",
		});
		strictEqual(calls.length, 0);
	});

	it("removes index.lock without PID authority when the provider exited", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			prlctlFn: (args) => {
				calls.push(args);
				return "ok";
			},
		});
		const result = backend.cleanupProviderProcess(
			"prlctl",
			["exec", "vm-timeout"],
			{
				workspaceId: "vm-timeout",
				runId: "run-timeout",
				taskId: "task-timeout",
				attemptId: "attempt-timeout",
				descriptorIdentity: "descriptor-timeout",
				processStartIdentity: null,
				operation: "provider",
			},
		);
		strictEqual(result.cleanupStage, "index_lock_removed");
		strictEqual(calls.length, 1);
		ok(guestText(calls[0]).includes("index.lock"));
		ok(!calls.some((args) => /\/bin\/cat|kill-tree/.test(guestText(args))));
	});

	it("defers helper cleanup to the VM destroy when a capture probe times out", async () => {
		const guestExecArgv = [];
		const cleanupReasons = [];
		const executionBackend = {
			execArgv: (workspaceId, options) => {
				guestExecArgv.push(options.argv);
				return { command: "prlctl", args: ["exec", workspaceId] };
			},
			cleanupProviderProcess: (_command, _args, options = {}) => {
				cleanupReasons.push(options.reason ?? null);
				return {
					cleanupStage: "destroy_pending",
					workspaceId: options.workspaceId,
				};
			},
		};
		const child = new EventEmitter();
		child.pid = 4242;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => true;
		const result = await captureProviderDiffDetailedAsync("vm-timeout-worker", {
			executionBackend,
			spawnFn: () => child,
			timeoutMs: 40,
			termGraceMs: 20,
			cleanupContext: {
				runId: "run-timeout",
				taskId: "task-timeout",
				attemptId: "attempt-timeout",
				descriptorIdentity: "descriptor-timeout",
				operation: "helper",
			},
		});
		strictEqual(result.status, "timed_out");
		strictEqual(result.diff, null);
		deepStrictEqual(cleanupReasons, ["timeout"]);
		strictEqual(guestExecArgv.length, 1);
	});

	it("retires the VM clone after a provider timeout without a cleanup-failure halt", async () => {
		const root = join(
			tmpdir(),
			`switchyard-vm-timeout-${process.pid}-${randomUUID()}`,
		);
		const tasksFilePath = join(root, "tasks.md");
		const checkpointPath = join(root, "checkpoint.json");
		const guestExecArgv = [];
		const cleanupReasons = [];
		const destroyCalls = [];
		const adapterContainers = [];
		const captureCalls = [];
		const dispatches = [];
		const executionBackend = {
			execArgv: (workspaceId, options) => {
				guestExecArgv.push(options.argv);
				return { command: "prlctl", args: ["exec", workspaceId] };
			},
			cleanupProviderProcess: (_command, _args, options = {}) => {
				cleanupReasons.push(options.reason ?? null);
				return {
					cleanupStage: "destroy_pending",
					workspaceId: options.workspaceId,
				};
			},
		};
		const descriptor = {
			target_id: "claude-code",
			model_ref: "fixture/claude-standard",
			selector: "fixture/claude-standard",
			invocation_args: [],
		};
		mkdirSync(root, { recursive: true });
		writeFileSync(
			tasksFilePath,
			"### Task 4.4: VM timeout\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Quick checks:** none\n- **Description:** fixture\n\n### Task 4.5: Never reached\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/b.mjs\n- **Quick checks:** none\n- **Description:** fixture\n",
			"utf8",
		);
		try {
			const result = await runQueueAsync({
				tasksFilePath,
				projectPath: root,
				checkpointPath,
				stopOnFailure: false,
				dependencies: {
					hostPowerProbe: () => ({ state: "ac" }),
					queuePreflight: () => ({ ok: true, eligible: true }),
					recordDispatch: (entry) => dispatches.push(entry),
					recordDispatchIntent: () => {},
					route: () => ({
						provider: "claude",
						resolved_harness: "claude",
						resolvedTargetId: "claude-code",
						model: descriptor.selector,
						invocationDescriptor: descriptor,
					}),
					resolveDescriptor: () => descriptor,
					resolveTargetIdentity: () => ({
						targetId: "claude-code",
						harnessKey: "claude",
						ambiguous: false,
					}),
					adapters: {
						claude: {
							executeAsync: async (_prompt, container, options) => {
								adapterContainers.push(container);
								await options.executionBackend.cleanupProviderProcess(
									"prlctl",
									["exec", container],
									{ reason: "timeout" },
								);
								return {
									success: false,
									timedOut: true,
									error: "provider execution timed out (ETIMEDOUT)",
									diagnosticCode: "execution_timed_out",
									failurePhase: "provider_execution",
								};
							},
							captureDiffAsync: async () => {
								captureCalls.push("capture");
								return null;
							},
						},
					},
					backendFactory: () => ({
						executionBackend,
						readiness: () => ({ inventoryCount: 0 }),
						create: () => "vm-timeout-worker",
						provision: () => {},
						seed: () => {},
						commit: () => {},
						reset: () => {},
						destroy: () => destroyCalls.push("destroy"),
						captureTaskBaseAsync: async () => ({
							ref: "refs/switchyard/task-base/router-timeout/4.4",
							tree: "4".repeat(40),
						}),
						validateTaskBaseAsync: async (_workspaceId, base) => base,
						releaseTaskBaseAsync: async () => {},
					}),
				},
			});
			strictEqual(result.results.length, 2);
			strictEqual(result.results[0].result, "execution_timed_out");
			strictEqual(result.results[0].timeoutDiff, "unavailable_destroy_only");
			strictEqual(result.results[0].partialDiff, undefined);
			strictEqual(result.results[0].cleanupFailed, false);
			strictEqual(
				result.results.at(-1).result,
				"halted_after_provider_timeout",
			);
			strictEqual(
				result.results.at(-1).errorKind,
				"provider_timeout_clone_retired",
			);
			ok(
				!result.results.some(
					(entry) => entry.result === "halted_after_provider_cleanup_failure",
				),
			);
			strictEqual(adapterContainers.length, 1);
			strictEqual(captureCalls.length, 0);
			strictEqual(guestExecArgv.length, 0);
			deepStrictEqual(cleanupReasons, ["timeout"]);
			strictEqual(destroyCalls.length, 1);
			strictEqual(dispatches[0].timeoutDiff, "unavailable_destroy_only");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("Task 6.1 queue-level platform selection", () => {
	it("normalizes macos by default and rejects an invalid platform", () => {
		strictEqual(normalizeRunOptions({}).platform, "macos");
		throws(() => normalizeRunOptions({ platform: "windows" }), /platform/);
	});

	it("selects one macOS backend before workspace creation for every queue entrypoint", async () => {
		const root = join(
			tmpdir(),
			`switchyard-platform-${process.pid}-${randomUUID()}`,
		);
		const tasksFilePath = join(root, "tasks.md");
		const calls = [];
		const backendFactory = ({ platform }) => {
			strictEqual(platform, "macos");
			return {
				platform,
				readiness: () => ({ inventoryCount: 0 }),
				create: () => {
					calls.push("create-vm");
					return "vm-handle";
				},
				provision: () => calls.push("provision-vm"),
				seed: () => calls.push("seed-vm"),
				commit: () => calls.push("commit-vm"),
				reset: () => calls.push("reset-vm"),
				destroy: () => calls.push("destroy-vm"),
			};
		};
		mkdirSync(root, { recursive: true });
		writeFileSync(
			tasksFilePath,
			"### Task 1.1: Already complete\n- **Status:** done\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Quick checks:** none\n- **Description:** fixture\n",
			"utf8",
		);
		const base = {
			tasksFilePath,
			projectPath: process.cwd(),
			checkpointPath: join(root, "checkpoint.json"),
			platform: "macos",
			dependencies: {
				backendFactory,
			},
		};
		try {
			await runQueueAsync(base);
			runQueue(base);
			strictEqual(calls.filter((call) => call === "create-vm").length, 2);
			strictEqual(calls.filter((call) => call === "destroy-vm").length, 2);
			ok(!calls.some((call) => call.includes("docker")));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the injected queue helper synchronous and exposes later queue gates", () => {
		const events = [];
		const helper = createQueueBackend({
			platform: "macos",
			dependencies: {
				backendFactory: () => ({
					readiness: () => ({ inventoryCount: 0 }),
					create: () => "vm",
					seed: () => {},
					commit: () => {},
					reset: () => {},
					destroy: () => {},
					preflight: () => events.push("preflight"),
					acquireSlot: () => events.push("acquire"),
					releaseSlot: () => events.push("release"),
				}),
			},
		});
		strictEqual(helper.platform, "macos");
		strictEqual(typeof helper.preflight, "function");
		strictEqual(typeof helper.acquireSlot, "function");
		strictEqual(typeof helper.releaseSlot, "function");
		deepStrictEqual(events, []);
	});

	it("wires the default macOS preflight into the queue backend", () => {
		// What this proves is the hand-through: the queue backend reaches the
		// default preflight with the default gates, none of them injected by the
		// caller. The allowlist gate itself is covered below by the test that
		// injects `goldenImageVerifiedProviders: ["codex"]` against a real
		// target. This one used a real name ("claude") as its stand-in for
		// "unverified" and broke on 2026-09-18 the moment claude-code was
		// actually verified, so the name is now synthetic and the test encodes
		// nothing about which real logins happen to exist.
		strictEqual(resolveTargetIdentity(UNVERIFIED_PROVIDER).targetId, null);
		const helper = createQueueBackend({
			platform: "macos",
			dependencies: {
				preflightReadSnapshot: () => ({
					snapshot: {
						schema_version: 2,
						updated_at: new Date().toISOString(),
						providers: [
							{
								name: UNVERIFIED_PROVIDER,
								ok: true,
								windows: [{ percent_left: 80, pace_delta: 1 }],
							},
						],
					},
					snapshotStatus: "fresh",
					snapshotMtime: 1,
					snapshotAgeMsAtRoute: 0,
				}),
			},
		});

		throws(
			() =>
				helper.preflight({
					tasks: [{ status: "pending", requiredCapability: "high" }],
				}),
			// The reason is asserted, not just the name: without it this passes
			// for whichever default gate happens to fire first, which is not the
			// same claim. A name no roster resolves is rejected at the identity
			// gate, and only the default preflight can reject it there.
			new RegExp(
				`high: no_golden_image_verified_provider_with_quota_headroom.*${UNVERIFIED_PROVIDER}: target_identity_unavailable`,
			),
		);
	});

	it("admits clone-verified tier-1 targets through the default macOS preflight", () => {
		for (const targetId of [
			"codex",
			"antigravity",
			"copilot-student",
			"antigravity-claude",
		]) {
			ok(
				GOLDEN_IMAGE_VERIFIED_PROVIDERS.includes(targetId),
				`${targetId} should be recorded as clone verified`,
			);
		}
		const cases = [
			["antigravity", "low"],
			["copilot-student", "low"],
		];
		for (const [targetId, requiredCapability] of cases) {
			const result = preflightMacosQueue({
				tasks: [{ status: "pending", requiredCapability }],
				only: [targetId],
				readSnapshot: () => ({
					snapshot: {
						schema_version: 2,
						updated_at: new Date().toISOString(),
						providers: [
							{
								name: targetId,
								ok: true,
								windows: [{ percent_left: 80, pace_delta: 1 }],
							},
						],
					},
					snapshotStatus: "fresh",
					snapshotMtime: 1,
					snapshotAgeMsAtRoute: 0,
				}),
			});
			strictEqual(result.eligible, true, `${targetId} should be admitted`);
		}
	});
});
