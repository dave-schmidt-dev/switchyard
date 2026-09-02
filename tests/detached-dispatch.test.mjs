// Detached dispatch integration tests: launch/status/result round-trips,
// worker-bootstrap nonce handshake, project locks, and failure recording.
// These spawn real Node subprocesses.

import { ok, rejects, strictEqual } from "node:assert";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { projectDisposition } from "../src/switchyard/dispatch/disposition.mjs";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import { getInvocationDescriptorIdentity } from "../src/switchyard/roster/index.mjs";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const DISPATCH_PATH = resolve(
	__dirname,
	"..",
	"src",
	"switchyard",
	"dispatch",
	"index.mjs",
);
const BOOTSTRAP_PATH = resolve(
	__dirname,
	"..",
	"src",
	"switchyard",
	"dispatch",
	"worker-bootstrap.mjs",
);
// Task 1.5 (roster-unification plan): src/switchyard/roster/index.mjs now
// lazily loads the roster, resolving SWITCHYARD_ROSTER_PATH or the canonical
// ~/.agent/roster.json default (Task 4.1) and failing loud only if that
// resolved file can't load. This file's real dispatch subprocesses (and the
// detached workers they spawn) go through the real, unmocked router/roster
// on the way to routing a task, so every spawned process needs a valid
// roster — point at this committed synthetic fixture (not the real
// ~/.agent/roster.json).
const ROSTER_FIXTURE_PATH = resolve(
	__dirname,
	"fixtures",
	"roster.fixture.json",
);

function runDispatch(args, env = {}) {
	return spawnSync(process.execPath, [DISPATCH_PATH, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
		env: { ...process.env, ...env },
	});
}

// Workspace creation on the sole surviving (macOS/Parallels) platform clones
// and boots a real VM from a golden image — unlike the removed Docker lane,
// there is no lightweight hermetic fallback. The two "routes end-to-end via
// launch" tests below need routing to actually happen (not just a run
// reaching *some* terminal state), so they can't pass in an environment
// without a configured golden image; gate them the same way the -vm suite
// files do rather than let them hard-fail when Parallels prerequisites are
// missing. Runtime under real hardware (clone + boot + route) is unverified
// here — this dev machine has no golden image configured — so the poll
// budget below is a conservative guess a Parallels-equipped run should
// double check.
const PARALLELS_GOLDEN_IMAGE =
	process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE || "";
const PARALLELS_AQUA_UID = process.env.SWITCHYARD_PARALLELS_AQUA_UID || "";
const PARALLELS_PROVIDER_USER =
	process.env.SWITCHYARD_PARALLELS_PROVIDER_USER || "switchyard";

function commandAvailable(command) {
	try {
		execFileSync("/usr/bin/which", [command], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

let parallelsConfigurationFault = null;

function assertParallelsConfigured() {
	if (parallelsConfigurationFault) {
		throw new Error(parallelsConfigurationFault);
	}
}

function parallelsGoldenImagePrerequisiteReason() {
	if (!commandAvailable("prlctl")) return "Parallels prlctl is unavailable";
	// Parallels is installed but the operator has not said which VM to clone.
	// That is a configuration fault, not an absent dependency, so it FAILS the gate
	// instead of skipping it. The previous `|| "macOS"` fallback pointed at the
	// unhardened Task 1.1 base VM, which is present and stopped on this host: with
	// the variable unset the gate would have cloned and asserted against a VM that
	// was never hardened. Production already refuses to guess (README.md: "no
	// default -- guessing at which VM to clone is not a safe default").
	if (!PARALLELS_GOLDEN_IMAGE) {
		parallelsConfigurationFault =
			"SWITCHYARD_PARALLELS_GOLDEN_IMAGE must be set to run the VM gate";
		return null;
	}
	let output;
	try {
		output = execFileSync("prlctl", ["list", "-a", "-o", "uuid,status,name"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return "Parallels VM inventory is unavailable";
	}
	const golden = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.split(/\s+/))
		.find(
			(fields) =>
				fields.length >= 3 &&
				fields.slice(2).join(" ") === PARALLELS_GOLDEN_IMAGE,
		);
	if (!golden) return `golden image ${PARALLELS_GOLDEN_IMAGE} is unavailable`;
	if (!/^stopped$/i.test(golden[1])) {
		return `golden image ${PARALLELS_GOLDEN_IMAGE} is not stopped`;
	}
	// An unset or malformed Aqua uid is a configuration fault, not an absent
	// dependency, so it FAILS the gate instead of skipping it. Returning a skip
	// reason here made the gate report green having proven nothing: it passes
	// locally only because ~/.zshrc exports the variable, so any non-interactive
	// shell, CI runner, or launchd context silently lost the INV-1 assertions.
	if (!PARALLELS_AQUA_UID) {
		parallelsConfigurationFault =
			"SWITCHYARD_PARALLELS_AQUA_UID must be set to run the VM gate";
		return null;
	}
	if (!/^\d+$/.test(PARALLELS_AQUA_UID) || Number(PARALLELS_AQUA_UID) <= 0) {
		parallelsConfigurationFault = `SWITCHYARD_PARALLELS_AQUA_UID must be a positive integer uid, got ${JSON.stringify(PARALLELS_AQUA_UID.slice(0, 32))}`;
		return null;
	}
	try {
		if (new ParallelsExecutionBackend().listManaged().length > 0) {
			return "a Switchyard working VM is active";
		}
	} catch {
		return "Parallels VM inventory is unavailable";
	}
	return null;
}

const PARALLELS_PREREQUISITE_REASON = parallelsGoldenImagePrerequisiteReason();

function parallelsBackendEnv() {
	// Only export what is actually set. Handing the worker an empty
	// SWITCHYARD_PARALLELS_GOLDEN_IMAGE would recreate the fallback this file
	// just removed, one process down, where it reads as configured-but-blank.
	return Object.fromEntries(
		[
			["SWITCHYARD_PARALLELS_GOLDEN_IMAGE", PARALLELS_GOLDEN_IMAGE],
			["SWITCHYARD_PARALLELS_AQUA_UID", PARALLELS_AQUA_UID],
			["SWITCHYARD_PARALLELS_PROVIDER_USER", PARALLELS_PROVIDER_USER],
		].filter(([, value]) => value !== ""),
	);
}

function runBootstrap(args, env = {}) {
	return spawnSync(process.execPath, [BOOTSTRAP_PATH, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
		env: { ...process.env, ...env },
	});
}

function writeDispatchQualifiedRoster(path, targetId) {
	const roster = JSON.parse(readFileSync(ROSTER_FIXTURE_PATH, "utf8"));
	const target = roster.targets[targetId];
	const slot = target.slots.standard[0];
	const model = roster.models[slot.model_ref];
	const core = {
		target_id: targetId,
		model_ref: slot.model_ref,
		selector: model.selector,
		effort: slot.effort ?? null,
		variant: slot.variant ?? null,
		invocation_args: slot.invocation_args ?? [],
	};
	const identity = getInvocationDescriptorIdentity(core, target.harness);
	const now = new Date().toISOString();
	target.qualifications[identity] = {
		...core,
		descriptor_identity: identity,
		status: "dispatch_qualified",
		tested_at: now,
		credential_profile: target.credential_profile,
		promotion_receipt: {
			...core,
			descriptor_identity: identity,
			status: "promoted",
			atomic: true,
			receipt_id: `detached-test-${targetId}`,
			committed_at: now,
		},
	};
	writeFileSync(path, JSON.stringify(roster), "utf8");
}

let dir;
let tasksFile;
let projectDir;
let stateRoot;
let detachedCleanupPending;
let detachedCleanupRunId;

function makeStateRootEnv() {
	return { SWITCHYARD_RUN_STORE_ROOT: stateRoot };
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "switchyard-detached-dispatch-"));
	detachedCleanupPending = false;
	detachedCleanupRunId = null;
	stateRoot = join(dir, "state-root");
	tasksFile = join(dir, "tasks.md");
	writeFileSync(
		tasksFile,
		"### Task 1.1: Test task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** A test\n",
		"utf8",
	);
	projectDir = join(dir, "project");
	mkdirSync(join(projectDir, ".git"), { recursive: true });

	process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;
	process.env.SWITCHYARD_ROSTER_PATH = ROSTER_FIXTURE_PATH;
	// Real dispatch subprocesses go through the real, unmocked ledger writer —
	// redirect it so this suite never writes to the real dispatch-ledger.jsonl.
	process.env.SWITCHYARD_LEDGER_PATH = join(dir, "dispatch-ledger.jsonl");
});

afterEach(() => {
	delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	delete process.env.SWITCHYARD_ROSTER_PATH;
	delete process.env.SWITCHYARD_LEDGER_PATH;
	if (detachedCleanupPending) {
		console.error(
			`detached cleanup was not confirmed for run ${detachedCleanupRunId ?? "unknown"}; preserving fixture ${dir}`,
		);
		return;
	}
	rmSync(dir, { recursive: true, force: true });
});

async function launchAndGetRunId() {
	const result = runDispatch(
		["launch", tasksFile, "--project", projectDir],
		makeStateRootEnv(),
	);
	strictEqual(result.status, 0, `launch failed: ${result.stderr}`);
	const envelope = JSON.parse(result.stdout.trim());
	ok(typeof envelope.runId === "string" && envelope.runId.length > 0);
	return envelope.runId;
}

function pollStatus(runId, env) {
	return runDispatch(["status", runId], env);
}

function compactDiagnostic(value) {
	return String(value ?? "")
		.trim()
		.replace(/\s+/g, " ")
		.slice(0, 256);
}

function boundedFailureField(value) {
	return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,96}$/u.test(value)
		? value
		: value == null
			? null
			: "<redacted>";
}

function boundedFailureDiagnostic(entry) {
	return {
		failurePhase: boundedFailureField(entry?.failurePhase),
		errorKind: boundedFailureField(entry?.errorKind),
		diagnosticCode: boundedFailureField(entry?.diagnosticCode),
	};
}

function providerFilterDiagnostic(run, events) {
	return {
		run: {
			state: boundedFailureField(run?.state),
			cleanupState: boundedFailureField(run?.cleanupState),
			lastFailure: boundedFailureDiagnostic(run?.lastFailure),
		},
		recentEvents: (events ?? []).slice(-5).map((event) => ({
			phase: boundedFailureField(event?.phase),
			event: boundedFailureField(event?.event),
			taskId: boundedFailureField(event?.taskId),
			...boundedFailureDiagnostic(event),
		})),
	};
}

function cleanupDiagnostic(run) {
	if (!run) return null;
	return {
		state: run.state ?? null,
		cleanupState: run.cleanupState ?? null,
		workerPid: run.workerPid ?? null,
		activeTaskId: run.activeTaskId ?? null,
		activeTaskProvider: run.activeTaskProvider ?? null,
		activeTaskProcessPhase: run.activeTaskProcessPhase ?? null,
		updatedAt: run.updatedAt ?? null,
	};
}

