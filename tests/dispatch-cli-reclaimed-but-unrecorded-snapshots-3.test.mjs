import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	handleRecover,
	sweepManagedOrphans,
} from "../src/switchyard/dispatch/index.mjs";
import {
	DISPATCH_PATH,
	ROSTER_FIXTURE_PATH,
} from "./helpers/dispatch-cli-fixtures.mjs";
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
	it("preserves inventory and reclaim failures while lock reconciliation continues", async () => {
		let directReconciliations = 0;
		let claimReconciliations = 0;
		const swept = await sweepManagedOrphans({
			projectPath: projectDir,
			listManaged: () => {
				throw new Error("inventory unavailable");
			},
			reclaim: () => ({
				reclaimed: [],
				skippedSnapshots: [],
				errors: [{ name: "candidate", reason: "reclaim failed" }],
			}),
			releaseOrphanedProjectLocks: async () => {
				directReconciliations += 1;
				return [];
			},
			reconcileProjectLockClaims: async () => {
				claimReconciliations += 1;
				return [];
			},
		});
		deepStrictEqual(swept.errors, [
			"managed_inventory_unavailable",
			"candidate: reclaim failed",
		]);
		strictEqual(directReconciliations, 1);
		strictEqual(claimReconciliations, 1);
	});
	it("retains prior reclaim results when a later candidate throws", async () => {
		const projectPath = join(dir, "partial-reclaim-project");
		const entries = ["a", "b", "c"].map((runId, index) => ({
			uuid: `partial-${runId}`,
			name: `switchyard-work-${runId}-${index + 1}`,
			runId,
			creatorPid: index + 1,
			status: "stopped",
		}));
		const reclaimCalls = [];
		let directReconciliations = 0;
		let claimReconciliations = 0;
		const swept = await sweepManagedOrphans({
			projectPath,
			listManaged: () => entries,
			readRun: async (runId) => ({
				runId,
				projectPath,
				state: "failed",
				cleanupState: "complete",
			}),
			reclaim: ({ eligibility }) => {
				const selected = entries.find(eligibility);
				reclaimCalls.push(selected.runId);
				if (selected.runId === "b") throw new Error("unavailable");
				return {
					reclaimed: selected.runId === "a" ? [selected] : [],
					skippedSnapshots: [],
					errors: [],
				};
			},
			releaseProjectLockIfOwnedBy: async () => false,
			releaseOrphanedProjectLocks: async () => {
				directReconciliations += 1;
				return [];
			},
			reconcileProjectLockClaims: async () => {
				claimReconciliations += 1;
				return [];
			},
		});
		deepStrictEqual(reclaimCalls, ["a", "b", "c"]);
		strictEqual(swept.vmsReclaimed, 1);
		deepStrictEqual(swept.errors, [
			"switchyard-work-b-2: managed_reclaim_failed",
		]);
		strictEqual(directReconciliations, 1);
		strictEqual(claimReconciliations, 1);
	});
	it("recover's JSON envelope names the golden's leftover snapshots", async () => {
		const projectPath = join(dir, "recover-residue-project");
		const lines = [];
		const realLog = console.log;
		console.log = (line) => lines.push(line);
		const priorExitCode = process.exitCode;
		try {
			await handleRecover([], {
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
		} finally {
			console.log = realLog;
			process.exitCode = priorExitCode;
		}

		strictEqual(lines.length, 1);
		const output = JSON.parse(lines[0]);
		strictEqual(output.vmsReclaimed, 1);
		deepStrictEqual(output.unreclaimedSnapshots, [
			{ name: DEAD_VM, uuid: "u-1", reason: "no-snapshot-sidecar" },
		]);
	});
	it("the pre-dispatch sweep report reads a field sweepManagedOrphans actually returns", async () => {
		// It read `containersReclaimed`/`volumesReclaimed` after the
		// Docker-to-Parallels rename, so `undefined > 0` made the branch
		// unreachable and every pre-run reclamation went unreported.
		const source = readFileSync(DISPATCH_PATH, "utf8");
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
		for (const match of source.matchAll(/swept\.([A-Za-z]+)/g)) {
			ok(
				Object.hasOwn(swept, match[1]),
				`pre-run sweep reads swept.${match[1]}, which sweepManagedOrphans does not return`,
			);
		}
	});
});
