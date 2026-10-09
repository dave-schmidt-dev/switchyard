// Live timeout and VM destroy test for the Parallels backend.
//
// Gated on Parallels, golden image, Aqua identity, and the shared VM slot.
// Launches a provider-shaped sleep with a short timeout in a real clone,
// asserts no provider_cleanup_uncertain, verifies the queue ends,
// ensures the clone is absent from prlctl list -a within 120 s,
// and logs the destroy latency.

import { ok, strictEqual } from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";

import { getWorkspaceExecution } from "../src/switchyard/adapter/provider-lifecycle.mjs";
import { executeProviderInvocation } from "../src/switchyard/adapter/provider-lifecycle-invocation.mjs";
import { captureHostFingerprint } from "../src/switchyard/dispatch/launch-support.mjs";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import { validateInvocationDescriptor } from "../src/switchyard/roster/index.mjs";
import { initializeRun } from "../src/switchyard/run-store/index.mjs";
import { runQueueAsync } from "../src/switchyard/runner/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const GOLDEN_IMAGE = process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE || "";
const AQUA_UID = process.env.SWITCHYARD_PARALLELS_AQUA_UID || "";
const SKIP_LIVE_VM_TESTS = process.env.SWITCHYARD_SKIP_LIVE_VM_TESTS === "1";

// The test reporter drops cause, so include the chain in a diagnostic.
function describeCauseChain(error) {
	const levels = [];
	let current = error;
	for (let level = 0; level < 4; level += 1) {
		if (current instanceof Error) {
			const name =
				typeof current.name === "string" && current.name
					? current.name
					: "Error";
			const code = typeof current.code === "string" ? ` ${current.code}` : "";
			const message =
				typeof current.message === "string"
					? current.message.split(/\r?\n/u, 1)[0].slice(0, 300)
					: "";
			levels.push(`${name}${code}: ${message}`);
		} else {
			levels.push(String(current).slice(0, 300));
		}
		if (current === null || current === undefined) break;
		current = current.cause;
		if (current === undefined) break;
	}
	return levels.join(" <- ");
}

function commandAvailable(command) {
	try {
		execFileSync("/usr/bin/which", [command], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
}

function listGoldenImage() {
	const output = execFileSync(
		"prlctl",
		["list", "-a", "-o", "uuid,status,name"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 },
	);
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const fields = line.includes("\t")
				? line.split("\t").map((field) => field.trim())
				: line.split(/\s+/);
			return fields.length >= 3
				? {
						uuid: fields[0],
						status: fields[1],
						name: fields.slice(2).join(" "),
					}
				: null;
		})
		.find((entry) => entry?.name === GOLDEN_IMAGE);
}

async function loadSlotPrimitive() {
	let module;
	try {
		module = await import("../src/switchyard/run-store/index.mjs");
	} catch {
		return null;
	}
	const acquire = module.acquireVmSlot ?? module.acquireMacosVmSlot;
	const release = module.releaseVmSlot ?? module.releaseMacosVmSlot;
	const wait = module.acquireVmSlotForTest;
	return typeof acquire === "function" &&
		typeof release === "function" &&
		typeof wait === "function"
		? { acquire, release, wait }
		: null;
}

let configurationFault = null;

async function inspectPrerequisites() {
	if (!commandAvailable("prlctl")) return "Parallels prlctl is unavailable";
	try {
		execFileSync("prlctl", ["--version"], { stdio: "ignore", timeout: 5_000 });
	} catch {
		return "Parallels Desktop is unavailable to prlctl";
	}
	if (!GOLDEN_IMAGE) {
		configurationFault =
			"SWITCHYARD_PARALLELS_GOLDEN_IMAGE must be set to run the VM gate";
		return null;
	}
	let golden;
	try {
		golden = listGoldenImage();
	} catch {
		return "Parallels VM inventory is unavailable";
	}
	if (!golden) return `golden image ${GOLDEN_IMAGE} is unavailable`;
	if (!/^stopped$/i.test(golden.status)) {
		return `golden image ${GOLDEN_IMAGE} is not stopped`;
	}
	if (!AQUA_UID) {
		configurationFault =
			"SWITCHYARD_PARALLELS_AQUA_UID must be set to run the VM gate";
		return null;
	}
	if (!/^\d+$/.test(AQUA_UID) || Number(AQUA_UID) <= 0) {
		configurationFault = `SWITCHYARD_PARALLELS_AQUA_UID must be a positive integer uid, got ${JSON.stringify(AQUA_UID.slice(0, 32))}`;
		return null;
	}
	if (!(await loadSlotPrimitive())) {
		return "shared VM-slot primitive is unavailable";
	}
	return null;
}