async function awaitRunTerminalCleanup(
	runId,
	env,
	{
		maxWait = 300_000,
		pollInterval = 200,
		progressInterval = 5_000,
		pollStatusFn = pollStatus,
		onProgress = () => process.stderr.write("detached cleanup: polling\n"),
		sleep = (delayMs) =>
			new Promise((resolveWait) => setTimeout(resolveWait, delayMs)),
	} = {},
) {
	const start = Date.now();
	let nextProgressAt = 0;
	let lastStatus = null;
	let lastStatusResult = null;
	let pollCount = 0;
	const emitProgress = (status) => {
		const now = Date.now();
		if (now < nextProgressAt) return;
		nextProgressAt = now + Math.max(0, progressInterval);
		try {
			onProgress({
				pollCount,
				elapsedMs: now - start,
				status: cleanupDiagnostic(status),
			});
		} catch {
			// Progress is advisory and must never mask the cleanup result.
		}
	};
	while (true) {
		pollCount += 1;
		try {
			const statusResult = pollStatusFn(runId, env);
			lastStatusResult = statusResult;
			if (statusResult.status === 0) {
				let status = null;
				try {
					status = JSON.parse(statusResult.stdout.trim());
					lastStatus = status;
					if (
						(status?.state === "succeeded" || status?.state === "failed") &&
						status?.cleanupState === "complete"
					) {
						return status;
					}
				} catch {
					// A partial/corrupt observation is retained in the timeout
					// diagnostic; it can never count as completed cleanup.
				}
				emitProgress(status);
				if (
					status?.state === "recovery_required" ||
					status?.cleanupState === "failed"
				) {
					const cleanupFailure = new Error(
						`run ${runId} entered unrecoverable cleanup state: ${JSON.stringify(cleanupDiagnostic(status))}`,
					);
					cleanupFailure.code = "cleanup_recovery_required";
					throw cleanupFailure;
				}
			}
			if (statusResult.status !== 0) emitProgress(null);
		} catch (error) {
			if (error?.code === "cleanup_recovery_required") throw error;
			lastStatusResult = { status: "threw", stderr: error.message };
			emitProgress(null);
		}

		const elapsed = Date.now() - start;
		if (elapsed >= maxWait) break;
		await sleep(Math.min(pollInterval, maxWait - elapsed));
	}
	let diagnosticEvents = [];
	let diagnosticRun = null;
	try {
		const { readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		diagnosticEvents = await readEvents(runId);
		diagnosticRun = await readRun(runId);
	} catch {}
	throw new Error(
		`run ${runId} did not reach terminal state with completed cleanup within ${maxWait}ms after ${pollCount} polls; last status: ${JSON.stringify(cleanupDiagnostic(lastStatus))}; run record: ${JSON.stringify(cleanupDiagnostic(diagnosticRun))}; status exit: ${lastStatusResult?.status ?? "unknown"}; status stderr: ${compactDiagnostic(lastStatusResult?.stderr) || "<empty>"}; recent events: ${JSON.stringify(diagnosticEvents.slice(-5).map(({ phase, event, taskId }) => ({ phase, event, taskId: taskId ?? null })))}`,
	);
}

function attachCleanupFailure(bodyError, cleanupError) {
	if (!bodyError || typeof bodyError !== "object") return;
	const property = bodyError.cause === undefined ? "cause" : "cleanupFailure";
	try {
		Object.defineProperty(bodyError, property, {
			value: cleanupError,
			configurable: true,
		});
	} catch {
		// Preserve the original body error even when it is not extensible.
	}
}

async function finishDetachedRun(runId, env, bodyError, cleanupOptions = {}) {
	let cleanupError = null;
	if (runId) {
		try {
			await awaitRunTerminalCleanup(runId, env, cleanupOptions);
			detachedCleanupPending = false;
		} catch (error) {
			cleanupError = error;
		}
	}

	if (bodyError) {
		if (cleanupError) attachCleanupFailure(bodyError, cleanupError);
		throw bodyError;
	}
	if (cleanupError) throw cleanupError;
}

describe("detached fixture terminal cleanup guard", () => {
	it("waits through a terminal-but-pending state and fails with bounded diagnostics if cleanup never completes", async () => {
		const statuses = [
			{ state: "running", cleanupState: "not_started", workerPid: 123 },
			{ state: "failed", cleanupState: "pending", workerPid: 123 },
			{ state: "failed", cleanupState: "complete", workerPid: null },
		];
		let pollCount = 0;
		const progress = [];
		const terminal = await awaitRunTerminalCleanup(
			"fixture-run",
			{},
			{
				maxWait: 100,
				pollInterval: 0,
				pollStatusFn: () => ({
					status: 0,
					stdout: JSON.stringify(statuses[pollCount++]),
					stderr: "",
				}),
				progressInterval: 0,
				onProgress: (event) => progress.push(event),
				sleep: async () => {},
			},
		);

		strictEqual(pollCount, 3);
		strictEqual(terminal.cleanupState, "complete");
		strictEqual(progress.length, 2);
		strictEqual(progress[0].status.state, "running");
		strictEqual(progress[1].status.cleanupState, "pending");

		let recoveryPolls = 0;
		await rejects(
			awaitRunTerminalCleanup(
				"recovery-run",
				{},
				{
					maxWait: 300_000,
					pollStatusFn: () => {
						recoveryPolls += 1;
						return {
							status: 0,
							stdout: JSON.stringify({
								state: "recovery_required",
								cleanupState: "failed",
								workerPid: 123,
							}),
							stderr: "",
						};
					},
					sleep: async () => {
						throw new Error("must not sleep after recovery failure");
					},
				},
			),
			/entered unrecoverable cleanup state.*recovery_required/,
		);
		strictEqual(recoveryPolls, 1);

		await rejects(
			awaitRunTerminalCleanup(
				"diagnostic-run",
				{},
				{
					maxWait: 0,
					pollStatusFn: () => ({
						status: 0,
						stdout: JSON.stringify({
							state: "failed",
							cleanupState: "pending",
							workerPid: 456,
						}),
						stderr: "",
					}),
				},
			),
			/diagnostic-run.*"state":"failed","cleanupState":"pending"/,
		);
	});

	it("rethrows the original routing failure when cleanup also fails and keeps fixture preservation armed", async () => {
		const routingError = new Error("synthetic selector assertion failure");
		detachedCleanupPending = true;
		detachedCleanupRunId = "masked-error-run";
		let observedError = null;
		try {
			await finishDetachedRun("masked-error-run", {}, routingError, {
				maxWait: 0,
				pollStatusFn: () => ({
					status: 0,
					stdout: JSON.stringify({
						state: "failed",
						cleanupState: "pending",
					}),
					stderr: "",
				}),
			});
		} catch (error) {
			observedError = error;
		}

		strictEqual(observedError, routingError);
		ok(
			observedError.cause?.message.includes(
				"did not reach terminal state with completed cleanup",
			),
			"cleanup failure diagnostic must be attached to the original error",
		);
		strictEqual(detachedCleanupPending, true);
		// This regression deliberately simulates failure without a real detached
		// worker, so disarm preservation before the shared afterEach runs.
		detachedCleanupPending = false;
	});
});

describe("launch returns before completion", () => {
	it("launch exits 0 immediately, status returns a tracked run", async () => {
		const startTime = Date.now();
		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		const elapsed = Date.now() - startTime;

		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		ok(elapsed < 5000, `launch took ${elapsed}ms, expected < 5000ms`);

		const envelope = JSON.parse(result.stdout.trim());
		strictEqual(envelope.state, "launcher_ready");
		const runId = envelope.runId;

		const statusResult = pollStatus(runId, makeStateRootEnv());
		strictEqual(
			statusResult.status,
			0,
			`status failed: ${statusResult.stderr}`,
		);
		const status = JSON.parse(statusResult.stdout.trim());
		strictEqual(status.runId, runId);
	});

	it("detached launch persists the v2 identity and selected task options", async () => {
		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir, "--task-id", "1.1"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0, `launch failed: ${result.stderr}`);
		const { runId } = JSON.parse(result.stdout.trim());
		const { readRun } = await import("../src/switchyard/run-store/index.mjs");
		const run = await readRun(runId);
		strictEqual(run.schemaVersion, 2);
		strictEqual(run.dispatchContractVersion, 1);
		strictEqual(run.activeTaskInvocationDescriptor, null);
		ok(/^[a-f0-9]{64}$/.test(run.queueIdentity));
		strictEqual(run.runOptions.taskIds[0], "1.1");
	});

	it("quarantines malformed records during the awaited worker startup sweep without touching a sibling launch", async () => {
		const { initializeRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const malformedRunId = `malformed-${randomUUID()}`;
		const siblingRunId = randomUUID();

		await initializeRun({
			runId: siblingRunId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		mkdirSync(join(stateRoot, "runs", malformedRunId), { recursive: true });
		writeFileSync(
			join(stateRoot, "runs", malformedRunId, "run.json"),
			"{ malformed run record",
			"utf8",
		);

		const launchResult = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(
			launchResult.status,
			0,
			`launch failed: ${launchResult.stderr}`,
		);

		// The quarantine move happens inside applyRetention, which bootstrap
		// awaits before claiming its lease. Seeing the moved directory confirms
		// that startup sweep completed before we inspect the sibling record.
		const quarantineRoot = join(stateRoot, ".quarantine");
		let sweepCompleted = false;
		const start = Date.now();
		while (Date.now() - start < 10_000) {
			try {
				const quarantined = readdirSync(quarantineRoot);
				if (quarantined.some((entry) => entry.startsWith(malformedRunId))) {
					sweepCompleted = true;
					break;
				}
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		}
		ok(
			sweepCompleted,
			"worker startup retention sweep did not quarantine malformed record",
		);

		const sibling = await readRun(siblingRunId);
		strictEqual(sibling.state, "created");
		strictEqual(sibling.workerPid, null);
	});
});

describe("worker reaches terminal state and result is readable", () => {
	it("worker runs against a real run and eventually reaches a terminal state", async () => {
		const runId = await launchAndGetRunId();

		let terminalReached = false;
		const start = Date.now();
		const maxWait = 15_000;

		while (Date.now() - start < maxWait) {
			const statusResult = pollStatus(runId, makeStateRootEnv());
			if (statusResult.status !== 0) {
				await new Promise((r) => setTimeout(r, 500));
				continue;
			}
			const status = JSON.parse(statusResult.stdout.trim());

			if (status.state === "succeeded" || status.state === "failed") {
				terminalReached = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 500));
		}

		ok(terminalReached, "run did not reach terminal state within timeout");

		const resultResult = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(resultResult.status, 1, "result exits 1 for failed run");

		const result = JSON.parse(resultResult.stdout.trim());
		ok(result.terminalSummary !== null, "terminalSummary present");
		ok(Array.isArray(result.artifactRefs), "artifactRefs is an array");
		strictEqual(result.dispatchContractVersion, 1);
		if (result.lastTaskDescriptorIdentity !== null) {
			ok(
				/^sha256:[a-f0-9]{64}$/.test(result.lastTaskDescriptorIdentity),
				"terminal result preserves the routed descriptor identity",
			);
			strictEqual(
				result.lastTaskInvocationDescriptor.descriptor_identity,
				result.lastTaskDescriptorIdentity,
			);
		}
	});
});

describe("detached descriptor receipt parity", () => {
	it("preserves a descriptor identity from run-store event/overlay into status and result", async () => {
		const { initializeRun, updateRun, createEvent } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const descriptorCore = {
			target_id: "claude-code",
			model_ref: "fixture/claude-standard",
			selector: "fixture-claude-standard",
			effort: null,
			variant: null,
			invocation_args: [],
		};
		const descriptor = {
			...descriptorCore,
			descriptor_identity: getInvocationDescriptorIdentity(
				descriptorCore,
				"claude",
			),
		};
		const runId = `receipt-${randomUUID()}`;
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "fixture",
		});
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				lastTaskInvocationDescriptor: descriptor,
				lastTaskDescriptorIdentity: descriptor.descriptor_identity,
				lastTaskDescriptorHarness: "claude",
				lastResolvedTargetId: descriptor.target_id,
			},
			1,
		);
		await createEvent(runId, {
			phase: "execution",
			event: "task_completed",
			status: "Task 1.1 completed",
			taskId: "1.1",
			invocationDescriptor: descriptor,
			descriptorIdentity: descriptor.descriptor_identity,
			descriptorHarness: "claude",
			resolvedTargetId: descriptor.target_id,
		});

		const status = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(status.status, 0);
		const statusEnvelope = JSON.parse(status.stdout.trim());
		strictEqual(
			statusEnvelope.lastTaskDescriptorIdentity,
			descriptor.descriptor_identity,
		);
		const result = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(result.status, 0);
		const resultEnvelope = JSON.parse(result.stdout.trim());
		strictEqual(
			resultEnvelope.lastTaskDescriptorIdentity,
			descriptor.descriptor_identity,
		);
		strictEqual(
			resultEnvelope.lastTaskInvocationDescriptor.descriptor_identity,
			descriptor.descriptor_identity,
		);
	});

	it("rejects unsafe argv, mismatched identities, and invalid event versions", async () => {
		const { initializeRun, updateRun, createEvent } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const descriptorCore = {
			target_id: "claude-code",
			model_ref: "fixture/claude-standard",
			selector: "fixture-claude-standard",
			effort: null,
			variant: null,
			invocation_args: [],
		};
		const descriptor = {
			...descriptorCore,
			descriptor_identity: getInvocationDescriptorIdentity(
				descriptorCore,
				"claude",
			),
		};
		const runId = `receipt-invalid-${randomUUID()}`;
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "fixture",
		});

		await rejects(
			updateRun(
				runId,
				{
					lastTaskInvocationDescriptor: descriptor,
					lastTaskDescriptorIdentity: `sha256:${"0".repeat(64)}`,
					lastTaskDescriptorHarness: "claude",
					lastResolvedTargetId: descriptor.target_id,
				},
				1,
			),
			/does not match/,
		);
		await rejects(
			updateRun(
				runId,
				{
					lastTaskInvocationDescriptor: {
						...descriptor,
						invocation_args: ["--prompt", "secret-token"],
					},
					lastTaskDescriptorHarness: "claude",
					lastResolvedTargetId: descriptor.target_id,
				},
				1,
			),
			/invalid descriptor receipt/,
		);
		await rejects(
			createEvent(runId, {
				phase: "execution",
				event: "task_completed",
				status: "complete",
				invocationDescriptor: descriptor,
				descriptorIdentity: `sha256:${"0".repeat(64)}`,
				descriptorHarness: "claude",
				resolvedTargetId: descriptor.target_id,
				dispatchContractVersion: 1,
			}),
			/event descriptorIdentity does not match invocationDescriptor/,
		);
		await rejects(
			createEvent(runId, {
				phase: "execution",
				event: "task_completed",
				status: "complete",
				dispatchContractVersion: 0,
			}),
			/event dispatchContractVersion must be a positive integer/,
		);
	});
});

