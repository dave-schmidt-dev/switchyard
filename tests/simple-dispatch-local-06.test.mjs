import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { simpleQuarantinePath } from "../src/switchyard/simple/worktree-cleanup.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const originalTmpdirEnv = process.env.TMPDIR;
const originalRunStoreEnv = process.env.SWITCHYARD_RUN_STORE_ROOT;
const ORIGINAL_REAL_TMPDIR = realpathSync(tmpdir());
function listRealTmpSimpleDirectoryNames(
	dir = ORIGINAL_REAL_TMPDIR,
	prefix = "switchyard-simple-",
) {
	return new Set(
		readdirSync(dir, { withFileTypes: true })
			.filter((dirent) => dirent.name.startsWith(prefix))
			.map((dirent) => dirent.name),
	);
}
function findNewSimpleRoots(
	initialSnapshot,
	currentEntries,
	prefix = "switchyard-simple-",
) {
	const initialSet =
		initialSnapshot instanceof Set ? initialSnapshot : new Set(initialSnapshot);
	return Array.from(currentEntries).filter(
		(name) => name.startsWith(prefix) && !initialSet.has(name),
	);
}
function assertNoLeakedSimpleRoots(initialSnapshot, currentEntries, prefix) {
	const leaked = findNewSimpleRoots(initialSnapshot, currentEntries, prefix);
	deepStrictEqual(
		leaked,
		[],
		`isolated simple tests leaked real temp roots: ${leaked.join(", ")}`,
	);
}
const initialRealTmpSimpleRoots =
	listRealTmpSimpleDirectoryNames(ORIGINAL_REAL_TMPDIR);
