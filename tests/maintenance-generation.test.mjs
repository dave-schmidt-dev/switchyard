import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rollback } from "../ops/switchyard-cutover.mjs";
import {
	handleLaunch,
	runDispatch,
} from "../src/switchyard/dispatch/index.mjs";
import { recordDispatch } from "../src/switchyard/ledger/index.mjs";
import {
	assertGenerationAllowed,
	beginGeneration,
	ConcurrentGenerationError,
	finishGeneration,
	GenerationGuardError,
	MaintenanceGenerationError,
} from "../src/switchyard/maintenance/index.mjs";
import {
	runQueue,
	runQueueWithOrchestrator,
} from "../src/switchyard/runner/index.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cutoverCli = join(projectRoot, "ops", "switchyard-cutover.mjs");
const workerBootstrap = join(
	projectRoot,
	"src",
	"switchyard",
	"dispatch",
	"worker-bootstrap.mjs",
);
const tempDirs = [];

function tempDir() {
	const path = mkdtempSync(join(tmpdir(), "switchyard-generation-test-"));
	tempDirs.push(path);
	return path;
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function markerPath() {
	return join(tempDir(), "generation-in-progress.json");
}

function activeMarker(path, runId = "test-generation") {
	beginGeneration({ markerPath: path, runId });
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	delete process.env.SWITCHYARD_GENERATION_MARKER;
});

