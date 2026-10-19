// @test-phase: serial
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	parseHealthArgs,
	parseOrphanLockRemediationArgs,
	parseRecoverArgs,
	USAGE,
	USAGE_RECOVER,
} from "../src/switchyard/dispatch/cli.mjs";
import {
	acquireProjectLock,
	advanceState,
	initializeRun,
} from "../src/switchyard/run-store/index.mjs";
import {
	__dirname,
	DISPATCH_PATH,
	ROSTER_FIXTURE_PATH,
	runDispatch,
} from "./helpers/dispatch-cli-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let dir;
let projectDir;
let stateRoot;
function makeStateRootEnv() {
	return { SWITCHYARD_RUN_STORE_ROOT: stateRoot };
}
beforeEach(async () => {
	dir = tempDir("switchyard-dispatch-cli-");
	stateRoot = join(dir, "state-root");
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
describe("health control CLI", () => {
	it("accepts only bounded inspection and attended attestation fields", () => {
		const hash = `sha256:${"a".repeat(64)}`;
		deepStrictEqual(
			parseHealthArgs([
				"inspect",
				"--target",
				"codex",
				"--descriptor",
				hash,
				"--public-configuration-epoch",
				hash,
				"--repair-epoch",
				"0",
			]).action,
			"inspect",
		);
		strictEqual(
			parseHealthArgs([
				"attest-repair",
				"--target",
				"codex",
				"--descriptor",
				hash,
				"--public-configuration-epoch",
				hash,
				"--repair-kind",
				"auth_repaired",
			]).repairKind,
			"auth_repaired",
		);
	});
});
describe("subcommand parsing", () => {
	it("parseRecoverArgs without --run", () => {
		const parsed = parseRecoverArgs([]);
		strictEqual(parsed.runId, null);
		strictEqual(parsed.help, false);
	});

	it("parseRecoverArgs with --run", () => {
		const parsed = parseRecoverArgs(["--run", "some-run-id"]);
		strictEqual(parsed.runId, "some-run-id");
	});

	it("parseRecoverArgs with --help", () => {
		const parsed = parseRecoverArgs(["--help"]);
		strictEqual(parsed.help, true);
	});

	it("parses the state-root-bound orphan-lock remediation command", () => {
		deepStrictEqual(
			parseOrphanLockRemediationArgs([
				"--dry-run",
				"--state-root",
				"/tmp/switchyard state",
			]),
			{
				argv: ["--dry-run"],
				stateRoot: "/tmp/switchyard state",
			},
		);
	});
});
describe("usage output", () => {
	it("USAGE lists only the surviving subcommands", () => {
		ok(USAGE.includes("--version"));
		for (const name of [
			"simple",
			"routing-run",
			"recover",
			"health",
			"doctor",
			"remediate-orphaned-locks",
		])
			ok(USAGE.includes(`  ${name} `), `USAGE must list ${name}`);
		for (const retired of [
			"run",
			"launch",
			"validate-inputs",
			"backend-health",
			"status",
			"result",
		])
			ok(
				!USAGE.includes(`  ${retired} `),
				`USAGE must not list retired ${retired}`,
			);
	});

	it("USAGE_RECOVER describes recover usage", () => {
		ok(USAGE_RECOVER.includes("--run"));
		ok(USAGE_RECOVER.includes("runLiveness"));
		ok(USAGE_RECOVER.includes("global project-lock cleanup"));
	});
});
describe("CLI exit codes via process spawn", () => {
	it("--version prints the package version independently of cwd", () => {
		const packageVersion = JSON.parse(
			readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
		).version;
		strictEqual(packageVersion, "0.3.0");
		const result = spawnSync(process.execPath, [DISPATCH_PATH, "--version"], {
			cwd: dir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		strictEqual(result.status, 0);
		strictEqual(result.stdout, `${packageVersion}\n`);
		strictEqual(result.stderr, "");
	});

	it("dispatch --help prints usage and exits 0", () => {
		const result = runDispatch(["--help"]);
		strictEqual(result.status, 0);
		ok(result.stdout.includes("Usage"), "stdout should contain usage text");
	});

	it("an unknown subcommand exits 2 (usage error)", () => {
		const result = runDispatch(["nonexistent-subcommand"]);
		strictEqual(result.status, 2);
	});

	it("each retired subcommand exits 2 as unknown", () => {
		for (const retired of [
			"run",
			"launch",
			"validate-inputs",
			"backend-health",
			"status",
			"result",
		]) {
			const result = runDispatch([retired, "--help"], makeStateRootEnv());
			strictEqual(result.status, 2, `${retired} must be refused`);
			ok(
				result.stderr.includes(`unknown subcommand: ${retired}`),
				result.stderr,
			);
		}
	});

	it("a bare tasks-file positional exits 2 instead of starting a queue", () => {
		const result = runDispatch(
			[join(dir, "tasks.md"), "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 2);
		ok(result.stderr.includes("unknown subcommand"), result.stderr);
	});

	it("orphan-lock remediation help exits 0 without changing state", () => {
		const result = runDispatch(["remediate-orphaned-locks", "--help"]);
		strictEqual(result.status, 0);
		ok(result.stdout.includes("Usage: node remediate-orphaned-locks.mjs"));
	});

	it("remediate-orphaned-locks reads a supplied state root dry without mutation and rejects invalid flags", async () => {
		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: join(dir, "tasks.md"),
			projectPath: projectDir,
			orderedTaskIds: ["task-1"],
			initialHostFingerprint: { git: "abc123", worktree: "clean" },
			launchArgs: [],
		});
		await advanceState(runId, "failed");
		await acquireProjectLock(projectDir, runId);
		const lockName = `${createHash("sha256")
			.update(`project:${resolve(projectDir)}`)
			.digest("hex")}.lock`;
		const lockPath = join(stateRoot, "locks", lockName);
		const before = readFileSync(lockPath, "utf8");

		const dryRun = runDispatch(
			["remediate-orphaned-locks", "--dry-run", "--state-root", stateRoot],
			makeStateRootEnv(),
		);
		strictEqual(dryRun.status, 0);
		ok(dryRun.stdout.includes(runId));
		strictEqual(readFileSync(lockPath, "utf8"), before);

		const invalid = runDispatch(
			["remediate-orphaned-locks", "--unknown-remediation-flag"],
			makeStateRootEnv(),
		);
		strictEqual(invalid.status, 2);
	});
});
