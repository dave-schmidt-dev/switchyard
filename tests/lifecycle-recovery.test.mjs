import { ok, rejects, strictEqual } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
	AGENT_CONTAINER_NAME,
	isContainerRuntimeAvailable,
} from "../src/switchyard/container/index.mjs";
import { handleRecover } from "../src/switchyard/dispatch/index.mjs";
import { recoverManagedObjects } from "../src/switchyard/lifecycle/index.mjs";
import {
	acquireRunLock,
	initializeRun,
	readRun,
	renewRunLock,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import {
	containerExists,
	createLabeledContainer,
	createTestWorkingContainer,
	getContainerLabels,
	reapOwnManagedObjects,
	removeContainer,
	removeVolume,
	volumeExists,
} from "./helpers/lifecycle-fixture.mjs";

const HAS_DOCKER = isContainerRuntimeAvailable();

function projectHash(projectPath) {
	return createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
}

function cleanFixture(name) {
	removeContainer(name);
	removeVolume(`${name}-vol`);
}

if (!HAS_DOCKER) {
	console.log("Docker not available — skipping lifecycle recovery tests");
}

function describeIf(condition, ...args) {
	if (condition) return describe(...args);
	return describe.skip(...args);
}

const TEST_PROJECT = "/tmp/switchyard-test-recovery";

after(() => reapOwnManagedObjects());

describeIf(HAS_DOCKER, "lifecycle recovery — label round-trip", () => {
	let containerName;

	before(() => {
		containerName = createTestWorkingContainer(TEST_PROJECT, {
			runId: "test-run-1",
		});
	});

	after(() => {
		cleanFixture(containerName);
	});

	it("container has managed=true label", () => {
		const labels = getContainerLabels(containerName);
		strictEqual(
			labels["com.zerodelta.switchyard.managed"],
			"true",
			"managed label must be true",
		);
	});

	it("container has correct run_id label", () => {
		const labels = getContainerLabels(containerName);
		strictEqual(
			labels["com.zerodelta.switchyard.run_id"],
			"test-run-1",
			"run_id label must match",
		);
	});

	it("container has correct project hash label", () => {
		const labels = getContainerLabels(containerName);
		const ph = labels["com.zerodelta.switchyard.project"];
		const expected = projectHash(TEST_PROJECT);
		strictEqual(ph, expected, "project label must be the 12-char hex hash");
		strictEqual(/^[0-9a-f]{12}$/.test(ph), true);
	});
});

describeIf(HAS_DOCKER, "lifecycle recovery — active run protection", () => {
	let containerName;

	before(() => {
		containerName = createTestWorkingContainer(TEST_PROJECT, {
			runId: "active-run",
		});
	});

	after(() => {
		cleanFixture(containerName);
	});

	it("does NOT reclaim container whose run is active", () => {
		const result = recoverManagedObjects({
			isRunActive: () => true,
		});

		strictEqual(result.containersReclaimed, 0);
		strictEqual(result.volumesReclaimed, 0);
		strictEqual(containerExists(containerName), true);
	});
});

describeIf(HAS_DOCKER, "lifecycle recovery — dead run reclamation", () => {
	let containerName;

	before(() => {
		containerName = createTestWorkingContainer(TEST_PROJECT, {
			runId: "dead-run",
		});
	});

	after(() => {
		removeContainer(containerName);
		removeVolume(`${containerName}-vol`);
	});

	it("reclaims container for a dead run", () => {
		const result = recoverManagedObjects({
			isRunActive: (runId) => runId !== "dead-run",
		});

		ok(
			result.containersReclaimed >= 1,
			"should reclaim at least the fixture container",
		);
		strictEqual(containerExists(containerName), false);
	});

	it("reclaims volume for a dead run", () => {
		recoverManagedObjects({
			isRunActive: (runId) => runId !== "dead-run",
		});

		strictEqual(volumeExists(`${containerName}-vol`), false);
	});
});

describeIf(
	HAS_DOCKER,
	"lifecycle recovery — standing agent preservation",
	() => {
		const agentExists = (() => {
			try {
				const out = execFileSync(
					"docker",
					[
						"ps",
						"-a",
						"--filter",
						`name=^/${AGENT_CONTAINER_NAME}$`,
						"--format",
						"{{.Names}}",
					],
					{ encoding: "utf8", stdio: "pipe" },
				);
				return out.trim() === AGENT_CONTAINER_NAME;
			} catch {
				return false;
			}
		})();

		it("recovery never touches the standing agent container", () => {
			if (!agentExists) {
				return;
			}

			const result = recoverManagedObjects({
				isRunActive: () => false,
			});

			strictEqual(
				containerExists(AGENT_CONTAINER_NAME),
				true,
				"agent container must survive recovery",
			);

			strictEqual(
				result.containersReclaimed > 0,
				false,
				"agent container must not appear in reclaimed count",
			);
		});
	},
);

describeIf(
	HAS_DOCKER,
	"lifecycle recovery — missing/contradictory metadata",
	() => {
		let unlabeledName;

		before(() => {
			unlabeledName = createTestWorkingContainer(TEST_PROJECT);
		});

		after(() => {
			cleanFixture(unlabeledName);
		});

		it("does not touch containers without managed label", () => {
			recoverManagedObjects({
				isRunActive: () => false,
			});

			strictEqual(containerExists(unlabeledName), true);
		});
	},
);

describeIf(
	HAS_DOCKER,
	"lifecycle recovery — partial create: orphan volume",
	() => {
		const orphanRunId = "orphan-run";
		const orphanVolName = `switchyard-test-orphan-${orphanRunId}-vol`;

		before(() => {
			try {
				execFileSync("docker", ["volume", "rm", "-f", orphanVolName], {
					stdio: "pipe",
				});
			} catch {
				/* not present */
			}
			execFileSync(
				"docker",
				[
					"volume",
					"create",
					"--label",
					"com.zerodelta.switchyard.managed=true",
					"--label",
					`com.zerodelta.switchyard.run_id=${orphanRunId}`,
					"--label",
					`com.zerodelta.switchyard.project=${projectHash(TEST_PROJECT)}`,
					orphanVolName,
				],
				{ stdio: "pipe" },
			);
		});

		after(() => {
			removeVolume(orphanVolName);
		});

		it("reclaims orphaned volume with no matching container", () => {
			const result = recoverManagedObjects({
				isRunActive: (runId) => runId !== orphanRunId,
			});

			ok(
				result.volumesReclaimed >= 1,
				"should reclaim at least the fixture volume",
			);
			strictEqual(volumeExists(orphanVolName), false);
		});
	},
);

describeIf(HAS_DOCKER, "lifecycle recovery — PID/lease protection stub", () => {
	let protectedName;

	before(() => {
		protectedName = createTestWorkingContainer(TEST_PROJECT, {
			runId: "protected-run",
		});
	});

	after(() => {
		cleanFixture(protectedName);
	});

	it("isRunActive returning true prevents deletion", () => {
		const result = recoverManagedObjects({
			isRunActive: (runId) => runId === "protected-run",
		});

		strictEqual(result.containersReclaimed, 0);
		strictEqual(containerExists(protectedName), true);
	});
});

describeIf(HAS_DOCKER, "lifecycle recovery — dry run mode", () => {
	let dryRunName;

	before(() => {
		dryRunName = createTestWorkingContainer(TEST_PROJECT, {
			runId: "dry-run-test",
		});
	});

	after(() => {
		cleanFixture(dryRunName);
	});

	it("reports would-reclaim but does not delete", () => {
		const events = [];
		const result = recoverManagedObjects({
			isRunActive: (runId) => runId !== "dry-run-test",
			dryRun: true,
			onStatus: (e) => events.push(e),
		});

		ok(
			result.containersReclaimed >= 1,
			"dry run should reclaim at least the fixture container",
		);
		strictEqual(containerExists(dryRunName), true);

		const wouldReclaim = events.filter((e) => e.type === "would-reclaim");
		ok(wouldReclaim.length > 0, "dry run must emit would-reclaim events");
		const ourEvent = wouldReclaim.find((e) => e.name === dryRunName);
		ok(ourEvent, "dry run must emit would-reclaim for our fixture");
		strictEqual(ourEvent.runId, "dry-run-test");
	});
});

describeIf(HAS_DOCKER, "lifecycle recovery — onStatus diagnostics", () => {
	let diagName;

	before(() => {
		diagName = createTestWorkingContainer(TEST_PROJECT, {
			runId: "diag-run",
		});
	});

	after(() => {
		cleanFixture(diagName);
	});

	it("emits reclaimed event with container name and runId", () => {
		const events = [];
		const result = recoverManagedObjects({
			isRunActive: (runId) => runId !== "diag-run",
			onStatus: (e) => events.push(e),
		});

		ok(
			result.containersReclaimed >= 1,
			"should reclaim at least the fixture container",
		);

		const reclaimed = events.find((e) => e.type === "reclaimed");
		ok(reclaimed, "must emit a reclaimed event");
		strictEqual(reclaimed.object, "container");
		strictEqual(reclaimed.name, diagName);
		strictEqual(reclaimed.runId, "diag-run");
	});
});

describeIf(HAS_DOCKER, "lifecycle recovery — exact-label teardown", () => {
	const TEARDOWN_RUN_ID = "teardown-run";
	let teardownContainerName;

	beforeEach(() => {
		teardownContainerName = createTestWorkingContainer(TEST_PROJECT, {
			runId: TEARDOWN_RUN_ID,
		});
	});

	afterEach(() => {
		recoverManagedObjects({
			isRunActive: (runId) => runId !== TEARDOWN_RUN_ID,
		});

		strictEqual(
			containerExists(teardownContainerName),
			false,
			"teardown must remove the fixture container",
		);
		strictEqual(
			volumeExists(`${teardownContainerName}-vol`),
			false,
			"teardown must remove the fixture volume",
		);
	});

	it("creates and tears down a labeled container/volume cleanly", () => {
		strictEqual(
			containerExists(teardownContainerName),
			true,
			"fixture container must exist before teardown",
		);
		strictEqual(
			volumeExists(`${teardownContainerName}-vol`),
			true,
			"fixture volume must exist before teardown",
		);
	});
});

describeIf(
	HAS_DOCKER,
	"lifecycle recovery — missing isRunActive defaults to no-op",
	() => {
		let noopContainerName;

		beforeEach(() => {
			noopContainerName = createTestWorkingContainer(TEST_PROJECT, {
				runId: "noop-run",
			});
		});

		afterEach(() => {
			cleanFixture(noopContainerName);
		});

		it("reclaims nothing when isRunActive is not provided", () => {
			const result = recoverManagedObjects();

			strictEqual(result.containersReclaimed, 0);
			strictEqual(result.volumesReclaimed, 0);
			strictEqual(containerExists(noopContainerName), true);
		});
	},
);

describeIf(HAS_DOCKER, "lifecycle recovery — CLI mixed scenario", () => {
	let _tempDir;
	let _stateRoot;
	let _projectDir;
	let deadRunId;
	let activeRunId;
	let deadContainer;
	let activeContainer2;
	let deadVolume;

	beforeEach(async () => {
		_tempDir = mkdtempSync(join(tmpdir(), "switchyard-mixed-"));
		_stateRoot = join(_tempDir, "state-root");
		_projectDir = join(_tempDir, "project");
		mkdirSync(join(_projectDir, ".git"), { recursive: true });

		process.env.SWITCHYARD_RUN_STORE_ROOT = _stateRoot;

		deadRunId = randomUUID();
		activeRunId = randomUUID();

		await initializeRun({
			runId: activeRunId,
			tasksFilePath: join(_tempDir, "tasks.md"),
			projectPath: _projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fp",
			launchArgs: [],
		});

		deadContainer = createLabeledContainer({
			name: `switchyard-mixed-dead-${randomUUID().slice(0, 8)}`,
			labels: {
				"com.zerodelta.switchyard.managed": "true",
				"com.zerodelta.switchyard.run_id": deadRunId,
				"com.zerodelta.switchyard.project": createHash("sha256")
					.update(_projectDir)
					.digest("hex")
					.slice(0, 12),
			},
		});
		deadVolume = `${deadContainer}-vol`;
		try {
			execFileSync(
				"docker",
				[
					"volume",
					"create",
					"--label",
					"com.zerodelta.switchyard.managed=true",
					"--label",
					`com.zerodelta.switchyard.run_id=${deadRunId}`,
					"--label",
					`com.zerodelta.switchyard.project=${createHash("sha256").update(_projectDir).digest("hex").slice(0, 12)}`,
					deadVolume,
				],
				{ stdio: "pipe" },
			);
		} catch {
			/* already exists */
		}

		activeContainer2 = createLabeledContainer({
			name: `switchyard-mixed-active-${randomUUID().slice(0, 8)}`,
			labels: {
				"com.zerodelta.switchyard.managed": "true",
				"com.zerodelta.switchyard.run_id": activeRunId,
				"com.zerodelta.switchyard.project": createHash("sha256")
					.update(_projectDir)
					.digest("hex")
					.slice(0, 12),
			},
		});
	});

	afterEach(() => {
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		cleanFixture(deadContainer);
		cleanFixture(activeContainer2);
		removeVolume(deadVolume);
		rmSync(_tempDir, { recursive: true, force: true });
	});

	it("reclaims dead run objects, preserves active run objects", async () => {
		strictEqual(
			containerExists(deadContainer),
			true,
			"dead container must exist before recovery",
		);
		strictEqual(
			containerExists(activeContainer2),
			true,
			"active container must exist before recovery",
		);

		const result = recoverManagedObjects({
			isRunActive: (rid) => rid === activeRunId,
		});

		ok(
			result.containersReclaimed >= 1,
			"should reclaim at least the dead container",
		);

		strictEqual(
			containerExists(deadContainer),
			false,
			"dead container must be reclaimed",
		);
		strictEqual(
			containerExists(activeContainer2),
			true,
			"active container must be preserved",
		);
	});

	it("CLI recover subcommand handles mixed scenario", async () => {
		strictEqual(
			containerExists(deadContainer),
			true,
			"dead container must exist before CLI recover",
		);
		strictEqual(
			containerExists(activeContainer2),
			true,
			"active container must exist before CLI recover",
		);

		const { listManagedContainers: lmc } = await import(
			"../src/switchyard/lifecycle/index.mjs"
		);

		let capturedOutput = null;
		const origLog = console.log;
		console.log = (msg) => {
			capturedOutput = msg;
		};

		try {
			process.exitCode = undefined;
			await handleRecover([], {
				listManagedContainers: () =>
					lmc().filter((c) => c.runId === deadRunId || c.runId === activeRunId),
			});
		} finally {
			console.log = origLog;
		}

		const cliOutput = JSON.parse(capturedOutput);
		strictEqual(cliOutput.runId, null, "no specific runId when run globally");
		ok(
			cliOutput.containersReclaimed >= 1,
			"CLI must reclaim at least one container",
		);
		strictEqual(
			cliOutput.errors.length,
			0,
			`CLI recover had errors: ${JSON.stringify(cliOutput.errors)}`,
		);

		strictEqual(
			containerExists(deadContainer),
			false,
			"CLI recover must remove dead container",
		);
		strictEqual(
			containerExists(activeContainer2),
			true,
			"CLI recover must preserve active container",
		);
	});
});

describeIf(
	HAS_DOCKER,
	"lifecycle recovery — PID reuse cannot satisfy ownership",
	() => {
		let _tempDir;
		let _stateRoot;
		let _projectDir;
		let runId;

		beforeEach(async () => {
			_tempDir = mkdtempSync(join(tmpdir(), "switchyard-pid-"));
			_stateRoot = join(_tempDir, "state-root");
			_projectDir = join(_tempDir, "project");
			mkdirSync(join(_projectDir, ".git"), { recursive: true });

			process.env.SWITCHYARD_RUN_STORE_ROOT = _stateRoot;

			runId = randomUUID();
			await initializeRun({
				runId,
				tasksFilePath: join(_tempDir, "tasks.md"),
				projectPath: _projectDir,
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "test-fp",
				launchArgs: [],
			});
		});

		afterEach(() => {
			delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			rmSync(_tempDir, { recursive: true, force: true });
		});

		it("renewRunLock rejects same PID with different startToken", async () => {
			const pid = 12345;
			const originalToken = "original-start-token";

			const current = await readRun(runId);
			await updateRun(
				runId,
				{
					workerPid: pid,
					workerStartToken: originalToken,
					workerNonce: "test-nonce",
				},
				current.revision,
			);

			await rejects(
				() => renewRunLock(runId, pid, "different-token"),
				/identity mismatch/,
			);
		});

		it("acquireRunLock without allowRecovery rejects reused PID with different token", async () => {
			const pid = 12346;

			const current = await readRun(runId);
			await updateRun(
				runId,
				{
					workerPid: pid,
					workerStartToken: "old-token",
					workerNonce: "test-nonce",
				},
				current.revision,
			);

			await rejects(
				() => acquireRunLock(runId, pid, "new-token", "test-nonce"),
				/already leased by pid/,
			);
		});

		it("acquireRunLock with allowRecovery succeeds on expired lease with reused PID", async () => {
			const reusedPid = 12347;

			const current = await readRun(runId);
			await updateRun(
				runId,
				{
					workerPid: reusedPid,
					workerStartToken: "real-original-token",
					workerNonce: "original-nonce",
					lastLeaseHeartbeat: new Date(Date.now() - 120_000).toISOString(),
				},
				current.revision,
			);

			const updated = await acquireRunLock(
				runId,
				reusedPid,
				"recovery-token",
				"recovery-nonce",
				{ allowRecovery: true, maxAgeMs: 60_000 },
			);
			strictEqual(updated.workerPid, reusedPid);
			strictEqual(updated.workerStartToken, "recovery-token");
		});
	},
);

// worker_pid-label liveness: the primary, self-contained reclamation signal.
// These prove recovery decides liveness from the object's own worker_pid label
// with NO run-store dependency (no isRunActive) — the property that fixes
// cross-state-root blindness (the recover-hang and worker-sweep interference).
function deadPid() {
	// A just-exited child's PID is reliably dead (tiny reuse window, fine for a
	// test). Using an arbitrary large integer would not be guaranteed dead.
	const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
	return child.pid;
}

describeIf(HAS_DOCKER, "lifecycle recovery — worker_pid liveness", () => {
	const PID_LABEL = "com.zerodelta.switchyard.worker_pid";
	let names;

	beforeEach(() => {
		names = [];
	});

	afterEach(() => {
		for (const n of names) cleanFixture(n);
	});

	function makeContainer(labels) {
		const name = `switchyard-pidtest-${randomUUID().slice(0, 8)}`;
		names.push(name);
		createLabeledContainer({
			name,
			labels: { "com.zerodelta.switchyard.managed": "true", ...labels },
		});
		return name;
	}

	it("reclaims a container whose worker_pid is dead, with NO isRunActive and NO run_id", () => {
		const c = makeContainer({ [PID_LABEL]: String(deadPid()) });
		strictEqual(containerExists(c), true);

		// No isRunActive at all: the dead pid label is the only signal.
		const result = recoverManagedObjects({});

		ok(result.containersReclaimed >= 1, "dead-pid container must be reclaimed");
		strictEqual(containerExists(c), false);
	});

	it("preserves a container whose worker_pid is live even when isRunActive says dead", () => {
		// process.pid is this live test process; pid liveness must win over the
		// run-store signal so an explicit isRunActive:false cannot reap a live run.
		const c = makeContainer({
			[PID_LABEL]: String(process.pid),
			"com.zerodelta.switchyard.run_id": "some-run",
		});

		const result = recoverManagedObjects({ isRunActive: () => false });

		strictEqual(
			containerExists(c),
			true,
			"live-pid container must survive even when isRunActive returns false",
		);
		strictEqual(result.containersReclaimed, 0);
	});

	it("never reaps a managed object with neither a usable worker_pid nor a run_id", () => {
		// No liveness signal at all => ambiguous => must be left untouched, and
		// reported as an error rather than silently reclaimed.
		const c = makeContainer({});
		const events = [];

		const result = recoverManagedObjects({
			isRunActive: () => false,
			onStatus: (e) => events.push(e),
		});

		strictEqual(containerExists(c), true, "no-signal object must survive");
		ok(
			result.errors.some((m) => m.includes(c)),
			"no-signal object must be reported as an error",
		);
		ok(
			events.some((e) => e.name === c && e.reason === "no-liveness-signal"),
			"a no-liveness-signal event must be emitted",
		);
	});

	it("run_id fallback still works for a legacy object with no worker_pid label", () => {
		// Backwards compatibility: pre-labeling objects have no worker_pid, so
		// reclamation must fall back to the run-store isRunActive check.
		const c = makeContainer({
			"com.zerodelta.switchyard.run_id": "legacy-run",
		});

		const result = recoverManagedObjects({
			isRunActive: (rid) => rid !== "legacy-run",
		});

		ok(result.containersReclaimed >= 1, "legacy dead run must be reclaimed");
		strictEqual(containerExists(c), false);
	});
});