describe("maintenance generation guard", () => {
	it("keeps ordinary operation compatible when no marker exists", () => {
		assert.equal(
			assertGenerationAllowed({ markerPath: markerPath() }).active,
			false,
		);
	});

	it("rejects new synchronous and detached queue work in progress", async () => {
		const path = markerPath();
		activeMarker(path);
		assert.throws(
			() =>
				runQueue({
					tasksFilePath: "unused",
					projectPath: projectRoot,
					dependencies: { generationMarkerPath: path },
				}),
			(error) => error instanceof MaintenanceGenerationError,
		);
		await assert.rejects(
			() =>
				runQueueWithOrchestrator({
					tasksFilePath: "unused",
					projectPath: projectRoot,
					dependencies: { generationMarkerPath: path },
				}),
			(error) => error instanceof MaintenanceGenerationError,
		);
	});

	it("rejects dispatch and ledger entry points before side effects", async () => {
		const path = markerPath();
		activeMarker(path);
		const opts = {
			tasksFilePath: "unused",
			projectPath: projectRoot,
			maxTasks: 1,
		};
		await assert.rejects(
			() =>
				runDispatch(opts, {
					assertGenerationAllowed: () =>
						assertGenerationAllowed({ markerPath: path }),
				}),
			(error) => error instanceof MaintenanceGenerationError,
		);
		process.env.SWITCHYARD_GENERATION_MARKER = path;
		await assert.rejects(
			() =>
				handleLaunch([join(projectRoot, "TASKS.md"), "--project", projectRoot]),
			(error) => error instanceof MaintenanceGenerationError,
		);
		assert.throws(
			() =>
				recordDispatch({
					provider: "test",
					model: "test",
					taskId: "test",
					result: "test",
				}),
			(error) => error instanceof MaintenanceGenerationError,
		);
	});

	it("rejects detached workers before run-store retention side effects", () => {
		const path = markerPath();
		activeMarker(path);
		const stateRoot = join(tempDir(), "state-root");
		const result = spawnSync(
			process.execPath,
			[
				workerBootstrap,
				"--state-root",
				stateRoot,
				"--run-id",
				"guarded-worker",
				"--nonce",
				"guarded-nonce",
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					SWITCHYARD_GENERATION_MARKER: path,
				},
			},
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /generation guard refused/);
		assert.equal(
			existsSync(join(stateRoot, "runs")),
			false,
			"guarded worker must not initialize run-store retention state",
		);
	});

	it("fails closed when the guard marker is unavailable", () => {
		const dir = tempDir();
		const path = join(dir, "generation.json");
		writeFileSync(path, "{}\n");
		chmodSync(dir, 0o000);
		try {
			assert.throws(
				() => assertGenerationAllowed({ markerPath: path }),
				GenerationGuardError,
			);
		} finally {
			chmodSync(dir, 0o700);
		}
	});

	it("fails closed for an unknown marker state", () => {
		const path = markerPath();
		writeFileSync(
			path,
			JSON.stringify({ schemaVersion: 1, state: "future_state" }),
		);
		assert.throws(
			() => assertGenerationAllowed({ markerPath: path }),
			GenerationGuardError,
		);
	});

	it("rejects concurrent generation starts and permits a completed marker", () => {
		const path = markerPath();
		beginGeneration({ markerPath: path, runId: "first" });
		assert.throws(
			() => beginGeneration({ markerPath: path, runId: "second" }),
			(error) => error instanceof ConcurrentGenerationError,
		);
		finishGeneration({ markerPath: path, runId: "first" });
		assert.equal(assertGenerationAllowed({ markerPath: path }).active, false);
		beginGeneration({ markerPath: path, runId: "second" });
		assert.throws(
			() => assertGenerationAllowed({ markerPath: path }),
			(error) => error instanceof MaintenanceGenerationError,
		);
		finishGeneration({ markerPath: path, runId: "second" });
	});

	it("serializes a stale finisher against a newer generation", () => {
		const path = markerPath();
		beginGeneration({ markerPath: path, runId: "generation-a" });
		const beginScript = `
			import { beginGeneration } from ${JSON.stringify(
				pathToFileURL(join(projectRoot, "src/switchyard/maintenance/index.mjs"))
					.href,
			)};
			try {
				beginGeneration({ markerPath: process.argv[1], runId: "generation-b" });
				process.exitCode = 0;
			} catch (error) {
				process.exitCode = error.code === "CONCURRENT_GENERATION" ? 2 : 3;
			}
		`;
		let overlappingBegin;
		finishGeneration({
			markerPath: path,
			runId: "generation-a",
			beforeCommit() {
				overlappingBegin = spawnSync(
					process.execPath,
					["--input-type=module", "-e", beginScript, path],
					{ encoding: "utf8" },
				);
			},
		});
		assert.equal(
			overlappingBegin.status,
			2,
			"a competing begin must not pass the finisher's critical section",
		);

		beginGeneration({ markerPath: path, runId: "generation-b" });
		assert.throws(
			() => finishGeneration({ markerPath: path, runId: "generation-a" }),
			(error) =>
				error instanceof GenerationGuardError &&
				error.message === "generation owner does not match marker",
		);
		assert.equal(
			readFileSync(path, "utf8").includes('"runId": "generation-b"'),
			true,
			"the stale finisher must not overwrite the newer in-progress marker",
		);
		finishGeneration({ markerPath: path, runId: "generation-b" });
		assert.equal(existsSync(`${path}.lock`), false);
	});

	it("reclaims a generation lock left by a dead caller", () => {
		const path = markerPath();
		const deadCaller = spawnSync(process.execPath, ["-e", ""], {
			encoding: "utf8",
		});
		assert.equal(typeof deadCaller.pid, "number");
		writeFileSync(
			`${path}.lock`,
			JSON.stringify({ pid: deadCaller.pid, token: "dead-caller" }),
		);
		beginGeneration({ markerPath: path, runId: "recovered-generation" });
		finishGeneration({ markerPath: path, runId: "recovered-generation" });
		assert.equal(existsSync(`${path}.lock`), false);
	});

	it("fails closed for malformed generation lock metadata", () => {
		const path = markerPath();
		const lockPath = `${path}.lock`;
		writeFileSync(lockPath, "not-json\n");
		const old = new Date(Date.now() - 60_000);
		utimesSync(lockPath, old, old);

		assert.throws(
			() => beginGeneration({ markerPath: path, runId: "blocked-generation" }),
			(error) => error instanceof ConcurrentGenerationError,
		);
		assert.equal(existsSync(lockPath), true);
	});

	it("does not reclaim an old lock held by a live caller", () => {
		const path = markerPath();
		const lockPath = `${path}.lock`;
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: process.pid, token: "live-caller" }),
		);
		const old = new Date(Date.now() - 60_000);
		utimesSync(lockPath, old, old);

		assert.throws(
			() => beginGeneration({ markerPath: path, runId: "blocked-generation" }),
			(error) => error instanceof ConcurrentGenerationError,
		);
		assert.equal(existsSync(lockPath), true);
	});

	it("keeps the completed marker present until the active marker rename", () => {
		const path = markerPath();
		beginGeneration({ markerPath: path, runId: "completed-generation" });
		finishGeneration({ markerPath: path, runId: "completed-generation" });

		let markerDuringRename;
		beginGeneration({
			markerPath: path,
			runId: "replacement-generation",
			beforeRename() {
				markerDuringRename = assertGenerationAllowed({ markerPath: path });
			},
		});
		assert.equal(markerDuringRename.active, false);
		assert.equal(markerDuringRename.marker.state, "complete");
		assert.throws(
			() => assertGenerationAllowed({ markerPath: path }),
			(error) => error instanceof MaintenanceGenerationError,
		);
	});

	it("guards the external metrics and plan/implement producers", () => {
		const path = markerPath();
		activeMarker(path);
		const env = { ...process.env, SWITCHYARD_GENERATION_MARKER: path };
		const metrics = spawnSync(
			"python3",
			[
				"/Users/dave/.agent/bin/metrics",
				"append",
				"--file",
				join(tempDir(), "metrics.jsonl"),
			],
			{
				encoding: "utf8",
				input: "{}",
				env,
				stdio: ["pipe", "ignore", "ignore"],
			},
		);
		assert.equal(metrics.status, 1);
		const producer = spawnSync(
			"bash",
			["/Users/dave/.agent/prompts/_shared/expand.sh", "implement"],
			{
				encoding: "utf8",
				env,
				stdio: ["ignore", "ignore", "ignore"],
			},
		);
		assert.equal(producer.status, 1);
		const ordinary = spawnSync(
			"bash",
			["/Users/dave/.agent/prompts/_shared/expand.sh", "implement"],
			{
				encoding: "utf8",
				env: {
					...process.env,
					SWITCHYARD_GENERATION_MARKER: join(tempDir(), "absent.json"),
				},
				stdio: ["ignore", "ignore", "ignore"],
			},
		);
		assert.equal(ordinary.status, 0);
	});
});

