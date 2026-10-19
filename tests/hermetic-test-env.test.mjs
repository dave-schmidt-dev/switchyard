// @test-phase: other
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createHermeticTestEnv,
	ensureRunScratchRoot,
	SCRATCH_ROOT_ENV,
} from "../scripts/hermetic-test-env.mjs";
import { HANG_GUARD_MS } from "./helpers/hang-guard.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

describe("hermetic test environment", () => {
	it("moves HOME, TMPDIR, XDG, git config and every state root into one scratch dir", () => {
		const ownerHome = tempDir("sy-hermetic-owner-");
		mkdirSync(join(ownerHome, ".docker"));
		const hermetic = createHermeticTestEnv({
			PATH: "/usr/bin:/bin",
			HOME: ownerHome,
			NODE_TEST_CONTEXT: "child-v8",
			GIT_DIR: "/leaked/.git",
			SWITCHYARD_RUN_STORE_ROOT: join(ownerHome, "live-run-store"),
		});
		try {
			const { env, dir } = hermetic;
			strictEqual(env.PATH, "/usr/bin:/bin");
			for (const key of ["NODE_TEST_CONTEXT", "GIT_DIR"])
				strictEqual(Object.hasOwn(env, key), false, key);
			for (const key of [
				"HOME",
				"TMPDIR",
				"XDG_CONFIG_HOME",
				"XDG_CACHE_HOME",
				"XDG_DATA_HOME",
				"XDG_STATE_HOME",
				"GIT_CONFIG_GLOBAL",
				"SWITCHYARD_RUN_STORE_ROOT",
				"SWITCHYARD_VM_ADMISSION_ROOT",
				"SWITCHYARD_ACCOUNT_ROOT",
				"SWITCHYARD_SNAPSHOT_PATH_OVERRIDE",
			])
				ok(env[key].startsWith(`${dir}/`), `${key}=${env[key]}`);
			ok(existsSync(env.HOME) && existsSync(env.TMPDIR));
			ok(
				existsSync(join(env.HOME, ".npm")),
				"offline npm setup needs a cache dir",
			);
			strictEqual(realpathSync(dir), dir, "no symlinked ancestor such as /var");
			strictEqual(env.GIT_CONFIG_NOSYSTEM, "1");
			strictEqual(env.DOCKER_CONFIG, join(ownerHome, ".docker"));
			strictEqual(env.SWITCHYARD_HOST_HOME, ownerHome);
			const nested = createHermeticTestEnv(env);
			try {
				strictEqual(nested.env.SWITCHYARD_HOST_HOME, ownerHome);
			} finally {
				nested.cleanup();
			}
		} finally {
			hermetic.cleanup();
		}
		strictEqual(existsSync(hermetic.dir), false);
	});

	it("nests each spawn under the run scratch root and leaves an inherited root alone", () => {
		const env = { PATH: process.env.PATH };
		const release = ensureRunScratchRoot(env);
		const root = env[SCRATCH_ROOT_ENV];
		ok(root && existsSync(root));
		const first = createHermeticTestEnv(env);
		const second = createHermeticTestEnv(env);
		strictEqual(realpathSync(join(first.dir, "..")), realpathSync(root));
		ok(first.dir !== second.dir);
		strictEqual(first.env[SCRATCH_ROOT_ENV], root);
		const inherited = ensureRunScratchRoot(env);
		inherited();
		ok(existsSync(root), "an inherited root is not the caller's to remove");
		first.cleanup();
		release();
		strictEqual(existsSync(second.dir), false);
		strictEqual(existsSync(root), false);
		strictEqual(Object.hasOwn(env, SCRATCH_ROOT_ENV), false);
	});

	it("keeps the host-global VM slots only for an opt-in live-VM run", () => {
		const ownerHome = realpathSync(tempDir("sy-hermetic-owner-"));
		const base = { PATH: process.env.PATH, HOME: ownerHome };
		const ordinary = createHermeticTestEnv(base);
		const live = createHermeticTestEnv({
			...base,
			SWITCHYARD_LIVE_VM_TESTS: "1",
		});
		const pinned = createHermeticTestEnv({
			...base,
			SWITCHYARD_LIVE_VM_TESTS: "1",
			SWITCHYARD_VM_ADMISSION_ROOT: "/x/admission",
		});
		try {
			ok(ordinary.env.SWITCHYARD_VM_ADMISSION_ROOT.startsWith(ordinary.dir));
			strictEqual(
				live.env.SWITCHYARD_VM_ADMISSION_ROOT,
				join(ownerHome, ".switchyard", "admission"),
			);
			strictEqual(pinned.env.SWITCHYARD_VM_ADMISSION_ROOT, "/x/admission");
		} finally {
			for (const item of [ordinary, live, pinned]) item.cleanup();
		}
	});

	it("gives a real child its own home, temp dir and a non-signing git identity", () => {
		const hermetic = createHermeticTestEnv(process.env);
		try {
			const seen = JSON.parse(
				execFileSync(
					process.execPath,
					[
						"-e",
						'const os = require("node:os"); console.log(JSON.stringify([os.homedir(), os.tmpdir()]))',
					],
					{ env: hermetic.env, encoding: "utf8", timeout: HANG_GUARD_MS },
				),
			);
			deepStrictEqual(seen, [hermetic.env.HOME, hermetic.env.TMPDIR]);
			const config = execFileSync(
				"git",
				["config", "--get-regexp", "^(user|commit)\\."],
				{ env: hermetic.env, encoding: "utf8", timeout: HANG_GUARD_MS },
			);
			deepStrictEqual(config.trim().split("\n"), [
				"user.name Switchyard Test",
				"user.email switchyard-test@example.invalid",
				"commit.gpgsign false",
			]);
		} finally {
			hermetic.cleanup();
		}
	});
});
