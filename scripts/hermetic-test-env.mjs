/**
 * Hermetic environment for every `node --test` child that validation spawns.
 *
 * Production defaults resolve state from HOME (`~/.switchyard/admission`,
 * `~/.switchyard/accounts`, the Gradus snapshot) and from the checkout
 * (`<repo>/.logs/switchyard`), so a test that forgot to redirect one wrote
 * live dispatcher state or read owner files (audit TEST-9). Each spawn now gets
 * its own HOME, TMPDIR, XDG roots, git global config and Switchyard state
 * roots in one scratch directory, deleted when the child exits.
 *
 * A validation run exports SWITCHYARD_TEST_SCRATCH_ROOT so every spawn below
 * it lands in one per-run directory; without it the spawn directory is made
 * directly under the inherited TMPDIR. Names stay short because the path
 * becomes the child's TMPDIR prefix.
 *
 * Deliberate host references remain. The Docker CLI finds the OrbStack
 * context through `~/.docker`, so DOCKER_CONFIG keeps pointing there. Tests
 * that check host ground truth (the live roster, the ~/.agent producers) read
 * the owner's home from SWITCHYARD_HOST_HOME; production code never does.
 * With SWITCHYARD_LIVE_VM_TESTS=1 the VM admission root stays host-global.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const SCRATCH_ROOT_ENV = "SWITCHYARD_TEST_SCRATCH_ROOT";
/** The owner's real home, for host-ground-truth tests only. */
const HOST_HOME_ENV = "SWITCHYARD_HOST_HOME";

/** Removed so a child cannot reach the owner's config through an override. */
const STRIPPED = Object.freeze([
	"NODE_TEST_CONTEXT",
	"GIT_CONFIG_SYSTEM",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
]);

const TEST_GITCONFIG = `[user]
	name = Switchyard Test
	email = switchyard-test@example.invalid
[commit]
	gpgsign = false
[tag]
	gpgsign = false
`;

/**
 * Create one hermetic environment and its scratch directory.
 * @param {NodeJS.ProcessEnv} [base] Environment to derive from (PATH etc. kept).
 * @returns {{env: NodeJS.ProcessEnv, dir: string, cleanup: () => void}}
 */
export function createHermeticTestEnv(base = process.env) {
	// Canonical: macOS /var is a symlink, and routing state refuses any
	// symlinked ancestor of its root.
	const parent = realpathSync(
		base[SCRATCH_ROOT_ENV] && existsSync(base[SCRATCH_ROOT_ENV])
			? base[SCRATCH_ROOT_ENV]
			: tmpdir(),
	);
	const dir = mkdtempSync(join(parent, "syt-"));
	const home = join(dir, "h");
	const tmp = join(dir, "t");
	const state = join(dir, "s");
	for (const path of [home, tmp, state]) mkdirSync(path, { mode: 0o700 });
	// An empty npm cache: offline setup refuses a home without one.
	mkdirSync(join(home, ".npm"), { mode: 0o700 });
	const gitconfig = join(home, ".gitconfig");
	writeFileSync(gitconfig, TEST_GITCONFIG, { mode: 0o600 });
	const hostHome = base[HOST_HOME_ENV] || base.HOME || homedir();
	const hostDocker = join(hostHome, ".docker");
	// Opt-in live-VM runs boot real guests, so they take the host-global VM
	// slots production queues hold instead of a private pool.
	const vmAdmission =
		base.SWITCHYARD_LIVE_VM_TESTS === "1"
			? base.SWITCHYARD_VM_ADMISSION_ROOT ||
				join(hostHome, ".switchyard", "admission")
			: join(state, "vm-admission");
	const env = Object.fromEntries(
		Object.entries(base).filter(([key]) => !STRIPPED.includes(key)),
	);
	Object.assign(env, {
		HOME: home,
		TMPDIR: tmp,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		GIT_CONFIG_GLOBAL: gitconfig,
		GIT_CONFIG_NOSYSTEM: "1",
		SWITCHYARD_RUN_STORE_ROOT: join(state, "run-store"),
		SWITCHYARD_VM_ADMISSION_ROOT: vmAdmission,
		SWITCHYARD_ACCOUNT_ROOT: join(state, "accounts"),
		SWITCHYARD_SNAPSHOT_PATH_OVERRIDE: join(state, "gradus-snapshot.json"),
		[HOST_HOME_ENV]: hostHome,
	});
	if (!base.DOCKER_CONFIG && existsSync(hostDocker))
		env.DOCKER_CONFIG = hostDocker;
	return {
		env,
		dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/** Run `fn` with a hermetic env and always delete its directory afterwards. */
export function withHermeticTestEnv(base, fn) {
	const hermetic = createHermeticTestEnv(base);
	try {
		return fn(hermetic.env);
	} finally {
		hermetic.cleanup();
	}
}

/** Async twin of {@link withHermeticTestEnv}. */
export async function withHermeticTestEnvAsync(base, fn) {
	const hermetic = createHermeticTestEnv(base);
	try {
		return await fn(hermetic.env);
	} finally {
		hermetic.cleanup();
	}
}

/**
 * Create the per-run scratch root that every hermetic spawn of one validation
 * run nests under, export it to children, and return its cleanup.
 * An inherited root wins, so nested runners share the outer run's directory.
 * @param {NodeJS.ProcessEnv} [env] Mutated: receives SCRATCH_ROOT_ENV.
 * @returns {() => void} Removes the root this call created; no-op otherwise.
 */
export function ensureRunScratchRoot(env = process.env) {
	if (env[SCRATCH_ROOT_ENV] && existsSync(env[SCRATCH_ROOT_ENV]))
		return () => {};
	const root = mkdtempSync(join(realpathSync(tmpdir()), "syv-"));
	env[SCRATCH_ROOT_ENV] = root;
	return () => {
		rmSync(root, { recursive: true, force: true });
		if (env[SCRATCH_ROOT_ENV] === root) delete env[SCRATCH_ROOT_ENV];
	};
}

/**
 * Hold a per-run scratch root for this process's lifetime: create or inherit
 * it, and remove a root this process created on exit or on a fatal signal.
 * @returns {() => void} The cleanup, also registered for exit.
 */
export function holdRunScratchRoot(env = process.env) {
	const cleanup = ensureRunScratchRoot(env);
	process.once("exit", cleanup);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.once(signal, () => {
			cleanup();
			process.kill(process.pid, signal);
		});
	}
	return cleanup;
}
