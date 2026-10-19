// @test-phase: other
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	assertGenerationAllowed,
	beginGeneration,
	ConcurrentGenerationError,
	finishGeneration,
	GenerationGuardError,
	MaintenanceGenerationError,
} from "../src/switchyard/maintenance/index.mjs";
import { HOST_HOME } from "./helpers/host-home.mjs";
import { tempDir as trackedTempDir } from "./helpers/tempdir.mjs";

// The producers are host tools under ~/.agent; skip, never fail, where they
// are absent (the check sandbox and CI run under an isolated HOME).
const HOST_METRICS = join(HOST_HOME, ".agent", "bin", "metrics");
const HOST_EXPAND = join(
	HOST_HOME,
	".agent",
	"prompts",
	"_shared",
	"expand.sh",
);
const HOST_PRODUCERS_SKIP =
	!(existsSync(HOST_METRICS) && existsSync(HOST_EXPAND)) &&
	"host ~/.agent producers absent";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];
function tempDir() {
	const path = trackedTempDir("switchyard-generation-test-");
	tempDirs.push(path);
	return path;
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

	it("guards the external metrics and plan/implement producers", {
		skip: HOST_PRODUCERS_SKIP,
	}, () => {
		const path = markerPath();
		activeMarker(path);
		// Host tools resolve their own files from the owner's HOME.
		const env = {
			...process.env,
			HOME: HOST_HOME,
			SWITCHYARD_GENERATION_MARKER: path,
		};
		const metrics = spawnSync(
			"python3",
			[HOST_METRICS, "append", "--file", join(tempDir(), "metrics.jsonl")],
			{
				encoding: "utf8",
				input: "{}",
				env,
				stdio: ["pipe", "ignore", "ignore"],
			},
		);
		assert.equal(metrics.status, 1);
		const producer = spawnSync("bash", [HOST_EXPAND, "implement"], {
			encoding: "utf8",
			env,
			stdio: ["ignore", "ignore", "ignore"],
		});
		assert.equal(producer.status, 1);
		const ordinary = spawnSync("bash", [HOST_EXPAND, "implement"], {
			encoding: "utf8",
			env: {
				...process.env,
				HOME: HOST_HOME,
				SWITCHYARD_GENERATION_MARKER: join(tempDir(), "absent.json"),
			},
			stdio: ["ignore", "ignore", "ignore"],
		});
		assert.equal(ordinary.status, 0);
	});
});
