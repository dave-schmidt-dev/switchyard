import {
	deepStrictEqual,
	notStrictEqual,
	ok,
	rejects,
	strictEqual,
} from "node:assert";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
	classifyPreProviderFailure,
	INTEGRATION_REFUSAL_KINDS,
	isPersistentFailureMetadata,
	sanitizeFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";
import { validateInvocationDescriptor } from "../src/switchyard/roster/index.mjs";
import {
	acquireLaunchLock,
	acquireProjectLock,
	acquireRunLock,
	acquireVmSlot,
	advanceState,
	applyRetention,
	assertProjectLockOwnership,
	createEvent,
	getRunRoot,
	getStateRoot,
	getVmAdmissionRoot,
	initializeRun,
	isProjectLockHeld,
	isProjectLockOwnedBy,
	isRunLockExpired,
	LockError,
	RevisionError,
	readEvents,
	readRun,
	reconcileProjectLockClaims,
	releaseLaunchLock,
	releaseOrphanedProjectLocks,
	releaseProjectLock,
	releaseProjectLockIfOwnedBy,
	releaseRunLock,
	releaseVmSlot,
	renewRunLock,
	runStoreTesting,
	SchemaError,
	sanitizeVmAdmissionError,
	updateRun,
	updateRunWithRetry,
	VmAdmissionPermissionDeniedError,
	VmAdmissionStorageError,
	VmAdmissionUnavailableError,
	VmSlotUnavailableError,
} from "../src/switchyard/run-store/index.mjs";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "switchyard-run-store-"));

process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_ROOT, "store");
const VM_ADMISSION_ROOT = join(TEST_ROOT, "vm-admission");
process.env.SWITCHYARD_VM_ADMISSION_ROOT = VM_ADMISSION_ROOT;
process.env.SWITCHYARD_ROSTER_PATH = resolve(
	"tests/fixtures/roster.fixture.json",
);

after(() => {
	try {
		rmSync(TEST_ROOT, { recursive: true, force: true });
	} catch {
		// no-op
	}
});

afterEach(() => {
	try {
		rmSync(join(TEST_ROOT, "store"), { recursive: true, force: true });
		rmSync(VM_ADMISSION_ROOT, { recursive: true, force: true });
	} catch {
		// no-op
	}
});

function uniqueRunId() {
	return randomUUID();
}

const RUN_STORE_MODULE_URL = pathToFileURL(
	resolve("src/switchyard/run-store/index.mjs"),
).href;

function spawnSlotChild(source) {
	return spawn(process.execPath, ["--input-type=module", "-e", source], {
		env: { ...process.env, SWITCHYARD_VM_ADMISSION_ROOT: VM_ADMISSION_ROOT },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function readChildLine(child) {
	return new Promise((resolveLine, reject) => {
		let output = "";
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`timed out waiting for child output: ${output}`));
		}, 5_000);
		child.stdout.setEncoding("utf8");
		const onData = (chunk) => {
			output += chunk;
			const newline = output.indexOf("\n");
			if (newline < 0) return;
			clearTimeout(timeout);
			child.stdout.off("data", onData);
			resolveLine(output.slice(0, newline));
		};
		child.stdout.on("data", onData);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

function waitForChild(child) {
	return new Promise((resolveExit, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolveExit({ code, signal }));
	});
}

function uniquePath(label) {
	return join(TEST_ROOT, `path-${label || uniqueRunId()}`);
}

// Mirrors the private lockFilePath() hashing scheme in run-store/index.mjs
// so tests can read a lock file's raw JSON body directly.
function projectLockFilePath(canonicalProjectPath) {
	const identity = `project:${resolve(canonicalProjectPath)}`;
	const hash = createHash("sha256").update(identity).digest("hex");
	return resolve(getStateRoot(), "locks", `${hash}.lock`);
}

function projectLockClaimFilePath(canonicalProjectPath) {
	return `${projectLockFilePath(canonicalProjectPath)}.recovery-claim`;
}

function cwdDerivedProjectLockFilePath(canonicalProjectPath) {
	const historicalKeyPath = resolve(
		canonicalProjectPath,
		`project:${canonicalProjectPath}`,
	);
	const hash = createHash("sha256").update(historicalKeyPath).digest("hex");
	return resolve(getStateRoot(), "locks", `${hash}.lock`);
}

function makeOptions(overrides = {}) {
	return {
		runId: uniqueRunId(),
		tasksFilePath: uniquePath("tasks"),
		projectPath: uniquePath("project"),
		orderedTaskIds: ["task-1", "task-2", "task-3"],
		initialHostFingerprint: { git: "abc123", worktree: "clean" },
		launchArgs: ["--provider", "claude"],
		...overrides,
	};
}

describe("getStateRoot", () => {
	it("returns an absolute path ending in .logs/switchyard by default", () => {
		const saved = process.env.SWITCHYARD_RUN_STORE_ROOT;
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		try {
			const root = getStateRoot();
			strictEqual(resolve(root), root);
			ok(
				root.endsWith(`${sep}.logs${sep}switchyard`),
				`${root} should end with .logs/switchyard, got ${root}`,
			);
		} finally {
			if (saved) process.env.SWITCHYARD_RUN_STORE_ROOT = saved;
		}
	});

	it("returns the env override path when SWITCHYARD_RUN_STORE_ROOT is set", () => {
		const root = getStateRoot();
		strictEqual(resolve(root), root);
		ok(
			root.endsWith(`${sep}store`),
			`${root} should end with store (the env override)`,
		);
	});
});

describe("initializeRun", () => {
	it("creates run.json with state created and all required fields", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);

		strictEqual(snapshot.schemaVersion, 1);
		strictEqual(snapshot.runId, opts.runId);
		strictEqual(snapshot.state, "created");
		strictEqual(snapshot.cleanupState, "not_started");
		strictEqual(snapshot.revision, 1);
		strictEqual(typeof snapshot.createdAt, "string");
		strictEqual(typeof snapshot.updatedAt, "string");
		strictEqual(snapshot.tasksFilePath, opts.tasksFilePath);
		strictEqual(snapshot.projectPath, opts.projectPath);
		ok(Array.isArray(snapshot.orderedTaskIds));
		strictEqual(snapshot.orderedTaskIds.length, 3);
		ok(typeof snapshot.initialHostFingerprint === "object");
		strictEqual(snapshot.workerPid, null);
		strictEqual(snapshot.workerStartToken, null);
		strictEqual(snapshot.workerNonce, "");
		strictEqual(snapshot.activeTaskId, null);
		strictEqual(snapshot.terminalSummary, null);
		strictEqual(snapshot.cleanupError, null);
		strictEqual(snapshot.lastFailure, null);
		strictEqual(snapshot.resolvedTargetId, null);
		deepStrictEqual(snapshot.quarantinedTargetIds, []);
		strictEqual(snapshot.retryState, null);
		strictEqual(snapshot.retryTransitionId, 0);
		strictEqual(snapshot.snapshotStatus, null);
		strictEqual(snapshot.snapshotMtime, null);
		strictEqual(snapshot.snapshotAgeMsAtRoute, null);
		strictEqual(typeof snapshot.lastLeaseHeartbeat, "string");
		ok(Array.isArray(snapshot.launchArgs));
		strictEqual(snapshot.launchArgs[0], "--provider");
	});

	it("readRun returns the same data written to disk", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const loaded = await readRun(opts.runId);

		strictEqual(loaded.runId, opts.runId);
		strictEqual(loaded.state, "created");
		strictEqual(loaded.revision, 1);
	});

	it("persists an identity-bound v2 run while retaining the v1 reader", async () => {
		const opts = makeOptions({
			projectRevision: "rev-1",
			queueIdentity: "a".repeat(64),
			runOptions: {
				version: 1,
				maxTasks: 2,
				checkpointPath: "/tmp/checkpoint.json",
				stopOnFailure: true,
				onlyProviders: ["claude"],
				excludeProviders: [],
				taskIds: ["task-1"],
			},
		});
		const snapshot = await initializeRun(opts);
		strictEqual(snapshot.schemaVersion, 2);
		strictEqual(snapshot.projectRevision, "rev-1");
		strictEqual(snapshot.queueIdentity, "a".repeat(64));
		strictEqual((await readRun(opts.runId)).schemaVersion, 2);

		const legacy = makeOptions({ runId: uniqueRunId() });
		const legacySnapshot = await initializeRun(legacy);
		strictEqual(legacySnapshot.schemaVersion, 1);
		strictEqual((await readRun(legacy.runId)).schemaVersion, 1);
	});

	it("creates run directory and artifacts subdirectory", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const runDir = getRunRoot(opts.runId);
		const artifactsDir = join(runDir, "artifacts");
		ok(existsSync(runDir));
		ok(existsSync(artifactsDir));
	});

	it("fails when runId already exists", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await rejects(initializeRun(opts), /Run already exists/);
	});
});

describe("revision", () => {
	it("throws RevisionError when expectedRevision does not match", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await rejects(
			updateRun(opts.runId, { state: "launching" }, 999),
			RevisionError,
		);
	});

	it("succeeds and increments revision on correct expectedRevision", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		const updated = await updateRun(opts.runId, { state: "launching" }, 1);
		strictEqual(updated.revision, 2);
		strictEqual(updated.state, "launching");
	});

	it("advanceState reads current revision and increments", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		const updated = await advanceState(opts.runId, "running");
		strictEqual(updated.revision, 2);
		strictEqual(updated.state, "running");
	});

	it("rapid consecutive updates each increment revision", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		const a = await updateRun(opts.runId, { state: "launching" }, 1);
		const b = await updateRun(opts.runId, { state: "running" }, 2);
		const c = await updateRun(opts.runId, { state: "succeeded" }, 3);

		strictEqual(a.revision, 2);
		strictEqual(b.revision, 3);
		strictEqual(c.revision, 4);
	});

	it("prevents stale concurrent writes via revision mismatch", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		const current = await readRun(opts.runId);

		await advanceState(opts.runId, "launching");

		await rejects(
			updateRun(opts.runId, { state: "running" }, current.revision),
			RevisionError,
		);
	});
});

describe("event ordering", () => {
	it("assigns monotonically increasing sequence numbers", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		const s1 = await createEvent(opts.runId, {
			phase: "bootstrap",
			event: "task_started",
			status: "ok",
		});
		const s2 = await createEvent(opts.runId, {
			phase: "execution",
			event: "task_completed",
			status: "ok",
		});
		const s3 = await createEvent(opts.runId, {
			phase: "cleanup",
			event: "cleanup_started",
			status: "ok",
		});

		strictEqual(s1, 1);
		strictEqual(s2, 2);
		strictEqual(s3, 3);
	});

	it("includes extra context fields in the event entry", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await createEvent(opts.runId, {
			phase: "execution",
			event: "task_started",
			status: "ok",
			taskId: "task-1",
			provider: "claude",
			model: "sonnet",
		});

		const eventsPath = join(getRunRoot(opts.runId), "events.jsonl");
		const { readFile } = await import("node:fs/promises");
		const content = await readFile(eventsPath, "utf8");
		const parsed = JSON.parse(content.trim().split("\n")[0]);

		strictEqual(parsed.schemaVersion, 1);
		strictEqual(parsed.sequence, 1);
		strictEqual(parsed.taskId, "task-1");
		strictEqual(parsed.provider, "claude");
		strictEqual(parsed.model, "sonnet");
	});

	it("persists only valid VM-slot wait elapsed time", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await createEvent(opts.runId, {
			phase: "bootstrap",
			event: "vm_slot_wait",
			status: "Waiting for VM admission capacity",
			elapsedMs: 12.5,
			unrelated: "SECRET_CANARY_unrelated_status_field",
		});
		for (const elapsedMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			await createEvent(opts.runId, {
				phase: "bootstrap",
				event: "vm_slot_wait",
				status: "Waiting for VM admission capacity",
				elapsedMs,
			});
		}
		await createEvent(opts.runId, {
			phase: "bootstrap",
			event: "another_status",
			status: "Other status",
			elapsedMs: 1,
		});

		const events = await readEvents(opts.runId);
		strictEqual(events[0].elapsedMs, 12.5);
		ok(!("unrelated" in events[0]));
		for (const event of events.slice(1)) {
			ok(!("elapsedMs" in event));
		}
		ok(!JSON.stringify(events).includes("SECRET_CANARY"));
	});

	it("sanitizes failure events before they are persisted", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await createEvent(opts.runId, {
			phase: "execution",
			event: "task_failed",
			status: "Task task-1 failed",
			taskId: "task-1",
			result: "execution_failed",
			errorKind: "provider_private_reason",
			error: "SECRET_CANARY_provider_error",
			output: "SECRET_CANARY_provider_output",
			reason: "SECRET_CANARY_provider_reason",
			partialDiffPath: "/Users/dave/project/.partial-diffs/task-1.diff",
		});

		const eventsPath = join(getRunRoot(opts.runId), "events.jsonl");
		const [event] = (await readFile(eventsPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		strictEqual(event.errorKind, "execution_failed");
		strictEqual(event.reasonCode, "execution_failed");
		strictEqual(
			event.reason,
			"Provider execution failed before a reviewed integration.",
		);
		for (const key of ["error", "output", "partialDiffPath"]) {
			ok(!(key in event), `raw event field ${key} must not persist`);
		}
		ok(!JSON.stringify(event).includes("SECRET_CANARY"));
	});

	it("persists integration failures with static diagnostics only", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await createEvent(opts.runId, {
			phase: "integration",
			event: "task_failed",
			status: "Task task-1 failed",
			taskId: "task-1",
			result: "integration_failed",
			errorKind: "integration_failed",
			reason: "SECRET_CANARY_gate_message",
			error: "SECRET_CANARY_gate_error",
			output: "SECRET_CANARY_gate_output",
			partialDiff: "SECRET_CANARY_gate_diff",
			partialDiffPath: "/Users/dave/project/.partial-diffs/task-1.diff",
			artifactRef: "artifact:aaaaaaaaaaaaaaaaaaaaaaaa",
		});

		const eventsPath = join(getRunRoot(opts.runId), "events.jsonl");
		const [event] = (await readFile(eventsPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		strictEqual(event.errorKind, "integration_failed");
		strictEqual(event.reasonCode, "integration_failed");
		strictEqual(
			event.reason,
			"The reviewed integration gate rejected the task result.",
		);
		ok(/^artifact:[a-f0-9]{24}$/.test(event.artifactRef));
		for (const key of ["error", "output", "partialDiff", "partialDiffPath"]) {
			ok(!(key in event), `raw event field ${key} must not persist`);
		}
		ok(!JSON.stringify(event).includes("SECRET_CANARY"));
	});

	it("carries an integration refusal kind through to events.jsonl and run.json", async () => {
		// Before this, every refusal arrived as the same static
		// `integration_failed`, so run eab7d23c's real cause (a manifest touched
		// without `AllowManifests: true`) was only recoverable by reading the
		// gate's source. The kind is a closed-enum member, so naming the cause
		// costs nothing on the INV-2 boundary.
		for (const kind of INTEGRATION_REFUSAL_KINDS) {
			const opts = makeOptions();
			await initializeRun(opts);

			await createEvent(opts.runId, {
				phase: "integration",
				event: "task_failed",
				status: "Task task-1 failed",
				taskId: "task-1",
				result: "integration_failed",
				errorKind: "integration_failed",
				diagnosticCode: kind,
				reason: "SECRET_CANARY_gate_message",
			});
			const current = await readRun(opts.runId);
			await updateRun(
				opts.runId,
				{
					lastFailure: {
						errorKind: "integration_failed",
						reasonCode: "integration_failed",
						reason: "The reviewed integration gate rejected the task result.",
						diagnosticCode: kind,
					},
				},
				current.revision,
			);

			const eventsPath = join(getRunRoot(opts.runId), "events.jsonl");
			const [event] = (await readFile(eventsPath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			strictEqual(event.diagnosticCode, kind, `${kind} lost in events.jsonl`);
			ok(!JSON.stringify(event).includes("SECRET_CANARY"));

			const run = await readRun(opts.runId);
			strictEqual(
				run.lastFailure.diagnosticCode,
				kind,
				`${kind} lost in run.json`,
			);
			ok(!JSON.stringify(run.lastFailure).includes("/"));
		}
	});
});

describe("corruption", () => {
	it("throws SchemaError when run.json contains invalid JSON", async () => {
		const runId = uniqueRunId();
		const runDir = getRunRoot(runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "run.json"), "not json {{{");

		await rejects(readRun(runId), SchemaError);
	});

	it("throws SchemaError when schemaVersion is wrong", async () => {
		const runId = uniqueRunId();
		const runDir = getRunRoot(runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "run.json"),
			JSON.stringify({
				schemaVersion: 99,
				runId,
				state: "created",
				cleanupState: "not_started",
				revision: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				orderedTaskIds: [],
				initialHostFingerprint: {},
				workerNonce: "",
				lastLeaseHeartbeat: new Date().toISOString(),
				lastEventSequence: 0,
			}),
		);

		await rejects(readRun(runId), SchemaError);
	});

	it("throws SchemaError when required fields are missing", async () => {
		const runId = uniqueRunId();
		const runDir = getRunRoot(runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "run.json"),
			JSON.stringify({ schemaVersion: 1 }),
		);

		await rejects(readRun(runId), SchemaError);
	});

	it("throws Error when run does not exist", async () => {
		await rejects(readRun("nonexistent-run-id"), /Run not found/);
	});
});

