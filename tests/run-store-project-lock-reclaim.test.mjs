import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	FAILURE_REGISTRY,
	INFORMATIONAL_EVENTS,
} from "../src/switchyard/diagnostics/failure-registry.mjs";
import {
	acquireProjectLock,
	advanceState,
	getStateRoot,
	initializeRun,
	readRun,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const TEST_ROOT = tempDir("switchyard-lock-reclaim-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_ROOT, "store");
const PROJECT_LOCKS_MODULE = fileURLToPath(
	new URL("../src/switchyard/run-store/project-locks.mjs", import.meta.url),
);
const helpers = [];

after(() => {
	rmSync(TEST_ROOT, { recursive: true, force: true });
});
afterEach(async () => {
	for (const helper of helpers.splice(0)) {
		if (helper.exitCode === null && helper.signalCode === null) {
			helper.kill("SIGTERM");
			await once(helper, "exit");
		}
	}
	rmSync(join(TEST_ROOT, "store"), { recursive: true, force: true });
});

function lockPathFor(projectPath) {
	const hash = createHash("sha256")
		.update(`project:${resolve(projectPath)}`)
		.digest("hex");
	return resolve(getStateRoot(), "locks", `${hash}.lock`);
}
async function deadPid() {
	const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
		stdio: "ignore",
	});
	await once(child, "exit");
	return child.pid;
}
function liveHelper() {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
		stdio: "ignore",
	});
	helpers.push(child);
	return child.pid;
}
async function makeRun({ state = "failed", cleanupState, projectPath } = {}) {
	const runId = randomUUID();
	const runProject = projectPath ?? join(TEST_ROOT, `project-${runId}`);
	await initializeRun({
		runId,
		tasksFilePath: join(TEST_ROOT, "tasks.md"),
		projectPath: runProject,
		orderedTaskIds: ["task-1"],
		initialHostFingerprint: "test-host",
	});
	await advanceState(runId, state === "failed" ? "failed" : "running");
	if (cleanupState) {
		const current = await readRun(runId);
		await updateRun(runId, { cleanupState }, current.revision);
	}
	return { runId, projectPath: runProject };
}
function writeLock(projectPath, body) {
	const lockPath = lockPathFor(projectPath);
	mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
	const raw = typeof body === "string" ? body : JSON.stringify(body);
	writeFileSync(lockPath, raw, { mode: 0o600 });
	return { lockPath, raw };
}
async function deadHolderLock(overrides = {}) {
	const old = await makeRun();
	const holderPid = await deadPid();
	const { lockPath, raw } = writeLock(old.projectPath, {
		runId: old.runId,
		createdAt: new Date().toISOString(),
		projectPath: old.projectPath,
		holderPid,
		holderHost: hostname(),
		...overrides,
	});
	return { old, lockPath, raw };
}
async function assertHeld(projectPath, lockPath, raw, code) {
	const events = [];
	await rejects(
		acquireProjectLock(projectPath, randomUUID(), {
			onEvent: (event) => events.push(event),
		}),
		(error) => error.code === code,
	);
	strictEqual(readFileSync(lockPath, "utf8"), raw, "lock body untouched");
	deepStrictEqual(events, []);
}

