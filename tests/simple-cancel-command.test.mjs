import { deepStrictEqual, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	initializeRun,
	isProjectLockHeld,
	readRun,
	updateRunWithRetry,
} from "../src/switchyard/run-store/index.mjs";
import { handleSimple } from "../src/switchyard/simple/cli.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUN_STORE_IMPORT = pathToFileURL(
	join(REPO_ROOT, "src/switchyard/run-store/index.mjs"),
).href;
const STORE_ROOT = realpathSync(tempDir("simple-cancel-store-"));
process.env.SWITCHYARD_RUN_STORE_ROOT = STORE_ROOT;

const children = new Set();

after(async () => {
	for (const child of children) {
		await stopWorker(child);
	}
	children.clear();
});

function startWorker(source, args) {
	const child = spawn(
		process.execPath,
		["--input-type=module", "-e", source, ...args],
		{ stdio: "ignore", env: { ...process.env } },
	);
	children.add(child);
	return child;
}

async function stopWorker(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	try {
		child.kill("SIGKILL");
	} catch {
		// Cross-process signals are sandboxed; the fixture self-terminates.
	}
	await Promise.race([
		once(child, "exit"),
		new Promise((resolve) => setTimeout(resolve, 4_000)),
	]);
	if (child.exitCode === null && child.signalCode === null) child.unref();
}

async function waitForPath(path, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`timed out waiting for ${path}`);
}

function makeProject() {
	const project = realpathSync(tempDir("simple-cancel-project-"));
	writeFileSync(join(project, "prompt.txt"), "Change src/a.txt", "utf8");
	return project;
}

// The fixture handles a real SIGTERM and also watches a signal file, so the
// test can exercise the same SIGTERM path where cross-process signals are
// sandboxed. It releases the project lock and writes the terminal record
// before exiting, exactly like the simple engine's interrupt path.
const CANCEL_WORKER_SOURCE = `
import { existsSync, writeFileSync } from "node:fs";
import {
	acquireProjectLock,
	initializeRun,
	releaseProjectLockIfOwnedBy,
	updateRunWithRetry,
} from ${JSON.stringify(RUN_STORE_IMPORT)};
const [runId, projectPath, readyPath, termPath, signalPath, startToken, nonce] =
	process.argv.slice(1);
await initializeRun({
	runId,
	tasksFilePath: projectPath + "/prompt.txt",
	projectPath,
	orderedTaskIds: ["task-1"],
	initialHostFingerprint: "simple",
	workerPid: process.pid,
	workerNonce: nonce,
});
await updateRunWithRetry(runId, { state: "running", workerStartToken: startToken });
await acquireProjectLock(projectPath, runId);
let handling = false;
const handleTerm = async () => {
	if (handling) return;
	handling = true;
	writeFileSync(termPath, "SIGTERM");
	await releaseProjectLockIfOwnedBy(projectPath, runId);
	await updateRunWithRetry(runId, { state: "failed", cleanupState: "complete" });
	process.exit(0);
};
process.on("SIGTERM", handleTerm);
const watch = setInterval(() => {
	if (existsSync(signalPath)) {
		clearInterval(watch);
		void handleTerm();
	}
}, 25);
writeFileSync(readyPath, "ready");
setTimeout(() => process.exit(0), 3_000);
`;

const MARKER_WORKER_SOURCE = `
import { writeFileSync } from "node:fs";
const [readyPath, termPath] = process.argv.slice(1);
process.on("SIGTERM", () => {
	writeFileSync(termPath, "SIGTERM");
	process.exit(0);
});
writeFileSync(readyPath, "ready");
setTimeout(() => process.exit(0), 3_000);
`;

function writeRunLock(project, runId, holderPid, holderStartToken) {
	const identity = `project:${project}`;
	const hash = createHash("sha256").update(identity).digest("hex");
	const lockPath = join(STORE_ROOT, "locks", `${hash}.lock`);
	mkdirSync(dirname(lockPath), { recursive: true });
	writeFileSync(
		lockPath,
		JSON.stringify({
			runId,
			createdAt: new Date().toISOString(),
			projectPath: project,
			holderPid,
			holderHost: hostname(),
			holderStartToken,
		}),
		{ mode: 0o600 },
	);
	return lockPath;
}