describe("permissions", () => {
	it("run.json and events.jsonl have mode 0600", {
		skip:
			process.platform === "win32"
				? "permissions not applicable on Windows"
				: false,
	}, async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await createEvent(opts.runId, {
			phase: "bootstrap",
			event: "task_started",
			status: "ok",
		});

		const runDir = getRunRoot(opts.runId);
		const runJsonStat = await stat(join(runDir, "run.json"));
		const eventsStat = await stat(join(runDir, "events.jsonl"));

		const runPerm = runJsonStat.mode & 0o777;
		const eventsPerm = eventsStat.mode & 0o777;

		strictEqual(runPerm, 0o600, "run.json should be 0600");
		strictEqual(eventsPerm, 0o600, "events.jsonl should be 0600");
	});
});

describe("retention", () => {
	async function createTerminalRun(idSuffix, overrides = {}) {
		const opts = makeOptions({
			runId: `retention-${idSuffix}-${uniqueRunId().slice(0, 8)}`,
		});
		await initializeRun(opts);

		let run = await advanceState(opts.runId, "succeeded");
		run = await updateRun(
			opts.runId,
			{ cleanupState: "complete", ...overrides },
			run.revision,
		);
		return run;
	}

	it("deletes eligible completed runs respecting maxRuns", async () => {
		const runs = [];
		for (let i = 0; i < 5; i++) {
			runs.push(await createTerminalRun(i));
		}

		const result = await applyRetention({ maxRuns: 2 });
		strictEqual(result.deletedCount, 3);

		for (let i = 0; i < 3; i++) {
			await rejects(readRun(runs[i].runId), /Run not found/);
		}
		for (let i = 3; i < 5; i++) {
			const r = await readRun(runs[i].runId);
			strictEqual(r.state, "succeeded");
		}
	});

	// Retention is no longer gated on run state. The old rule spared a
	// non-terminal or cleanup-failed run and reclaimed a succeeded one, which
	// had it exactly backwards: the succeeded run is the one nobody reads.
	// What protects a run now is having a diagnostic record — the two tests
	// below are the state-gate cases, rewritten to assert the replacement.
	it("removes a non-terminal run that never recorded an event", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const nonTerminal = await updateRun(
			opts.runId,
			{ state: "failed", cleanupState: "not_started" },
			1,
		);

		await createTerminalRun("ok");

		const result = await applyRetention({ maxRuns: 0 });
		strictEqual(result.deletedCount, 2);
		await rejects(readRun(nonTerminal.runId), /Run not found/);
	});

	it("removes a cleanup-failed run that never recorded an event", async () => {
		const run = await createTerminalRun("cf");
		await updateRun(run.runId, { cleanupState: "failed" }, run.revision);

		const result = await applyRetention({ maxRuns: 0 });
		strictEqual(result.deletedCount, 1);
		await rejects(readRun(run.runId), /Run not found/);
	});

	it("keeps run.json and events.jsonl at any age, for any run state", async () => {
		const states = [
			{ state: "created", cleanupState: "not_started" },
			{ state: "running", cleanupState: "not_started" },
			{ state: "failed", cleanupState: "failed" },
			{ state: "succeeded", cleanupState: "complete" },
		];
		const runIds = [];
		for (const [index, override] of states.entries()) {
			const opts = makeOptions({
				runId: `retention-keep-${index}-${uniqueRunId().slice(0, 8)}`,
			});
			await initializeRun(opts);
			// One event is the whole difference between a diagnostic record
			// and a directory that only attests it once existed.
			await createEvent(opts.runId, {
				phase: "execution",
				event: "task_failed",
				status: "Task 1.1 failed: provider_error",
				taskId: "1.1",
			});
			const current = await readRun(opts.runId);
			await updateRun(opts.runId, override, current.revision);
			runIds.push(opts.runId);
		}

		// maxRuns: 0 and a cutoff a day in the future together say "reclaim
		// everything you are allowed to reclaim".
		const result = await applyRetention({
			maxRuns: 0,
			maxAgeDays: 0,
			now: new Date(Date.now() + 86_400_000).toISOString(),
		});
		strictEqual(result.deletedCount, 0);

		for (const runId of runIds) {
			const run = await readRun(runId);
			ok(run.runId === runId, "run.json must survive");
			ok(
				existsSync(join(getRunRoot(runId), "events.jsonl")),
				"events.jsonl must survive",
			);
		}
	});

	it("removes a directory with no events.jsonl whatever its state", async () => {
		const states = [
			{ state: "created", cleanupState: "not_started" },
			{ state: "running", cleanupState: "not_started" },
			{ state: "failed", cleanupState: "failed" },
			{ state: "succeeded", cleanupState: "complete" },
		];
		const runIds = [];
		for (const [index, override] of states.entries()) {
			const opts = makeOptions({
				runId: `retention-noev-${index}-${uniqueRunId().slice(0, 8)}`,
			});
			await initializeRun(opts);
			await updateRun(opts.runId, override, 1);
			runIds.push(opts.runId);
		}

		const result = await applyRetention({ maxRuns: 0 });
		strictEqual(result.deletedCount, 4);
		for (const runId of runIds) {
			await rejects(readRun(runId), /Run not found/);
		}
	});

	it("collects artifacts from a failed run while its diagnostics survive", async () => {
		const opts = makeOptions({
			runId: `retention-collect-${uniqueRunId().slice(0, 8)}`,
		});
		await initializeRun(opts);
		await createEvent(opts.runId, {
			phase: "execution",
			event: "task_failed",
			status: "Task 1.1 failed: execution_timed_out",
			taskId: "1.1",
		});
		const current = await readRun(opts.runId);
		await updateRun(
			opts.runId,
			{ state: "failed", cleanupState: "complete" },
			current.revision,
		);
		const artifactsDir = join(getRunRoot(opts.runId), "artifacts");
		writeFileSync(join(artifactsDir, "1.1.diff"), "diff --git a/x b/x\n");

		// No age or count limit at all: collection is unconditional, because
		// an artifact is raw provider output at every age.
		const result = await applyRetention({});
		strictEqual(result.collectedCount, 1);
		strictEqual(result.deletedCount, 0);

		deepStrictEqual(readdirSync(artifactsDir), []);
		const run = await readRun(opts.runId);
		strictEqual(run.state, "failed");

		// The point of the rule is a readable post-mortem, so assert the
		// failure event survives intact rather than that the file exists:
		// a truncated or sanitized-to-nothing events.jsonl would still pass
		// an existence check while leaving the diagnostic worthless.
		const events = await readEvents(opts.runId);
		const failure = events.find((e) => e.event === "task_failed");
		ok(failure, `task_failed missing from events: ${JSON.stringify(events)}`);
		strictEqual(failure.taskId, "1.1");
		strictEqual(failure.status, "Task 1.1 failed: execution_timed_out");
		strictEqual(failure.phase, "execution");
	});

	it("does not touch a run still referenced by a live checkpoint", async () => {
		// uniquePath() is keyed on its label, so every makeOptions() run shares
		// one tasksFilePath. This test writes a checkpoint beside that path and
		// TEST_ROOT outlives afterEach, so it must use a path of its own and
		// remove it — otherwise it protects every later test's runs too.
		const tasksFilePath = join(TEST_ROOT, `ckpt-tasks-${uniqueRunId()}.md`);
		const checkpointPath = `${tasksFilePath}.checkpoint.json`;
		const opts = makeOptions({
			runId: `retention-ckpt-${uniqueRunId().slice(0, 8)}`,
			tasksFilePath,
		});
		await initializeRun(opts);
		const artifactsDir = join(getRunRoot(opts.runId), "artifacts");
		writeFileSync(join(artifactsDir, "1.1.diff"), "partial");
		writeFileSync(
			checkpointPath,
			JSON.stringify({ version: 1, tasksFilePath, completedTaskIds: [] }),
		);

		try {
			// This run has no events.jsonl, so rule 3 would remove it outright.
			const result = await applyRetention({ maxRuns: 0 });
			strictEqual(result.deletedCount, 0);
			strictEqual(
				result.collectedCount,
				0,
				"artifacts are not collected either",
			);
			const run = await readRun(opts.runId);
			strictEqual(run.runId, opts.runId);
			deepStrictEqual(readdirSync(artifactsDir), ["1.1.diff"]);
		} finally {
			rmSync(checkpointPath, { force: true });
		}
	});

	it("dryRun reports collection without removing anything", async () => {
		const opts = makeOptions({
			runId: `retention-drycollect-${uniqueRunId().slice(0, 8)}`,
		});
		await initializeRun(opts);
		await createEvent(opts.runId, {
			phase: "execution",
			event: "task_failed",
			status: "Task 1.1 failed: provider_error",
			taskId: "1.1",
		});
		const artifactsDir = join(getRunRoot(opts.runId), "artifacts");
		writeFileSync(join(artifactsDir, "1.1.diff"), "partial");

		const result = await applyRetention({ dryRun: true });
		strictEqual(result.collectedCount, 1);
		deepStrictEqual(readdirSync(artifactsDir), ["1.1.diff"]);
	});

	it("deletes runs older than maxAgeDays", async () => {
		await createTerminalRun("old");

		const result = await applyRetention({
			maxAgeDays: 0,
			now: new Date(Date.now() + 86_400_000).toISOString(),
		});
		strictEqual(result.deletedCount, 1);
	});

	it("dryRun reports maxAgeDays-eligible runs without deleting them", async () => {
		const run = await createTerminalRun("dry-age");

		const result = await applyRetention({
			maxAgeDays: 0,
			now: new Date(Date.now() + 86_400_000).toISOString(),
			dryRun: true,
		});
		// Same count as the non-dryRun call above, but nothing was removed.
		strictEqual(result.deletedCount, 1);

		const r = await readRun(run.runId);
		strictEqual(r.state, "succeeded");
	});

	it("dryRun reports maxRuns-eligible runs without deleting them", async () => {
		const runs = [];
		for (let i = 0; i < 3; i++) {
			runs.push(await createTerminalRun(`dry-runs-${i}`));
		}

		const result = await applyRetention({ maxRuns: 1, dryRun: true });
		strictEqual(result.deletedCount, 2);

		for (const run of runs) {
			const r = await readRun(run.runId);
			strictEqual(r.state, "succeeded");
		}
	});

	it("deletes nothing when no retention limits set", async () => {
		await createTerminalRun("keep");
		const result = await applyRetention({});
		strictEqual(result.deletedCount, 0);
	});

	it("returns 0 when runs directory does not exist", async () => {
		const result = await applyRetention({ maxRuns: 1 });
		strictEqual(result.deletedCount, 0);
	});

	function writeMalformedRun(runId, rawContent) {
		const runDir = join(getStateRoot(), "runs", runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "run.json"), rawContent, "utf8");
		return runDir;
	}

	it("quarantines a run with invalid JSON using a safe, static reason", async () => {
		const runId = `quarantine-badjson-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(runId, "not valid json at all {{{");

		const result = await applyRetention({});
		strictEqual(result.deletedCount, 0);
		strictEqual(result.quarantined.length, 1);
		strictEqual(result.quarantined[0].runId, runId);
		strictEqual(result.quarantined[0].reason, "run.json contains invalid JSON");
		ok(!result.quarantined[0].reason.includes("{{{"));

		strictEqual(existsSync(join(getStateRoot(), "runs", runId)), false);
		strictEqual(
			existsSync(join(getStateRoot(), ".quarantine", runId, "run.json")),
			true,
		);
		await rejects(readRun(runId), /Run not found/);
	});

	it("quarantines a run with an unsupported schemaVersion, surfacing SchemaError's static message", async () => {
		const runId = `quarantine-schema-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(runId, JSON.stringify({ schemaVersion: 99, runId }));

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 1);
		strictEqual(result.quarantined[0].runId, runId);
		strictEqual(
			result.quarantined[0].reason,
			"Unsupported schemaVersion (expected 1 or 2)",
		);
	});

	it("dryRun suppresses deletion of eligible runs but still quarantines malformed ones", async () => {
		const malformedRunId = `quarantine-dry-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(malformedRunId, "{ this is not json");
		const goodRun = await createTerminalRun("dry-keep");

		const result = await applyRetention({
			maxRuns: 0,
			maxAgeDays: 0,
			now: new Date(Date.now() + 86_400_000).toISOString(),
			dryRun: true,
		});
		// dryRun only suppresses the DELETION of eligible valid runs — the
		// protective quarantine move must still happen, or a malformed record
		// would fail this same scan forever under a dry-run-only dispatch.
		strictEqual(result.quarantined.length, 1);
		strictEqual(result.quarantined[0].runId, malformedRunId);
		strictEqual(
			existsSync(join(getStateRoot(), "runs", malformedRunId)),
			false,
			"the malformed run must leave the active scan even under dryRun",
		);
		strictEqual(
			existsSync(
				join(getStateRoot(), ".quarantine", malformedRunId, "run.json"),
			),
			true,
			"the malformed run must be moved into quarantine even under dryRun",
		);
		// ...while the eligible valid run is only reported, never deleted.
		strictEqual(result.deletedCount, 1);
		const r = await readRun(goodRun.runId);
		strictEqual(r.state, "succeeded");
	});

	it("quarantining a malformed run does not affect valid records in the same sweep", async () => {
		const badRunId = `quarantine-mixed-bad-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(badRunId, "garbage");
		const goodRun = await createTerminalRun("mixed-good");

		const result = await applyRetention({ maxRuns: 0 });
		strictEqual(result.deletedCount, 1);
		strictEqual(result.quarantined.length, 1);
		strictEqual(result.quarantined[0].runId, badRunId);

		await rejects(readRun(goodRun.runId), /Run not found/);
		await rejects(readRun(badRunId), /Run not found/);
		strictEqual(
			existsSync(join(getStateRoot(), ".quarantine", badRunId, "run.json")),
			true,
		);
	});

	it("does not quarantine a run directory whose run.json is absent (ENOENT)", async () => {
		const runId = `quarantine-nojson-${uniqueRunId().slice(0, 8)}`;
		const runDir = join(getStateRoot(), "runs", runId);
		mkdirSync(runDir, { recursive: true });
		// No run.json at all. This is the transient-missing signal a
		// concurrent initializeRun mid-flight produces (the window between
		// ensureDir and the atomic run.json write), which is indistinguishable
		// from a genuinely malformed record on this signal — so the
		// conservative choice is to leave the directory in place for a later
		// sweep rather than quarantine a legitimate run's directory.

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 0);
		strictEqual(
			existsSync(runDir),
			true,
			"a directory without run.json must be left in the active scan",
		);
		strictEqual(
			existsSync(join(getStateRoot(), ".quarantine", runId)),
			false,
			"a directory without run.json must not be quarantined",
		);
	});

	it("preserves a pre-existing quarantine artifact instead of overwriting it", async () => {
		const runId = `quarantine-collide-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(runId, "garbage");

		// Pre-seed `.quarantine/<runId>` with an existing artifact that must
		// survive the sweep untouched — the collision the move must never
		// overwrite or replace.
		const existingQuarantine = join(getStateRoot(), ".quarantine", runId);
		mkdirSync(existingQuarantine, { recursive: true });
		writeFileSync(
			join(existingQuarantine, "pre-existing.txt"),
			"keep me",
			"utf8",
		);

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 1);
		const entry = result.quarantined[0];
		strictEqual(entry.runId, runId);
		ok(
			entry.destination !== existingQuarantine,
			"a suffixed destination must be used on collision",
		);
		ok(
			entry.destination.startsWith(existingQuarantine),
			"the suffixed destination stays under .quarantine/<runId>",
		);
		strictEqual(
			existsSync(join(existingQuarantine, "pre-existing.txt")),
			true,
			"the pre-existing quarantine artifact must survive untouched",
		);
		strictEqual(
			existsSync(join(entry.destination, "run.json")),
			true,
			"the newly quarantined run must be preserved alongside the existing artifact",
		);
		strictEqual(
			existsSync(join(getStateRoot(), "runs", runId)),
			false,
			"the malformed run must leave the active scan",
		);
	});

	it("skips a run whose run.json is unreadable (EACCES) instead of quarantining it", {
		skip:
			process.platform === "win32" || process.getuid?.() === 0
				? "permissions not applicable on Windows or when running as root (uid 0 can still read mode-000 files)"
				: false,
	}, async () => {
		const runId = `quarantine-eacces-${uniqueRunId().slice(0, 8)}`;
		const runDir = join(getStateRoot(), "runs", runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "run.json"), "garbage {{{", "utf8");
		// chmod 000 makes readFile throw EACCES before JSON.parse can run, so
		// this read fails with a filesystem/IO error, NOT a SchemaError — the
		// non-SchemaError branch must skip, never quarantine. (The garbage
		// content is irrelevant; it is never reached.)
		chmodSync(join(runDir, "run.json"), 0o000);

		try {
			const result = await applyRetention({});
			strictEqual(result.quarantined.length, 0);
			strictEqual(
				existsSync(runDir),
				true,
				"an unreadable run.json is not a positive corruption signal; the directory must be left in the active scan",
			);
			strictEqual(
				existsSync(join(getStateRoot(), ".quarantine", runId)),
				false,
				"an unreadable run.json must not be quarantined",
			);
		} finally {
			// Restore permissions so the temp tree cleans up cleanly.
			chmodSync(join(runDir, "run.json"), 0o600);
		}
	});

	it("skips a run whose run.json is a directory (EISDIR) instead of quarantining it", async () => {
		const runId = `quarantine-eisdir-${uniqueRunId().slice(0, 8)}`;
		const runDir = join(getStateRoot(), "runs", runId);
		mkdirSync(runDir, { recursive: true });
		// readFile on a directory throws EISDIR — a non-SchemaError
		// filesystem/IO error that must be skipped conservatively, never
		// quarantined.
		mkdirSync(join(runDir, "run.json"));

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 0);
		strictEqual(
			existsSync(runDir),
			true,
			"a directory-shaped run.json must be left in the active scan, not quarantined",
		);
		strictEqual(
			existsSync(join(getStateRoot(), ".quarantine", runId)),
			false,
			"a directory-shaped run.json must not be quarantined",
		);
	});

	it("returns the raw on-disk destination and a separately sanitized destinationDisplay for bidi/zero-width names", async () => {
		const name = `quarantine-bidi-\u202e\u200b\u200e${uniqueRunId().slice(0, 8)}`;
		const runDir = join(getStateRoot(), "runs", name);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "run.json"), "garbage", "utf8");

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 1);
		const entry = result.quarantined[0];

		// The raw on-disk destination is preserved verbatim for machine use.
		const expectedDestination = join(getStateRoot(), ".quarantine", name);
		strictEqual(entry.destination, expectedDestination);
		strictEqual(existsSync(entry.destination), true);

		// The display variant is sanitized: no control, format, or separator
		// characters may survive.
		ok(
			!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(entry.destinationDisplay),
			"destinationDisplay must never carry control, format, or separator characters",
		);
		ok(
			!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(entry.runId),
			"runId metadata must never carry control, format, or separator characters",
		);
		ok(
			entry.destinationDisplay !== entry.destination,
			"destinationDisplay must differ from the raw destination when the name needs sanitization",
		);
		strictEqual(
			existsSync(runDir),
			false,
			"the bidi/zero-width-named run must still leave the active scan",
		);
	});

	it("returns destinationDisplay identical to the raw destination when no sanitization is needed", async () => {
		const runId = `quarantine-plain-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(runId, "garbage");

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 1);
		const entry = result.quarantined[0];
		strictEqual(entry.destination, join(getStateRoot(), ".quarantine", runId));
		strictEqual(entry.destinationDisplay, entry.destination);
	});

	it("sanitizes control and format characters in directory names from quarantine metadata", async () => {
		const runId = `quarantine-ctrl-${uniqueRunId().slice(0, 8)}\nINJECT`;
		writeMalformedRun(runId, "garbage");

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 1);
		const entry = result.quarantined[0];
		ok(
			!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(entry.runId),
			"returned runId metadata must never carry control or format characters",
		);
		ok(
			!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(entry.destinationDisplay),
			"returned destinationDisplay metadata must never carry control or format characters",
		);
		// The raw destination is the verbatim on-disk path, control
		// characters and all, so machine callers can still act on it.
		strictEqual(entry.destination, join(getStateRoot(), ".quarantine", runId));
		strictEqual(existsSync(entry.destination), true);
		// The raw directory was still moved out of the active scan, control
		// characters and all.
		strictEqual(existsSync(join(getStateRoot(), "runs", runId)), false);
	});

	it("a repeated sweep is idempotent: nothing left to quarantine or delete", async () => {
		const badRunId = `quarantine-repeat-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(badRunId, "garbage");
		await createTerminalRun("repeat-good");

		const first = await applyRetention({ maxRuns: 0 });
		strictEqual(first.quarantined.length, 1);
		strictEqual(first.deletedCount, 1);

		const second = await applyRetention({ maxRuns: 0 });
		strictEqual(
			second.quarantined.length,
			0,
			"already-quarantined runs are not re-reported on a repeated sweep",
		);
		strictEqual(
			second.deletedCount,
			0,
			"already-deleted runs are not re-reported on a repeated sweep",
		);
	});

	it("classifies each malformed category with a static, sanitized reason", async () => {
		const cases = [
			{
				name: `q-invalid-json-${uniqueRunId().slice(0, 8)}`,
				content: "not json {{",
				reason: "run.json contains invalid JSON",
			},
			{
				name: `q-non-object-${uniqueRunId().slice(0, 8)}`,
				content: "null",
				reason: "run.json is not a valid object",
			},
			{
				name: `q-bad-schema-${uniqueRunId().slice(0, 8)}`,
				content: JSON.stringify({ schemaVersion: 99 }),
				reason: "Unsupported schemaVersion (expected 1 or 2)",
			},
			{
				name: `q-missing-field-${uniqueRunId().slice(0, 8)}`,
				content: JSON.stringify({ schemaVersion: 1 }),
				reason: "runId must be a string",
			},
			{
				name: `dir name with spaces-${uniqueRunId().slice(0, 8)}`,
				content: "ignored",
				reason: "Invalid runId",
			},
		];
		for (const c of cases) writeMalformedRun(c.name, c.content);

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, cases.length);
		const byId = new Map(result.quarantined.map((e) => [e.runId, e]));
		for (const c of cases) {
			ok(byId.has(c.name), `expected ${c.name} to be quarantined`);
			strictEqual(byId.get(c.name).reason, c.reason);
			ok(
				!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(byId.get(c.name).reason),
				"a quarantined reason must never carry control or format characters",
			);
		}
	});
});

describe("launch lock", () => {
	it("two acquires on different paths succeed for different runIds", async () => {
		const path1 = uniquePath("tasks-a");
		const path2 = uniquePath("tasks-b");
		const runId1 = uniqueRunId();
		const runId2 = uniqueRunId();

		await acquireLaunchLock(path1, runId1);
		await acquireLaunchLock(path2, runId2);

		ok(true);
	});

	it("two acquires on the same path fails", async () => {
		const path = uniquePath("tasks");
		const runId1 = uniqueRunId();
		const runId2 = uniqueRunId();

		await acquireLaunchLock(path, runId1);
		await rejects(acquireLaunchLock(path, runId2), LockError);
	});

	it("release then re-acquire with a different runId succeeds", async () => {
		const path = uniquePath("tasks");
		const runId1 = uniqueRunId();

		await acquireLaunchLock(path, runId1);
		await releaseLaunchLock(path);
		await acquireLaunchLock(path, uniqueRunId());
		ok(true);
	});

	it("release on non-existent lock does not throw", async () => {
		await releaseLaunchLock(uniquePath("nonexistent"));
		ok(true);
	});
});

describe("project lock", () => {
	it("two acquires on different project paths succeed", async () => {
		const path1 = uniquePath("proj-a");
		const path2 = uniquePath("proj-b");
		const runId1 = uniqueRunId();
		const runId2 = uniqueRunId();

		await acquireProjectLock(path1, runId1);
		await acquireProjectLock(path2, runId2);

		ok(true);
	});

	it("two acquires on the same project path fails", async () => {
		const path = uniquePath("project");
		const runId1 = uniqueRunId();
		const runId2 = uniqueRunId();

		await acquireProjectLock(path, runId1);
		await rejects(acquireProjectLock(path, runId2), LockError);
	});

	it("uses one canonical identity across child-process working directories", async () => {
		const projectPath = uniquePath("cross-cwd-project");
		const cwdA = uniquePath("cross-cwd-a");
		const cwdB = uniquePath("cross-cwd-b");
		mkdirSync(cwdA, { recursive: true });
		mkdirSync(cwdB, { recursive: true });
		const firstRunId = uniqueRunId();
		const secondRunId = uniqueRunId();
		const childSource = (runId) => `
			import { acquireProjectLock } from ${JSON.stringify(RUN_STORE_MODULE_URL)};
			try {
				await acquireProjectLock(${JSON.stringify(projectPath)}, ${JSON.stringify(runId)});
				console.log("acquired");
			} catch (error) {
				console.log(error.code ?? "unknown");
				process.exitCode = 1;
			}`;
		const invoke = (cwd, runId) =>
			new Promise((resolveChild, reject) => {
				const child = spawn(
					process.execPath,
					["--input-type=module", "-e", childSource(runId)],
					{
						cwd,
						env: {
							...process.env,
							SWITCHYARD_RUN_STORE_ROOT: getStateRoot(),
						},
					},
				);
				let output = "";
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (chunk) => {
					output += chunk;
				});
				child.once("error", reject);
				child.once("exit", (code) => resolveChild({ code, output }));
			});

		const first = await invoke(cwdA, firstRunId);
		const second = await invoke(cwdB, secondRunId);
		strictEqual(first.code, 0);
		strictEqual(first.output.trim(), "acquired");
		strictEqual(second.code, 1);
		strictEqual(second.output.trim(), "PROJECT_LOCK_HELD");
		await releaseProjectLock(projectPath, firstRunId);
	});

	it("isProjectLockHeld reflects lock state", async () => {
		const path = uniquePath("project");
		const runId = uniqueRunId();
		strictEqual(isProjectLockHeld(path), false);

		await acquireProjectLock(path, runId);
		strictEqual(isProjectLockHeld(path), true);

		await releaseProjectLock(path, runId);
		strictEqual(isProjectLockHeld(path), false);
	});

	it("release then re-acquire with a different runId succeeds", async () => {
		const path = uniquePath("project");
		const runId = uniqueRunId();
		await acquireProjectLock(path, runId);
		await releaseProjectLock(path, runId);
		await acquireProjectLock(path, uniqueRunId());
		ok(true);
	});

	it("release on non-existent lock does not throw", async () => {
		await releaseProjectLock(uniquePath("nonexistent"), uniqueRunId());
		ok(true);
	});

	it("lock body includes projectPath alongside runId and createdAt", async () => {
		const path = uniquePath("project");
		const runId = uniqueRunId();

		await acquireProjectLock(path, runId);

		const raw = await readFile(projectLockFilePath(path), "utf8");
		const body = JSON.parse(raw);
		strictEqual(body.projectPath, path);
		strictEqual(body.runId, runId);
		ok(typeof body.createdAt === "string");
	});

	it("checks project-lock ownership instead of path-wide lock presence", async () => {
		const path = uniquePath("project-owner");
		const ownerRunId = uniqueRunId();
		const staleRunId = uniqueRunId();

		await acquireProjectLock(path, ownerRunId);

		strictEqual(await isProjectLockOwnedBy(path, ownerRunId), true);
		strictEqual(await isProjectLockOwnedBy(path, staleRunId), false);
		strictEqual(isProjectLockHeld(path), true);
	});

	it("keeps legacy project-lock ownership and release compatible", async () => {
		const path = uniquePath("legacy-project-owner");
		const runId = uniqueRunId();
		await acquireProjectLock(path, runId);
		writeFileSync(
			projectLockFilePath(path),
			JSON.stringify({ runId, createdAt: new Date().toISOString() }),
			"utf8",
		);

		strictEqual(await isProjectLockOwnedBy(path, runId), true);
		strictEqual(await releaseProjectLockIfOwnedBy(path, runId), true);
		strictEqual(isProjectLockHeld(path), false);
	});

	it("matches an equivalent trailing-slash project path in a stored lock body", async () => {
		const path = uniquePath("equivalent-project-path");
		const runId = uniqueRunId();
		await acquireProjectLock(path, runId);
		const lockPath = projectLockFilePath(path);
		writeFileSync(
			lockPath,
			JSON.stringify({
				runId,
				projectPath: `${path}/`,
				createdAt: new Date().toISOString(),
			}),
		);

		strictEqual(await isProjectLockOwnedBy(path, runId), true);
		strictEqual(await releaseProjectLockIfOwnedBy(path, runId), true);
	});

	it("blocks and releases a body-validated historical filename", async () => {
		const projectPath = uniquePath("historical-project");
		const ownerRunId = uniqueRunId();
		const historicalPath = join(
			getStateRoot(),
			"locks",
			`${createHash("sha256").update(uniqueRunId()).digest("hex")}.lock`,
		);
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(
			historicalPath,
			JSON.stringify({
				runId: ownerRunId,
				projectPath,
				createdAt: new Date().toISOString(),
			}),
		);

		await rejects(
			acquireProjectLock(projectPath, uniqueRunId()),
			(error) =>
				error instanceof LockError &&
				error.code === "PROJECT_LOCK_RECOVERY_IN_PROGRESS",
		);
		strictEqual(
			await releaseProjectLockIfOwnedBy(projectPath, ownerRunId),
			true,
		);
		strictEqual(existsSync(historicalPath), false);
	});

	it("fails closed when the canonical recovery claim is malformed", async () => {
		const projectPath = uniquePath("malformed-canonical-claim");
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(projectLockClaimFilePath(projectPath), "not-json", "utf8");

		await rejects(
			acquireProjectLock(projectPath, uniqueRunId()),
			(error) =>
				error instanceof LockError &&
				error.code === "PROJECT_LOCK_RECOVERY_IN_PROGRESS",
		);
		strictEqual(existsSync(projectLockFilePath(projectPath)), false);
		strictEqual(existsSync(projectLockClaimFilePath(projectPath)), true);
	});

	it("blocks pre-projectPath cwd-derived locks and claims", async () => {
		const projectPath = uniquePath("pre-project-path-historical");
		const ownerRunId = uniqueRunId();
		const historicalLockPath = cwdDerivedProjectLockFilePath(projectPath);
		const ownerRaw = JSON.stringify({
			runId: ownerRunId,
			createdAt: new Date().toISOString(),
		});
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(historicalLockPath, ownerRaw);
		strictEqual(isProjectLockHeld(projectPath), true);

		await rejects(
			acquireProjectLock(projectPath, uniqueRunId()),
			(error) =>
				error instanceof LockError &&
				error.code === "PROJECT_LOCK_RECOVERY_IN_PROGRESS",
		);
		strictEqual(await releaseProjectLock(projectPath, ownerRunId), true);
		strictEqual(isProjectLockHeld(projectPath), false);

		writeFileSync(`${historicalLockPath}.recovery-claim`, ownerRaw);
		strictEqual(isProjectLockHeld(projectPath), true);
		await rejects(
			acquireProjectLock(projectPath, uniqueRunId()),
			(error) =>
				error instanceof LockError &&
				error.code === "PROJECT_LOCK_RECOVERY_IN_PROGRESS",
		);
		strictEqual(await releaseProjectLock(projectPath, ownerRunId), true);
		strictEqual(isProjectLockHeld(projectPath), false);
	});

	it("never deletes a replacement published after an atomic body take", async () => {
		const opts = makeOptions({ projectPath: uniquePath("atomic-take") });
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		const current = await readRun(opts.runId);
		await updateRun(opts.runId, { cleanupState: "complete" }, current.revision);
		const lockPath = join(
			getStateRoot(),
			"locks",
			`${createHash("sha256").update(uniqueRunId()).digest("hex")}.lock`,
		);
		const expectedRaw = JSON.stringify({
			runId: opts.runId,
			projectPath: opts.projectPath,
			createdAt: new Date().toISOString(),
		});
		const replacementRaw = JSON.stringify({ runId: uniqueRunId() });
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(lockPath, expectedRaw);

		strictEqual(
			await runStoreTesting.unlinkBodyMatched(lockPath, expectedRaw, {
				afterRename: async (proofPath) => {
					deepStrictEqual(await reconcileProjectLockClaims(), []);
					strictEqual(existsSync(proofPath), true);
					writeFileSync(lockPath, replacementRaw);
				},
			}),
			true,
		);
		strictEqual(readFileSync(lockPath, "utf8"), replacementRaw);
	});

	it("blocks and reconciles a crashed pre-projectPath claim proof", async () => {
		const opts = makeOptions({ projectPath: uniquePath("legacy-proof") });
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		const current = await readRun(opts.runId);
		await updateRun(opts.runId, { cleanupState: "complete" }, current.revision);
		const historicalClaimPath = `${cwdDerivedProjectLockFilePath(opts.projectPath)}.recovery-claim`;
		const ownerRaw = JSON.stringify({
			runId: opts.runId,
			createdAt: new Date().toISOString(),
		});
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(historicalClaimPath, ownerRaw);
		let liveProofPath;

		await rejects(
			runStoreTesting.unlinkBodyMatched(historicalClaimPath, ownerRaw, {
				afterRename: async (proofPath) => {
					liveProofPath = proofPath;
					throw new Error("simulated crash");
				},
			}),
			/simulated crash/,
		);
		strictEqual(isProjectLockHeld(opts.projectPath), true);
		await rejects(
			acquireProjectLock(opts.projectPath, uniqueRunId()),
			(error) =>
				error instanceof LockError &&
				error.code === "PROJECT_LOCK_RECOVERY_IN_PROGRESS",
		);

		const deadProofPath = `${historicalClaimPath}.99999999.${randomUUID()}.lock.recovery-claim`;
		renameSync(liveProofPath, deadProofPath);
		let repeatedProofPath;
		await rejects(
			runStoreTesting.unlinkBodyMatched(deadProofPath, ownerRaw, {
				afterRename: async (proofPath) => {
					repeatedProofPath = proofPath;
					throw new Error("simulated reconciliation crash");
				},
			}),
			/simulated reconciliation crash/,
		);
		strictEqual(isProjectLockHeld(opts.projectPath), true);
		const retryableDeadProofPath = `${historicalClaimPath}.99999998.${randomUUID()}.lock.recovery-claim`;
		renameSync(repeatedProofPath, retryableDeadProofPath);
		deepStrictEqual(await reconcileProjectLockClaims(), [opts.runId]);
		strictEqual(existsSync(retryableDeadProofPath), false);
		strictEqual(isProjectLockHeld(opts.projectPath), false);
	});

	it("uses the injected PID probe to retain a live recovery proof", async () => {
		const opts = makeOptions({
			projectPath: uniquePath("injected-live-proof"),
		});
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		await updateRun(
			opts.runId,
			{ cleanupState: "complete" },
			(await readRun(opts.runId)).revision,
		);
		const claimPath = projectLockClaimFilePath(opts.projectPath);
		const proofOwnerPid = 99999999;
		const proofPath = `${claimPath}.${proofOwnerPid}.${randomUUID()}.lock.recovery-claim`;
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(
			proofPath,
			JSON.stringify({
				runId: opts.runId,
				projectPath: opts.projectPath,
				createdAt: new Date().toISOString(),
			}),
		);

		deepStrictEqual(
			await reconcileProjectLockClaims({
				probePid: (pid) => (pid === proofOwnerPid ? "live" : "dead"),
			}),
			[],
		);
		strictEqual(existsSync(proofPath), true);
	});
});

describe("project lock recovery claims", () => {
	it("allows at most one concurrent recoverer to release a terminal-clean owner", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		const current = await readRun(opts.runId);
		await updateRun(opts.runId, { cleanupState: "complete" }, current.revision);
		await acquireProjectLock(opts.projectPath, opts.runId);

		const outcomes = await Promise.all([
			releaseProjectLockIfOwnedBy(opts.projectPath, opts.runId),
			releaseProjectLockIfOwnedBy(opts.projectPath, opts.runId),
		]);
		strictEqual(outcomes.filter(Boolean).length, 1);
		strictEqual(isProjectLockHeld(opts.projectPath), false);
	});

	it("keeps live/startup/unknown claims and removes terminal/dead claims once", async () => {
		const live = makeOptions({ projectPath: uniquePath("claim-live") });
		await initializeRun(live);
		let current = await readRun(live.runId);
		await updateRun(
			live.runId,
			{ state: "running", workerPid: process.pid },
			current.revision,
		);
		await acquireProjectLock(live.projectPath, live.runId);
		renameSync(
			projectLockFilePath(live.projectPath),
			projectLockClaimFilePath(live.projectPath),
		);
		strictEqual(await isProjectLockOwnedBy(live.projectPath, live.runId), true);

		const startup = makeOptions({ projectPath: uniquePath("claim-startup") });
		await initializeRun(startup);
		await acquireProjectLock(startup.projectPath, startup.runId);
		renameSync(
			projectLockFilePath(startup.projectPath),
			projectLockClaimFilePath(startup.projectPath),
		);

		const terminal = makeOptions({ projectPath: uniquePath("claim-terminal") });
		await initializeRun(terminal);
		await advanceState(terminal.runId, "failed");
		current = await readRun(terminal.runId);
		await updateRun(
			terminal.runId,
			{ cleanupState: "complete" },
			current.revision,
		);
		await acquireProjectLock(terminal.projectPath, terminal.runId);
		renameSync(
			projectLockFilePath(terminal.projectPath),
			projectLockClaimFilePath(terminal.projectPath),
		);

		const dead = makeOptions({ projectPath: uniquePath("claim-dead") });
		await initializeRun(dead);
		current = await readRun(dead.runId);
		await updateRun(
			dead.runId,
			{ state: "running", workerPid: 999999 },
			current.revision,
		);
		await acquireProjectLock(dead.projectPath, dead.runId);
		renameSync(
			projectLockFilePath(dead.projectPath),
			projectLockClaimFilePath(dead.projectPath),
		);

		const missingPath = uniquePath("claim-missing");
		await acquireProjectLock(missingPath, uniqueRunId());
		renameSync(
			projectLockFilePath(missingPath),
			projectLockClaimFilePath(missingPath),
		);
		const malformedPath = uniquePath("claim-malformed");
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(projectLockClaimFilePath(malformedPath), "not-json");

		const reclaimed = await reconcileProjectLockClaims();
		deepStrictEqual(new Set(reclaimed), new Set([terminal.runId, dead.runId]));
		strictEqual(existsSync(projectLockClaimFilePath(live.projectPath)), true);
		strictEqual(
			existsSync(projectLockClaimFilePath(startup.projectPath)),
			true,
		);
		strictEqual(existsSync(projectLockClaimFilePath(missingPath)), true);
		strictEqual(existsSync(projectLockClaimFilePath(malformedPath)), true);
		strictEqual(
			await reconcileProjectLockClaims().then((ids) => ids.length),
			0,
		);
	});

	it("reconciles only a byte-bound reservation for a terminal owner", async () => {
		const opts = makeOptions({
			projectPath: uniquePath("reservation-terminal"),
		});
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		const current = await readRun(opts.runId);
		await updateRun(opts.runId, { cleanupState: "complete" }, current.revision);
		await acquireProjectLock(opts.projectPath, opts.runId);
		const expectedRaw = readFileSync(
			projectLockFilePath(opts.projectPath),
			"utf8",
		);
		writeFileSync(
			projectLockClaimFilePath(opts.projectPath),
			JSON.stringify({ claimState: "reservation", expectedRaw }),
			{ flag: "wx", mode: 0o600 },
		);

		deepStrictEqual(await reconcileProjectLockClaims(), [opts.runId]);
		strictEqual(existsSync(projectLockClaimFilePath(opts.projectPath)), false);
		strictEqual(
			readFileSync(projectLockFilePath(opts.projectPath), "utf8"),
			expectedRaw,
		);
	});

	it("reconciles a dead reservation proof after its lock bytes changed", async () => {
		const opts = makeOptions({ projectPath: uniquePath("reservation-proof") });
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		const current = await readRun(opts.runId);
		await updateRun(opts.runId, { cleanupState: "complete" }, current.revision);
		const expectedRaw = JSON.stringify({
			runId: opts.runId,
			projectPath: opts.projectPath,
			createdAt: new Date().toISOString(),
		});
		const replacementRaw = JSON.stringify({
			runId: uniqueRunId(),
			projectPath: opts.projectPath,
			createdAt: new Date().toISOString(),
		});
		const lockPath = projectLockFilePath(opts.projectPath);
		const proofPath = `${projectLockClaimFilePath(opts.projectPath)}.99999999.${randomUUID()}.lock.recovery-claim`;
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(lockPath, replacementRaw);
		writeFileSync(
			proofPath,
			JSON.stringify({ claimState: "reservation", expectedRaw }),
		);

		deepStrictEqual(await reconcileProjectLockClaims(), [opts.runId]);
		strictEqual(existsSync(proofPath), false);
		strictEqual(readFileSync(lockPath, "utf8"), replacementRaw);
	});

	it("reconciles historical reservation and post-rename interruption claims", async () => {
		const opts = makeOptions({ projectPath: uniquePath("historical-claim") });
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		await updateRun(
			opts.runId,
			{ cleanupState: "complete" },
			(await readRun(opts.runId)).revision,
		);
		const historicalLockPath = join(
			getStateRoot(),
			"locks",
			`${createHash("sha256").update(uniqueRunId()).digest("hex")}.lock`,
		);
		const ownerRaw = JSON.stringify({
			runId: opts.runId,
			projectPath: opts.projectPath,
			createdAt: new Date().toISOString(),
		});
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(historicalLockPath, ownerRaw);
		writeFileSync(
			`${historicalLockPath}.recovery-claim`,
			JSON.stringify({ claimState: "reservation", expectedRaw: ownerRaw }),
		);

		deepStrictEqual(await reconcileProjectLockClaims(), [opts.runId]);
		strictEqual(existsSync(`${historicalLockPath}.recovery-claim`), false);
		strictEqual(readFileSync(historicalLockPath, "utf8"), ownerRaw);

		renameSync(historicalLockPath, `${historicalLockPath}.recovery-claim`);
		deepStrictEqual(await reconcileProjectLockClaims(), [opts.runId]);
		strictEqual(existsSync(`${historicalLockPath}.recovery-claim`), false);
	});

	it("retains a claim whose project path disagrees with its run record", async () => {
		const opts = makeOptions({
			projectPath: uniquePath("claim-owner-project"),
		});
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		await updateRun(
			opts.runId,
			{ cleanupState: "complete" },
			(await readRun(opts.runId)).revision,
		);
		const mismatchedProjectPath = uniquePath("claim-mismatched-project");
		const historicalClaimPath = join(
			getStateRoot(),
			"locks",
			`${createHash("sha256").update(uniqueRunId()).digest("hex")}.lock.recovery-claim`,
		);
		const claimRaw = JSON.stringify({
			runId: opts.runId,
			projectPath: mismatchedProjectPath,
			createdAt: new Date().toISOString(),
		});
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(historicalClaimPath, claimRaw);

		deepStrictEqual(await reconcileProjectLockClaims(), []);
		strictEqual(readFileSync(historicalClaimPath, "utf8"), claimRaw);
	});

	it("retains reservations when canonical bytes change or owner is live", async () => {
		const changed = makeOptions({
			projectPath: uniquePath("reservation-changed"),
		});
		await initializeRun(changed);
		await advanceState(changed.runId, "failed");
		await acquireProjectLock(changed.projectPath, changed.runId);
		const expectedRaw = readFileSync(
			projectLockFilePath(changed.projectPath),
			"utf8",
		);
		writeFileSync(
			projectLockClaimFilePath(changed.projectPath),
			JSON.stringify({ claimState: "reservation", expectedRaw }),
		);
		writeFileSync(
			projectLockFilePath(changed.projectPath),
			JSON.stringify({
				runId: uniqueRunId(),
				projectPath: changed.projectPath,
				createdAt: new Date().toISOString(),
				holderPid: process.pid,
			}),
		);

		const live = makeOptions({ projectPath: uniquePath("reservation-live") });
		await initializeRun(live);
		await updateRun(
			live.runId,
			{ state: "running", workerPid: process.pid },
			(await readRun(live.runId)).revision,
		);
		await acquireProjectLock(live.projectPath, live.runId);
		const liveRaw = readFileSync(projectLockFilePath(live.projectPath), "utf8");
		writeFileSync(
			projectLockClaimFilePath(live.projectPath),
			JSON.stringify({ claimState: "reservation", expectedRaw: liveRaw }),
		);

		deepStrictEqual(await reconcileProjectLockClaims(), []);
		strictEqual(
			existsSync(projectLockClaimFilePath(changed.projectPath)),
			true,
		);
		strictEqual(existsSync(projectLockClaimFilePath(live.projectPath)), true);
	});

	it("rejects a displaced holder and removes only its body-matched claim", async () => {
		const owner = makeOptions({ projectPath: uniquePath("three-party") });
		await initializeRun(owner);
		await acquireProjectLock(owner.projectPath, owner.runId);
		renameSync(
			projectLockFilePath(owner.projectPath),
			projectLockClaimFilePath(owner.projectPath),
		);
		const replacementRunId = uniqueRunId();
		writeFileSync(
			projectLockFilePath(owner.projectPath),
			JSON.stringify({
				runId: replacementRunId,
				projectPath: owner.projectPath,
				createdAt: new Date().toISOString(),
				holderPid: process.pid,
			}),
			{ flag: "wx", mode: 0o600 },
		);

		await rejects(
			assertProjectLockOwnership(owner.projectPath, owner.runId),
			(error) =>
				error instanceof LockError &&
				error.code === "PROJECT_LOCK_OWNERSHIP_DISPLACED",
		);
		strictEqual(existsSync(projectLockClaimFilePath(owner.projectPath)), false);
		const canonical = JSON.parse(
			readFileSync(projectLockFilePath(owner.projectPath), "utf8"),
		);
		strictEqual(canonical.runId, replacementRunId);
	});

	it("reconciles failed displaced cleanup through both scanners without touching the replacement", async () => {
		const scanners = [
			["claim reconciler", reconcileProjectLockClaims],
			["orphan-lock scanner", releaseOrphanedProjectLocks],
		];

		for (const [scannerName, scan] of scanners) {
			const projectPath = uniquePath(`claim-cleanup-fail-${scannerName}`);
			const owner = makeOptions({ projectPath });
			await initializeRun(owner);
			await acquireProjectLock(projectPath, owner.runId);
			renameSync(
				projectLockFilePath(projectPath),
				projectLockClaimFilePath(projectPath),
			);

			const replacement = makeOptions({ projectPath });
			await initializeRun(replacement);
			let replacementRun = await readRun(replacement.runId);
			await updateRun(
				replacement.runId,
				{ state: "running", workerPid: process.pid },
				replacementRun.revision,
			);
			const replacementRaw = JSON.stringify({
				runId: replacement.runId,
				projectPath,
				createdAt: new Date().toISOString(),
				holderPid: process.pid,
			});
			writeFileSync(projectLockFilePath(projectPath), replacementRaw, {
				flag: "wx",
				mode: 0o600,
			});

			await rejects(
				assertProjectLockOwnership(projectPath, owner.runId, {
					unlinkBodyMatched: async () => false,
				}),
				(error) =>
					error instanceof LockError &&
					error.code === "PROJECT_LOCK_CLAIM_CLEANUP_FAILED",
			);
			const failed = await readRun(owner.runId);
			strictEqual(failed.state, "recovery_required", scannerName);
			strictEqual(failed.cleanupState, "failed", scannerName);
			strictEqual(
				existsSync(projectLockClaimFilePath(projectPath)),
				true,
				scannerName,
			);

			const reclaimed = await scan();
			deepStrictEqual(reclaimed, [owner.runId], scannerName);
			strictEqual(
				existsSync(projectLockClaimFilePath(projectPath)),
				false,
				scannerName,
			);
			strictEqual(
				readFileSync(projectLockFilePath(projectPath), "utf8"),
				replacementRaw,
				scannerName,
			);

			replacementRun = await readRun(replacement.runId);
			await updateRun(
				replacement.runId,
				{ workerPid: 999999 },
				replacementRun.revision,
			);
			const laterReclaimed = await releaseOrphanedProjectLocks();
			deepStrictEqual(laterReclaimed, [replacement.runId], scannerName);
			strictEqual(isProjectLockHeld(projectPath), false, scannerName);
		}
	});

	it("retains cleanup-failed claims without a different valid canonical owner", async () => {
		const cases = ["absent", "malformed", "same-owner"];
		const owners = [];

		for (const scenario of cases) {
			const owner = makeOptions({
				projectPath: uniquePath(`claim-cleanup-${scenario}`),
			});
			await initializeRun(owner);
			await acquireProjectLock(owner.projectPath, owner.runId);
			const canonicalRaw = readFileSync(
				projectLockFilePath(owner.projectPath),
				"utf8",
			);
			renameSync(
				projectLockFilePath(owner.projectPath),
				projectLockClaimFilePath(owner.projectPath),
			);
			const current = await readRun(owner.runId);
			await updateRun(
				owner.runId,
				{ state: "recovery_required", cleanupState: "failed" },
				current.revision,
			);
			if (scenario === "malformed") {
				writeFileSync(projectLockFilePath(owner.projectPath), "not-json");
			} else if (scenario === "same-owner") {
				writeFileSync(projectLockFilePath(owner.projectPath), canonicalRaw);
			}
			owners.push(owner);
		}

		deepStrictEqual(await reconcileProjectLockClaims(), []);
		deepStrictEqual(await releaseOrphanedProjectLocks(), []);
		for (const owner of owners) {
			strictEqual(
				existsSync(projectLockClaimFilePath(owner.projectPath)),
				true,
				owner.projectPath,
			);
		}
	});

	it("retains cleanup-failed reservations during automatic reconciliation", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await advanceState(opts.runId, "running");
		await updateRun(
			opts.runId,
			{ state: "recovery_required", cleanupState: "failed" },
			(await readRun(opts.runId)).revision,
		);
		await acquireProjectLock(opts.projectPath, opts.runId);
		const lockPath = projectLockFilePath(opts.projectPath);
		const claimPath = projectLockClaimFilePath(opts.projectPath);
		writeFileSync(
			claimPath,
			JSON.stringify({
				claimState: "reservation",
				expectedRaw: readFileSync(lockPath, "utf8"),
			}),
		);

		deepStrictEqual(await reconcileProjectLockClaims(), []);
		strictEqual(existsSync(lockPath), true);
		strictEqual(existsSync(claimPath), true);
	});

	it("reconciles an unadorned pre-F.1 claim through exact run/path evidence", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		await updateRun(
			opts.runId,
			{ cleanupState: "complete" },
			(await readRun(opts.runId)).revision,
		);
		await acquireProjectLock(opts.projectPath, opts.runId);
		const lockPath = projectLockFilePath(opts.projectPath);
		const claimPath = projectLockClaimFilePath(opts.projectPath);
		writeFileSync(
			lockPath,
			JSON.stringify({
				runId: opts.runId,
				createdAt: new Date().toISOString(),
			}),
		);
		renameSync(lockPath, claimPath);

		deepStrictEqual(await reconcileProjectLockClaims(), [opts.runId]);
		strictEqual(existsSync(claimPath), false);
	});

	it("uses closed codes for blocked and missing project ownership", async () => {
		const missing = makeOptions({
			projectPath: uniquePath("ownership-missing"),
		});
		await rejects(
			assertProjectLockOwnership(missing.projectPath, missing.runId),
			(error) =>
				error instanceof LockError &&
				error.code === "PROJECT_LOCK_OWNERSHIP_FAILED",
		);

		const owner = makeOptions({ projectPath: uniquePath("claim-blocked") });
		await initializeRun(owner);
		await acquireProjectLock(owner.projectPath, owner.runId);
		renameSync(
			projectLockFilePath(owner.projectPath),
			projectLockClaimFilePath(owner.projectPath),
		);
		await rejects(
			assertProjectLockOwnership(owner.projectPath, uniqueRunId()),
			(error) =>
				error instanceof LockError &&
				error.code === "PROJECT_LOCK_RECOVERY_CLAIM_BLOCKS_EXECUTION",
		);
	});
});

describe("global VM admission slots", () => {
	it("uses a dedicated override root outside the project run store", () => {
		strictEqual(getVmAdmissionRoot(), VM_ADMISSION_ROOT);
		notStrictEqual(getVmAdmissionRoot(), getStateRoot());
	});

	it("publishes a complete parseable owner and releases by matching token only", () => {
		const lease = acquireVmSlot({ runId: "token-owner" });
		const slotPath = join(VM_ADMISSION_ROOT, `vm-slot-${lease.slot}.lock`);
		const body = JSON.parse(readFileSync(slotPath, "utf8"));

		strictEqual(body.ownerPid, process.pid);
		strictEqual(body.runId, "token-owner");
		strictEqual(body.token, lease.token);
		strictEqual(releaseVmSlot({ ...lease, token: "wrong-token" }), false);
		ok(existsSync(slotPath));
		strictEqual(releaseVmSlot(lease), true);
		strictEqual(releaseVmSlot(lease), false);
	});

	it("reclaims a slot whose owner PID is provably dead", () => {
		mkdirSync(VM_ADMISSION_ROOT, { recursive: true });
		for (const slotIndex of [0, 1]) {
			writeFileSync(
				join(VM_ADMISSION_ROOT, `vm-slot-${slotIndex}.lock`),
				JSON.stringify({
					ownerPid: 999999999,
					runId: `dead-owner-${slotIndex}`,
					token: `dead-token-${slotIndex}`,
				}),
			);
		}

		const lease = acquireVmSlot({ runId: "new-owner-0" });
		const secondLease = acquireVmSlot({ runId: "new-owner-1" });
		strictEqual(lease.slot, 0);
		strictEqual(secondLease.slot, 1);
		strictEqual(
			JSON.parse(readFileSync(lease.path, "utf8")).runId,
			"new-owner-0",
		);
		lease.release();
		secondLease.release();
	});

	it("ignores interrupted temporary files", () => {
		mkdirSync(VM_ADMISSION_ROOT, { recursive: true });
		const tmpPath = join(
			VM_ADMISSION_ROOT,
			`vm-slot-0.lock.${process.pid}.interrupted.tmp`,
		);
		writeFileSync(tmpPath, "complete but unpublished");

		const lease = acquireVmSlot({ runId: "after-interruption" });
		strictEqual(lease.slot, 0);
		lease.release();
		ok(
			existsSync(tmpPath),
			"the primitive need not guess which temp files are safe to remove",
		);
	});

	it("contains admission filesystem failures behind a closed preflight diagnostic", () => {
		writeFileSync(VM_ADMISSION_ROOT, "HOST_ERROR_CANARY /private/admission");

		try {
			acquireVmSlot({ runId: "filesystem-failure" });
			throw new Error("expected VM admission to fail");
		} catch (error) {
			ok(error instanceof VmAdmissionUnavailableError);
			strictEqual(error.code, "VM_ADMISSION_UNAVAILABLE");
			ok(String(error.cause?.message).includes(VM_ADMISSION_ROOT));
			const classified = classifyPreProviderFailure(error);
			deepStrictEqual(classified, {
				diagnosticCode: "vm_admission_unavailable",
				errorKind: "environment_incomplete",
				failurePhase: "queue_preflight",
			});
			const persisted = JSON.stringify(
				sanitizeFailureMetadata({ result: "launch_failed", ...classified }),
			);
			ok(!persisted.includes("HOST_ERROR_CANARY"));
			ok(!persisted.includes("/private/admission"));
			ok(!persisted.includes(VM_ADMISSION_ROOT));
		}
	});

	it("maps admission filesystem codes to closed sanitized categories", () => {
		for (const [code, ErrorType, diagnosticCode] of [
			[
				"EPERM",
				VmAdmissionPermissionDeniedError,
				"vm_admission_permission_denied",
			],
			[
				"EACCES",
				VmAdmissionPermissionDeniedError,
				"vm_admission_permission_denied",
			],
			["EIO", VmAdmissionStorageError, "vm_admission_storage_failed"],
			["ENOSPC", VmAdmissionStorageError, "vm_admission_storage_failed"],
			["UNEXPECTED", VmAdmissionUnavailableError, "vm_admission_unavailable"],
		]) {
			const cause = Object.assign(
				new Error(`HOST_ERROR_CANARY ${VM_ADMISSION_ROOT}`),
				{ code },
			);
			const wrapped = sanitizeVmAdmissionError(cause);
			ok(wrapped instanceof ErrorType);
			const classified = classifyPreProviderFailure(wrapped);
			strictEqual(classified.diagnosticCode, diagnosticCode);
			const persisted = JSON.stringify(
				sanitizeFailureMetadata({ result: "launch_failed", ...classified }),
			);
			ok(!persisted.includes("HOST_ERROR_CANARY"));
			ok(!persisted.includes(VM_ADMISSION_ROOT));
		}
	});

	it("preserves closed admission errors when an occupied slot cannot be read", () => {
		for (const [code, ErrorType, diagnosticCode] of [
			[
				"EACCES",
				VmAdmissionPermissionDeniedError,
				"vm_admission_permission_denied",
			],
			[
				"EPERM",
				VmAdmissionPermissionDeniedError,
				"vm_admission_permission_denied",
			],
			["EIO", VmAdmissionStorageError, "vm_admission_storage_failed"],
		]) {
			const cause = Object.assign(new Error("slot read failed"), { code });
			let observed;
			try {
				runStoreTesting.readVmSlotBody("occupied-slot", () => {
					throw cause;
				});
			} catch (error) {
				observed = error;
			}

			strictEqual(observed, cause);
			const classified = sanitizeVmAdmissionError(observed);
			ok(classified instanceof ErrorType);
			strictEqual(
				classifyPreProviderFailure(classified).diagnosticCode,
				diagnosticCode,
			);
		}
	});

	it("classifies occupied admission slots without confusing storage failure", () => {
		mkdirSync(VM_ADMISSION_ROOT, { recursive: true });
		for (const slotIndex of [0, 1]) {
			writeFileSync(
				join(VM_ADMISSION_ROOT, `vm-slot-${slotIndex}.lock`),
				JSON.stringify({
					ownerPid: process.pid,
					runId: `HOLDER_CANARY_${slotIndex}`,
					token: `holder-token-${slotIndex}`,
				}),
			);
		}

		try {
			acquireVmSlot({ runId: "slot-challenger" });
			throw new Error("expected VM slots to be unavailable");
		} catch (error) {
			ok(error instanceof VmSlotUnavailableError);
			strictEqual(error.code, "VM_SLOT_UNAVAILABLE");
			const classified = classifyPreProviderFailure(error);
			deepStrictEqual(classified, {
				diagnosticCode: "vm_slot_unavailable",
				errorKind: "environment_incomplete",
				failurePhase: "queue_preflight",
			});
			const persisted = JSON.stringify(
				sanitizeFailureMetadata({ result: "launch_failed", ...classified }),
			);
			ok(!persisted.includes("HOLDER_CANARY"));
			ok(!persisted.includes("holder-token"));
		}
	});

	it("classifies malformed or empty occupied slot contents as storage failure", () => {
		for (const contents of [
			"",
			"not-json",
			JSON.stringify({ runId: "missing-owner" }),
		]) {
			rmSync(VM_ADMISSION_ROOT, { recursive: true, force: true });
			mkdirSync(VM_ADMISSION_ROOT, { recursive: true });
			writeFileSync(join(VM_ADMISSION_ROOT, "vm-slot-0.lock"), contents);
			try {
				acquireVmSlot({ runId: "corrupt-slot-challenger" });
				throw new Error("expected corrupted admission slot to fail");
			} catch (error) {
				ok(error instanceof VmAdmissionStorageError);
				strictEqual(error.code, "VM_ADMISSION_STORAGE_FAILED");
				strictEqual(
					classifyPreProviderFailure(error).diagnosticCode,
					"vm_admission_storage_failed",
				);
			}
		}
	});

	it("retries a slot that disappears between failed publication and owner read", () => {
		let publishCalls = 0;
		let readCalls = 0;
		const lease = runStoreTesting.acquireVmSlotWithDependencies(
			{ runId: "slot-release-race" },
			{
				publishVmSlot: () => {
					publishCalls += 1;
					return publishCalls > 1;
				},
				readVmSlotBody: () => {
					readCalls += 1;
					throw Object.assign(new Error("slot vanished"), { code: "ENOENT" });
				},
			},
		);

		strictEqual(lease.slotIndex, 0);
		strictEqual(publishCalls, 2);
		strictEqual(readCalls, 1);
	});

	it("does not invoke project-lock orphan reclamation", async () => {
		const source = await readFile(
			new URL("../src/switchyard/run-store/index.mjs", import.meta.url),
			"utf8",
		);
		const primitive = source.slice(
			source.indexOf("export function acquireVmSlot"),
			source.indexOf("export const acquireMacosVmSlot"),
		);
		ok(primitive.includes("linkSync"));
		ok(!primitive.includes("releaseOrphanedProjectLocks"));
		ok(!primitive.includes('flag: "wx"'));
	});

	it("contends across processes and reports the holding runs safely", async () => {
		const holderSource = `
			import * as store from ${JSON.stringify(RUN_STORE_MODULE_URL)};
			const lease = store.acquireVmSlot({ runId: "child-holder" });
			console.log(JSON.stringify({ slot: lease.slot }));
			process.stdin.once("data", () => { lease.release(); process.exit(0); });
		`;
		const holder = spawnSlotChild(holderSource);
		let parentLease;
		try {
			deepStrictEqual(JSON.parse(await readChildLine(holder)), { slot: 0 });
			parentLease = acquireVmSlot({ runId: "parent-holder" });
			strictEqual(parentLease.slot, 1);

			const challengerSource = `
				import * as store from ${JSON.stringify(RUN_STORE_MODULE_URL)};
			try {
					store.acquireVmSlot({ runId: "challenger" });
				} catch (error) {
					console.log(JSON.stringify({ code: error.code, message: error.message }));
					process.exit(0);
				}
				process.exit(1);
			`;
			const challenger = spawnSlotChild(challengerSource);
			const result = JSON.parse(await readChildLine(challenger));
			await waitForChild(challenger);
			strictEqual(result.code, "VM_SLOT_UNAVAILABLE");
			ok(result.message.includes("child-holder"));
			ok(result.message.includes("parent-holder"));
		} finally {
			if (parentLease) parentLease.release();
			holder.stdin.write("release\n");
			await waitForChild(holder);
		}
	});

	it("allows a later process to acquire after an unreleased owner is killed", async () => {
		const holderSource = `
			import * as store from ${JSON.stringify(RUN_STORE_MODULE_URL)};
			store.acquireVmSlot({ runId: "killed-holder" });
			console.log("ready");
			setInterval(() => {}, 1000);
		`;
		const holder = spawnSlotChild(holderSource);
		try {
			strictEqual((await readChildLine(holder)).trim(), "ready");
			holder.kill("SIGKILL");
			await waitForChild(holder);
			const lease = acquireVmSlot({ runId: "reclaimed-after-kill" });
			strictEqual(lease.slot, 0);
			lease.release();
		} finally {
			if (!holder.killed) holder.kill("SIGKILL");
		}
	});
});

describe("releaseOrphanedProjectLocks", () => {
	it("returns an empty array when the locks directory does not exist", async () => {
		const reclaimed = await releaseOrphanedProjectLocks();
		strictEqual(reclaimed.length, 0);
	});

	it("leaves a live run's lock untouched alongside an orphaned lock it reclaims", async () => {
		// Live run: non-terminal state, worker pid points at this very test
		// process, which is provably alive.
		const liveOpts = makeOptions({ projectPath: uniquePath("live-project") });
		await initializeRun(liveOpts);
		await advanceState(liveOpts.runId, "running");
		const liveCurrent = await readRun(liveOpts.runId);
		await updateRun(
			liveOpts.runId,
			{ workerPid: process.pid },
			liveCurrent.revision,
		);
		await acquireProjectLock(liveOpts.projectPath, liveOpts.runId);

		// Orphaned run sitting alongside it: terminal state, lock never
		// released (the residue a crashed worker leaves behind).
		const deadOpts = makeOptions({ projectPath: uniquePath("dead-project") });
		await initializeRun(deadOpts);
		await advanceState(deadOpts.runId, "failed");
		const deadCurrent = await readRun(deadOpts.runId);
		await updateRun(
			deadOpts.runId,
			{ cleanupState: "complete" },
			deadCurrent.revision,
		);
		await acquireProjectLock(deadOpts.projectPath, deadOpts.runId);

		const reclaimed = await releaseOrphanedProjectLocks();

		ok(
			reclaimed.includes(deadOpts.runId),
			"the orphaned run's lock should be reclaimed",
		);
		ok(
			!reclaimed.includes(liveOpts.runId),
			"the live run's id must not appear in the reclaimed list",
		);
		strictEqual(
			isProjectLockHeld(liveOpts.projectPath),
			true,
			"a live run's lock must never be touched by the scan",
		);
		strictEqual(
			isProjectLockHeld(deadOpts.projectPath),
			false,
			"the orphaned lock should have been reclaimed",
		);
	});

	it("reclaims a lock whose worker is still 'running' but the pid is dead", async () => {
		// Non-terminal state with a dead worker pid: exactly what a
		// hard-crashed worker (process.exit before any terminal write)
		// leaves behind. Covered by the isWorkerLive branch, not the
		// terminal-state branch, of the shared staleness check.
		const opts = makeOptions();
		await initializeRun(opts);
		await advanceState(opts.runId, "running");
		const current = await readRun(opts.runId);
		await updateRun(opts.runId, { workerPid: 999999 }, current.revision);
		await acquireProjectLock(opts.projectPath, opts.runId);

		const reclaimed = await releaseOrphanedProjectLocks();

		ok(reclaimed.includes(opts.runId));
		strictEqual(isProjectLockHeld(opts.projectPath), false);
	});

	it("never reclaims a lock with an unparseable body, regardless of age", async () => {
		const locksDir = join(getStateRoot(), "locks");
		mkdirSync(locksDir, { recursive: true });
		const corruptLockPath = join(locksDir, "corrupt-test.lock");
		writeFileSync(corruptLockPath, "not json {{{");

		const reclaimed = await releaseOrphanedProjectLocks();

		strictEqual(reclaimed.length, 0);
		ok(
			existsSync(corruptLockPath),
			"a lock with an unparseable body must be left on disk untouched",
		);
	});

	it("never reclaims a launch lock (parseable body, no projectPath)", async () => {
		// A launch lock predates F.1's projectPath addition: {runId,
		// createdAt} only. This is the permanent, correct shape for launch
		// locks — not a migration gap — so the scan must leave it alone.
		const tasksPath = uniquePath("tasks");
		const launchRunId = uniqueRunId();
		await acquireLaunchLock(tasksPath, launchRunId);

		const reclaimed = await releaseOrphanedProjectLocks();

		strictEqual(reclaimed.length, 0);
		// Black-box check that the launch lock file is still present: a
		// second acquire on the same tasks path must still collide.
		await rejects(acquireLaunchLock(tasksPath, uniqueRunId()), LockError);
	});

	it("never reclaims a lock whose runId has no run.json at all", async () => {
		// A parseable, projectPath-bearing lock whose run was never
		// initialized (or whose run directory is gone entirely) is a
		// strictly weaker signal than a resolvable-but-dead run: the scan
		// can observe the run record is gone but cannot prove the lock's
		// original holder is actually dead. Per CR-4/CR-5 this resolves to
		// "cannot identify, leave alone" — same posture as an unparseable
		// body or a launch lock. Deferred to F.3's human-confirmed manual
		// remediation, not something this scan should reclaim on its own.
		const path = uniquePath("project");
		const ghostRunId = uniqueRunId();
		await acquireProjectLock(path, ghostRunId);

		const reclaimed = await releaseOrphanedProjectLocks();

		ok(!reclaimed.includes(ghostRunId));
		strictEqual(isProjectLockHeld(path), true);
	});

	it("retains a lock whose project path disagrees with its run record", async () => {
		const opts = makeOptions({
			projectPath: uniquePath("orphan-owner-project"),
		});
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		await updateRun(
			opts.runId,
			{ cleanupState: "complete" },
			(await readRun(opts.runId)).revision,
		);
		const mismatchedProjectPath = uniquePath("orphan-mismatched-project");
		const mismatchedLockPath = join(
			getStateRoot(),
			"locks",
			`${createHash("sha256").update(uniqueRunId()).digest("hex")}.lock`,
		);
		const lockRaw = JSON.stringify({
			runId: opts.runId,
			projectPath: mismatchedProjectPath,
			createdAt: new Date().toISOString(),
		});
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(mismatchedLockPath, lockRaw);

		deepStrictEqual(await releaseOrphanedProjectLocks(), []);
		strictEqual(readFileSync(mismatchedLockPath, "utf8"), lockRaw);
	});

	it("does not release a lock already reassigned to a newer active run on the same project", async () => {
		// Mirrors dispatch's releaseProjectLockIfOwnedBy ownership guard: a
		// stale run's own lock file was already superseded by a different,
		// currently-active run against the same project path. The scan must
		// never pull that active run's lock out from under it.
		const projectPath = uniquePath("project");

		const staleOpts = makeOptions({ projectPath });
		await initializeRun(staleOpts);
		await advanceState(staleOpts.runId, "failed");
		// staleRunId's own lock was already released elsewhere; only the
		// active run below currently holds project lock for this path.

		const activeOpts = makeOptions({ projectPath });
		await initializeRun(activeOpts);
		await advanceState(activeOpts.runId, "running");
		const activeCurrent = await readRun(activeOpts.runId);
		await updateRun(
			activeOpts.runId,
			{ workerPid: process.pid },
			activeCurrent.revision,
		);
		await acquireProjectLock(projectPath, activeOpts.runId);

		const reclaimed = await releaseOrphanedProjectLocks();

		ok(!reclaimed.includes(activeOpts.runId));
		strictEqual(
			isProjectLockHeld(projectPath),
			true,
			"the active run's lock must survive even though a stale run once used the same project path",
		);
	});
});

describe("lease", () => {
	it("acquire -> renew -> release round-trip", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		const pid = 12345;
		const token = "start-token-abc";
		const nonce = "nonce-xyz";

		const acquired = await acquireRunLock(opts.runId, pid, token, nonce);
		strictEqual(acquired.workerPid, pid);
		strictEqual(acquired.workerStartToken, token);
		strictEqual(acquired.workerNonce, nonce);

		const renewed = await renewRunLock(opts.runId, pid, token);
		ok(
			new Date(renewed.lastLeaseHeartbeat).getTime() >=
				new Date(acquired.lastLeaseHeartbeat).getTime(),
		);

		const released = await releaseRunLock(opts.runId);
		strictEqual(released.workerPid, null);
		strictEqual(released.workerStartToken, null);
		strictEqual(released.workerNonce, "");
	});

	it("stale lease is recognized as expired", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await acquireRunLock(opts.runId, 34567, "token-1", "nonce-1");

		const expired = await isRunLockExpired(opts.runId, {
			maxAgeMs: 0,
			now: new Date(Date.now() + 120_000).toISOString(),
		});
		strictEqual(expired, true);
	});

	it("wrong identity fails renew", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await acquireRunLock(opts.runId, 12345, "token-a", "nonce");
		await rejects(renewRunLock(opts.runId, 99999, "token-a"), LockError);
		await rejects(renewRunLock(opts.runId, 12345, "token-b"), LockError);
	});

	it("wrong identity fails acquire when lease is active", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await acquireRunLock(opts.runId, 12345, "token-a", "nonce-a");
		await rejects(
			acquireRunLock(opts.runId, 99999, "token-b", "nonce-b"),
			LockError,
		);
	});

	it("acquire with allowRecovery succeeds on expired lease", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await acquireRunLock(opts.runId, 12345, "token-a", "nonce-a");

		const acquired = await acquireRunLock(
			opts.runId,
			99999,
			"token-b",
			"nonce-b",
			{
				allowRecovery: true,
				maxAgeMs: 0,
				now: new Date(Date.now() + 120_000).toISOString(),
			},
		);

		strictEqual(acquired.workerPid, 99999);
		strictEqual(acquired.workerStartToken, "token-b");
	});

	it("acquire with allowRecovery fails on non-expired lease", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await acquireRunLock(opts.runId, 12345, "token-a", "nonce-a");

		await rejects(
			acquireRunLock(opts.runId, 99999, "token-b", "nonce-b", {
				allowRecovery: true,
			}),
			LockError,
		);
	});

	it("isRunLockExpired returns true when no lease is held", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const expired = await isRunLockExpired(opts.runId);
		strictEqual(expired, true);
	});
});

describe("nonce handshake", () => {
	it("lease acquire includes nonce and readRun shows it", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		const nonce = "handshake-nonce-42";
		await acquireRunLock(opts.runId, 12345, "token", nonce);

		const run = await readRun(opts.runId);
		strictEqual(run.workerNonce, nonce);
	});

	it("release clears nonce", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await acquireRunLock(opts.runId, 12345, "token", "nonce-1");
		await releaseRunLock(opts.runId);

		const run = await readRun(opts.runId);
		strictEqual(run.workerNonce, "");
	});
});

describe("runId validation", () => {
	it("rejects runId with path traversal attempts", async () => {
		await rejects(readRun("../etc/passwd"), SchemaError);
	});

	it("rejects runId with forward-slash traversal", async () => {
		await rejects(readRun("foo/../../bar"), SchemaError);
	});

	it("rejects runId in initializeRun with traversal", async () => {
		const opts = makeOptions({ runId: "../../etc" });
		await rejects(initializeRun(opts), SchemaError);
	});

	it("accepts valid runId characters", async () => {
		const opts = makeOptions({ runId: "valid-run_123" });
		const snapshot = await initializeRun(opts);
		strictEqual(snapshot.runId, "valid-run_123");
	});

	it("rejects runId with special characters", async () => {
		await rejects(readRun("run with spaces"), SchemaError);
	});
});

describe("initialHostFingerprint validation", () => {
	it("rejects null initialHostFingerprint", async () => {
		const runId = uniqueRunId();
		const runDir = getRunRoot(runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "run.json"),
			JSON.stringify({
				schemaVersion: 1,
				runId,
				state: "created",
				cleanupState: "not_started",
				revision: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				orderedTaskIds: [],
				initialHostFingerprint: null,
				workerNonce: "",
				lastLeaseHeartbeat: new Date().toISOString(),
				lastEventSequence: 0,
			}),
		);

		await rejects(readRun(runId), SchemaError);
	});
});

describe("validateRun type checks for telemetry fields", () => {
	it("accepts retry projection metadata and rejects unsafe shapes", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		const projection = {
			quarantinedTargetIds: ["agy-gemini"],
			retryState: {
				taskId: "1.1",
				attempt: 1,
				phase: "target_quarantined",
				resolvedTargetId: "agy-gemini",
			},
			retryTransitionId: 2,
		};

		const updated = await updateRun(opts.runId, projection, snapshot.revision);
		strictEqual(updated.retryTransitionId, 2);
		deepStrictEqual(updated.quarantinedTargetIds, ["agy-gemini"]);

		await rejects(
			updateRun(
				opts.runId,
				{ retryState: { taskId: "1.1", attempt: 3, phase: "bad" } },
				updated.revision,
			),
			SchemaError,
		);
		await rejects(
			updateRun(
				opts.runId,
				{ quarantinedTargetIds: ["bad\u0000target"] },
				updated.revision,
			),
			SchemaError,
		);
	});

	it("accepts static lastFailure metadata and rejects raw fields", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		const safeFailure = {
			errorKind: "execution_failed",
			reasonCode: "execution_failed",
			reason: "Provider execution failed before a reviewed integration.",
			artifactRef: "artifact:0123456789abcdef01234567",
		};

		const updated = await updateRun(
			opts.runId,
			{ lastFailure: safeFailure },
			snapshot.revision,
		);
		strictEqual(updated.lastFailure.reasonCode, "execution_failed");

		await rejects(
			updateRun(
				opts.runId,
				{
					lastFailure: {
						...safeFailure,
						output: "SECRET_CANARY_provider_output",
					},
				},
				updated.revision,
			),
			SchemaError,
		);
	});

	it("rejects a non-number activeTaskStartedAt", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);

		await rejects(
			updateRun(
				opts.runId,
				{ activeTaskStartedAt: "not-a-number" },
				snapshot.revision,
			),
			SchemaError,
		);
	});

	it("rejects a non-number lastCompletionAt", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);

		await rejects(
			updateRun(
				opts.runId,
				{ lastCompletionAt: "not-a-number" },
				snapshot.revision,
			),
			SchemaError,
		);
	});

	it("rejects a non-string workingContainerName", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);

		await rejects(
			updateRun(opts.runId, { workingContainerName: 12345 }, snapshot.revision),
			SchemaError,
		);
	});

	it("accepts activeTaskStartedAt, lastCompletionAt, and workingContainerName when absent, null, or correctly typed", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);

		// Absent: initializeRun doesn't set these fields at all.
		strictEqual(snapshot.activeTaskStartedAt, undefined);
		strictEqual(snapshot.lastCompletionAt, undefined);
		strictEqual(snapshot.workingContainerName, undefined);

		// Explicit null.
		const nulled = await updateRun(
			opts.runId,
			{
				activeTaskStartedAt: null,
				lastCompletionAt: null,
				workingContainerName: null,
			},
			snapshot.revision,
		);
		strictEqual(nulled.activeTaskStartedAt, null);
		strictEqual(nulled.lastCompletionAt, null);
		strictEqual(nulled.workingContainerName, null);

		// Correctly typed values.
		const typed = await updateRun(
			opts.runId,
			{
				activeTaskStartedAt: 1000,
				lastCompletionAt: 2000,
				workingContainerName: "container-abc",
			},
			nulled.revision,
		);
		strictEqual(typed.activeTaskStartedAt, 1000);
		strictEqual(typed.lastCompletionAt, 2000);
		strictEqual(typed.workingContainerName, "container-abc");
	});

	it("rejects unrecognized telemetry write-failure labels", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		await rejects(
			updateRun(
				opts.runId,
				{ lastTelemetryWriteFailure: "/private/path/SECRET" },
				snapshot.revision,
			),
			SchemaError,
		);
		const valid = await updateRun(
			opts.runId,
			{ lastTelemetryWriteFailure: "revision_conflict" },
			snapshot.revision,
		);
		strictEqual(valid.lastTelemetryWriteFailure, "revision_conflict");
	});
});

describe("descriptor receipt harness binding", () => {
	it("rejects forged Claude provenance and accepts the enabled Agy Sonnet target", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		// Empty argv is valid for both harnesses, so this identity is deliberately
		// recomputed for Claude. The rejection below must therefore come from the
		// current roster's antigravity -> agy target provenance, not a hash mismatch.
		const forgedClaudeDescriptor = validateInvocationDescriptor(
			{
				target_id: "antigravity",
				model_ref: "google/fixture",
				selector: "fixture-gemini",
				effort: null,
				variant: null,
				invocation_args: [],
			},
			"claude",
		);

		await rejects(
			updateRun(
				opts.runId,
				{
					resolvedTargetId: "antigravity",
					activeTaskInvocationDescriptor: forgedClaudeDescriptor,
					activeTaskDescriptorIdentity:
						forgedClaudeDescriptor.descriptor_identity,
					activeTaskDescriptorHarness: "claude",
				},
				snapshot.revision,
			),
			SchemaError,
		);

		const descriptor = validateInvocationDescriptor(
			{
				target_id: "antigravity-claude",
				model_ref: "google/fixture",
				selector: "fixture-gemini",
				effort: null,
				variant: null,
				invocation_args: [],
			},
			"agy",
		);
		const accepted = await updateRun(
			opts.runId,
			{
				resolvedTargetId: "antigravity-claude",
				activeTaskInvocationDescriptor: descriptor,
				activeTaskDescriptorIdentity: descriptor.descriptor_identity,
				activeTaskDescriptorHarness: "agy",
			},
			snapshot.revision,
		);
		strictEqual(accepted.activeTaskDescriptorHarness, "agy");
	});
});

describe("protected fields in updateRun", () => {
	it("does not allow overwriting runId", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);

		const updated = await updateRun(
			opts.runId,
			{ runId: "hacked-id", state: "launching" },
			snapshot.revision,
		);

		strictEqual(updated.runId, opts.runId);
		strictEqual(updated.state, "launching");
	});

	it("does not allow overwriting schemaVersion", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);

		const updated = await updateRun(
			opts.runId,
			{ schemaVersion: 99 },
			snapshot.revision,
		);

		strictEqual(updated.schemaVersion, 1);
	});

	it("does not allow overwriting createdAt", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);

		const updated = await updateRun(
			opts.runId,
			{ createdAt: "2000-01-01T00:00:00.000Z" },
			snapshot.revision,
		);

		strictEqual(updated.createdAt, snapshot.createdAt);
	});
});

describe("lastEventSequence tracking", () => {
	it("tracks sequence in run.json after createEvent", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		strictEqual(snapshot.lastEventSequence, 0);

		await createEvent(opts.runId, {
			phase: "bootstrap",
			event: "task_started",
			status: "ok",
		});

		const run = await readRun(opts.runId);
		strictEqual(run.lastEventSequence, 1);
	});

	it("increments lastEventSequence across multiple events", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await createEvent(opts.runId, {
			phase: "bootstrap",
			event: "event_1",
			status: "ok",
		});
		await createEvent(opts.runId, {
			phase: "execution",
			event: "event_2",
			status: "ok",
		});
		await createEvent(opts.runId, {
			phase: "cleanup",
			event: "event_3",
			status: "ok",
		});

		const run = await readRun(opts.runId);
		strictEqual(run.lastEventSequence, 3);
	});

	it("createEvent fails validation when lastEventSequence is missing", async () => {
		const runId = uniqueRunId();
		const runDir = getRunRoot(runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "run.json"),
			JSON.stringify({
				schemaVersion: 1,
				runId,
				state: "created",
				cleanupState: "not_started",
				revision: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				orderedTaskIds: [],
				initialHostFingerprint: {},
				workerNonce: "",
				lastLeaseHeartbeat: new Date().toISOString(),
			}),
		);

		await rejects(
			createEvent(runId, {
				phase: "bootstrap",
				event: "test",
				status: "ok",
			}),
			SchemaError,
		);
	});
});

describe("lock file path resolution", () => {
	it("acquireLaunchLock resolves relative paths to the same lock", async () => {
		const path1 = uniquePath("tasks");
		const runId = uniqueRunId();
		await acquireLaunchLock(path1, runId);

		const relPath = relative(process.cwd(), path1);
		await rejects(acquireLaunchLock(relPath, uniqueRunId()), LockError);
	});
});

describe("concurrent atomic writes", () => {
	it("concurrent updateRun/createEvent never throw ENOENT and leave a valid run.json", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const { runId } = opts;
		const base = await readRun(runId);

		// Fire many writers concurrently at the same run.json. With a fixed,
		// shared tmp path (the bug), roughly half of these collide on rename:
		// one writer renames the shared tmp away before another's rename runs,
		// so the loser throws ENOENT. A unique tmp path per write eliminates
		// the collision — each writer's rename only touches its own tmp file.
		const N = 40;
		const ops = [];
		for (let i = 0; i < N; i++) {
			if (i % 2 === 0) {
				ops.push(
					updateRun(runId, { activeTaskId: `task-${i}` }, base.revision),
				);
			} else {
				ops.push(
					createEvent(runId, {
						phase: "execution",
						event: `evt-${i}`,
						status: "ok",
					}),
				);
			}
		}
		const settled = await Promise.allSettled(ops);

		const enoent = settled.filter(
			(r) => r.status === "rejected" && r.reason?.code === "ENOENT",
		);
		strictEqual(
			enoent.length,
			0,
			`no writer should fail with ENOENT, got ${enoent.length}`,
		);

		// run.json must remain valid and parseable; readRun validates the schema.
		const final = await readRun(runId);
		strictEqual(final.runId, runId);
		ok(
			final.revision > base.revision,
			`revision should advance past ${base.revision}, got ${final.revision}`,
		);
	});

	it("serializes racing updateRun calls on the same expectedRevision instead of clobbering", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const { runId } = opts;
		const base = await readRun(runId);

		// Simulate worker-bootstrap's fire-and-forget callbacks (onTaskStart,
		// onResult) racing the main thread's terminal write: every caller reads
		// the same starting revision before any of them has written. Without
		// serialization, all of these can pass the optimistic-concurrency check
		// and last-rename-wins silently discards every write but the last —
		// with no error thrown, and no guarantee the terminal write survives.
		const N = 10;
		const settled = await Promise.allSettled(
			Array.from({ length: N }, (_, i) =>
				updateRun(runId, { activeTaskId: `task-${i}` }, base.revision),
			),
		);

		const succeeded = settled.filter((r) => r.status === "fulfilled");
		const revisionErrors = settled.filter(
			(r) => r.status === "rejected" && r.reason instanceof RevisionError,
		);
		strictEqual(
			succeeded.length,
			1,
			`exactly one racing updateRun should win, got ${succeeded.length}`,
		);
		strictEqual(
			revisionErrors.length,
			N - 1,
			`the other ${N - 1} should lose with RevisionError, got ${revisionErrors.length}`,
		);

		const final = await readRun(runId);
		strictEqual(final.revision, base.revision + 1);
		strictEqual(final.activeTaskId, succeeded[0].value.activeTaskId);
	});

	it("updateRunWithRetry's authoritative write survives a losing race against a stale-revision writer", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const { runId } = opts;
		const base = await readRun(runId);

		// Mirror worker-bootstrap: a fire-and-forget callback (e.g. onResult)
		// captured the starting revision before the terminal write began, so
		// it races updateRunWithRetry using that now-stale expectedRevision.
		// Whichever of these actually reaches the update queue first, the
		// authoritative write must still land with its real payload — it must
		// never be discarded by losing the race.
		const floatingWrite = updateRun(
			runId,
			{ activeTaskId: "floating-task" },
			base.revision,
		);
		const authoritativeWrite = updateRunWithRetry(runId, {
			state: "failed",
			activeTaskId: null,
			cleanupState: "complete",
			terminalSummary: { totalTasks: 2, processedTasks: 1, failedCount: 1 },
		});

		const authoritative = await authoritativeWrite;
		await floatingWrite.catch(() => {});

		strictEqual(authoritative.state, "failed");
		strictEqual(authoritative.cleanupState, "complete");
		strictEqual(authoritative.terminalSummary.failedCount, 1);

		const final = await readRun(runId);
		strictEqual(final.state, "failed");
		strictEqual(final.cleanupState, "complete");
		strictEqual(
			final.terminalSummary.failedCount,
			1,
			"the real terminal summary must win, not be lost to the floating writer",
		);
	});

	it("two concurrent updateRunWithRetry callers touching different fields both survive", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const { runId } = opts;

		// Mirrors worker-bootstrap's onTaskStart and onTaskRouted: routing is
		// synchronous and fires microseconds after task-start, so both
		// callbacks can read the same base revision and race for the same
		// per-runId update queue slot. Before onTaskStart/onTaskRouted/onResult
		// were switched to updateRunWithRetry, this shape (two fixed-revision
		// updateRun calls) would silently drop one caller's write via
		// RevisionError — the specific regression this fix addresses.
		const [a, b] = await Promise.all([
			updateRunWithRetry(runId, { activeTaskId: "task-1" }),
			updateRunWithRetry(runId, {
				activeTaskProvider: "claude",
				activeTaskModel: "claude-sonnet-5",
			}),
		]);
		ok(a && b, "both concurrent updateRunWithRetry calls should resolve");

		const final = await readRun(runId);
		strictEqual(final.activeTaskId, "task-1");
		strictEqual(final.activeTaskProvider, "claude");
		strictEqual(final.activeTaskModel, "claude-sonnet-5");
	});
});

describe("lastCompletionAt (worker-bootstrap onResult conditional field)", () => {
	// Mirrors worker-bootstrap's onResult callback, which adds lastCompletionAt
	// via a conditional spread — `...(r.success ? { lastCompletionAt: Date.now() } : {})`
	// — rather than a bare field. A failed task's patch must never carry the
	// key at all, so it can neither introduce nor null out lastCompletionAt.
	function completionPatch(success, now) {
		return {
			activeTaskId: null,
			activeTaskProvider: null,
			activeTaskModel: null,
			activeTaskDeadline: null,
			...(success ? { lastCompletionAt: now } : {}),
		};
	}

	it("stays absent (not null, not set) after a task_failed outcome on a fresh run", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const { runId } = opts;

		const final = await updateRunWithRetry(runId, completionPatch(false, 1234));

		ok(
			!Object.hasOwn(final, "lastCompletionAt"),
			"a failed task's patch must never introduce lastCompletionAt",
		);
		strictEqual(final.lastCompletionAt, undefined);
	});

	it("leaves an existing lastCompletionAt untouched (not nulled) when a later task fails", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const { runId } = opts;

		const afterSuccess = await updateRunWithRetry(
			runId,
			completionPatch(true, 111222),
		);
		strictEqual(afterSuccess.lastCompletionAt, 111222);

		const afterFailure = await updateRunWithRetry(
			runId,
			completionPatch(false, 333444),
		);

		strictEqual(
			afterFailure.lastCompletionAt,
			111222,
			"a failed task must not overwrite or null out the prior completion timestamp",
		);
	});
});

describe("shared run finalization", () => {
	it("orders event, pending cleanup, ownership cleanup, terminal patch, and run-lock release", async () => {
		const { finalizeRun } = await import(
			"../src/switchyard/dispatch/run-finalization.mjs"
		);
		const calls = [];
		await finalizeRun(
			{
				runId: "finalizer-order",
				state: "succeeded",
				terminalSummary: { processedTasks: 0, failedCount: 0 },
				cleanup: async () => calls.push("ownership-cleanup"),
			},
			{
				createEvent: async () => calls.push("event"),
				updateRunWithRetry: async (_runId, patch) => {
					calls.push(
						patch.cleanupState === "pending"
							? "pending-cleanup"
							: "terminal-patch",
					);
					return patch;
				},
				releaseRunLock: async () => calls.push("run-lock-release"),
			},
		);
		deepStrictEqual(calls, [
			"event",
			"pending-cleanup",
			"ownership-cleanup",
			"terminal-patch",
			"run-lock-release",
		]);
	});

	it("records cleanup failure as recovery_required without a terminal discriminator", async () => {
		const { finalizeRun } = await import(
			"../src/switchyard/dispatch/run-finalization.mjs"
		);
		const patches = [];
		const result = await finalizeRun(
			{
				runId: "finalizer-cleanup-failure",
				state: "failed",
				terminalSummary: { processedTasks: null, failedCount: null },
				cleanup: async () => {
					throw new Error("raw cleanup detail");
				},
			},
			{
				createEvent: async () => {},
				updateRunWithRetry: async (_runId, patch) => {
					patches.push(patch);
					return patch;
				},
				releaseRunLock: async () => {},
			},
		);
		strictEqual(result.terminal, false);
		strictEqual(patches.at(-1).state, "recovery_required");
		strictEqual(patches.at(-1).cleanupState, "failed");
		strictEqual(patches.at(-1).terminalizedBy, undefined);
		strictEqual(
			patches.at(-1).lastFailure.diagnosticCode,
			"recovery_incomplete",
		);
		ok(!JSON.stringify(patches).includes("raw cleanup detail"));
	});

	it("persists worker terminalization while historical omission remains valid", async () => {
		const { finalizeRun } = await import(
			"../src/switchyard/dispatch/run-finalization.mjs"
		);
		const opts = makeOptions();
		await initializeRun(opts);
		await finalizeRun({
			runId: opts.runId,
			state: "succeeded",
			terminalSummary: { processedTasks: 0, failedCount: 0 },
		});
		strictEqual((await readRun(opts.runId)).terminalizedBy, "worker");

		const historical = makeOptions();
		await initializeRun(historical);
		strictEqual((await readRun(historical.runId)).terminalizedBy, undefined);
	});
});

describe("terminal failure metadata invariants (Task 1.1)", () => {
	it("substitutes unclassified lastFailure when state is updated to failed without metadata", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		const updated = await updateRun(
			opts.runId,
			{ state: "failed" },
			snapshot.revision,
		);

		strictEqual(updated.state, "failed");
		ok(updated.lastFailure !== null, "lastFailure must be non-null");
		strictEqual(updated.lastFailure.errorKind, "unclassified");
		strictEqual(updated.lastFailure.reasonCode, "unclassified");
		ok(isPersistentFailureMetadata(updated.lastFailure));

		const onDisk = await readRun(opts.runId);
		strictEqual(onDisk.state, "failed");
		strictEqual(onDisk.lastFailure?.errorKind, "unclassified");
		ok(isPersistentFailureMetadata(onDisk.lastFailure));
	});

	it("substitutes unclassified lastFailure when advanceState sets state to failed", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const updated = await advanceState(opts.runId, "failed");

		strictEqual(updated.state, "failed");
		ok(updated.lastFailure !== null, "lastFailure must be non-null");
		strictEqual(updated.lastFailure.errorKind, "unclassified");
		ok(isPersistentFailureMetadata(updated.lastFailure));

		const onDisk = await readRun(opts.runId);
		strictEqual(onDisk.state, "failed");
		strictEqual(onDisk.lastFailure?.errorKind, "unclassified");
	});

	it("substitutes unclassified lastFailure when updateRunWithRetry sets state to failed", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const updated = await updateRunWithRetry(opts.runId, { state: "failed" });

		strictEqual(updated.state, "failed");
		ok(updated.lastFailure !== null, "lastFailure must be non-null");
		strictEqual(updated.lastFailure.errorKind, "unclassified");
		ok(isPersistentFailureMetadata(updated.lastFailure));

		const onDisk = await readRun(opts.runId);
		strictEqual(onDisk.state, "failed");
		strictEqual(onDisk.lastFailure?.errorKind, "unclassified");
	});

	it("preserves an existing known failure cause when state is updated to failed without metadata", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await createEvent(opts.runId, {
			phase: "dispatch",
			event: "task_failed",
			status: "Task failed",
			errorKind: "launch_failed",
			reasonCode: "launch_failed",
			reason: "The headless provider job could not be launched.",
		});

		const current = await readRun(opts.runId);
		strictEqual(current.lastFailure?.errorKind, "launch_failed");

		const updated = await updateRun(
			opts.runId,
			{ state: "failed" },
			current.revision,
		);
		strictEqual(updated.state, "failed");
		strictEqual(updated.lastFailure.errorKind, "launch_failed");

		const onDisk = await readRun(opts.runId);
		strictEqual(onDisk.state, "failed");
		strictEqual(onDisk.lastFailure?.errorKind, "launch_failed");
	});

	it("preserves explicitly supplied known failure metadata on failed state patch", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		const safeFailure = {
			errorKind: "auth_expired",
			reasonCode: "auth_expired",
			reason:
				"Provider authentication expired; interactive re-authentication is required.",
		};

		const updated = await updateRun(
			opts.runId,
			{ state: "failed", lastFailure: safeFailure },
			snapshot.revision,
		);
		strictEqual(updated.state, "failed");
		strictEqual(updated.lastFailure.errorKind, "auth_expired");

		const onDisk = await readRun(opts.runId);
		strictEqual(onDisk.state, "failed");
		strictEqual(onDisk.lastFailure?.errorKind, "auth_expired");
	});

	it("leaves success paths untouched with no lastFailure substituted", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const updated = await advanceState(opts.runId, "succeeded");

		strictEqual(updated.state, "succeeded");
		strictEqual(updated.lastFailure, null);

		const onDisk = await readRun(opts.runId);
		strictEqual(onDisk.state, "succeeded");
		strictEqual(onDisk.lastFailure, null);
	});
});

describe("prlctl failure metadata survives the persistence boundary", () => {
	// The whole point of classifying a prlctl misfire is that a reader of the
	// FILE, not just the in-process object, can tell it apart from an ordinary
	// provisioning failure. A wrapper that built the right object in memory but
	// lost exitCode/signal on the way through validateRun's allowlist would
	// still read as "no metadata recorded" to anyone who only reads run.json.
	it("round-trips a prlctl_job_misfire lastFailure with its exit code through disk", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		const misfireFailure = sanitizeFailureMetadata({
			result: "launch_failed",
			errorKind: "launch_failed",
			diagnosticCode: "prlctl_job_misfire",
			failurePhase: "worker_boot",
			exitCode: 255,
		});

		const updated = await updateRun(
			opts.runId,
			{ state: "failed", lastFailure: misfireFailure },
			snapshot.revision,
		);
		strictEqual(updated.lastFailure.diagnosticCode, "prlctl_job_misfire");
		strictEqual(updated.lastFailure.exitCode, 255);

		const onDisk = await readRun(opts.runId);
		strictEqual(onDisk.state, "failed");
		strictEqual(onDisk.lastFailure?.diagnosticCode, "prlctl_job_misfire");
		strictEqual(
			onDisk.lastFailure?.exitCode,
			255,
			"the exit code must still be readable from the file, not just the in-memory return value",
		);
		ok(isPersistentFailureMetadata(onDisk.lastFailure));
	});

	it("round-trips a prlctl_call_timed_out lastFailure with its signal through disk", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		const timeoutFailure = sanitizeFailureMetadata({
			result: "launch_failed",
			errorKind: "launch_failed",
			diagnosticCode: "prlctl_call_timed_out",
			failurePhase: "worker_boot",
			signal: "SIGTERM",
		});

		await updateRun(
			opts.runId,
			{ state: "failed", lastFailure: timeoutFailure },
			snapshot.revision,
		);

		const onDisk = await readRun(opts.runId);
		strictEqual(onDisk.lastFailure?.diagnosticCode, "prlctl_call_timed_out");
		strictEqual(onDisk.lastFailure?.signal, "SIGTERM");
		ok(isPersistentFailureMetadata(onDisk.lastFailure));
	});
});