describe("--exclude-provider on the detached worker path", () => {
	it("excludes the given provider from routing end-to-end via `launch` (not just the foreground path)", {
		skip: PARALLELS_PREREQUISITE_REASON
			? `VM gate skipped: ${PARALLELS_PREREQUISITE_REASON}`
			: false,
	}, async () => {
		assertParallelsConfigured();
		// The shared `projectDir` fixture (beforeEach) is just an empty `.git`
		// directory — enough for the other tests in this file, which only care
		// that the run reaches *some* terminal state, but seedProject's `git
		// archive HEAD` needs a real commit or the worker crashes before ever
		// reaching routing. Use a dedicated, properly-initialized repo here
		// (same recipe as dispatch-cli.test.mjs's "run subcommand via spawn").
		const excludeProjectDir = join(dir, "exclude-provider-project");
		mkdirSync(excludeProjectDir, { recursive: true });
		execSync("git init", { cwd: excludeProjectDir, stdio: "ignore" });
		execSync("git config user.email test@test.com", {
			cwd: excludeProjectDir,
			stdio: "ignore",
		});
		execSync("git config user.name test", {
			cwd: excludeProjectDir,
			stdio: "ignore",
		});
		execSync("git commit --allow-empty -m initial", {
			cwd: excludeProjectDir,
			stdio: "ignore",
		});

		// Deterministic routing: point SWITCHYARD_SNAPSHOT_PATH_OVERRIDE at a
		// fixture snapshot with two known-healthy providers instead of relying
		// on whatever the real production snapshot happens to contain (see
		// resolveSnapshotPath() in router/index.mjs — the same override
		// router.test.mjs and runner.test.mjs use for isolation). Without
		// --exclude-provider, claude (90% left) outranks codex (50% left) and
		// wins routing under router/index.mjs's spread-by-headroom rule; with
		// `--exclude-provider claude`, codex must be routed instead.
		const snapshotPath = join(dir, "snapshot.json");
		writeFileSync(
			snapshotPath,
			JSON.stringify({
				schema_version: 2,
				updated_at: new Date().toISOString(),
				providers: [
					{
						name: "claude",
						ok: true,
						windows: [{ percent_left: 90, pace_delta: 0 }],
					},
					{
						name: "codex",
						ok: true,
						windows: [{ percent_left: 50, pace_delta: 0 }],
					},
				],
			}),
			"utf8",
		);

		const env = {
			...makeStateRootEnv(),
			...parallelsBackendEnv(),
			SWITCHYARD_SNAPSHOT_PATH_OVERRIDE: snapshotPath,
		};
		const runtimeRosterPath = join(dir, "codex-dispatch-roster.json");
		writeDispatchQualifiedRoster(runtimeRosterPath, "codex");
		env.SWITCHYARD_ROSTER_PATH = runtimeRosterPath;

		let runId;
		let bodyError = null;
		try {
			const launchResult = runDispatch(
				[
					"launch",
					tasksFile,
					"--project",
					excludeProjectDir,
					"--exclude-provider",
					"claude",
					"--platform",
					"macos",
				],
				env,
			);
			strictEqual(
				launchResult.status,
				0,
				`launch failed: ${launchResult.stderr}`,
			);
			const envelope = JSON.parse(launchResult.stdout.trim());
			runId = envelope.runId;
			ok(
				typeof runId === "string" && runId.length > 0,
				"launch must return a run id before detached cleanup can be guarded",
			);
			detachedCleanupPending = true;
			detachedCleanupRunId = runId;

			// onTaskRouted fires (and is persisted to activeTaskProvider) before the
			// blocking adapter.execute call, so poll frequently: this only needs to
			// observe routing, not wait for the task to finish executing.
			let observedProvider = null;
			let observedDescriptor = null;
			let observedDescriptorIdentity = null;
			let terminalDiagnostic = null;
			const start = Date.now();
			// A full linked/full clone + boot of the golden image replaces the old
			// Docker cold-start (~24.9s under sustained load) this budget used to be
			// tuned for. Unverified against real hardware — no golden image is
			// configured on this dev machine — so 5 minutes is a conservative guess;
			// tighten it once measured against a real Parallels clone+boot.
			const maxWait = 300_000;
			while (Date.now() - start < maxWait) {
				const statusResult = pollStatus(runId, env);
				if (statusResult.status === 0) {
					const status = JSON.parse(statusResult.stdout.trim());
					if (status.activeTaskProvider) {
						observedProvider = status.activeTaskProvider;
						observedDescriptor = status.activeTaskInvocationDescriptor;
						observedDescriptorIdentity = status.activeTaskDescriptorIdentity;
						break;
					}
					if (status.state === "succeeded" || status.state === "failed") {
						break;
					}
				}
				await new Promise((r) => setTimeout(r, 200));
			}

			// Fallback for the race where the task already reached a terminal state
			// (task_completed/task_failed) before any poll caught
			// activeTaskProvider populated — the routed provider is still on the
			// terminal event worker-bootstrap.mjs's onResult callback records.
			if (!observedProvider) {
				const { readEvents, readRun } = await import(
					"../src/switchyard/run-store/index.mjs"
				);
				const events = await readEvents(runId);
				const run = await readRun(runId);
				const routedEvent = events.find(
					(e) =>
						e.phase === "execution" &&
						(e.event === "task_completed" || e.event === "task_failed"),
				);
				observedProvider = routedEvent?.provider ?? null;
				observedDescriptor = routedEvent?.invocationDescriptor ?? null;
				observedDescriptorIdentity = routedEvent?.descriptorIdentity ?? null;
				terminalDiagnostic = providerFilterDiagnostic(run, events);
			}

			ok(
				observedProvider,
				`expected the task to be routed to some provider; terminal diagnostic: ${JSON.stringify(terminalDiagnostic ?? providerFilterDiagnostic(null, []))}`,
			);
			strictEqual(
				observedProvider,
				"codex",
				"claude is excluded and has more headroom, so codex must be routed instead",
			);
			ok(
				observedProvider !== "claude",
				"the excluded provider must never be routed",
			);
			ok(
				observedDescriptor,
				"detached worker must persist its descriptor receipt",
			);
			strictEqual(
				observedDescriptor.descriptor_identity,
				observedDescriptorIdentity,
				"detached descriptor identity must match its receipt",
			);
		} catch (error) {
			bodyError = error;
		} finally {
			await finishDetachedRun(runId, env, bodyError);
		}
	});
});

describe("--only-provider on the detached worker path", () => {
	it("restricts routing to the given provider end-to-end via `launch` (not just the foreground path) (Task C.9)", {
		skip: PARALLELS_PREREQUISITE_REASON
			? `VM gate skipped: ${PARALLELS_PREREQUISITE_REASON}`
			: false,
	}, async () => {
		assertParallelsConfigured();
		// Mirrors the --exclude-provider test above, but proves the allowlist
		// (not just the denylist) works end-to-end through the real detached
		// worker path: without --only-provider, claude (90% left) outranks
		// codex (50% left) and wins routing under router/index.mjs's
		// spread-by-headroom rule; with `--only-provider codex`, codex must be
		// routed instead even though claude has more headroom.
		const onlyProjectDir = join(dir, "only-provider-project");
		mkdirSync(onlyProjectDir, { recursive: true });
		execSync("git init", { cwd: onlyProjectDir, stdio: "ignore" });
		execSync("git config user.email test@test.com", {
			cwd: onlyProjectDir,
			stdio: "ignore",
		});
		execSync("git config user.name test", {
			cwd: onlyProjectDir,
			stdio: "ignore",
		});
		execSync("git commit --allow-empty -m initial", {
			cwd: onlyProjectDir,
			stdio: "ignore",
		});

		const snapshotPath = join(dir, "snapshot-only.json");
		writeFileSync(
			snapshotPath,
			JSON.stringify({
				schema_version: 2,
				updated_at: new Date().toISOString(),
				providers: [
					{
						name: "claude",
						ok: true,
						windows: [{ percent_left: 90, pace_delta: 0 }],
					},
					{
						name: "codex",
						ok: true,
						windows: [{ percent_left: 50, pace_delta: 0 }],
					},
				],
			}),
			"utf8",
		);

		const env = {
			...makeStateRootEnv(),
			...parallelsBackendEnv(),
			SWITCHYARD_SNAPSHOT_PATH_OVERRIDE: snapshotPath,
		};
		// Automatic routing now requires an exact dispatch-qualified descriptor;
		// qualify the allowlisted Codex slot in this subprocess fixture so the
		// test exercises --only-provider rather than legacy selector evidence.
		const runtimeRosterPath = join(dir, "codex-only-dispatch-roster.json");
		writeDispatchQualifiedRoster(runtimeRosterPath, "codex");
		env.SWITCHYARD_ROSTER_PATH = runtimeRosterPath;

		let runId;
		let bodyError = null;
		try {
			const launchResult = runDispatch(
				[
					"launch",
					tasksFile,
					"--project",
					onlyProjectDir,
					"--only-provider",
					"codex",
					"--platform",
					"macos",
				],
				env,
			);
			strictEqual(
				launchResult.status,
				0,
				`launch failed: ${launchResult.stderr}`,
			);
			const envelope = JSON.parse(launchResult.stdout.trim());
			runId = envelope.runId;
			ok(
				typeof runId === "string" && runId.length > 0,
				"launch must return a run id before detached cleanup can be guarded",
			);
			detachedCleanupPending = true;
			detachedCleanupRunId = runId;

			let observedProvider = null;
			let terminalDiagnostic = null;
			const start = Date.now();
			// See the --exclude-provider test's matching comment: unverified against
			// real hardware, conservative budget for a full clone + boot.
			const maxWait = 300_000;
			while (Date.now() - start < maxWait) {
				const statusResult = pollStatus(runId, env);
				if (statusResult.status === 0) {
					const status = JSON.parse(statusResult.stdout.trim());
					if (status.activeTaskProvider) {
						observedProvider = status.activeTaskProvider;
						break;
					}
					if (status.state === "succeeded" || status.state === "failed") {
						break;
					}
				}
				await new Promise((r) => setTimeout(r, 200));
			}

			if (!observedProvider) {
				const { readEvents, readRun } = await import(
					"../src/switchyard/run-store/index.mjs"
				);
				const events = await readEvents(runId);
				const run = await readRun(runId);
				const routedEvent = events.find(
					(e) =>
						e.phase === "execution" &&
						(e.event === "task_completed" || e.event === "task_failed"),
				);
				observedProvider = routedEvent?.provider ?? null;
				terminalDiagnostic = providerFilterDiagnostic(run, events);
			}

			ok(
				observedProvider,
				`expected the task to be routed to some provider; terminal diagnostic: ${JSON.stringify(terminalDiagnostic ?? providerFilterDiagnostic(null, []))}`,
			);
			strictEqual(
				observedProvider,
				"codex",
				"claude has more headroom but is not in the --only-provider allowlist, so codex must be routed instead",
			);
			ok(
				observedProvider !== "claude",
				"a provider outside the --only-provider allowlist must never be routed",
			);
		} catch (error) {
			bodyError = error;
		} finally {
			await finishDetachedRun(runId, env, bodyError);
		}
	});
});

