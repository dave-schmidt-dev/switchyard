import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..", "..");
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
const SWITCHYARD_SKIP_LIVE_VM_TESTS =
	process.env.SWITCHYARD_SKIP_LIVE_VM_TESTS === "1";
const PARALLELS_AQUA_UID = process.env.SWITCHYARD_PARALLELS_AQUA_UID || "";

function commandAvailable(command) {
	try {
		execFileSync("/usr/bin/which", [command], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function runBootstrap(args, env = {}) {
	return spawnSync(process.execPath, [BOOTSTRAP_PATH, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
		env: { ...process.env, ...env },
	});
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

export {
	__dirname,
	attachCleanupFailure,
	BOOTSTRAP_PATH,
	cleanupDiagnostic,
	commandAvailable,
	compactDiagnostic,
	DISPATCH_PATH,
	PARALLELS_AQUA_UID,
	PARALLELS_GOLDEN_IMAGE,
	pollStatus,
	ROSTER_FIXTURE_PATH,
	runBootstrap,
	runDispatch,
	SWITCHYARD_SKIP_LIVE_VM_TESTS,
};