const prerequisiteReason = SKIP_LIVE_VM_TESTS
	? "fixture-only: SWITCHYARD_SKIP_LIVE_VM_TESTS=1"
	: await inspectPrerequisites();

describe("VM timeout and clone destroy (live)", () => {
	it("retires and destroys the real clone on provider timeout", {
		timeout: 300_000,
		skip: prerequisiteReason ? `VM gate skipped: ${prerequisiteReason}` : false,
	}, async (testContext) => {
		if (configurationFault) throw new Error(configurationFault);
		const slotPrimitive = await loadSlotPrimitive();
		if (!slotPrimitive) {
			testContext.skip(
				"VM gate skipped: shared VM-slot primitive is unavailable",
			);
			return;
		}

		const runId = `vm-timeout-${process.pid}-${randomUUID()}`;
		const backend = new ParallelsExecutionBackend({
			aquaUid: AQUA_UID,
			goldenImage: GOLDEN_IMAGE,
		});

		const admission = await slotPrimitive.wait({
			runId,
			onStatus: (event) =>
				console.error(`[vm-timeout-destroy-live] ${event.status}`),
			readinessFn: () => {
				backend.probeHostReadiness({
					onStatus: (event) =>
						console.error(`[vm-timeout-destroy-live] ${event.status}`),
				});
				return (
					backend.listManaged().length === 0 || {
						ready: false,
						reason: "a Switchyard working VM is active",
					}
				);
			},
		});

		if (admission.status !== "executed") {
			testContext.skip(`VM gate unavailable-with-proof: ${admission.reason}`);
			return;
		}

		let slotLease = admission.lease;
		const owned = backend.listManaged();
		if (owned.length > 0) {
			testContext.skip(
				`VM gate unavailable-with-proof: a Switchyard working VM is active (${owned.map((entry) => entry.name).join(", ")})`,
			);
			return;
		}
		backend.assertGoldenImageAvailable(GOLDEN_IMAGE);

		const projectDir = tempDir("switchyard-vm-timeout-live-project-");
		const storeDir = tempDir("switchyard-vm-timeout-live-store-");
		const previousRunStoreRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = storeDir;

		let cloneHandle = null;
		let destroyLatencyMs = null;

		const originalDestroy = backend.destroy.bind(backend);
		backend.destroy = (handle) => {
			const start = performance.now();
			const res = originalDestroy(handle);
			destroyLatencyMs = performance.now() - start;
			console.log(
				`[vm-timeout-destroy-live] destroy latency: ${destroyLatencyMs.toFixed(2)} ms`,
			);
			return res;
		};

		try {
			execSync("git init", { cwd: projectDir, stdio: "ignore" });
			execSync("git config user.email test@test.com", {
				cwd: projectDir,
				stdio: "ignore",
			});
			execSync("git config user.name test", {
				cwd: projectDir,
				stdio: "ignore",
			});
			execSync("git commit --allow-empty -m initial", {
				cwd: projectDir,
				stdio: "ignore",
			});

			const tasksFilePath = join(projectDir, "tasks.md");
			writeFileSync(
				tasksFilePath,
				"### Task 1.1: Live timeout\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** none\n- **Quick checks:** none\n- **Description:** test\n",
				"utf8",
			);
			const checkpointPath = join(projectDir, "checkpoint.json");
			// Production dispatch (run-dispatch.mjs, launch.mjs) always creates the
			// run record before the queue starts. Provider cleanup persists its
			// mutation intent there, so a queue run without one fails cleanup with
			// "Run not found" before the backend is ever asked to clean up.
			await initializeRun({
				runId,
				tasksFilePath,
				projectPath: projectDir,
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: captureHostFingerprint(projectDir),
			});

			const descriptor = validateInvocationDescriptor(
				{
					target_id: "claude-code",
					model_ref: "fixture/claude-standard",
					selector: "fixture/claude-standard",
					effort: null,
					variant: null,
					invocation_args: [],
				},
				"claude",
			);

			let queueResult;
			try {
				queueResult = await runQueueAsync({
					tasksFilePath,
					projectPath: projectDir,
					checkpointPath,
					stopOnFailure: false,
					platform: "macos",
					runId,
					dependencies: {
						executionBackend: backend,
						acquireSlot: () => slotLease,
						releaseSlot: () => {
							if (typeof slotLease?.release === "function") slotLease.release();
							else slotPrimitive.release(slotLease);
							slotLease = null;
						},
						queuePreflight: () => ({ ok: true, eligible: true }),
						hostPowerProbe: () => ({ state: "ac" }),
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
									cloneHandle = container;
									const { command, args } = getWorkspaceExecution(container, {
										...options,
										argv: ["/bin/sleep", "30"],
										recordPid: true,
									});
									return await executeProviderInvocation(command, args, {
										...options,
										provider: "claude",
										timeoutMs: 1500,
									});
								},
								captureDiffAsync: async () => null,
							},
						},
						onContainerReady: ({ workingContainerName }) => {
							cloneHandle = workingContainerName;
						},
					},
				});
			} catch (error) {
				testContext.diagnostic(`cause chain: ${describeCauseChain(error)}`);
				throw error;
			}

			ok(queueResult, "the queue must end");
			strictEqual(
				queueResult.results.at(-1).result,
				"halted_after_provider_timeout",
				`the queue must end halted: ${JSON.stringify(
					queueResult.results.map((entry) => ({
						result: entry.result,
						errorKind: entry.errorKind,
						diagnosticCode: entry.diagnosticCode,
						cleanupStage: entry.cleanupStage,
						cleanupFailed: entry.cleanupFailed,
						timeoutDiff: entry.timeoutDiff,
					})),
				)}`,
			);
			ok(
				!queueResult.results.some(
					(entry) =>
						entry.diagnosticCode === "provider_cleanup_uncertain" ||
						entry.errorKind === "provider_cleanup_uncertain" ||
						entry.result === "halted_after_provider_cleanup_failure",
				),
				"assert no provider_cleanup_uncertain",
			);
			strictEqual(queueResult.results[0].result, "execution_timed_out");
			strictEqual(
				queueResult.results[0].timeoutDiff,
				"unavailable_destroy_only",
			);
			strictEqual(queueResult.results[0].cleanupFailed, false);
			strictEqual(
				queueResult.results.at(-1).result,
				"halted_after_provider_timeout",
			);
			strictEqual(
				queueResult.results.at(-1).errorKind,
				"provider_timeout_clone_retired",
			);

			ok(cloneHandle, "clone handle must have been captured");

			const checkDeadline = Date.now() + 120_000;
			let absent = false;
			while (Date.now() < checkDeadline) {
				const output = execFileSync(
					"prlctl",
					["list", "-a", "-o", "uuid,name"],
					{
						encoding: "utf8",
						stdio: ["ignore", "pipe", "pipe"],
						timeout: 5_000,
					},
				);
				if (!output.includes(cloneHandle)) {
					absent = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 1_000));
			}
			ok(
				absent,
				`clone ${cloneHandle} must be absent from prlctl list -a within 120 s`,
			);

			ok(
				typeof destroyLatencyMs === "number" && destroyLatencyMs >= 0,
				"destroy latency must be recorded",
			);
			console.log(
				`[vm-timeout-destroy-live] confirmed destroy latency: ${destroyLatencyMs.toFixed(2)} ms`,
			);
		} finally {
			if (backend && cloneHandle) {
				try {
					backend.destroy(cloneHandle);
				} catch {
					// Ignore if already destroyed
				}
			}
			if (slotLease !== undefined && slotLease !== null) {
				if (typeof slotLease.release === "function") await slotLease.release();
				else await slotPrimitive.release(slotLease);
			}
			if (previousRunStoreRoot === undefined) {
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			} else {
				process.env.SWITCHYARD_RUN_STORE_ROOT = previousRunStoreRoot;
			}
			rmSync(projectDir, { recursive: true, force: true });
			rmSync(storeDir, { recursive: true, force: true });
		}
	});
});