describe("duplicate project runs fail", () => {
	it("launch is blocked while the project lock is already held", async () => {
		const { acquireProjectLock } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		// Hold the project lock directly to simulate an in-flight run. This is
		// deterministic: it does not race a detached worker's terminal cleanup
		// (which now releases the lock — see the "terminal run" test below).
		await acquireProjectLock(projectDir, randomUUID());

		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(
			result.status,
			1,
			`launch against a locked project should exit 1, got ${result.status}: ${result.stderr}`,
		);
	});
});

describe("terminal run releases the project lock", () => {
	it("after a run reaches terminal state the lock is released and a second launch succeeds", async () => {
		const { isProjectLockHeld } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const runId = await launchAndGetRunId();

		const start = Date.now();
		const maxWait = 20_000;

		let terminalReached = false;
		while (Date.now() - start < maxWait) {
			const statusResult = pollStatus(runId, makeStateRootEnv());
			if (statusResult.status === 0) {
				const status = JSON.parse(statusResult.stdout.trim());
				if (status.state === "succeeded" || status.state === "failed") {
					terminalReached = true;
					break;
				}
			}
			await new Promise((r) => setTimeout(r, 300));
		}
		ok(terminalReached, "run did not reach terminal state within timeout");

		// The worker releases the project lock right after writing terminal
		// state; poll until the lock file is gone.
		let released = false;
		while (Date.now() - start < maxWait) {
			if (!isProjectLockHeld(projectDir)) {
				released = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 200));
		}
		ok(
			released,
			"project lock was not released after the run reached terminal state",
		);

		const second = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(
			second.status,
			0,
			`second launch after lock release should exit 0, got ${second.status}: ${second.stderr}`,
		);
	});
});

describe("project-lock reconciliation without managed VMs", () => {
	it("recover --state-root releases one stale lock once with no VM candidate", async () => {
		const {
			acquireProjectLock,
			advanceState,
			initializeRun,
			isProjectLockHeld,
			readRun,
			updateRun,
		} = await import("../src/switchyard/run-store/index.mjs");
		const { handleRecover } = await import(
			"../src/switchyard/dispatch/index.mjs"
		);
		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		await advanceState(runId, "failed");
		const current = await readRun(runId);
		await updateRun(runId, { cleanupState: "complete" }, current.revision);
		await acquireProjectLock(projectDir, runId);

		const output = [];
		const originalLog = console.log;
		const previousExitCode = process.exitCode;
		console.log = (line) => output.push(line);
		const dependencies = {
			executionBackend: {
				listManaged: () => [],
				reclaim: () => ({ reclaimed: [], errors: [], skippedSnapshots: [] }),
			},
		};
		try {
			await handleRecover(["--state-root", stateRoot], dependencies);
			await handleRecover(["--state-root", stateRoot], dependencies);
		} finally {
			console.log = originalLog;
			process.exitCode = previousExitCode;
		}
		strictEqual(JSON.parse(output[0]).projectLocksReleased, 1);
		strictEqual(JSON.parse(output[1]).projectLocksReleased, 0);
		strictEqual(isProjectLockHeld(projectDir), false);
	});

	it("never enters the queue when ownership reassertion fails", async () => {
		const { runDispatch: runDispatchInProcess } = await import(
			"../src/switchyard/dispatch/index.mjs"
		);
		let queueEntries = 0;
		await rejects(
			runDispatchInProcess(
				{
					tasksFilePath: tasksFile,
					projectPath: projectDir,
					maxTasks: 1,
					checkpointPath: undefined,
					stopOnFailure: true,
					excludeProviders: [],
					onlyProviders: [],
					taskIds: ["1.1"],
					platform: "macos",
				},
				{
					assertGenerationAllowed: () => {},
					releaseOrphanedProjectLocks: async () => [],
					reconcileProjectLockClaims: async () => [],
					assertProjectLockOwnership: async () => false,
					executionBackend: {
						listManaged: () => [],
						reclaim: () => ({
							reclaimed: [],
							errors: [],
							skippedSnapshots: [],
						}),
					},
					runQueue: async () => {
						queueEntries += 1;
						return null;
					},
				},
			),
		);
		strictEqual(queueEntries, 0);
	});
});

