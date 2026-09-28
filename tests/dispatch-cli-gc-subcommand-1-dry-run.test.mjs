import { ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	collectGcInventory,
	handleGc,
} from "../src/switchyard/dispatch/index.mjs";
import {
	acquireProjectLock,
	initializeRun,
	readRun,
	releaseProjectLockIfOwnedBy,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import { simpleQuarantinePath } from "../src/switchyard/simple/worktree-cleanup.mjs";
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
describe("gc subcommand (T62)", () => {
	it("dry-run preserves an old recorded root and --apply removes exactly that root", async () => {
		const runId = `gc-owned-${randomUUID()}`;
		const nonce = randomUUID();
		const parent = "/private/tmp";
		const candidateChild = `switchyard-simple-${randomUUID()}`;
		const path = join(parent, candidateChild);
		const quarantine = simpleQuarantinePath(nonce);
		const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
		mkdirSync(path, { mode: 0o700 });
		const marker = join(path, ".switchyard-cleanup-owner.json");
		const payload = join(path, "payload.txt");
		writeFileSync(marker, JSON.stringify({ runId, nonce }), { mode: 0o600 });
		writeFileSync(payload, "owned fixture", { mode: 0o600 });
		for (const entry of [marker, payload, path])
			utimesSync(entry, oldDate, oldDate);
		const info = lstatSync(path, { bigint: true });
		try {
			await initializeRun({
				runId,
				tasksFilePath: tasksFile,
				projectPath: projectDir,
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "simple",
				workerPid: process.pid,
				workerNonce: randomUUID(),
				launchArgs: [],
			});
			const initial = await readRun(runId);
			await updateRun(
				runId,
				{
					state: "succeeded",
					cleanupState: "failed",
					worktree: {
						canonicalParent: parent,
						candidateChild,
						path,
						state: "active",
						reason: "worktree_cleanup_failed",
						retainedAt: null,
						device: info.dev.toString(),
						inode: info.ino.toString(),
						nonce,
						writerStopped: true,
					},
				},
				initial.revision,
			);
			const logs = [];
			const originalLog = console.log;
			const priorExit = process.exitCode;
			const dependencies = {
				tmpdir: () => parent,
				measurePrivateBytes: async () => ({ status: "error", roots: {} }),
			};
			try {
				const inspected = async () =>
					(
						await collectGcInventory(
							{ stateRoot, checkEligibility: true },
							dependencies,
						)
					).roots.find((entry) => entry.path === path);
				utimesSync(payload, new Date(), new Date());
				strictEqual((await inspected()).eligibilityReason, "recently_modified");
				utimesSync(payload, oldDate, oldDate);
				await acquireProjectLock(projectDir, runId);
				try {
					strictEqual((await inspected()).eligibilityReason, "project_locked");
				} finally {
					await releaseProjectLockIfOwnedBy(projectDir, runId);
				}
				const current = await readRun(runId);
				await updateRun(
					runId,
					{
						state: "failed",
						worktree: {
							...current.worktree,
							state: "active",
							reason: "provider_exit_nonzero",
							retainedAt: null,
						},
					},
					current.revision,
				);
				strictEqual(
					(await inspected()).eligibilityReason,
					"active_claim_unresolved",
				);
				const unresolved = await readRun(runId);
				await updateRun(
					runId,
					{
						worktree: {
							...unresolved.worktree,
							state: "retained",
							reason: "provider_exit_nonzero",
							retainedAt: new Date().toISOString(),
						},
					},
					unresolved.revision,
				);
				strictEqual(
					(await inspected()).eligibilityReason,
					"salvage_not_expired",
				);
				const retained = await readRun(runId);
				await updateRun(
					runId,
					{
						state: "succeeded",
						worktree: {
							...retained.worktree,
							state: "active",
							reason: "worktree_cleanup_failed",
							retainedAt: null,
						},
					},
					retained.revision,
				);
				const active = await readRun(runId);
				await updateRun(
					runId,
					{
						worktree: {
							...active.worktree,
							state: "retained",
							retainedAt: new Date().toISOString(),
						},
					},
					active.revision,
				);
				strictEqual(
					(await inspected()).deletionEligible,
					true,
					"failed cleanup is non-salvage even with a recent retainedAt",
				);
				const nonSalvage = await readRun(runId);
				await updateRun(
					runId,
					{
						worktree: {
							...nonSalvage.worktree,
							state: "active",
							retainedAt: null,
						},
					},
					nonSalvage.revision,
				);
				const fd = openSync(payload, "r");
				try {
					strictEqual((await inspected()).eligibilityReason, "open_handles");
				} finally {
					closeSync(fd);
				}
				console.log = (line) => logs.push(line);
				await handleGc(["--state-root", stateRoot], dependencies);
				const dry = JSON.parse(logs.pop());
				strictEqual(
					dry.roots.find((entry) => entry.path === path).deletionEligible,
					true,
				);
				ok(existsSync(path));
				await handleGc(["--apply", "--state-root", stateRoot], dependencies);
				const applied = JSON.parse(logs.pop());
				strictEqual(applied.apply.removed, 1);
				strictEqual(existsSync(path), false);
				strictEqual(existsSync(quarantine), false);
				strictEqual((await readRun(runId)).worktree.state, "removed");
			} finally {
				console.log = originalLog;
				process.exitCode = priorExit;
			}
		} finally {
			if (existsSync(path)) rmSync(path, { recursive: true, force: true });
			if (existsSync(quarantine))
				rmSync(quarantine, { recursive: true, force: true });
		}
	});
});