describe("acquire-time reclaim of a provably dead holder", () => {
	it("registers project_lock_reclaimed as informational, not a failure", () => {
		strictEqual(
			INFORMATIONAL_EVENTS.get("project_lock_reclaimed").kind,
			"informational",
		);
		strictEqual(FAILURE_REGISTRY.has("project_lock_reclaimed"), false);
	});

	it("reclaims a dead holder's lock on a terminal run in one call", async () => {
		const { old, lockPath } = await deadHolderLock();
		const newRunId = randomUUID();
		const events = [];
		await acquireProjectLock(old.projectPath, newRunId, {
			onEvent: (event) => events.push(event),
		});
		const body = JSON.parse(readFileSync(lockPath, "utf8"));
		strictEqual(body.runId, newRunId);
		strictEqual(body.holderPid, process.pid);
		strictEqual(body.holderHost, hostname());
		deepStrictEqual(events, [
			{ event: "project_lock_reclaimed", reclaimedRunId: old.runId },
		]);
	});

	it("keeps PROJECT_LOCK_HELD for a live holder pid", async () => {
		const { old, lockPath, raw } = await deadHolderLock({
			holderPid: liveHelper(),
		});
		await assertHeld(old.projectPath, lockPath, raw, "PROJECT_LOCK_HELD");
	});

	it("treats an EPERM liveness probe as live", async (t) => {
		if (process.getuid?.() === 0) return t.skip("root can signal pid 1");
		const { old, lockPath, raw } = await deadHolderLock({ holderPid: 1 });
		await assertHeld(old.projectPath, lockPath, raw, "PROJECT_LOCK_HELD");
	});

	it("keeps PROJECT_LOCK_HELD for a malformed body", async () => {
		const projectPath = join(TEST_ROOT, "malformed");
		const { lockPath, raw } = writeLock(projectPath, "not json {");
		await assertHeld(projectPath, lockPath, raw, "PROJECT_LOCK_HELD");
	});

	it("keeps PROJECT_LOCK_HELD when run.json is missing", async () => {
		const projectPath = join(TEST_ROOT, "run-missing");
		const { lockPath, raw } = writeLock(projectPath, {
			runId: randomUUID(),
			createdAt: new Date().toISOString(),
			projectPath,
			holderPid: await deadPid(),
			holderHost: hostname(),
		});
		await assertHeld(projectPath, lockPath, raw, "PROJECT_LOCK_HELD");
	});

	it("keeps PROJECT_LOCK_HELD for a cleanup-failed run", async () => {
		const old = await makeRun({ state: "running" });
		const current = await readRun(old.runId);
		await updateRun(
			old.runId,
			{ state: "recovery_required", cleanupState: "failed" },
			current.revision,
		);
		const { lockPath, raw } = writeLock(old.projectPath, {
			runId: old.runId,
			createdAt: new Date().toISOString(),
			projectPath: old.projectPath,
			holderPid: await deadPid(),
			holderHost: hostname(),
		});
		await assertHeld(old.projectPath, lockPath, raw, "PROJECT_LOCK_HELD");
	});

	it("keeps PROJECT_LOCK_HELD when the run belongs to another project", async () => {
		const old = await makeRun();
		const projectPath = join(TEST_ROOT, "other-project");
		const { lockPath, raw } = writeLock(projectPath, {
			runId: old.runId,
			createdAt: new Date().toISOString(),
			projectPath,
			holderPid: await deadPid(),
			holderHost: hostname(),
		});
		await assertHeld(projectPath, lockPath, raw, "PROJECT_LOCK_HELD");
	});

	it("never reclaims a holder on another host or with no host identity", async () => {
		for (const holderHost of [`not-${hostname()}`, undefined]) {
			const { old, lockPath, raw } = await deadHolderLock({ holderHost });
			await assertHeld(old.projectPath, lockPath, raw, "PROJECT_LOCK_HELD");
		}
	});

	it("keeps PROJECT_LOCK_HELD for a non-terminal run with a live worker", async () => {
		const old = await makeRun({ state: "running" });
		const current = await readRun(old.runId);
		await updateRun(old.runId, { workerPid: liveHelper() }, current.revision);
		const { lockPath, raw } = writeLock(old.projectPath, {
			runId: old.runId,
			createdAt: new Date().toISOString(),
			projectPath: old.projectPath,
			holderPid: await deadPid(),
			holderHost: hostname(),
		});
		await assertHeld(old.projectPath, lockPath, raw, "PROJECT_LOCK_HELD");
	});

	it("keeps PROJECT_LOCK_RECOVERY_IN_PROGRESS when a recovery claim exists", async () => {
		const { old, lockPath, raw } = await deadHolderLock();
		writeFileSync(`${lockPath}.recovery-claim`, raw, { mode: 0o600 });
		await assertHeld(
			old.projectPath,
			lockPath,
			raw,
			"PROJECT_LOCK_RECOVERY_IN_PROGRESS",
		);
	});

	it("lets at most one of two concurrent in-process acquirers win", async () => {
		let roundsWon = 0;
		for (let round = 0; round < 25; round += 1) {
			const { old, lockPath } = await deadHolderLock();
			const ids = [randomUUID(), randomUUID()];
			const settled = await Promise.allSettled(
				ids.map((id) => acquireProjectLock(old.projectPath, id)),
			);
			const winners = ids.filter((_, i) => settled[i].status === "fulfilled");
			ok(winners.length <= 1, `round ${round}: both acquirers won`);
			roundsWon += winners.length;
			for (const result of settled) {
				if (result.status === "rejected") {
					ok(
						["PROJECT_LOCK_HELD", "PROJECT_LOCK_RECOVERY_IN_PROGRESS"].includes(
							result.reason.code,
						),
						result.reason.message,
					);
				}
			}
			if (winners.length === 1) {
				strictEqual(
					JSON.parse(readFileSync(lockPath, "utf8")).runId,
					winners[0],
				);
			}
			rmSync(join(getStateRoot(), "locks"), { recursive: true, force: true });
		}
		ok(roundsWon > 0, "the dead holder's lock was reclaimed in some round");
	});

	it("lets at most one of two concurrent acquirer processes win", async () => {
		// Each child imports, reports "ready", then spins on a shared start file
		// so both acquires begin within the same millisecond window.
		const script = `
			const { existsSync } = await import("node:fs");
			const { acquireProjectLock } = await import(${JSON.stringify(PROJECT_LOCKS_MODULE)});
			console.log("ready");
			while (!existsSync(process.argv[3])) {}
			try { await acquireProjectLock(process.argv[1], process.argv[2]); console.log("won"); }
			catch (error) { console.log(error.code); }`;
		for (let round = 0; round < 10; round += 1) {
			const { old, lockPath } = await deadHolderLock();
			const startFile = join(TEST_ROOT, `start-${randomUUID()}`);
			const ids = [randomUUID(), randomUUID()];
			const children = ids.map((id) => {
				const child = spawn(
					process.execPath,
					["--input-type=module", "-e", script, old.projectPath, id, startFile],
					{ stdio: ["ignore", "pipe", "inherit"], env: process.env },
				);
				helpers.push(child);
				const state = { out: "" };
				state.ready = new Promise((resolveReady) => {
					child.stdout.on("data", (chunk) => {
						state.out += chunk;
						if (state.out.includes("ready")) resolveReady();
					});
				});
				state.exited = once(child, "exit");
				return state;
			});
			await Promise.all(children.map((child) => child.ready));
			writeFileSync(startFile, "");
			await Promise.all(children.map((child) => child.exited));
			const outputs = children.map((child) =>
				child.out.replace("ready", "").trim(),
			);
			const winners = ids.filter((_, i) => outputs[i] === "won");
			ok(winners.length <= 1, `round ${round}: ${outputs.join(",")}`);
			for (const output of outputs) {
				ok(
					[
						"won",
						"PROJECT_LOCK_HELD",
						"PROJECT_LOCK_RECOVERY_IN_PROGRESS",
					].includes(output),
					output,
				);
			}
			if (winners.length === 1) {
				strictEqual(
					JSON.parse(readFileSync(lockPath, "utf8")).runId,
					winners[0],
				);
			}
			rmSync(join(getStateRoot(), "locks"), { recursive: true, force: true });
		}
	});
});
