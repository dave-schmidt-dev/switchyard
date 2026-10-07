import {
	deepStrictEqual,
	notStrictEqual,
	ok,
	strictEqual,
	throws,
} from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { integrationGate } from "../src/switchyard/integrate/index.mjs";
import { captureDirtyOverlay } from "../src/switchyard/lifecycle/index.mjs";
import {
	createBrokerAdapterLauncher,
	createQueueIdentity,
	executeTaskAsync,
	normalizeRunOptions,
	parseTaskQueue,
} from "../src/switchyard/runner/index.mjs";
import {
	descriptorForRoute,
	runnerTestDir,
	TASK_BASE,
} from "./helpers/async-runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
const FIXTURE_ROUTE = { provider: "claude", model: "fixture-model" };
// executeTaskAsync is a bare execute path: it has no queue bootstrap, so the
// immutable task base, provider execution, and diff capture all have to come
// from stub async seams.
function asyncBroker(route, adapters) {
	return {
		selectAndReserve: async (request) => {
			const routed = route(request) ?? FIXTURE_ROUTE;
			return {
				provider: routed.provider,
				model: routed.model,
				resolvedTarget: routed.resolvedTargetId ?? routed.provider,
				harness: routed.resolved_harness ?? routed.provider,
				capability: request.capability,
				effort: null,
				reason: routed.reason ?? "fixture",
				reservation: { id: "fixture-reservation" },
				snapshotIdentity: { status: "fresh", mtime: null, ageMs: 0 },
			};
		},
		launcherIdentity: () => ({}),
		execute: async () =>
			adapters.claude.executeAsync("fixture", "overlay-worker", {}),
		release: async () => {},
	};
}
function asyncTaskContext(overrides = {}) {
	const route = overrides.route ?? (() => FIXTURE_ROUTE);
	const taskBases = overrides.taskBases ?? {};
	const adapters = overrides.adapters ?? {
		claude: {
			executeAsync: async () => ({ success: true, output: "ok" }),
			captureDiffAsync: async () => "",
		},
	};
	return {
		projectPath: TEST_DIR,
		workingContainerName: "overlay-worker",
		taskBases,
		persistTaskBase: (taskId, base) => {
			taskBases[taskId] = base;
		},
		resolveDescriptor: () => descriptorForRoute(route()),
		recordDispatch: () => {},
		recordDispatchIntent: () => {},
		integrationGate: () => ({ success: true }),
		queueBackend: {
			beforeRun: () => {},
			afterRun: () => {},
			captureTaskBaseAsync: async () => TASK_BASE,
			validateTaskBaseAsync: async (_workspaceId, base) => base,
			releaseTaskBaseAsync: async () => {},
		},
		broker: asyncBroker(route, adapters),
		adapters,
		...overrides,
	};
}
describe("attempt-scoped execution backend", () => {
	it("returns one dirty-overlay receipt identity across repeated async executions", async () => {
		const project = join(TEST_DIR, "dirty-overlay-paths");
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(
			join(project, "src", "changed.mjs"),
			"export const value = 1;\n",
		);
		runFixtureGit(project, ["init", "-q"]);
		runFixtureGit(project, ["config", "user.email", "test@example.invalid"]);
		runFixtureGit(project, ["config", "user.name", "Test"]);
		runFixtureGit(project, ["add", "src/changed.mjs"]);
		runFixtureGit(project, ["commit", "-qm", "base"]);
		writeFileSync(
			join(project, "src", "changed.mjs"),
			"export const value = 2;\n",
		);
		const receipt = captureDirtyOverlay(project, ["src/changed.mjs"]);
		const task = (id) => ({
			id,
			title: "overlay",
			description: "overlay",
			executor: "switchyard",
			requiredPaths: ["src/changed.mjs"],
			files: ["src/changed.mjs"],
		});
		const base = asyncTaskContext({
			projectPath: project,
			workingContainerName: "overlay-worker",
			dirtyOverlayReceipt: receipt,
			adapters: {
				claude: {
					executeAsync: async () => ({ success: true, output: "ok" }),
					captureDiffAsync: async () =>
						"diff --git a/src/changed.mjs b/src/changed.mjs\n",
				},
			},
		});
		const results = [
			await executeTaskAsync(task("1.1"), base),
			await executeTaskAsync(task("1.2"), base),
		];
		deepStrictEqual(
			results.map((result) => result.dirtyOverlayReceiptHash),
			[receipt.receiptHash, receipt.receiptHash],
		);
		let routeCalls = 0;
		let providerCalls = 0;
		const rejected = await executeTaskAsync(
			task("1.4"),
			asyncTaskContext({
				projectPath: project,
				workingContainerName: "overlay-worker",
				route: () => {
					routeCalls += 1;
					return FIXTURE_ROUTE;
				},
				dirtyOverlayReceipt: { ...receipt, receiptHash: "f".repeat(64) },
				adapters: {
					claude: {
						executeAsync: async () => {
							providerCalls += 1;
							return { success: true, output: "ok" };
						},
					},
				},
			}),
		);
		strictEqual(rejected.result, "dirty_overlay_rejected");
		strictEqual(routeCalls, 0);
		strictEqual(providerCalls, 0);

		// A task that declares nothing satisfies `every()` vacuously. Without an
		// explicit non-empty check it would reach provider allocation inside a
		// workspace seeded with overlay bytes it never scoped — the review path,
		// where `Files:` is otherwise optional, is exactly where that happens.
		const undeclared = await executeTaskAsync(
			{ ...task("1.5"), type: "review", requiredPaths: null, files: [] },
			asyncTaskContext({
				projectPath: project,
				workingContainerName: "overlay-worker",
				route: () => {
					routeCalls += 1;
					return FIXTURE_ROUTE;
				},
				dirtyOverlayReceipt: receipt,
				adapters: {
					claude: {
						executeAsync: async () => {
							providerCalls += 1;
							return { success: true, output: "ok" };
						},
					},
				},
			}),
		);
		strictEqual(undeclared.result, "dirty_overlay_rejected");
		strictEqual(undeclared.reasonCode, "dirty_overlay_scope_mismatch");
		strictEqual(undeclared.dirtyOverlayReceiptHash, receipt.receiptHash);
		strictEqual(routeCalls, 0);
		strictEqual(providerCalls, 0);
	});
	it("integrates one overlay task and then refuses the drift that integration created", async () => {
		const project = join(TEST_DIR, "dirty-overlay-one-integration");
		mkdirSync(join(project, "src"), { recursive: true });
		const target = join(project, "src", "changed.mjs");
		writeFileSync(target, "export const value = 1;\n");
		runFixtureGit(project, ["init", "-q"]);
		runFixtureGit(project, ["config", "user.email", "test@example.invalid"]);
		runFixtureGit(project, ["config", "user.name", "Test"]);
		runFixtureGit(project, ["add", "src/changed.mjs"]);
		runFixtureGit(project, ["commit", "-qm", "base"]);
		const overlay = "export const value = 2;\n";
		const applied = "export const value = 3;\n";
		writeFileSync(target, overlay);
		const receipt = captureDirtyOverlay(project, ["src/changed.mjs"]);
		// A patch whose preimage is the overlay bytes: stage the overlay, write
		// the result, diff, then restore exactly what the receipt captured.
		runFixtureGit(project, ["add", "src/changed.mjs"]);
		writeFileSync(target, applied);
		const diff = `${runFixtureGit(project, ["diff", "--no-color"])}\n`;
		runFixtureGit(project, ["reset", "-q"]);
		writeFileSync(target, overlay);

		let providerCalls = 0;
		const base = asyncTaskContext({
			projectPath: project,
			workingContainerName: "overlay-worker",
			dirtyOverlayReceipt: receipt,
			integrationGate,
			adapters: {
				claude: {
					executeAsync: async () => {
						providerCalls += 1;
						return { success: true, output: "ok" };
					},
					captureDiffAsync: async () => diff,
				},
			},
		});
		const overlayTask = (id) => ({
			id,
			title: "overlay",
			description: "overlay",
			executor: "switchyard",
			requiredPaths: ["src/changed.mjs"],
			files: ["src/changed.mjs"],
		});
		const bytes = receipt.paths[0].bytes;

		const first = await executeTaskAsync(overlayTask("1.1"), base);
		strictEqual(first.result, "success");
		strictEqual(readFileSync(target, "utf8"), applied);
		strictEqual(providerCalls, 1);
		strictEqual(first.dirtyOverlayReceiptHash, receipt.receiptHash);
		// Raw overlay bytes never reach a result projection.
		strictEqual(JSON.stringify(first).includes(bytes), false);

		const second = await executeTaskAsync(overlayTask("1.2"), base);
		strictEqual(second.result, "dirty_overlay_rejected");
		strictEqual(second.reasonCode, "dirty_overlay_file_drift");
		strictEqual(providerCalls, 1);
		strictEqual(JSON.stringify(second).includes(bytes), false);
	});
	it("keeps overlay identity out of normalized run options until it is opted into", () => {
		const off = normalizeRunOptions({
			checkpointPath: "/tmp/q.checkpoint.json",
		});
		deepStrictEqual(Object.keys(off), [
			"version",
			"platform",
			"maxTasks",
			"checkpointPath",
			"stopOnFailure",
			"onlyProviders",
			"excludeProviders",
			"taskIds",
		]);
		deepStrictEqual(
			normalizeRunOptions({
				checkpointPath: "/tmp/q.checkpoint.json",
				dirtyOverlay: false,
			}),
			off,
		);
		// The opt-in alone decides the shape. A stray receipt path or hash that
		// dispatch preparation ignores because the opt-in is unset must not shift
		// a non-overlay queue's identity.
		deepStrictEqual(
			normalizeRunOptions({
				checkpointPath: "/tmp/q.checkpoint.json",
				dirtyOverlayReceiptPath: "/tmp/stray.dirty-overlay.json",
				dirtyOverlayReceiptHash: "b".repeat(64),
			}),
			off,
		);

		const hash = "a".repeat(64);
		const on = normalizeRunOptions({
			checkpointPath: "/tmp/q.checkpoint.json",
			dirtyOverlay: true,
			dirtyOverlayReceiptPath: "/tmp/q.checkpoint.json.dirty-overlay.json",
			dirtyOverlayReceiptHash: hash,
		});
		strictEqual(on.dirtyOverlay, true);
		strictEqual(on.dirtyOverlayReceiptHash, hash);
		strictEqual(
			normalizeRunOptions({
				checkpointPath: "/tmp/q.checkpoint.json",
				dirtyOverlay: true,
				dirtyOverlayReceiptHash: "not-a-hash",
			}).dirtyOverlayReceiptHash,
			null,
		);

		const markdown =
			"### Task 1.1: Overlay\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** d\n";
		const tasksFilePath = join(TEST_DIR, "overlay-identity-tasks.md");
		mkdirSync(TEST_DIR, { recursive: true });
		writeFileSync(tasksFilePath, markdown);
		const tasks = parseTaskQueue(markdown);
		const identityFor = (runOptions) =>
			createQueueIdentity({
				tasksFilePath,
				markdown,
				tasks,
				projectRevision: "deadbeef",
				runOptions,
			});
		strictEqual(identityFor(off), identityFor({ ...off }));
		notStrictEqual(identityFor(off), identityFor(on));
	});
	it("binds immutable sync context, preserves receivers, and rejects contradiction", async () => {
		const seen = [];
		const backend = {
			label: "receiver",
			execArgv(_workspaceId, options) {
				strictEqual(this, backend);
				seen.push(options.cleanupContext);
				return { command: "true", args: [] };
			},
		};
		const descriptor = descriptorForRoute({
			provider: "claude",
			model: "claude-sonnet-5",
		});
		const selectedRoute = {
			provider: "claude",
			model: descriptor.selector,
			resolvedTarget: "claude",
			harness: "claude",
			capability: "standard",
			effort: null,
			reason: "fixture",
			reservation: { id: "fixture-reservation" },
			snapshotIdentity: { status: "fresh", mtime: null, ageMs: 0 },
		};
		let adapterOptions;
		const adapter = {
			executeAsync: async (_prompt, _workspace, options) => {
				adapterOptions = options;
				options.executionBackend.execArgv("vm", {});
				options.executionBackend.execArgv("vm", {
					cleanupContext: {
						...options.cleanupContext,
						operation: "helper",
					},
				});
				throws(
					() =>
						options.executionBackend.execArgv("vm", {
							cleanupContext: {
								...options.cleanupContext,
								attemptId: "other",
							},
						}),
					/contradictory cleanup context attemptId/,
				);
				return { success: false, output: "" };
			},
			captureDiffAsync: async (_workspace, options) => {
				options.executionBackend.execArgv("vm", {});
				return "";
			},
		};
		// The production broker executor binds the provider attempt through
		// createBrokerAdapterLauncher; the stub broker invokes that same real
		// launcher so the provider-side binding is exercised end to end.
		const launch = createBrokerAdapterLauncher({
			adapter,
			executionBackend: backend,
			workingContainerName: "vm",
			prompt: "fixture",
			cleanupContext: {
				runId: "run-a",
				taskId: "1.4",
				attemptId: "attempt-a",
				descriptorIdentity: descriptor.descriptor_identity,
				workspaceId: "vm",
				processStartIdentity: null,
				operation: "provider",
			},
		});
		const launcherIdentity = {
			provider: selectedRoute.provider,
			resolvedTarget: selectedRoute.resolvedTarget,
			harness: selectedRoute.harness,
			model: selectedRoute.model,
			effort: selectedRoute.effort,
			descriptorIdentity: descriptor.descriptor_identity,
			reservationId: selectedRoute.reservation.id,
		};
		await executeTaskAsync(
			{ id: "1.4", title: "marker", description: "marker" },
			asyncTaskContext({
				runId: "run-a",
				attemptId: "attempt-a",
				processStartIdentity: null,
				executionBackend: backend,
				workingContainerName: "vm",
				resolveDescriptor: () => descriptor,
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: { claude: adapter },
				broker: {
					selectAndReserve: async () => selectedRoute,
					launcherIdentity: () => launcherIdentity,
					execute: async (request, route, options) =>
						launch({
							request,
							route,
							invocationDescriptor: descriptor,
							launcherIdentity: options.launcherIdentity,
							signal: options.signal,
							onAdapterStatus: options.onAdapterStatus,
							onPoll: options.onPoll,
							onProgress: options.onProgress,
						}),
					release: async () => {},
				},
			}),
		);
		ok(Object.isFrozen(adapterOptions.cleanupContext));
		strictEqual(seen[0].operation, "provider");
		strictEqual(seen[1].operation, "helper");
		strictEqual(seen[2].operation, "helper");
		strictEqual(seen[0].attemptId, "attempt-a");
		const beforeWrongWorkspace = seen.length;
		throws(
			() => adapterOptions.executionBackend.execArgv("other-vm", {}),
			/contradictory cleanup context workspaceId/,
		);
		strictEqual(seen.length, beforeWrongWorkspace);
	});
	it("binds helper context to a successful synchronous capture", async () => {
		let observed;
		let captureFacade;
		let backendCalls = 0;
		const backend = {
			execArgv(_workspaceId, options) {
				backendCalls += 1;
				observed = options.cleanupContext;
				return { command: "true", args: [] };
			},
		};
		const result = await executeTaskAsync(
			{ id: "1.4-success", title: "marker", description: "marker" },
			asyncTaskContext({
				runId: "run-sync-success",
				attemptId: "attempt-sync-success",
				executionBackend: backend,
				workingContainerName: "vm",
				adapters: {
					claude: {
						executeAsync: async () => ({ success: true, output: "ok" }),
						captureDiffAsync: async (_workspace, options) => {
							captureFacade = options.executionBackend;
							options.executionBackend.execArgv("vm", {});
							return "";
						},
					},
				},
			}),
		);
		strictEqual(result.success, true);
		strictEqual(observed.operation, "helper");
		strictEqual(observed.attemptId, "attempt-sync-success");
		const beforePromotion = backendCalls;
		throws(
			() =>
				captureFacade.execArgv("vm", {
					cleanupContext: { operation: "provider" },
				}),
			/helper cleanup context cannot become provider context/,
		);
		strictEqual(backendCalls, beforePromotion);
	});
});
function runFixtureGit(projectPath, args) {
	const result = spawnSync("git", args, {
		cwd: projectPath,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