describe("recover releases stale project locks", {
	skip: PARALLELS_PREREQUISITE_REASON
		? `VM gate skipped: ${PARALLELS_PREREQUISITE_REASON}`
		: undefined,
}, () => {
	it("recover --run clears a project lock left by a dead/terminal run", async () => {
		assertParallelsConfigured();
		const {
			initializeRun,
			advanceState,
			acquireProjectLock,
			isProjectLockHeld,
			readRun,
			updateRun,
		} = await import("../src/switchyard/run-store/index.mjs");

		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		// Terminal-clean, dead run that still holds its project lock: the stale-lock
		// residue a hard-crashed worker would leave behind.
		await advanceState(runId, "failed");
		const current = await readRun(runId);
		await updateRun(runId, { cleanupState: "complete" }, current.revision);
		await acquireProjectLock(projectDir, runId);
		strictEqual(isProjectLockHeld(projectDir), true);

		const result = runDispatch(["recover", "--run", runId], makeStateRootEnv());
		ok(
			result.status === 0 || result.status === 1,
			`recover exit code should be 0 or 1, got ${result.status}: ${result.stderr}`,
		);
		strictEqual(
			isProjectLockHeld(projectDir),
			false,
			"recover should have released the stale project lock",
		);
	});

	it("recover --run does not release a lock held by a live worker", async () => {
		assertParallelsConfigured();
		const {
			initializeRun,
			advanceState,
			acquireProjectLock,
			isProjectLockHeld,
			readRun,
			updateRun,
		} = await import("../src/switchyard/run-store/index.mjs");

		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		await advanceState(runId, "running");
		// Point the lease at this test process, which is provably alive.
		const current = await readRun(runId);
		await updateRun(runId, { workerPid: process.pid }, current.revision);
		await acquireProjectLock(projectDir, runId);
		strictEqual(isProjectLockHeld(projectDir), true);

		const result = runDispatch(["recover", "--run", runId], makeStateRootEnv());
		ok(
			result.status === 0 || result.status === 1,
			`recover exit code should be 0 or 1, got ${result.status}: ${result.stderr}`,
		);
		strictEqual(
			isProjectLockHeld(projectDir),
			true,
			"recover must not yank a project lock from a live worker",
		);
	});

	it("recover --run clears a lock left by a crashed worker still marked running", async () => {
		assertParallelsConfigured();
		const {
			initializeRun,
			advanceState,
			acquireProjectLock,
			isProjectLockHeld,
			readRun,
			updateRun,
		} = await import("../src/switchyard/run-store/index.mjs");

		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		// Non-terminal state with a dead worker pid: exactly the residue a
		// hard-crashed worker (unhandledRejection -> process.exit before any
		// terminal write) leaves behind. The safety net must reclaim this via
		// the liveness probe, not the terminal-state check.
		await advanceState(runId, "running");
		const current = await readRun(runId);
		await updateRun(runId, { workerPid: 99999 }, current.revision);
		await acquireProjectLock(projectDir, runId);
		strictEqual(isProjectLockHeld(projectDir), true);

		const result = runDispatch(["recover", "--run", runId], makeStateRootEnv());
		ok(
			result.status === 0 || result.status === 1,
			`recover exit code should be 0 or 1, got ${result.status}: ${result.stderr}`,
		);
		strictEqual(
			isProjectLockHeld(projectDir),
			false,
			"recover should have released the lock held by a dead running worker",
		);
	});

	it("recover --run does not release a lock reassigned to a newer active run on the same project", async () => {
		const {
			initializeRun,
			advanceState,
			acquireProjectLock,
			isProjectLockHeld,
			readRun,
			updateRun,
		} = await import("../src/switchyard/run-store/index.mjs");

		const staleRunId = randomUUID();
		await initializeRun({
			runId: staleRunId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		await advanceState(staleRunId, "failed");
		// staleRunId's own project lock was already released by its own worker
		// (the Bug 1 terminal-path fix) — never acquired here, matching that.

		// A newer run has since legitimately acquired the SAME project's lock
		// and is still actively running.
		const activeRunId = randomUUID();
		await initializeRun({
			runId: activeRunId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		await advanceState(activeRunId, "running");
		const current = await readRun(activeRunId);
		await updateRun(activeRunId, { workerPid: process.pid }, current.revision);
		await acquireProjectLock(projectDir, activeRunId);
		strictEqual(isProjectLockHeld(projectDir), true);

		// Someone runs recover against the OLD, already-terminal run id —
		// a blind release-by-path would incorrectly clear activeRunId's lock.
		const result = runDispatch(
			["recover", "--run", staleRunId],
			makeStateRootEnv(),
		);
		ok(
			result.status === 0 || result.status === 1,
			`recover exit code should be 0 or 1, got ${result.status}: ${result.stderr}`,
		);
		strictEqual(
			isProjectLockHeld(projectDir),
			true,
			"recover must not release a lock owned by a different, currently-active run",
		);
	});
});

describe("non-matching nonce", () => {
	it("bootstrap with wrong nonce exits 3 and records worker_boot_failed", async () => {
		const { initializeRun, readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const correctNonce = "correct-nonce-value";

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: correctNonce,
			launchArgs: [],
		});

		const result = runBootstrap(
			[
				"--state-root",
				stateRoot,
				"--run-id",
				runId,
				"--nonce",
				"wrong-nonce-value",
			],
			makeStateRootEnv(),
		);

		strictEqual(
			result.status,
			3,
			`expected exit 3 for nonce mismatch, got ${result.status}: ${result.stderr}`,
		);

		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.phase, "worker");
		strictEqual(bootFailed.event, "worker_boot_failed");
		strictEqual(bootFailed.status, "fatal");
		strictEqual(bootFailed.errorKind, "launch_failed");
		strictEqual(bootFailed.diagnosticCode, "worker_nonce_mismatch");
		strictEqual(bootFailed.failurePhase, "worker_boot");
		strictEqual(bootFailed.reasonCode, "launch_failed");
		strictEqual(
			bootFailed.reason,
			"The headless provider job could not be launched.",
		);
		strictEqual(bootFailed.error, undefined);
		ok(!JSON.stringify(bootFailed).includes("wrong-nonce-value"));
		ok(!JSON.stringify(bootFailed).includes("nonce mismatch"));
		ok(!JSON.stringify(bootFailed).includes(projectDir));

		const run = await readRun(runId);
		ok(run.lastFailure !== null, "lastFailure populated in run.json");
		strictEqual(run.lastFailure.errorKind, "launch_failed");
		strictEqual(run.lastFailure.diagnosticCode, "worker_nonce_mismatch");
		strictEqual(run.lastFailure.failurePhase, "worker_boot");
		strictEqual(run.lastFailure.reasonCode, "launch_failed");
		strictEqual(
			run.lastFailure.reason,
			"The headless provider job could not be launched.",
		);
		ok(!JSON.stringify(run.lastFailure).includes("wrong-nonce-value"));
		ok(!JSON.stringify(run.lastFailure).includes("nonce mismatch"));
		ok(!JSON.stringify(run.lastFailure).includes(projectDir));
	});

	it("bootstrap with a secret-canary-bearing nonce redacts it from the persisted worker_boot_failed event", async () => {
		const { initializeRun, readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const correctNonce = "correct-nonce-value";

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: correctNonce,
			launchArgs: [],
		});

		const result = runBootstrap(
			[
				"--state-root",
				stateRoot,
				"--run-id",
				runId,
				"--nonce",
				"SECRET_CANARY_leaked_nonce_value",
			],
			makeStateRootEnv(),
		);

		strictEqual(
			result.status,
			3,
			`expected exit 3 for nonce mismatch, got ${result.status}: ${result.stderr}`,
		);

		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.phase, "worker");
		strictEqual(bootFailed.event, "worker_boot_failed");
		strictEqual(bootFailed.status, "fatal");
		strictEqual(bootFailed.errorKind, "launch_failed");
		strictEqual(bootFailed.diagnosticCode, "worker_nonce_mismatch");
		strictEqual(bootFailed.failurePhase, "worker_boot");
		strictEqual(bootFailed.error, undefined);
		assertNoSecretCanary(runId);

		const run = await readRun(runId);
		ok(run.lastFailure !== null, "lastFailure populated in run.json");
		strictEqual(run.lastFailure.errorKind, "launch_failed");
		strictEqual(run.lastFailure.diagnosticCode, "worker_nonce_mismatch");
		strictEqual(run.lastFailure.failurePhase, "worker_boot");
	});

	it("bootstrap with unsupported dispatch contract version exits 5 and records worker_contract_unsupported", async () => {
		const { initializeRun, readEvents, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const nonce = "test-nonce-contract";

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: nonce,
			launchArgs: [],
		});

		const current = await readRun(runId);
		await updateRun(runId, { dispatchContractVersion: 2 }, current.revision);

		const result = runBootstrap(
			["--state-root", stateRoot, "--run-id", runId, "--nonce", nonce],
			makeStateRootEnv(),
		);

		strictEqual(
			result.status,
			5,
			`expected exit 5 for contract version mismatch, got ${result.status}: ${result.stderr}`,
		);

		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.phase, "worker");
		strictEqual(bootFailed.event, "worker_boot_failed");
		strictEqual(bootFailed.status, "fatal");
		strictEqual(bootFailed.errorKind, "launch_failed");
		strictEqual(bootFailed.diagnosticCode, "worker_contract_unsupported");
		strictEqual(bootFailed.failurePhase, "worker_boot");
		strictEqual(bootFailed.reasonCode, "launch_failed");
		strictEqual(
			bootFailed.reason,
			"The headless provider job could not be launched.",
		);
		strictEqual(bootFailed.error, undefined);
		ok(
			!JSON.stringify(bootFailed).includes(
				"unsupported dispatch descriptor contract version",
			),
		);
		ok(!JSON.stringify(bootFailed).includes(projectDir));

		const run = await readRun(runId);
		ok(run.lastFailure !== null, "lastFailure populated in run.json");
		strictEqual(run.lastFailure.errorKind, "launch_failed");
		strictEqual(run.lastFailure.diagnosticCode, "worker_contract_unsupported");
		strictEqual(run.lastFailure.failurePhase, "worker_boot");
		strictEqual(run.lastFailure.reasonCode, "launch_failed");
		strictEqual(
			run.lastFailure.reason,
			"The headless provider job could not be launched.",
		);
		ok(
			!JSON.stringify(run.lastFailure).includes(
				"unsupported dispatch descriptor contract version",
			),
		);
		ok(!JSON.stringify(run.lastFailure).includes(projectDir));
	});

	it("bootstrap with host fingerprint mismatch exits 4 and records worker_fingerprint_mismatch", async () => {
		const { initializeRun, readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const fpProjectDir = join(dir, "fp-mismatch-project");
		mkdirSync(fpProjectDir, { recursive: true });
		execSync("git init", { cwd: fpProjectDir, stdio: "ignore" });
		execSync("git config user.email test@test.com", {
			cwd: fpProjectDir,
			stdio: "ignore",
		});
		execSync("git config user.name test", {
			cwd: fpProjectDir,
			stdio: "ignore",
		});
		execSync("git commit --allow-empty -m initial", {
			cwd: fpProjectDir,
			stdio: "ignore",
		});

		const runId = randomUUID();
		const nonce = "test-nonce-fp";

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: fpProjectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint:
				"git:0123456789abcdef0123456789abcdef01234567:clean",
			workerNonce: nonce,
			launchArgs: [],
		});

		const result = runBootstrap(
			["--state-root", stateRoot, "--run-id", runId, "--nonce", nonce],
			makeStateRootEnv(),
		);

		strictEqual(
			result.status,
			4,
			`expected exit 4 for fingerprint mismatch, got ${result.status}: ${result.stderr}`,
		);

		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.phase, "worker");
		strictEqual(bootFailed.event, "worker_boot_failed");
		strictEqual(bootFailed.status, "fatal");
		strictEqual(bootFailed.errorKind, "launch_failed");
		strictEqual(bootFailed.diagnosticCode, "worker_fingerprint_mismatch");
		strictEqual(bootFailed.failurePhase, "worker_boot");
		strictEqual(bootFailed.reasonCode, "launch_failed");
		strictEqual(
			bootFailed.reason,
			"The headless provider job could not be launched.",
		);
		strictEqual(bootFailed.error, undefined);
		ok(!JSON.stringify(bootFailed).includes("host fingerprint mismatch"));
		ok(!JSON.stringify(bootFailed).includes(fpProjectDir));

		const run = await readRun(runId);
		ok(run.lastFailure !== null, "lastFailure populated in run.json");
		strictEqual(run.lastFailure.errorKind, "launch_failed");
		strictEqual(run.lastFailure.diagnosticCode, "worker_fingerprint_mismatch");
		strictEqual(run.lastFailure.failurePhase, "worker_boot");
		strictEqual(run.lastFailure.reasonCode, "launch_failed");
		strictEqual(
			run.lastFailure.reason,
			"The headless provider job could not be launched.",
		);
		ok(!JSON.stringify(run.lastFailure).includes("host fingerprint mismatch"));
		ok(!JSON.stringify(run.lastFailure).includes(fpProjectDir));
	});

	it("bootstrap with uncaught boot exception persists worker_boot_exception via readRun", async () => {
		const { initializeRun, readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const nonce = "test-nonce-exception";

		await initializeRun({
			runId,
			tasksFilePath: join(dir, "non-existent-tasks.md"),
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: nonce,
			launchArgs: [],
		});

		const result = runBootstrap(
			["--state-root", stateRoot, "--run-id", runId, "--nonce", nonce],
			makeStateRootEnv(),
		);

		strictEqual(
			result.status,
			1,
			`expected exit 1 for uncaught exception, got ${result.status}: ${result.stderr}`,
		);

		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.phase, "worker");
		strictEqual(bootFailed.event, "worker_boot_failed");
		strictEqual(bootFailed.status, "fatal");
		strictEqual(bootFailed.errorKind, "launch_failed");
		strictEqual(bootFailed.diagnosticCode, "worker_boot_exception");
		strictEqual(bootFailed.failurePhase, "worker_boot");
		strictEqual(bootFailed.reasonCode, "launch_failed");
		strictEqual(
			bootFailed.reason,
			"The headless provider job could not be launched.",
		);
		strictEqual(bootFailed.error, undefined);
		ok(!JSON.stringify(bootFailed).includes("non-existent-tasks.md"));
		ok(!JSON.stringify(bootFailed).includes(projectDir));

		const run = await readRun(runId);
		strictEqual(run.state, "failed");
		ok(run.lastFailure !== null, "lastFailure populated in run.json");
		strictEqual(run.lastFailure.errorKind, "launch_failed");
		strictEqual(run.lastFailure.diagnosticCode, "worker_boot_exception");
		strictEqual(run.lastFailure.failurePhase, "worker_boot");
		strictEqual(run.lastFailure.reasonCode, "launch_failed");
		strictEqual(
			run.lastFailure.reason,
			"The headless provider job could not be launched.",
		);
		ok(!JSON.stringify(run.lastFailure).includes("non-existent-tasks.md"));
		ok(!JSON.stringify(run.lastFailure).includes(projectDir));
		const disposition = projectDisposition({
			run,
			liveness: "terminal_clean",
			optionalEvidenceValid: false,
		});
		strictEqual(disposition.action, "repair_contract");
		strictEqual(disposition.reasonCode, "worker_boot_exception");
	});

	it("persists closed backend stage codes without durable error details", async () => {
		const { initializeRun, readEvents, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const errorModulePath = resolve(
			__dirname,
			"..",
			"src",
			"switchyard",
			"adapter",
			"exec-error.mjs",
		);

		for (const diagnosticCode of [
			"clone_hardening_failed",
			"workspace_prepare_failed",
		]) {
			const runId = randomUUID();
			const nonce = randomUUID();
			const canary = `SECRET-${diagnosticCode}-${randomUUID()}`;
			await initializeRun({
				runId,
				tasksFilePath: tasksFile,
				projectPath: projectDir,
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "test-fingerprint",
				workerNonce: nonce,
				launchArgs: [],
			});
			await updateRun(runId, { dispatchContractVersion: 99 }, 1);

			const child = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`
					import { WorkerBootStageError } from ${JSON.stringify(errorModulePath)};
					process.nextTick(() => {
						const cause = Object.assign(new Error(${JSON.stringify(`${canary} /host/private/path provider output`)}), {
							path: ${JSON.stringify(`/host/private/${canary}`)},
							providerOutput: ${JSON.stringify(`raw provider output ${canary}`)},
						});
						throw new WorkerBootStageError(${JSON.stringify(diagnosticCode)}, cause);
					});
					const { runWorkerBootstrap } = await import(
						${JSON.stringify(BOOTSTRAP_PATH)}
					);
					await runWorkerBootstrap(process.argv);
					`,
					"--",
					"--state-root",
					stateRoot,
					"--run-id",
					runId,
					"--nonce",
					nonce,
				],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, ...makeStateRootEnv() },
				},
			);
			strictEqual(child.status, 1);
			strictEqual(child.stderr, "");
			ok(!child.stderr.includes(canary));
			ok(!child.stderr.includes("/host/private/path"));
			ok(!child.stderr.includes("raw provider output"));
			ok(!child.stderr.includes("providerOutput"));

			const events = await readEvents(runId);
			const bootFailed = events.find(
				(event) => event.event === "worker_boot_failed",
			);
			ok(bootFailed, `${diagnosticCode}: worker_boot_failed event recorded`);
			strictEqual(bootFailed.diagnosticCode, diagnosticCode);
			strictEqual(bootFailed.errorKind, "launch_failed");
			strictEqual(bootFailed.failurePhase, "worker_boot");

			const run = await readRun(runId);
			strictEqual(run.lastFailure.diagnosticCode, diagnosticCode);
			const durableEvidence = JSON.stringify({ events, run });
			ok(!durableEvidence.includes(canary));
			ok(!durableEvidence.includes("/host/private/path"));
			ok(!durableEvidence.includes("raw provider output"));
			ok(!durableEvidence.includes("providerOutput"));
		}
	});
});

