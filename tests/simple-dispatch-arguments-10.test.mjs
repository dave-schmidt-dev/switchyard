import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
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
import { fileURLToPath } from "node:url";
import {
	buildSimpleProviderInvocation,
	handleSimple,
} from "../src/switchyard/simple/index.mjs";
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
const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const DISPATCH_PATH = resolve(
	__dirname,
	"..",
	"src",
	"switchyard",
	"dispatch",
	"index.mjs",
);
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
describe("simple dispatch argument boundary", () => {
	it("prints simple help directly instead of writing it as a result", async () => {
		const originalLog = console.log;
		const signalProcess = new EventEmitter();
		let printed = "";
		let resultWrites = 0;
		console.log = (message) => {
			printed = message;
		};
		try {
			await handleSimple(["--help"], {
				signalProcess,
				writeResult: () => {
					resultWrites += 1;
				},
			});
		} finally {
			console.log = originalLog;
		}
		ok(printed.includes("switchyard-dispatch simple"));
		strictEqual(resultWrites, 0);
	});
	it("runs Codex ephemerally with the workspace-write sandbox", () => {
		const repo = makeRepo();
		const invocation = buildSimpleProviderInvocation(
			"codex",
			{
				target_id: "codex",
				selector: "gpt-5.3-codex-spark",
				invocation_args: [],
			},
			"bounded task",
			join(repo.root, "worktree"),
			"codex",
		);
		strictEqual(invocation.command, "codex");
		ok(invocation.args.includes("--ephemeral"));
		ok(invocation.args.includes("--ignore-user-config"));
		ok(invocation.args.includes("--ignore-rules"));
		strictEqual(invocation.args.includes("-a"), false);
		strictEqual(invocation.args.includes("--approve-for-me"), false);
		const approvalIndex = invocation.args.indexOf('approval_policy="never"');
		ok(approvalIndex > 0);
		strictEqual(invocation.args[approvalIndex - 1], "-c");
		const sandboxIndex = invocation.args.indexOf("-s");
		strictEqual(invocation.args[sandboxIndex + 1], "workspace-write");
		const workdirIndex = invocation.args.indexOf("-C");
		strictEqual(invocation.args[workdirIndex + 1], join(repo.root, "worktree"));
		strictEqual(invocation.args.at(-1), "-");
		strictEqual(invocation.args.includes("bounded task"), false);
	});
	it("allows only bounded reasoning configuration from roster descriptors", () => {
		const repo = makeRepo();
		const safe = buildSimpleProviderInvocation(
			"codex",
			{
				target_id: "codex",
				selector: "gpt-5.3-codex-spark",
				invocation_args: ["-c", "model_reasoning_effort=high"],
			},
			"bounded task",
			join(repo.root, "worktree"),
			"codex",
		);
		ok(safe.args.includes("model_reasoning_effort=high"));
		for (const invocationArgs of [
			["-s", "danger-full-access"],
			["-c", "sandbox_workspace_write.network_access=true"],
			["-c"],
		]) {
			let threw = false;
			try {
				buildSimpleProviderInvocation(
					"codex",
					{
						target_id: "codex",
						selector: "gpt-5.3-codex-spark",
						invocation_args: invocationArgs,
					},
					"bounded task",
					join(repo.root, "worktree"),
					"codex",
				);
			} catch (error) {
				threw = error?.code === "local_descriptor_args_unsafe";
			}
			strictEqual(threw, true, invocationArgs.join(" "));
		}
	});
});
