import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildGuardedPrompt } from "../src/switchyard/simple/guarded-prompt.mjs";
import {
	parseSimpleArgs,
	runSimpleTask,
} from "../src/switchyard/simple/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const originalRunStoreEnv = process.env.SWITCHYARD_RUN_STORE_ROOT;
const SUITE_STATE_ROOT = tempDir("switchyard-report-state-");
process.env.SWITCHYARD_RUN_STORE_ROOT = SUITE_STATE_ROOT;

after(() => {
	if (originalRunStoreEnv === undefined)
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	else process.env.SWITCHYARD_RUN_STORE_ROOT = originalRunStoreEnv;
});

function git(path, args) {
	return execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
}

function commit(path, message) {
	git(path, ["add", "-A"]);
	git(path, [
		"-c",
		"user.name=Switchyard Tests",
		"-c",
		"user.email=switchyard@example.invalid",
		"commit",
		"-qm",
		message,
	]);
}

function makeRepo() {
	const root = tempDir("switchyard-report-");
	const projectPath = join(root, "project");
	mkdirSync(join(projectPath, "src"), { recursive: true });
	writeFileSync(join(projectPath, "src", "a.txt"), "base a\n", "utf8");
	writeFileSync(join(projectPath, ".gitignore"), ".logs/\n", "utf8");
	git(projectPath, ["init", "-q"]);
	commit(projectPath, "base");
	const promptPath = join(root, "prompt.txt");
	writeFileSync(promptPath, "Write the report", "utf8");
	return { root, projectPath, promptPath };
}

function parseBase(repo, extra = []) {
	return [
		repo.promptPath,
		"--project",
		repo.projectPath,
		"--capability",
		"standard",
		...extra,
		"--deadline",
		"1970-01-01T00:10:00Z",
	];
}

function options(repo, overrides = {}) {
	return {
		promptPath: repo.promptPath,
		projectPath: repo.projectPath,
		capability: "standard",
		files: [".logs/r.md"],
		checks: [],
		reportMode: true,
		deadlineMs: 100_000,
		...overrides,
	};
}

function dependencies(repo, provider) {
	return {
		now: () => 1_000,
		taskId: "simple-report-test",
		attemptId: "attempt-1",
		tmpdir: () => repo.root,
		acquireProjectLock: async () => {},
		releaseProjectLock: async () => true,
		route: () => ({ provider: "Codex (Spark)", reason: "priority_fill" }),
		resolveTargetIdentity: () => ({
			targetId: "codex",
			harnessKey: "codex",
			ambiguous: false,
		}),
		getInvocationDescriptor: () => ({
			target_id: "codex",
			selector: "gpt-5.3-codex-spark",
			invocation_args: [],
		}),
		assertFundedRoute: () => {},
		executeProvider: async ({ worktreePath }) => {
			provider(worktreePath);
			return { success: true, code: 0, writerLifecycle: "stopped" };
		},
		runCheck: async () => ({ success: true, writerLifecycle: "stopped" }),
		onRoutingWarning: () => {},
	};
}

function writeReport(worktreePath, content) {
	mkdirSync(join(worktreePath, ".logs"), { recursive: true });
	writeFileSync(join(worktreePath, ".logs", "r.md"), content, "utf8");
}

describe("simple report mode arguments", () => {
	it("sets files and reportMode and accepts no checks", () => {
		const repo = makeRepo();
		const parsed = parseSimpleArgs(
			parseBase(repo, ["--report", ".logs/r.md"]),
			{ now: () => 1_000 },
		);
		strictEqual(parsed.reportMode, true);
		deepStrictEqual(parsed.files, [".logs/r.md"]);
		deepStrictEqual(parsed.checks, []);
	});

	it("rejects --report combined with --file, --allow-manifest, --check or --dirty-overlay", () => {
		const repo = makeRepo();
		const parse = (extra) =>
			parseSimpleArgs(parseBase(repo, ["--report", ".logs/r.md", ...extra]), {
				now: () => 1_000,
			});
		throws(
			() => parse(["--file", "src/a.txt"]),
			/--report is mutually exclusive with --file/,
		);
		throws(
			() => parse(["--allow-manifest", "package.json"]),
			/--report is mutually exclusive with --allow-manifest/,
		);
		throws(
			() => parse(["--check", "true"]),
			/--report is mutually exclusive with --check/,
		);
		throws(
			() => parse(["--dirty-overlay"]),
			/--report is mutually exclusive with --dirty-overlay/,
		);
	});

	it("rejects a report path that already exists in the project", () => {
		const repo = makeRepo();
		writeFileSync(join(repo.projectPath, "existing.md"), "x\n", "utf8");
		throws(
			() =>
				parseSimpleArgs(parseBase(repo, ["--report", "existing.md"]), {
					now: () => 1_000,
				}),
			/--report path must not exist in the project: existing\.md/,
		);
	});
});

describe("simple report mode prompt", () => {
	it("appends the single-output rule", () => {
		const prompt = buildGuardedPrompt({
			promptText: "Write the report",
			files: [".logs/r.md"],
			reportMode: true,
		});
		strictEqual(
			prompt,
			"Write the report\n\nWork only in the current disposable checkout. Change only these writable files: .logs/r.md. Do not delegate, plan recursively, commit, push, access credentials, or change any other path.\n\nThis is a report-mode run: produce exactly one output file, the report at .logs/r.md, and change no other path.",
		);
	});
});

describe("simple report mode dispatch", () => {
	it("returns the report kind, bytes and sha256 for an ignored report", async () => {
		const repo = makeRepo();
		const content = "# Report\n\nall good\n";
		const result = await runSimpleTask(
			options(repo),
			dependencies(repo, (worktreePath) => writeReport(worktreePath, content)),
		);
		strictEqual(result.status, "succeeded", JSON.stringify(result));
		strictEqual(result.resultKind, "report");
		deepStrictEqual(result.changedFiles, [".logs/r.md"]);
		deepStrictEqual(result.report, {
			path: ".logs/r.md",
			bytes: Buffer.byteLength(content),
			sha256: createHash("sha256").update(content).digest("hex"),
		});
		strictEqual(
			readFileSync(join(repo.projectPath, ".logs", "r.md"), "utf8"),
			content,
		);
	});

	it("fails closed when another path changes", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo),
			dependencies(repo, (worktreePath) => {
				writeReport(worktreePath, "report\n");
				writeFileSync(
					join(worktreePath, "src", "a.txt"),
					"provider a\n",
					"utf8",
				);
			}),
		);
		strictEqual(result.status, "failed", JSON.stringify(result));
		strictEqual(result.failureReason, "undeclared_paths_changed");
		strictEqual(result.resultKind, "report");
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
			"base a\n",
		);
		strictEqual(existsSync(join(repo.projectPath, ".logs", "r.md")), false);
	});

	it("returns report_missing when no report is written", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo),
			dependencies(repo, () => {}),
		);
		strictEqual(result.status, "failed", JSON.stringify(result));
		strictEqual(result.failureReason, "report_missing");
		strictEqual(result.failurePhase, "diff");
	});

	it("returns report_missing for an empty report", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo),
			dependencies(repo, (worktreePath) => writeReport(worktreePath, "")),
		);
		strictEqual(result.status, "failed", JSON.stringify(result));
		strictEqual(result.failureReason, "report_missing");
	});
});