describe("typed pre-provider failures on the detached terminal path", () => {
	it("preserves exported task-selection, queue-preflight, and lock triples", async () => {
		const runnerUrl = `${pathToFileURL(resolve(__dirname, "..", "src", "switchyard", "runner", "index.mjs")).href}?typed-terminalization`;
		const runStoreUrl = pathToFileURL(
			resolve(__dirname, "..", "src", "switchyard", "run-store", "index.mjs"),
		).href;
		const cases = [
			{
				name: "task-selection",
				source: `import { TaskSelectionError } from ${JSON.stringify(runnerUrl)}; throw new TaskSelectionError("9.9", "external-blocked:private-canary");`,
				diagnosticCode: "task_selection_failed",
				errorKind: "task_selection_failed",
				failurePhase: "task_selection",
				action: "repair_contract",
				direction: "repair_input",
			},
			{
				name: "queue-preflight",
				source: `import { QueuePreflightError } from ${JSON.stringify(runnerUrl)}; throw new QueuePreflightError("/private/canary raw provider output");`,
				diagnosticCode: "environment_incomplete",
				errorKind: "environment_incomplete",
				failurePhase: "queue_preflight",
				action: "repair_contract",
				direction: "repair_input",
			},
			{
				name: "project-lock",
				source: `import { LockError } from ${JSON.stringify(runStoreUrl)}; throw new LockError("/private/canary lock detail", { code: "PROJECT_LOCK_OWNERSHIP_FAILED" });`,
				diagnosticCode: "project_lock_ownership_failed",
				errorKind: "project_lock_failed",
				failurePhase: "project_lock",
				action: "stop",
				direction: "retry_launch",
			},
		];

		for (const testCase of cases) {
			const { initializeRun, readEvents, readRun } = await import(
				"../src/switchyard/run-store/index.mjs"
			);
			const runId = randomUUID();
			const nonce = randomUUID();
			const loaderPath = join(dir, `${testCase.name}-loader.mjs`);
			writeFileSync(
				loaderPath,
				`export async function load(url, context, nextLoad) {
					if (url.endsWith("/src/switchyard/runner/index.mjs")) {
						return { format: "module", shortCircuit: true, source: ${JSON.stringify(testCase.source)} };
					}
					return nextLoad(url, context);
				}`,
				"utf8",
			);
			await initializeRun({
				runId,
				tasksFilePath: tasksFile,
				projectPath: projectDir,
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "test-fingerprint",
				workerNonce: nonce,
				launchArgs: [],
			});

			const result = runBootstrap(
				["--state-root", stateRoot, "--run-id", runId, "--nonce", nonce],
				{
					...makeStateRootEnv(),
					NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
				},
			);
			strictEqual(result.status, 1, `${testCase.name}: ${result.stderr}`);
			const event = (await readEvents(runId)).find(
				(entry) => entry.event === "worker_boot_failed",
			);
			ok(event, `${testCase.name}: terminal event missing`);
			const run = await readRun(runId);
			for (const evidence of [event, run.lastFailure]) {
				strictEqual(evidence.diagnosticCode, testCase.diagnosticCode);
				strictEqual(evidence.errorKind, testCase.errorKind);
				strictEqual(evidence.failurePhase, testCase.failurePhase);
				strictEqual(evidence.reasonCode, testCase.errorKind);
				const durable = JSON.stringify(evidence);
				ok(!durable.includes("9.9"));
				ok(!durable.includes("private-canary"));
				ok(!durable.includes("/private/canary"));
				ok(!durable.includes("raw provider output"));
			}
			const disposition = projectDisposition({
				run,
				liveness: "terminal_clean",
				optionalEvidenceValid: false,
			});
			strictEqual(disposition.action, testCase.action);
			strictEqual(disposition.direction, testCase.direction);
			strictEqual(disposition.reasonCode, testCase.diagnosticCode);
		}
	});
});

describe("checkpoint identity failures on detached worker path (Task 1.3)", () => {
	it("terminalizes an unknown CheckpointIdentityError with closed fatal evidence", async () => {
		const { initializeRun, readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const nonce = randomUUID();
		const loaderPath = join(dir, "unknown-checkpoint-identity-loader.mjs");
		const arbitraryCode = "checkpoint_unrecognized_test_code";
		const arbitraryDetail = "must-not-persist:/private/example";

		writeFileSync(
			loaderPath,
			`export async function load(url, context, nextLoad) {
				if (url.endsWith("/src/switchyard/runner/index.mjs")) {
					return {
						format: "module",
						shortCircuit: true,
						source: ${JSON.stringify(`const error = new Error(${JSON.stringify(arbitraryDetail)});\nerror.name = "CheckpointIdentityError";\nerror.code = "${arbitraryCode}";\nthrow error;\n`)},
					};
				}
				return nextLoad(url, context);
			}`,
			"utf8",
		);

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: nonce,
			launchArgs: [],
		});

		const result = runBootstrap(
			["--state-root", stateRoot, "--run-id", runId, "--nonce", nonce],
			{
				...makeStateRootEnv(),
				NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
			},
		);

		strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}: ${result.stderr}`,
		);

		const events = await readEvents(runId);
		const bootFailed = events.find(
			(event) => event.event === "worker_boot_failed",
		);
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.status, "fatal");
		strictEqual(bootFailed.reasonCode, "launch_failed");
		strictEqual(bootFailed.diagnosticCode, "worker_boot_exception");
		ok(!JSON.stringify(bootFailed).includes(arbitraryCode));
		ok(!JSON.stringify(bootFailed).includes(arbitraryDetail));

		const run = await readRun(runId);
		strictEqual(run.state, "failed");
		strictEqual(run.cleanupState, "complete");
		strictEqual(run.lastFailure.diagnosticCode, "worker_boot_exception");
		ok(!JSON.stringify(run).includes(arbitraryCode));
		ok(!JSON.stringify(run).includes(arbitraryDetail));
	});

	it("bootstrap with run-options mismatch emits checkpoint_run_options_mismatch", async () => {
		const { initializeRun, readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const { normalizeRunOptions, createQueueIdentity, loadTaskQueue } =
			await import("../src/switchyard/runner/index.mjs");

		const runId = randomUUID();
		const nonce = randomUUID();
		const checkpointPath = `${tasksFile}.checkpoint.json`;

		const tasks = loadTaskQueue(tasksFile);
		const runOptions1 = normalizeRunOptions({
			checkpointPath,
			maxTasks: 1,
			stopOnFailure: true,
		});
		const runOptions2 = normalizeRunOptions({
			checkpointPath,
			maxTasks: 2,
			stopOnFailure: true,
		});

		const queueIdentity = createQueueIdentity({
			tasksFilePath: tasksFile,
			markdown: readFileSync(tasksFile, "utf8"),
			tasks,
			projectRevision: "rev-1",
			runOptions: runOptions1,
		});

		writeFileSync(
			checkpointPath,
			JSON.stringify({
				version: 2,
				tasksFilePath: tasksFile,
				queueIdentity,
				runOptions: runOptions2,
				completedTaskIds: [],
				results: [],
			}),
			"utf8",
		);

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: nonce,
			launchArgs: [],
			queueIdentity,
			projectRevision: "rev-1",
			runOptions: runOptions1,
		});

		const result = runBootstrap(
			["--state-root", stateRoot, "--run-id", runId, "--nonce", nonce],
			makeStateRootEnv(),
		);

		strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}: ${result.stderr}`,
		);

		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.phase, "worker");
		strictEqual(bootFailed.event, "worker_boot_failed");
		strictEqual(bootFailed.status, "checkpoint_run_options_mismatch");
		strictEqual(bootFailed.errorKind, "launch_failed");
		strictEqual(bootFailed.reasonCode, "checkpoint_run_options_mismatch");
		strictEqual(bootFailed.diagnosticCode, "checkpoint_run_options_mismatch");
		strictEqual(bootFailed.failurePhase, "worker_boot");
		ok(bootFailed.reason.includes("normalized run options changed"));
		strictEqual(bootFailed.error, undefined);
		ok(!JSON.stringify(bootFailed).includes(projectDir));

		const run = await readRun(runId);
		ok(run.lastFailure !== null, "lastFailure populated in run.json");
		strictEqual(run.lastFailure.errorKind, "launch_failed");
		strictEqual(run.lastFailure.reasonCode, "launch_failed");
		strictEqual(
			run.lastFailure.reason,
			"The headless provider job could not be launched.",
		);
		strictEqual(run.lastFailure.failurePhase, "worker_boot");
		ok(!JSON.stringify(run.lastFailure).includes(projectDir));
		const disposition = projectDisposition({
			run,
			liveness: "terminal_clean",
			optionalEvidenceValid: false,
		});
		strictEqual(disposition.action, "repair_contract");
		strictEqual(disposition.reasonCode, "checkpoint_run_options_mismatch");
	});

	it("five checkpoint identity regressions emit distinct static codes on the worker-fatal path", async () => {
		const { initializeRun, readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const { normalizeRunOptions, createQueueIdentity, loadTaskQueue } =
			await import("../src/switchyard/runner/index.mjs");

		const checkpointPath = `${tasksFile}.checkpoint.json`;
		const tasks = loadTaskQueue(tasksFile);
		const runOptions = normalizeRunOptions({
			checkpointPath,
			maxTasks: 1,
			stopOnFailure: true,
		});
		const mismatchedRunOptions = normalizeRunOptions({
			checkpointPath,
			maxTasks: 2,
			stopOnFailure: true,
		});

		const queueIdentity = createQueueIdentity({
			tasksFilePath: tasksFile,
			markdown: readFileSync(tasksFile, "utf8"),
			tasks,
			projectRevision: "rev-1",
			runOptions,
		});
		const mismatchedQueueIdentity = "f".repeat(64);

		const cases = [
			{
				name: "task-file mismatch",
				expectedCode: "checkpoint_task_file_mismatch",
				checkpoint: {
					version: 2,
					tasksFilePath: "/other/path/tasks.md",
					queueIdentity,
					runOptions,
					completedTaskIds: [],
					results: [],
				},
				runOptions,
				queueIdentity,
			},
			{
				name: "missing queue identity",
				expectedCode: "checkpoint_missing_queue_identity",
				checkpoint: {
					version: 2,
					tasksFilePath: tasksFile,
					completedTaskIds: [],
					results: [],
				},
				runOptions,
				queueIdentity,
			},
			{
				name: "queue-identity mismatch",
				expectedCode: "checkpoint_queue_identity_mismatch",
				checkpoint: {
					version: 2,
					tasksFilePath: tasksFile,
					queueIdentity: mismatchedQueueIdentity,
					runOptions,
					completedTaskIds: [],
					results: [],
				},
				runOptions,
				queueIdentity,
			},
			{
				name: "run-options mismatch",
				expectedCode: "checkpoint_run_options_mismatch",
				checkpoint: {
					version: 2,
					tasksFilePath: tasksFile,
					queueIdentity,
					runOptions: mismatchedRunOptions,
					completedTaskIds: [],
					results: [],
				},
				runOptions,
				queueIdentity,
			},
			{
				name: "historical checkpoint",
				expectedCode: "checkpoint_historical_checkpoint",
				checkpoint: {
					version: 1,
					tasksFilePath: tasksFile,
					completedTaskIds: [],
					results: [],
				},
				runOptions,
				queueIdentity,
			},
		];

		const observedCodes = new Set();

		for (const testCase of cases) {
			const runId = randomUUID();
			const nonce = randomUUID();

			writeFileSync(
				checkpointPath,
				JSON.stringify(testCase.checkpoint),
				"utf8",
			);

			await initializeRun({
				runId,
				tasksFilePath: tasksFile,
				projectPath: projectDir,
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "test-fingerprint",
				workerNonce: nonce,
				launchArgs: [],
				queueIdentity: testCase.queueIdentity,
				projectRevision: "rev-1",
				runOptions: testCase.runOptions,
			});

			const result = runBootstrap(
				["--state-root", stateRoot, "--run-id", runId, "--nonce", nonce],
				makeStateRootEnv(),
			);

			strictEqual(
				result.status,
				1,
				`${testCase.name} expected exit 1, got ${result.status}: ${result.stderr}`,
			);

			const events = await readEvents(runId);
			const bootFailed = events.find((e) => e.event === "worker_boot_failed");
			ok(bootFailed, `${testCase.name}: worker_boot_failed event recorded`);
			strictEqual(
				bootFailed.phase,
				"worker",
				`${testCase.name} phase mismatch`,
			);
			strictEqual(
				bootFailed.event,
				"worker_boot_failed",
				`${testCase.name} event mismatch`,
			);
			strictEqual(
				bootFailed.status,
				testCase.expectedCode,
				`${testCase.name} status code mismatch`,
			);
			strictEqual(
				bootFailed.errorKind,
				"launch_failed",
				`${testCase.name} errorKind mismatch`,
			);
			strictEqual(
				bootFailed.reasonCode,
				testCase.expectedCode,
				`${testCase.name} reasonCode mismatch`,
			);
			strictEqual(
				bootFailed.diagnosticCode,
				testCase.expectedCode,
				`${testCase.name} diagnosticCode mismatch`,
			);
			strictEqual(
				bootFailed.failurePhase,
				"worker_boot",
				`${testCase.name} failurePhase mismatch`,
			);
			strictEqual(
				bootFailed.error,
				undefined,
				`${testCase.name} should not have raw error object`,
			);
			ok(
				!JSON.stringify(bootFailed).includes(projectDir),
				`${testCase.name} should not leak host paths`,
			);
			observedCodes.add(testCase.expectedCode);

			const run = await readRun(runId);
			ok(
				run.lastFailure !== null,
				`${testCase.name}: lastFailure populated in run.json`,
			);
			strictEqual(run.lastFailure.errorKind, "launch_failed");
			strictEqual(run.lastFailure.reasonCode, "launch_failed");
			strictEqual(run.lastFailure.failurePhase, "worker_boot");
			ok(!JSON.stringify(run.lastFailure).includes(projectDir));
		}

		strictEqual(observedCodes.size, 5, "five distinct static codes emitted");
	});
});

