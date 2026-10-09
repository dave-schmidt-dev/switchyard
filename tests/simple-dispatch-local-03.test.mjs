import { deepStrictEqual, strictEqual, throws } from "node:assert";
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
				dirname(recordedPath) ===
					join(ORIGINAL_REAL_TMPDIR, "switchyard-simple-roots") &&
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
	it("offers only exact locally compatible targets to automatic routing", async () => {
		const repo = makeRepo();
		let routedOptions = null;
		const identities = {
			codex: { targetId: "codex", harnessKey: "codex", ambiguous: false },
			antigravity: {
				targetId: "antigravity",
				harnessKey: "agy",
				ambiguous: false,
			},
			"antigravity-claude": {
				targetId: "antigravity-claude",
				harnessKey: "agy",
				ambiguous: false,
			},
			"copilot-student": {
				targetId: "copilot-student",
				harnessKey: "copilot",
				ambiguous: false,
			},
			vibe: { targetId: "vibe", harnessKey: "vibe", ambiguous: false },
			"vibe-code": {
				targetId: "vibe-code",
				harnessKey: "vibe",
				ambiguous: false,
			},
			"opencode-go": {
				targetId: "opencode-go",
				harnessKey: "opencode",
				ambiguous: false,
			},
		};
		const descriptors = {
			codex: {
				target_id: "codex",
				selector: "gpt-5.6-luna",
				invocation_args: [],
			},
			antigravity: {
				target_id: "antigravity",
				selector: "gemini-3.8-flash-medium",
				invocation_args: [],
			},
			"copilot-student": {
				target_id: "copilot-student",
				selector: "auto",
				invocation_args: [],
			},
			vibe: {
				target_id: "vibe",
				selector: "glm-5-3-medium",
				invocation_args: [],
			},
			"opencode-go": {
				target_id: "opencode-go",
				selector: "opencode-go/deepseek-v4.1-flash",
				invocation_args: ["--variant", "low"],
			},
		};
		const result = await runSimpleTask(
			options(repo, { capability: "low" }),
			dependencies({
				route: (routeOptions) => {
					routedOptions = routeOptions;
					return { provider: null, reason: "test_stop" };
				},
				resolveTargetIdentity: (name) =>
					identities[name] ?? {
						targetId: name,
						harnessKey: null,
						ambiguous: true,
					},
				getInvocationDescriptor: (name) => descriptors[name] ?? null,
			}),
		);
		deepStrictEqual(routedOptions.availableProviders, [
			"codex",
			"antigravity",
			"copilot-student",
			"vibe",
			"opencode-go",
		]);
		strictEqual(result.failureReason, "test_stop");
		strictEqual(result.failurePhase, "route");
		let pinnedOptions = null;
		const pinnedLowResult = await runSimpleTask(
			options(repo, { capability: "low", onlyProviders: ["vibe"] }),
			dependencies({
				route: (routeOptions) => {
					pinnedOptions = routeOptions;
					return { provider: null, reason: "test_stop" };
				},
				resolveTargetIdentity: (name) =>
					identities[name] ?? {
						targetId: name,
						harnessKey: null,
						ambiguous: true,
					},
				getInvocationDescriptor: (name) => descriptors[name] ?? null,
			}),
		);
		deepStrictEqual(pinnedOptions.availableProviders, ["vibe"]);
		strictEqual(pinnedLowResult.failureReason, "test_stop");
		strictEqual(pinnedLowResult.failurePhase, "route");
		routedOptions = null;
		const standardResult = await runSimpleTask(
			options(repo, { capability: "standard" }),
			dependencies({
				route: (routeOptions) => {
					routedOptions = routeOptions;
					return { provider: null, reason: "test_stop" };
				},
				resolveTargetIdentity: (name) =>
					identities[name] ?? {
						targetId: name,
						harnessKey: null,
						ambiguous: true,
					},
				getInvocationDescriptor: (name) => {
					if (name === "vibe")
						return { ...descriptors.vibe, selector: "glm-5-3" };
					if (name === "opencode-go")
						return {
							...descriptors[name],
							invocation_args: ["--variant", "max"],
						};
					return descriptors[name] ?? null;
				},
			}),
		);
		strictEqual(standardResult.failureReason, "test_stop");
		strictEqual(routedOptions.availableProviders.includes("vibe"), true);
		strictEqual(routedOptions.availableProviders.includes("opencode-go"), true);
	});
});
