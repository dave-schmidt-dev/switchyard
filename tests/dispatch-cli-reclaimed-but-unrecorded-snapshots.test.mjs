import { deepStrictEqual, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	handleRecover,
	sweepManagedOrphans,
} from "../src/switchyard/dispatch/index.mjs";
import { ROSTER_FIXTURE_PATH } from "./helpers/dispatch-cli-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let dir;
let tasksFile;
let projectDir;
let stateRoot;
beforeEach(async () => {
	dir = tempDir("switchyard-dispatch-cli-");
	stateRoot = join(dir, "state-root");
	tasksFile = join(dir, "tasks.md");
	writeFileSync(
		tasksFile,
		"### Task 1.1: Test task\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** A test\n",
		"utf8",
	);
	projectDir = join(dir, "project");
	mkdirSync(join(projectDir, ".git"), { recursive: true });

	// Set env var so direct run-store calls in tests target the temp dir
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
	rmSync(dir, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});
describe("reclaimed-but-unrecorded snapshots reach the operator", () => {
	const DEAD_VM = "switchyard-work-orphan-999999";
	function reclaimWithResidue() {
		return {
			reclaimed: [{ uuid: "u-1", name: DEAD_VM, forced: true }],
			reclaimedSnapshots: [],
			skipped: [],
			skippedSnapshots: [
				{ name: DEAD_VM, uuid: "u-1", reason: "no-snapshot-sidecar" },
			],
			errors: [],
		};
	}
	it("sweepManagedOrphans reports the residue instead of dropping it", async () => {
		const projectPath = join(dir, "residue-project");
		const swept = await sweepManagedOrphans({
			projectPath,
			listManaged: () => [
				{
					uuid: "u-1",
					runId: "run-1",
					creatorPid: 999999,
					name: DEAD_VM,
					status: "stopped",
				},
			],
			reclaim: reclaimWithResidue,
			readRun: async () => ({
				runId: "run-1",
				projectPath,
				state: "failed",
				cleanupState: "complete",
			}),
		});

		strictEqual(swept.vmsReclaimed, 1);
		deepStrictEqual(swept.unreclaimedSnapshots, [
			{ name: DEAD_VM, uuid: "u-1", reason: "no-snapshot-sidecar" },
		]);
	});
	it("sweepManagedOrphans reports an empty residue when every sidecar was found", async () => {
		const swept = await sweepManagedOrphans({
			listManaged: () => [],
			reclaim: () => ({
				reclaimed: [],
				reclaimedSnapshots: [],
				skipped: [],
				skippedSnapshots: [],
				errors: [],
			}),
			readRun: async () => {
				throw new Error("no such run");
			},
		});

		deepStrictEqual(swept.unreclaimedSnapshots, []);
	});
	it("pre-run sweep filters VM reclaim to readable dead runs in the current project", async () => {
		const currentProject = join(dir, "current-project");
		const entries = [
			{
				uuid: "u1",
				runId: "local-dead",
				creatorPid: 11,
				name: "local-dead",
				status: "stopped",
			},
			{
				uuid: "u2",
				runId: "local-live",
				creatorPid: 12,
				name: "local-live",
				status: "stopped",
			},
			{
				uuid: "u3",
				runId: "foreign-dead",
				creatorPid: 13,
				name: "foreign-dead",
				status: "stopped",
			},
			{
				uuid: "u4",
				runId: "missing",
				creatorPid: 14,
				name: "missing",
				status: "stopped",
			},
			{
				uuid: "u5",
				runId: "malformed",
				creatorPid: 15,
				name: "malformed",
				status: "stopped",
			},
		];
		const runs = {
			"local-dead": {
				runId: "local-dead",
				projectPath: currentProject,
				state: "running",
				cleanupState: "pending",
				workerPid: 999999,
			},
			"local-live": {
				runId: "local-live",
				projectPath: currentProject,
				state: "running",
				cleanupState: "pending",
				workerPid: process.pid,
			},
			"foreign-dead": {
				runId: "foreign-dead",
				projectPath: join(dir, "foreign-project"),
				state: "failed",
				cleanupState: "complete",
				workerPid: null,
			},
		};
		let reclaimOptions;
		const swept = await sweepManagedOrphans({
			projectPath: currentProject,
			listManaged: () => entries,
			readRun: async (runId) => {
				if (runId === "missing" || runId === "malformed") {
					throw new Error("unavailable");
				}
				return runs[runId];
			},
			reclaim: (options) => {
				reclaimOptions = options;
				const reclaimed = entries.filter((entry) => options.eligibility(entry));
				return {
					reclaimed,
					reclaimedSnapshots: [],
					skippedSnapshots: [],
					errors: [],
				};
			},
			releaseOrphanedProjectLocks: async () => [],
			reconcileProjectLockClaims: async () => [],
		});

		deepStrictEqual(
			reclaimOptions &&
				entries
					.filter((entry) => reclaimOptions.eligibility(entry))
					.map((entry) => entry.runId),
			["local-dead"],
		);
		strictEqual(swept.vmsReclaimed, 1);
	});
	it("targeted recover destroys only terminal-clean evidence and refuses unsafe owners", async () => {
		const target = {
			uuid: "target-uuid",
			name: "switchyard-work-target-42",
			runId: "target",
			creatorPid: 42,
			status: "stopped",
		};
		const unsafe = ["live", "startup_grace", "unknown"];
		for (const liveness of unsafe) {
			let destroys = 0;
			const previousExitCode = process.exitCode;
			const originalLog = console.log;
			console.log = () => {};
			try {
				await handleRecover(["--run", "target"], {
					listManaged: () => [target],
					readRun: async () => ({
						runId: "target",
						projectPath: projectDir,
						state: "running",
						cleanupState: "pending",
					}),
					classifyRunLiveness: () => liveness,
					destroy: () => {
						destroys += 1;
					},
					releaseProjectLockIfOwnedBy: async () => false,
					releaseOrphanedProjectLocks: async () => [],
					reconcileProjectLockClaims: async () => [],
				});
			} finally {
				console.log = originalLog;
				process.exitCode = previousExitCode;
			}
			strictEqual(destroys, 0, `${liveness} must not authorize destroy`);
		}

		let destroys = 0;
		const previousExitCode = process.exitCode;
		const originalLog = console.log;
		console.log = () => {};
		try {
			await handleRecover(["--run", "target"], {
				listManaged: () => [target],
				readRun: async () => ({
					runId: "target",
					projectPath: projectDir,
					state: "failed",
					cleanupState: "complete",
				}),
				classifyRunLiveness: () => "terminal_clean",
				destroy: () => {
					destroys += 1;
				},
				releaseProjectLockIfOwnedBy: async () => false,
				releaseOrphanedProjectLocks: async () => [],
				reconcileProjectLockClaims: async () => [],
			});
		} finally {
			console.log = originalLog;
			process.exitCode = previousExitCode;
		}
		strictEqual(destroys, 1);
	});
	it("recover reports reclaimed stale ownership and preserves every unsafe fixture", async () => {
		const baseTarget = {
			uuid: "target-uuid",
			name: "switchyard-work-target-42",
			runId: "target",
			creatorPid: 42,
			status: "stopped",
		};
		const fixtures = [
			{ label: "stale", liveness: "terminal_clean", expected: "reclaimed" },
			{ label: "live", liveness: "live", reason: "live_run" },
			{ label: "unknown", liveness: "unknown", reason: "liveness_unknown" },
			{ label: "missing", missing: true, reason: "run_missing" },
			{
				label: "mismatched",
				mismatchAfterInitialRead: true,
				reason: "project_identity_mismatch",
			},
			{
				label: "malformed",
				target: { ...baseTarget, creatorPid: "42" },
				liveness: "terminal_clean",
				reason: "identity_malformed",
			},
		];
		for (const fixture of fixtures) {
			const target = fixture.target ?? baseTarget;
			let reads = 0;
			let destroys = 0;
			const lines = [];
			const originalLog = console.log;
			const previousExitCode = process.exitCode;
			console.log = (line) => lines.push(String(line));
			try {
				await handleRecover(["--run", "target"], {
					listManaged: () => [target],
					readRun: async () => {
						reads += 1;
						if (fixture.missing) {
							const error = new Error("missing");
							error.code = "ENOENT";
							throw error;
						}
						return {
							runId: "target",
							projectPath:
								fixture.mismatchAfterInitialRead && reads > 2
									? join(dir, "other-project")
									: projectDir,
							state: "failed",
							cleanupState: "complete",
						};
					},
					classifyRunLiveness: () => fixture.liveness ?? "terminal_clean",
					destroy: () => {
						destroys += 1;
					},
					releaseProjectLockIfOwnedBy: async () => false,
					releaseOrphanedProjectLocks: async () => [],
					reconcileProjectLockClaims: async () => [],
				});
			} finally {
				console.log = originalLog;
				process.exitCode = previousExitCode;
			}
			const output = JSON.parse(lines[0]);
			if (fixture.expected === "reclaimed") {
				strictEqual(destroys, 1, fixture.label);
				strictEqual(output.disposition, "reclaimed", fixture.label);
				strictEqual(output.vmsReclaimed, 1, fixture.label);
				strictEqual(output.candidates[0].disposition, "reclaimed");
			} else {
				strictEqual(destroys, 0, `${fixture.label} must remain untouched`);
				strictEqual(output.disposition, "preserved", fixture.label);
				strictEqual(output.candidates[0].disposition, "preserved");
				strictEqual(output.candidates[0].reason, fixture.reason);
			}
		}
	});
	it("maps production-shaped backend reclaim output to the exact candidate", async () => {
		const target = {
			uuid: "target-uuid",
			name: "switchyard-work-target-42",
			runId: "target",
			creatorPid: 42,
			status: "stopped",
		};
		const output = [];
		const originalLog = console.log;
		const previousExitCode = process.exitCode;
		console.log = (line) => output.push(String(line));
		try {
			await handleRecover(["--run", "target"], {
				listManaged: () => [target],
				readRun: async () => ({
					runId: "target",
					projectPath: projectDir,
					state: "failed",
					cleanupState: "complete",
				}),
				classifyRunLiveness: () => "terminal_clean",
				reclaim: () => ({
					reclaimed: [{ uuid: target.uuid, name: target.name, forced: false }],
					skipped: [],
					skippedSnapshots: [],
					errors: [],
				}),
				releaseProjectLockIfOwnedBy: async () => false,
				releaseOrphanedProjectLocks: async () => [],
				reconcileProjectLockClaims: async () => [],
			});
		} finally {
			console.log = originalLog;
			process.exitCode = previousExitCode;
		}

		const envelope = JSON.parse(output[0]);
		strictEqual(envelope.disposition, "reclaimed");
		strictEqual(envelope.vmsReclaimed, 1);
		strictEqual(envelope.candidates[0].disposition, "reclaimed");
		strictEqual(envelope.candidates[0].reason, "stale_owned_resource");
	});
});