describe("cutover transaction hashes and rollback", () => {
	it("verifies source drift, supports rollback dry-run, and refuses hash conflicts", () => {
		const dir = tempDir();
		const target = join(
			projectRoot,
			"tests",
			`.cutover-fixture-${process.pid}.txt`,
		);
		const manifestDir = join(dir, "transaction");
		const copy = join(manifestDir, "copies", "fixture.txt");
		const manifest = join(manifestDir, "manifest.json");
		mkdirSync(dirname(copy), { recursive: true });
		mkdirSync(manifestDir, { recursive: true });
		try {
			writeFileSync(target, "before\n");
			mkdirSync(dirname(copy), { recursive: true });
			writeFileSync(copy, readFileSync(target));
			const pre = sha256("before\n");
			writeFileSync(target, "after\n");
			const post = sha256("after\n");
			writeFileSync(
				manifest,
				JSON.stringify({
					schemaVersion: 1,
					runId: "test-cutover",
					files: [
						{
							root: "project",
							path: relative(projectRoot, target),
							preCutoverSha256: pre,
							postCutoverSha256: post,
							copyPath: relative(manifestDir, copy),
						},
					],
				}),
			);

			const verifyPre = spawnSync(
				process.execPath,
				[cutoverCli, "verify", "--manifest", manifest],
				{ encoding: "utf8" },
			);
			assert.equal(verifyPre.status, 1);
			assert.match(verifyPre.stdout, /source_drift_count=1/);
			const dryRun = execFileSync(
				process.execPath,
				[cutoverCli, "rollback", "--manifest", manifest],
				{ encoding: "utf8" },
			);
			assert.match(dryRun, /CUTOVER_ROLLBACK=dry-run\|actions=1/);
			assert.equal(readFileSync(target, "utf8"), "after\n");
			execFileSync(
				process.execPath,
				[cutoverCli, "rollback", "--manifest", manifest, "--apply"],
				{ encoding: "utf8" },
			);
			assert.equal(readFileSync(target, "utf8"), "before\n");

			writeFileSync(target, "after\n");
			writeFileSync(copy, "corrupt-backup\n");
			const badBackup = spawnSync(
				process.execPath,
				[cutoverCli, "rollback", "--manifest", manifest, "--apply"],
				{ encoding: "utf8" },
			);
			assert.equal(badBackup.status, 1);
			assert.match(badBackup.stdout, /backup-hash-mismatch/);
			assert.equal(
				readFileSync(target, "utf8"),
				"after\n",
				"a mismatched backup must be refused before target mutation",
			);
			writeFileSync(copy, "before\n");

			writeFileSync(target, "after\n");
			writeFileSync(
				manifest,
				JSON.stringify({
					schemaVersion: 1,
					runId: "test-cutover",
					files: [
						{
							root: "project",
							path: relative(projectRoot, target),
							preCutoverSha256: pre,
							postCutoverSha256: post,
							copyPath: relative(manifestDir, copy),
						},
					],
				}),
			);
			writeFileSync(target, "unrelated\n");
			assert.throws(
				() =>
					execFileSync(
						process.execPath,
						[cutoverCli, "rollback", "--manifest", manifest, "--apply"],
						{ encoding: "utf8" },
					),
				(error) => error.status === 1,
			);
			assert.equal(readFileSync(target, "utf8"), "unrelated\n");
		} finally {
			rmSync(target, { force: true });
		}
	});

	it("rejects target drift injected after rollback preflight", () => {
		const dir = tempDir();
		const target = join(
			projectRoot,
			"tests",
			`.cutover-drift-fixture-${process.pid}.txt`,
		);
		const manifestDir = join(dir, "transaction");
		const copy = join(manifestDir, "copies", "fixture.txt");
		const manifest = join(manifestDir, "manifest.json");
		mkdirSync(dirname(copy), { recursive: true });
		try {
			writeFileSync(target, "before\n");
			writeFileSync(copy, "before\n");
			writeFileSync(
				manifest,
				JSON.stringify({
					schemaVersion: 1,
					runId: "test-cutover-drift",
					files: [
						{
							root: "project",
							path: relative(projectRoot, target),
							preCutoverSha256: sha256("before\n"),
							postCutoverSha256: sha256("after\n"),
							copyPath: relative(manifestDir, copy),
						},
					],
				}),
			);
			writeFileSync(target, "after\n");
			const result = rollback(manifest, true, {
				beforeMutation: () => writeFileSync(target, "drifted\n"),
			});
			assert.equal(result, 1);
			assert.equal(readFileSync(target, "utf8"), "drifted\n");
		} finally {
			rmSync(target, { force: true });
		}
	});

	it("refuses a corrupt backup during rollback dry-run preflight", () => {
		const dir = tempDir();
		const target = join(
			projectRoot,
			"tests",
			`.cutover-dry-run-fixture-${process.pid}.txt`,
		);
		const manifestDir = join(dir, "transaction");
		const copy = join(manifestDir, "copies", "fixture.txt");
		const manifest = join(manifestDir, "manifest.json");
		mkdirSync(dirname(copy), { recursive: true });
		try {
			writeFileSync(target, "after\n");
			writeFileSync(copy, "corrupt-backup\n");
			writeFileSync(
				manifest,
				JSON.stringify({
					schemaVersion: 1,
					runId: "test-cutover-dry-run",
					files: [
						{
							root: "project",
							path: relative(projectRoot, target),
							preCutoverSha256: sha256("before\n"),
							postCutoverSha256: sha256("after\n"),
							copyPath: relative(manifestDir, copy),
						},
					],
				}),
			);

			const result = spawnSync(
				process.execPath,
				[cutoverCli, "rollback", "--manifest", manifest],
				{ encoding: "utf8" },
			);
			assert.equal(result.status, 1);
			assert.match(result.stdout, /backup-hash-mismatch/);
			assert.doesNotMatch(result.stdout, /CUTOVER_ROLLBACK=dry-run\|actions=/);
			assert.equal(readFileSync(target, "utf8"), "after\n");
		} finally {
			rmSync(target, { force: true });
		}
	});
});
