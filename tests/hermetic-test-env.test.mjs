// @test-phase: other
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createHermeticTestEnv,
	ensureRunScratchRoot,
	GIT_LOCAL_ENV_VARS,
	SCRATCH_ROOT_ENV,
	scrubInheritedGitEnv,
} from "../scripts/hermetic-test-env.mjs";
import { HANG_GUARD_MS } from "./helpers/hang-guard.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

describe("hermetic test environment", () => {
	it("moves HOME, TMPDIR, XDG, git config and every state root into one scratch dir", () => {
		const ownerHome = tempDir("sy-hermetic-owner-");
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

	describe("inherited repository-local Git variables", () => {
		const SCRIPTS = fileURLToPath(new URL("../scripts", import.meta.url));
		// What a hook launched from a linked worktree hands its children.
		const LEAKED = Object.fromEntries(
			GIT_LOCAL_ENV_VARS.map((key) => [key, "/nonexistent/leaked"]),
		);

		function cleanEnv() {
			const env = { ...process.env, ...LEAKED };
			delete env.NODE_TEST_CONTEXT;
			return env;
		}

		it("lists exactly the variables git reports as repository-local", () => {
			const reported = execFileSync("git", ["rev-parse", "--local-env-vars"], {
				env: { PATH: process.env.PATH },
				encoding: "utf8",
				timeout: HANG_GUARD_MS,
			})
				.split("\n")
				.filter(Boolean);
			deepStrictEqual([...GIT_LOCAL_ENV_VARS].sort(), reported.sort());
		});

		it("removes every one of them from a hermetic child environment and from a scrubbed one", () => {
			const hermetic = createHermeticTestEnv(cleanEnv());
			try {
				for (const key of GIT_LOCAL_ENV_VARS)
					strictEqual(Object.hasOwn(hermetic.env, key), false, key);
			} finally {
				hermetic.cleanup();
			}
			const env = cleanEnv();
			scrubInheritedGitEnv(env);
			for (const key of GIT_LOCAL_ENV_VARS)
				strictEqual(Object.hasOwn(env, key), false, key);
		});

		it("lets a runner entry find its repository from the working directory", () => {
			const repo = tempDir("sy-hermetic-repo-");
			execFileSync("git", ["init", "-q"], { cwd: repo });
			const entry = `
import { holdRunScratchRoot } from ${JSON.stringify(join(SCRIPTS, "hermetic-test-env.mjs"))};
import { execFileSync } from "node:child_process";
holdRunScratchRoot();
console.log(execFileSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim());
`;
			const child = spawnSync(
				process.execPath,
				["--input-type=module", "-e", entry],
				{
					cwd: repo,
					env: cleanEnv(),
					encoding: "utf8",
					timeout: HANG_GUARD_MS,
				},
			);
			strictEqual(child.status, 0, child.stderr);
			strictEqual(
				realpathSync(child.stdout.trim()),
				realpathSync(join(repo, ".git")),
			);
		});

		it("keeps a leaked GIT_DIR out of the fixtures a test lane runs", () => {
			const root = tempDir("sy-hermetic-lane-");
			mkdirSync(join(root, "tests"));
			writeFileSync(
				join(root, "tests", "probe.test.mjs"),
				`// @test-phase: other
import { strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test("fixtures see no inherited repository", () => {
	const leaked = ${JSON.stringify(GIT_LOCAL_ENV_VARS)}.filter((key) =>
		Object.hasOwn(process.env, key),
	);
	strictEqual(leaked.length, 0, leaked.join(","));
	const fixture = join(process.env.TMPDIR, "probe");
	mkdirSync(fixture);
	execFileSync("git", ["init", "-q"], { cwd: fixture });
	strictEqual(existsSync(join(fixture, ".git")), true);
});
`,
			);
			const child = spawnSync(
				process.execPath,
				[join(SCRIPTS, "test-manifest.mjs"), "--run", "other"],
				{
					cwd: root,
					env: cleanEnv(),
					encoding: "utf8",
					timeout: HANG_GUARD_MS * 2,
				},
			);
			strictEqual(child.status, 0, `${child.stdout}\n${child.stderr}`);
		});
	});
});