const SUITE_TMPDIR = realpathSync(tempDir("switchyard-suite-tmp-"));
process.env.TMPDIR = SUITE_TMPDIR;
process.env.SWITCHYARD_RUN_STORE_ROOT = join(SUITE_TMPDIR, "run-store");
const retainedWorktrees = [];
function makeRepo() {
	const root = tempDir("switchyard-simple-test-");
	const projectPath = join(root, "project");
	mkdirSync(join(projectPath, "src"), { recursive: true });
	writeFileSync(join(projectPath, "src", "a.txt"), "base\n", "utf8");
	execFileSync("git", ["init", "-q"], { cwd: projectPath });
	execFileSync("git", ["add", "-A"], { cwd: projectPath });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Switchyard Tests",
			"-c",
			"user.email=switchyard@example.invalid",
			"commit",
			"-qm",
			"base",
		],
		{ cwd: projectPath },
	);
	const promptPath = join(root, "prompt.txt");
	writeFileSync(promptPath, "Change src/a.txt", "utf8");
	return { root, projectPath, promptPath };
}
function options(repo, overrides = {}) {
	return {
		promptPath: repo.promptPath,
		projectPath: repo.projectPath,
		capability: "standard",
		files: ["src/a.txt"],
		checks: ["test -f src/a.txt"],
		deadlineMs: 100_000,
		...overrides,
	};
}
function dependencies(overrides = {}) {
	return {
		now: () => 1_000,
		taskId: "simple-test",
		attemptId: "attempt-1",
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
			writeFileSync(join(worktreePath, "src", "a.txt"), "provider\n", "utf8");
			return { success: true, code: 0, writerLifecycle: "stopped" };
		},
		...overrides,
	};
}
afterEach(() => {
	for (const { worktreePath } of retainedWorktrees.splice(0)) {
		const root = dirname(resolve(worktreePath));
		if (
			dirname(root) === SUITE_TMPDIR &&
			basename(root).startsWith("switchyard-simple-")
		) {
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {}
		}
	}
	if (existsSync(SUITE_TMPDIR)) {
		for (const entry of readdirSync(SUITE_TMPDIR)) {
			if (/^switchyard-simple-[0-9a-f-]{36}$/u.test(entry)) {
				try {
					rmSync(join(SUITE_TMPDIR, entry), { recursive: true, force: true });
				} catch {}
			}
		}
	}
});
after(() => {
	const ownQuarantineRoots = [];
	const ownRealTmpRoots = [];
	const runsDir = join(SUITE_TMPDIR, "run-store", "runs");
	if (existsSync(runsDir)) {
		for (const entry of readdirSync(runsDir)) {
			const recordPath = join(runsDir, entry, "run.json");
			if (!existsSync(recordPath)) continue;
			const record = JSON.parse(readFileSync(recordPath, "utf8"));
			const recordedPath = record.worktree?.path;
			if (
				typeof recordedPath === "string" &&
				dirname(recordedPath) === ORIGINAL_REAL_TMPDIR &&
				existsSync(recordedPath)
			)
				ownRealTmpRoots.push(recordedPath);
			if (record.worktree?.nonce) {
				const quarantine = simpleQuarantinePath(record.worktree.nonce);
				if (existsSync(quarantine)) ownQuarantineRoots.push(quarantine);
			}
		}
	}
	if (originalTmpdirEnv === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpdirEnv;
	if (originalRunStoreEnv === undefined)
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	else process.env.SWITCHYARD_RUN_STORE_ROOT = originalRunStoreEnv;
	try {
		rmSync(SUITE_TMPDIR, { recursive: true, force: true });
	} catch {}

	const syntheticRoot = "switchyard-simple-synthetic-leak-check";
	deepStrictEqual(
		findNewSimpleRoots(initialRealTmpSimpleRoots, [
			...initialRealTmpSimpleRoots,
			syntheticRoot,
		]),
		[syntheticRoot],
	);
	throws(
		() =>
			assertNoLeakedSimpleRoots(initialRealTmpSimpleRoots, [
				...initialRealTmpSimpleRoots,
				syntheticRoot,
			]),
		/isolated simple tests leaked real temp roots/,
	);

	deepStrictEqual(
		ownRealTmpRoots,
		[],
		"simple tests leaked owned real temp roots",
	);
	deepStrictEqual(
		ownQuarantineRoots,
		[],
		"simple tests leaked owned quarantines",
	);
});
describe("simple local execution path", () => {
	it("executes one routed provider, checks in the worktree, and applies only its diff", async () => {
		const repo = makeRepo();
		const seen = { executions: 0, checks: 0 };
		const result = await runSimpleTask(
			options(repo),
			dependencies({
				route: (routeOptions) => {
					strictEqual(
						routeOptions.hasInvocationDescriptor("Codex (Spark)", "standard"),
						true,
					);
					return { provider: "Codex (Spark)", reason: "priority_fill" };
				},
				executeProvider: async ({ worktreePath, descriptor }) => {
					seen.executions += 1;
					strictEqual(descriptor.target_id, "codex");
					execFileSync("git", ["branch", "provider-local"], {
						cwd: worktreePath,
					});
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"changed\n",
						"utf8",
					);
					return { success: true, code: 0 };
				},
				runCheck: async ({ worktreePath }) => {
					seen.checks += 1;
					strictEqual(
						readFileSync(join(worktreePath, "src", "a.txt"), "utf8"),
						"changed\n",
					);
					return { success: true };
				},
			}),
		);
		strictEqual(result.status, "succeeded");
		strictEqual(result.provider, "Codex (Spark)");
		deepStrictEqual(result.changedFiles, ["src/a.txt"]);
		deepStrictEqual(result.checks, [{ index: 1, status: "passed" }]);
		deepStrictEqual(seen, { executions: 1, checks: 1 });
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
			"changed\n",
		);
		strictEqual(
			execFileSync("git", ["branch", "--list", "provider-local"], {
				cwd: repo.projectPath,
				encoding: "utf8",
			}).trim(),
			"",
		);
		strictEqual(result.partialWorktree, null);
	});
	it("emits evidence-only provider, change, capture, and check milestones", async () => {
		const repo = makeRepo();
		const events = [];
		const result = await runSimpleTask(
			options(repo),
			dependencies({ onStatus: (event) => events.push(event) }),
		);
		strictEqual(result.status, "succeeded");
		const milestones = events.map((event) => event.milestone).filter(Boolean);
		ok(milestones.includes("provider_started"));
		ok(milestones.includes("capture_started"));
		ok(milestones.includes("first_change_observed"));
		ok(milestones.includes("check_started"));
		ok(milestones.includes("check_finished"));
		const check = events.find((event) => event.milestone === "check_started");
		strictEqual(check.checkIndex, 1);
		strictEqual(check.checkIdentity.length, 64);
		strictEqual(JSON.stringify(events).includes("test -f src/a.txt"), false);
	});
	it("throttles first-change probes while keeping provider heartbeats", async () => {
		const repo = makeRepo();
		const events = [];
		let clock = 1_000;
		const result = await runSimpleTask(
			options(repo),
			dependencies({
				now: () => clock,
				onStatus: (event) => events.push(event),
				executeProvider: async ({ worktreePath, onProgress }) => {
					onProgress();
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"provider\n",
						"utf8",
					);
					clock += 1_000;
					onProgress();
					clock += 1_000;
					onProgress();
					return { success: true, code: 0, writerLifecycle: "stopped" };
				},
			}),
		);
		strictEqual(result.status, "succeeded");
		strictEqual(
			events.filter((event) => event.processPhase === "provider_running")
				.length,
			3,
		);
		strictEqual(
			events.find((event) => event.milestone === "first_change_observed")
				?.phase,
			"diff",
		);
	});
	it("runs real shell checks from the disposable worktree", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(options(repo), dependencies());
		strictEqual(result.status, "succeeded");
		deepStrictEqual(result.checks, [{ index: 1, status: "passed" }]);
	});
});
