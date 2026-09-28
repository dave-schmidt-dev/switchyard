import { spawnSync } from "node:child_process";
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
// Task 1.5 (roster-unification plan): src/switchyard/roster/index.mjs now
// lazily loads the roster, resolving SWITCHYARD_ROSTER_PATH or the canonical
// ~/.agent/roster.json default (Task 4.1) and failing loud only if that
// resolved file can't load. This file's `launch` subcommand spawns a
// detached worker that eventually reaches the real, unmocked router/roster
// on the way to routing a task — point at this committed synthetic fixture
// (not the real ~/.agent/roster.json) so a background routing failure can't
// leak into this suite as stray errors or a stuck run.
const ROSTER_FIXTURE_PATH = resolve(
	__dirname,
	"fixtures",
	"roster.fixture.json",
);

function runDispatch(args, env = {}, timeout = 10_000) {
	return spawnSync(process.execPath, [DISPATCH_PATH, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout,
		env: { ...process.env, ...env },
	});
}

export { __dirname, DISPATCH_PATH, ROSTER_FIXTURE_PATH, runDispatch };