describe("fast/failed bootstrap", () => {
	it("emits one fixed diagnostic when the run record is missing", async () => {
		const runId = `missing-${randomUUID()}`;
		const canary = "SECRET_CANARY_MISSING_RUN";
		const result = runBootstrap(
			["--state-root", stateRoot, "--run-id", runId, "--nonce", canary],
			makeStateRootEnv(),
		);

		strictEqual(result.status, 1);
		strictEqual(
			result.stderr,
			"worker-bootstrap: fatal event persistence unavailable; durable run state may be incomplete\n",
		);
		ok(!result.stderr.includes(canary));
		ok(!existsSync(resolve(stateRoot, "runs", runId, "run.json")));
	});

	it("emits one fixed diagnostic and preserves corrupt run.json", async () => {
		const runId = `corrupt-${randomUUID()}`;
		const canary = "SECRET_CANARY_CORRUPT_RUN";
		const runRoot = resolve(stateRoot, "runs", runId);
		const runJsonPath = resolve(runRoot, "run.json");
		mkdirSync(runRoot, { recursive: true });
		// An unreadable run.json (a directory) exercises the filesystem-error
		// path, which retention conservatively leaves in place.
		mkdirSync(runJsonPath);
		const canaryPath = resolve(runJsonPath, "canary");
		writeFileSync(canaryPath, canary, "utf8");

		const result = runBootstrap(
			["--state-root", stateRoot, "--run-id", runId, "--nonce", canary],
			makeStateRootEnv(),
		);

		strictEqual(result.status, 1);
		strictEqual(
			result.stderr,
			"worker-bootstrap: fatal event persistence unavailable; durable run state may be incomplete\n",
		);
		ok(!result.stderr.includes(canary));
		ok(existsSync(runJsonPath));
		strictEqual(readFileSync(canaryPath, "utf8"), canary);
	});

	it("bootstrap that fails to import the runner records worker_boot_failed and does not hang", async () => {
		const { initializeRun, readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const nonce = randomUUID();

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: nonce,
			launchArgs: [],
		});

		// Build a broken bootstrap script that fails to import
		const brokenBootstrapPath = join(dir, "broken-bootstrap.mjs");
		writeFileSync(
			brokenBootstrapPath,
			`process.env.SWITCHYARD_RUN_STORE_ROOT = ${JSON.stringify(stateRoot)};
import("${resolve(__dirname, "..", "src", "switchyard", "run-store", "index.mjs")}").then(async (runStore) => {
	await runStore.advanceState("${runId}", "running");
	throw new Error("simulated import failure: module not found");
}).catch(async (err) => {
	try {
		await (await import("${resolve(__dirname, "..", "src", "switchyard", "run-store", "index.mjs")}")).createEvent("${runId}", {
			phase: "worker",
			event: "worker_boot_failed",
			status: "fatal",
			errorKind: "launch_failed",
			diagnosticCode: "worker_boot_exception",
			failurePhase: "worker_boot",
		});
	} catch {}
	process.exit(1);
});
`,
			"utf8",
		);

		const start = Date.now();
		const result = spawnSync(process.execPath, [brokenBootstrapPath], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
			env: { ...process.env, SWITCHYARD_RUN_STORE_ROOT: stateRoot },
		});
		const elapsed = Date.now() - start;

		strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}: ${result.stderr}`,
		);
		ok(elapsed < 10_000, `broken bootstrap hung: ${elapsed}ms`);

		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.phase, "worker");
		strictEqual(bootFailed.event, "worker_boot_failed");
		strictEqual(bootFailed.status, "fatal");
		strictEqual(bootFailed.errorKind, "launch_failed");
		strictEqual(bootFailed.diagnosticCode, "worker_boot_exception");
		strictEqual(bootFailed.failurePhase, "worker_boot");
		strictEqual(bootFailed.reasonCode, "launch_failed");
		strictEqual(
			bootFailed.reason,
			"The headless provider job could not be launched.",
		);
		strictEqual(bootFailed.error, undefined);
		ok(!JSON.stringify(bootFailed).includes("simulated import failure"));

		const run = await readRun(runId);
		ok(run.lastFailure !== null, "lastFailure populated in run.json");
		strictEqual(run.lastFailure.errorKind, "launch_failed");
		strictEqual(run.lastFailure.diagnosticCode, "worker_boot_exception");
		strictEqual(run.lastFailure.failurePhase, "worker_boot");
		strictEqual(run.lastFailure.reasonCode, "launch_failed");
		strictEqual(
			run.lastFailure.reason,
			"The headless provider job could not be launched.",
		);
	});
});

describe("status and result envelope contracts", () => {
	it("status shows activeTaskId when a task is running and completed/failed counts change", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1", "1.2"],
			initialHostFingerprint: "test-fp",
			launchArgs: [],
		});

		// Advance to running and set activeTaskId
		const current = await readRun(runId);
		await updateRun(
			runId,
			{ state: "running", activeTaskId: "1.1" },
			current.revision,
		);

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0);
		const status = JSON.parse(statusResult.stdout.trim());
		strictEqual(status.state, "running");
		strictEqual(status.activeTaskId, "1.1");
	});

	it("status exposes workerLive:true and the routed provider/model/deadline for a live worker, without needing docker top", async () => {
		// Regression: an operator had to shell out to `docker top`/`ps` to
		// distinguish a genuinely active run from a ghost (a "running" state
		// whose worker process actually died), and had to inspect the host
		// process to learn which provider/model a task was routed to.
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fp",
			launchArgs: [],
		});

		const deadline = new Date(Date.now() + 1_800_000).toISOString();
		const current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "running",
				workerPid: process.pid,
				activeTaskId: "1.1",
				activeTaskProvider: "claude",
				activeTaskModel: "claude-sonnet-5",
				activeTaskDeadline: deadline,
				activeTaskElapsedMs: 321,
				activeTaskHeartbeatAt: 123456,
				activeTaskProcessPhase: "provider_transport_running",
				telemetryWriteFailures: 2,
				lastTelemetryWriteFailure: "revision_conflict",
			},
			current.revision,
		);

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0);
		const status = JSON.parse(statusResult.stdout.trim());
		strictEqual(status.workerLive, true);
		strictEqual(status.activeTaskProvider, "claude");
		strictEqual(status.activeTaskModel, "claude-sonnet-5");
		strictEqual(status.activeTaskDeadline, deadline);
		strictEqual(status.activeTaskElapsedMs, 321);
		strictEqual(status.activeTaskHeartbeatAt, 123456);
		strictEqual(status.activeTaskProcessPhase, "provider_transport_running");
		strictEqual(status.telemetryWriteFailures, 2);
		strictEqual(status.lastTelemetryWriteFailure, "revision_conflict");

		const terminalCurrent = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				terminalSummary: {
					totalTasks: 1,
					runnableTasks: 1,
					processedTasks: 1,
					completedTaskIds: ["1.1"],
					failedCount: 0,
				},
			},
			terminalCurrent.revision,
		);
		const resultResult = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(resultResult.status, 0);
		const result = JSON.parse(resultResult.stdout.trim());
		strictEqual(result.activeTaskId, null);
		strictEqual(result.activeTaskProvider, null);
		strictEqual(result.activeTaskModel, null);
		strictEqual(result.activeTaskDeadline, null);
		strictEqual(result.activeTaskElapsedMs, null);
		strictEqual(result.activeTaskHeartbeatAt, null);
		strictEqual(result.activeTaskProcessPhase, null);
		strictEqual(result.telemetryWriteFailures, 2);
		strictEqual(result.lastTelemetryWriteFailure, "revision_conflict");
	});

	it("status exposes workerLive:false for a running state whose worker pid is dead (ghost run)", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fp",
			launchArgs: [],
		});

		const current = await readRun(runId);
		await updateRun(
			runId,
			{ state: "running", workerPid: 99999, activeTaskId: "1.1" },
			current.revision,
		);

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0);
		const status = JSON.parse(statusResult.stdout.trim());
		strictEqual(status.workerLive, false);
	});

	it("status reports workerLive:null for a non-running state (no live-worker question applies)", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fp",
			launchArgs: [],
		});

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0);
		const status = JSON.parse(statusResult.stdout.trim());
		strictEqual(status.state, "created");
		strictEqual(status.workerLive, null);
		strictEqual(status.activeTaskProvider, null);
		strictEqual(status.activeTaskModel, null);
		strictEqual(status.activeTaskDeadline, null);
		strictEqual(status.activeTaskElapsedMs, null);
		strictEqual(status.activeTaskHeartbeatAt, null);
		strictEqual(status.activeTaskProcessPhase, null);
		strictEqual(status.telemetryWriteFailures, 0);
		strictEqual(status.lastTelemetryWriteFailure, null);
	});
});

describe("worker boot stderr capture and retention (Task 1.1)", () => {
	it("worker that fails before diagnostics sink exists leaves non-empty boot-stderr.log naming the failure", async () => {
		const { getRunRoot, initializeRun, readEvents } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const nonce = "test-nonce-pre-sink";

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: nonce,
			launchArgs: [],
		});

		const markerPath = join(dir, "active-generation-marker.json");
		writeFileSync(
			markerPath,
			JSON.stringify({
				schemaVersion: 1,
				state: "in_progress",
				runId: "generation-guard-test-run",
				owner: "native",
				startedAt: new Date().toISOString(),
				metadata: {},
			}),
		);

		const bootLogPath = resolve(getRunRoot(runId), "boot-stderr.log");
		const fd = openSync(bootLogPath, "w", 0o600);

		// Run worker-bootstrap with a maintenance generation active so it refuses
		// before runStore is imported and before the diagnostics sink is constructed
		const result = spawnSync(
			process.execPath,
			[
				BOOTSTRAP_PATH,
				"--state-root",
				stateRoot,
				"--run-id",
				runId,
				"--nonce",
				nonce,
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "ignore", fd],
				env: {
					...process.env,
					...makeStateRootEnv(),
					SWITCHYARD_GENERATION_MARKER: markerPath,
				},
			},
		);
		closeSync(fd);

		strictEqual(
			result.status,
			1,
			"expected exit 1 for generation guard refusal",
		);

		const events = await readEvents(runId);
		strictEqual(events.length, 1);
		strictEqual(events[0].event, "worker_boot_failed");
		strictEqual(events[0].errorKind, "launch_failed");

		// boot-stderr.log exists and contains the failure reason
		ok(existsSync(bootLogPath), "boot-stderr.log must exist");
		const bootStderr = readFileSync(bootLogPath, "utf8");
		ok(bootStderr.length > 0, "boot-stderr.log must have non-zero size");
		ok(
			bootStderr.includes("generation guard refused"),
			`expected boot-stderr.log to name failure, got: ${bootStderr}`,
		);
	});

	it("uncaught boot exception stack reaches boot-stderr.log and persists worker_boot_exception", async () => {
		const { getRunRoot, initializeRun, readEvents, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const nonce = "test-nonce-uncaught";

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: nonce,
			launchArgs: [],
		});
		await updateRun(runId, { dispatchContractVersion: 99 }, 1);

		const bootLogPath = resolve(getRunRoot(runId), "boot-stderr.log");
		const fd = openSync(bootLogPath, "w", 0o600);

		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
				process.nextTick(() => {
					throw new Error("Simulated uncaught boot explosion for Task 1.1");
				});
				const { runWorkerBootstrap } = await import(
					${JSON.stringify(BOOTSTRAP_PATH)}
				);
				await runWorkerBootstrap(process.argv);
				`,
				"--",
				"--state-root",
				stateRoot,
				"--run-id",
				runId,
				"--nonce",
				nonce,
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "ignore", fd],
				env: {
					...process.env,
					...makeStateRootEnv(),
				},
			},
		);
		closeSync(fd);

		strictEqual(
			child.status,
			1,
			"expected child to exit 1 on uncaughtException",
		);

		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.phase, "worker");
		strictEqual(bootFailed.status, "fatal");
		strictEqual(bootFailed.errorKind, "launch_failed");
		strictEqual(bootFailed.diagnosticCode, "worker_boot_exception");
		strictEqual(bootFailed.failurePhase, "worker_boot");

		// Fatal handlers do not echo raw exception messages or stack frames.
		ok(existsSync(bootLogPath), "boot-stderr.log must exist");
		const bootStderr = readFileSync(bootLogPath, "utf8");
		strictEqual(bootStderr, "");
	});

	it("retains boot-stderr.log when the worker fails before provider routing", async () => {
		const { getRunRoot, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0, `launch failed: ${result.stderr}`);
		const envelope = JSON.parse(result.stdout.trim());
		const runId = envelope.runId;

		const deadline = Date.now() + 5000;
		let finalState = "launching";
		while (Date.now() < deadline) {
			const run = await readRun(runId);
			finalState = run.state;
			if (run.state !== "launching") {
				break;
			}
			await new Promise((r) => setTimeout(r, 50));
		}

		// State advancement proves the worker executed its identity checks. In
		// this fixture provider admission fails, so the boot log remains as the
		// bounded pre-provider diagnostic channel.
		ok(
			finalState !== "launching",
			`worker never advanced past launching (state=${finalState}); unlink assertion below would be vacuous`,
		);

		const runRoot = getRunRoot(runId);
		const bootLogPath = resolve(runRoot, "boot-stderr.log");
		ok(existsSync(bootLogPath), "pre-provider failure retains boot-stderr.log");
	});

	it("nonce mismatch with secret canary never writes canary to boot-stderr.log bytes", async () => {
		const { getRunRoot, initializeRun, readEvents } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const correctNonce = "correct-nonce-val";
		const secretCanaryNonce = "SECRET_CANARY_NEVER_LEAK_INTO_BOOT_LOG";

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: correctNonce,
			launchArgs: [],
		});

		const bootLogPath = resolve(getRunRoot(runId), "boot-stderr.log");
		const fd = openSync(bootLogPath, "w", 0o600);

		const result = spawnSync(
			process.execPath,
			[
				BOOTSTRAP_PATH,
				"--state-root",
				stateRoot,
				"--run-id",
				runId,
				"--nonce",
				secretCanaryNonce,
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "ignore", fd],
				env: {
					...process.env,
					...makeStateRootEnv(),
				},
			},
		);
		closeSync(fd);

		strictEqual(result.status, 3, "expected exit 3 for nonce mismatch");

		ok(existsSync(bootLogPath), "boot-stderr.log exists");
		const logBytes = readFileSync(bootLogPath);
		const logText = logBytes.toString("utf8");

		ok(
			!logText.includes("SECRET_CANARY"),
			`secret canary found in boot-stderr.log: ${logText}`,
		);
		ok(
			!logText.includes(secretCanaryNonce),
			`secret nonce found in boot-stderr.log: ${logText}`,
		);

		// Presence alone would prove nothing: assert the classification the
		// event is supposed to carry, and that it too is canary-free.
		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.errorKind, "launch_failed");
		strictEqual(bootFailed.diagnosticCode, "worker_nonce_mismatch");
		strictEqual(bootFailed.failurePhase, "worker_boot");
		ok(!JSON.stringify(bootFailed).includes("SECRET_CANARY"));
	});

	it("launch creates boot-stderr.log and wires it to the worker's stderr", async () => {
		const { getRunRoot } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		// Poison NODE_OPTIONS *after* this launcher process is already running, so
		// only the worker it spawns is affected. The worker then dies before Node
		// executes a single line of worker-bootstrap — no diagnostics sink, no
		// event, no unlink. That is the register-no-boot case this channel exists
		// for, and it is the one lever that forces it deterministically: any
		// failure the worker can reach itself would unlink the log on the way past.
		const launchCode = `
		process.env.NODE_OPTIONS = "--this-flag-does-not-exist";
		const { handleLaunch } = await import(${JSON.stringify(DISPATCH_PATH)});
		await handleLaunch([${JSON.stringify(tasksFile)}, "--project", ${JSON.stringify(projectDir)}]);
		`;

		const result = spawnSync(
			process.execPath,
			["--input-type=module", "-e", launchCode, "--"],
			{
				encoding: "utf8",
				env: {
					...process.env,
					...makeStateRootEnv(),
				},
			},
		);

		strictEqual(
			result.status,
			0,
			`expected exit 0, got ${result.status}: ${result.stderr}`,
		);
		const envelope = JSON.parse(result.stdout.trim());
		strictEqual(envelope.state, "launcher_ready");

		const bootLogPath = resolve(getRunRoot(envelope.runId), "boot-stderr.log");
		ok(existsSync(bootLogPath), `launch never created ${bootLogPath}`);
		const captured = readFileSync(bootLogPath, "utf8");
		ok(
			captured.includes("is not allowed in NODE_OPTIONS"),
			`worker stderr was not wired to the boot log; got: ${captured}`,
		);

		// Without this channel the run record is the whole story, and it says
		// nothing: the worker never reached the code that writes an event.
		const { readEvents } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const events = await readEvents(envelope.runId);
		strictEqual(
			events.filter((e) => e.event === "worker_boot_failed").length,
			0,
			"no boot event is possible here — the boot log is the only record",
		);
	});

	it("launch still succeeds when the boot log cannot be opened", async () => {
		const { getRunRoot, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		// Reassigning `fs.openSync` alone does NOT reach dispatch's named
		// `import { openSync } from "node:fs"` binding — the ESM linker has
		// already snapshotted it. `syncBuiltinESMExports()` republishes the
		// mutated object through the builtin's named exports, and is the only
		// reason this stub is not vacuous. The stub announces itself and the
		// test asserts on that: otherwise a refactor that stopped opening the
		// log at all would keep this test green.
		const launchCode = `
		import fs from "node:fs";
		import { syncBuiltinESMExports } from "node:module";
		const realOpenSync = fs.openSync;
		fs.openSync = function (path, ...rest) {
			if (typeof path === "string" && path.endsWith("boot-stderr.log")) {
				process.stderr.write("STUB_REFUSED_BOOT_LOG\\n");
				throw new Error("EACCES: simulated open failure");
			}
			return realOpenSync.call(this, path, ...rest);
		};
		syncBuiltinESMExports();
		const { handleLaunch } = await import(${JSON.stringify(DISPATCH_PATH)});
		await handleLaunch([${JSON.stringify(tasksFile)}, "--project", ${JSON.stringify(projectDir)}]);
		`;

		const result = spawnSync(
			process.execPath,
			["--input-type=module", "-e", launchCode, "--"],
			{
				encoding: "utf8",
				env: {
					...process.env,
					...makeStateRootEnv(),
				},
			},
		);

		ok(
			result.stderr.includes("STUB_REFUSED_BOOT_LOG"),
			`the open stub never fired, so this test proves nothing: ${result.stderr}`,
		);
		strictEqual(
			result.status,
			0,
			`a diagnostics file must never fail a launch, got ${result.status}: ${result.stderr}`,
		);
		const envelope = JSON.parse(result.stdout.trim());
		strictEqual(envelope.state, "launcher_ready");
		ok(
			!existsSync(resolve(getRunRoot(envelope.runId), "boot-stderr.log")),
			"the open was refused, so no boot log should exist",
		);

		// The fallback has to yield a working worker, not merely a working
		// launcher: `stdio: "ignore"` must still be a valid spawn disposition.
		const deadline = Date.now() + 5000;
		let finalState = "launching";
		while (Date.now() < deadline) {
			finalState = (await readRun(envelope.runId)).state;
			if (finalState !== "launching") {
				break;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		ok(
			finalState !== "launching",
			`worker spawned with the "ignore" fallback never booted (state=${finalState})`,
		);
	});

	it("applyRetention preserves run with non-empty boot-stderr.log and deletes empty or absent", async () => {
		const { applyRetention, getRunRoot, initializeRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		// 1. Run with non-empty boot-stderr.log (should be preserved past cutoff)
		const runKeepId = `retention-keep-boot-${randomUUID()}`;
		await initializeRun({
			runId: runKeepId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: "nonce-keep",
			launchArgs: [],
		});
		const keepBootLog = resolve(getRunRoot(runKeepId), "boot-stderr.log");
		writeFileSync(
			keepBootLog,
			"worker-bootstrap: generation guard refused (fatal)\n",
			{ mode: 0o600 },
		);

		// 2. Run with empty boot-stderr.log (0 bytes -> should be deleted past cutoff)
		const runEmptyLogId = `retention-del-empty-${randomUUID()}`;
		await initializeRun({
			runId: runEmptyLogId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: "nonce-empty",
			launchArgs: [],
		});
		const emptyBootLog = resolve(getRunRoot(runEmptyLogId), "boot-stderr.log");
		writeFileSync(emptyBootLog, "", { mode: 0o600 });

		// 3. Run with no boot-stderr.log and no events.jsonl (should be deleted past cutoff)
		const runNoLogId = `retention-del-nolog-${randomUUID()}`;
		await initializeRun({
			runId: runNoLogId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: "nonce-nolog",
			launchArgs: [],
		});

		const result = await applyRetention({
			maxRuns: 0,
			maxAgeDays: 0,
			now: new Date(Date.now() + 86_400_000).toISOString(),
		});

		// Pin the sweep's scope, not just these three runs: the assertions
		// below say nothing about a directory they do not name.
		strictEqual(
			result.deletedCount,
			2,
			`expected exactly the two runs without a diagnostic record to be swept, got ${result.deletedCount}`,
		);

		// runKeepId must survive
		const keptRun = await readRun(runKeepId);
		strictEqual(keptRun.runId, runKeepId);
		ok(existsSync(keepBootLog));

		// runEmptyLogId and runNoLogId must be deleted
		await rejects(readRun(runEmptyLogId), /Run not found/);
		await rejects(readRun(runNoLogId), /Run not found/);
	});
});

function assertNoSecretCanary(runId) {
	const runDir = resolve(stateRoot, "runs", runId);
	const runJsonRaw = readFileSync(resolve(runDir, "run.json"), "utf8");
	ok(
		!runJsonRaw.includes("SECRET_CANARY_"),
		"run.json must not contain SECRET_CANARY_",
	);

	try {
		const eventsRaw = readFileSync(resolve(runDir, "events.jsonl"), "utf8");
		ok(
			!eventsRaw.includes("SECRET_CANARY_"),
			"events.jsonl must not contain SECRET_CANARY_",
		);
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}

	try {
		const bootLogRaw = readFileSync(resolve(runDir, "boot-stderr.log"), "utf8");
		ok(
			!bootLogRaw.includes("SECRET_CANARY_"),
			"boot-stderr.log must not contain SECRET_CANARY_",
		);
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}

	try {
		const artifactsDir = resolve(runDir, "artifacts");
		const entries = readdirSync(artifactsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isFile()) {
				const content = readFileSync(resolve(artifactsDir, entry.name), "utf8");
				ok(
					!content.includes("SECRET_CANARY_"),
					`artifact ${entry.name} must not contain SECRET_CANARY_`,
				);
			}
		}
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
}