describe("simple cancel command", () => {
	it("cancels a worker that handles SIGTERM and waits for lock release", async () => {
		const project = makeProject();
		const runId = `simple-cancel-${randomUUID()}`;
		const readyPath = join(project, "worker-ready");
		const termPath = join(project, "worker-term");
		const signalPath = join(project, "worker-signal");
		const worker = startWorker(CANCEL_WORKER_SOURCE, [
			runId,
			project,
			readyPath,
			termPath,
			signalPath,
			"start-token-live",
			"nonce-live",
		]);
		const exited = once(worker, "exit");
		await waitForPath(readyPath);
		strictEqual(worker.exitCode, null);

		const kills = [];
		let output = null;
		await handleSimple(
			[
				"cancel",
				"--project",
				project,
				"--run-id",
				runId,
				"--timeout-seconds",
				"10",
			],
			{
				writeResult: (line) => {
					output = JSON.parse(line);
				},
				killProcess: (pid, signal) => {
					kills.push({ pid, signal });
					try {
						process.kill(pid, signal);
					} catch {
						writeFileSync(signalPath, "SIGTERM");
					}
				},
			},
		);

		deepStrictEqual(kills, [{ pid: worker.pid, signal: "SIGTERM" }]);
		deepStrictEqual(output, {
			runId,
			cancelled: true,
			lockReleased: true,
			terminalStatus: "failed",
		});
		strictEqual(readFileSync(termPath, "utf8"), "SIGTERM");
		await exited;
		strictEqual(worker.exitCode, 0);
		strictEqual((await readRun(runId)).state, "failed");
		strictEqual(isProjectLockHeld(project), false);
	});

	it("refuses a live pid whose recorded start token does not match and sends no signal", async () => {
		const project = makeProject();
		const runId = `simple-cancel-${randomUUID()}`;
		const readyPath = join(project, "worker-ready");
		const termPath = join(project, "worker-term");
		const worker = startWorker(MARKER_WORKER_SOURCE, [readyPath, termPath]);
		await waitForPath(readyPath);
		await initializeRun({
			runId,
			tasksFilePath: join(project, "prompt.txt"),
			projectPath: project,
			orderedTaskIds: ["task-1"],
			initialHostFingerprint: "simple",
			workerPid: worker.pid,
			workerNonce: "nonce-live",
		});
		await updateRunWithRetry(runId, {
			state: "running",
			workerStartToken: "stale-token",
		});
		writeRunLock(project, runId, worker.pid, "actual-live-token");

		const kills = [];
		let output = null;
		await handleSimple(["cancel", "--project", project, "--run-id", runId], {
			writeResult: (line) => {
				output = JSON.parse(line);
			},
			killProcess: (pid, signal) => {
				kills.push({ pid, signal });
			},
		});

		deepStrictEqual(output, {
			runId,
			cancelled: false,
			lockReleased: false,
			terminalStatus: null,
			reason: "worker_not_live",
		});
		deepStrictEqual(kills, []);
		strictEqual(existsSync(termPath), false);
		strictEqual(worker.exitCode, null);
		strictEqual((await readRun(runId)).state, "running");
	});

	it("refuses a live pid that no longer holds the run's project lock and sends no signal", async () => {
		const project = makeProject();
		const runId = `simple-cancel-${randomUUID()}`;
		const readyPath = join(project, "worker-ready");
		const termPath = join(project, "worker-term");
		const worker = startWorker(MARKER_WORKER_SOURCE, [readyPath, termPath]);
		await waitForPath(readyPath);
		await initializeRun({
			runId,
			tasksFilePath: join(project, "prompt.txt"),
			projectPath: project,
			orderedTaskIds: ["task-1"],
			initialHostFingerprint: "simple",
			workerPid: worker.pid,
			workerNonce: "nonce-live",
		});
		await updateRunWithRetry(runId, {
			state: "running",
			workerStartToken: "token-live",
		});

		const kills = [];
		let output = null;
		await handleSimple(["cancel", "--project", project, "--run-id", runId], {
			writeResult: (line) => {
				output = JSON.parse(line);
			},
			killProcess: (pid, signal) => {
				kills.push({ pid, signal });
			},
		});

		strictEqual(output.cancelled, false);
		strictEqual(output.reason, "worker_not_live");
		deepStrictEqual(kills, []);
		strictEqual(existsSync(termPath), false);
		strictEqual(worker.exitCode, null);
	});

	it("reports invalid_invocation when --run-id is missing", async () => {
		const project = makeProject();
		const signalProcess = {
			exitCode: undefined,
			on() {},
			removeListener() {},
		};
		let output = null;
		await handleSimple(["cancel", "--project", project], {
			writeResult: (line) => {
				output = JSON.parse(line);
			},
			writeStderr: () => {},
			signalProcess,
		});
		strictEqual(output.status, "failed");
		strictEqual(output.failureReason, "invalid_invocation");
	});
});
