import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { EventEmitter } from "node:events";
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	buildSimpleProviderInvocation,
	defaultExecuteProvider,
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
const retainedWorktrees = [];
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
	it("uses only fixed bridge consumers for Vibe and OpenCode Go", async () => {
		const worktreePath = "/tmp/worktree";
		const prompt = "bounded task";
		const cases = [
			{
				harness: "vibe",
				capability: "low",
				descriptor: {
					target_id: "vibe",
					selector: "glm-5-3-medium",
					invocation_args: [],
				},
				command: "/Users/dave/.agent/bin/bws-secret-exec",
				args: [
					"switchyard-simple-vibe-dispatch",
					"--",
					"--target",
					"vibe",
					"--model",
					"glm-5-3-medium",
					"--worktree",
					worktreePath,
				],
			},
			{
				harness: "vibe",
				capability: "standard",
				descriptor: {
					target_id: "vibe",
					selector: "glm-5-3",
					invocation_args: [],
				},
				command: "/Users/dave/.agent/bin/bws-secret-exec",
				args: [
					"switchyard-simple-vibe-dispatch",
					"--",
					"--target",
					"vibe",
					"--model",
					"glm-5-3",
					"--worktree",
					worktreePath,
				],
			},
			{
				harness: "opencode",
				capability: "low",
				descriptor: {
					target_id: "opencode-go",
					selector: "opencode-go/deepseek-v4.1-flash",
					invocation_args: ["--variant", "low"],
				},
				command: "/Users/dave/.agent/bin/bws-secret-exec",
				args: [
					"switchyard-simple-opencode-go-dispatch",
					"--",
					"--target",
					"opencode-go",
					"--model",
					"opencode-go/deepseek-v4.1-flash",
					"--worktree",
					worktreePath,
					"--variant",
					"low",
				],
			},
			{
				harness: "opencode",
				capability: "standard",
				descriptor: {
					target_id: "opencode-go",
					selector: "opencode-go/deepseek-v4.1-flash",
					invocation_args: ["--variant", "max"],
				},
				command: "/Users/dave/.agent/bin/bws-secret-exec",
				args: [
					"switchyard-simple-opencode-go-dispatch",
					"--",
					"--target",
					"opencode-go",
					"--model",
					"opencode-go/deepseek-v4.1-flash",
					"--worktree",
					worktreePath,
					"--variant",
					"max",
				],
			},
		];
		for (const testCase of cases) {
			const invocation = buildSimpleProviderInvocation(
				testCase.harness,
				testCase.descriptor,
				prompt,
				worktreePath,
				testCase.descriptor.target_id,
				testCase.capability,
			);
			strictEqual(invocation.command, testCase.command);
			deepStrictEqual(invocation.args, testCase.args);
			strictEqual(invocation.args.includes(prompt), false);
			strictEqual(
				/(?:api[_-]?key|token|secret|password)/iu.test(
					invocation.args.join(" "),
				),
				false,
			);
		}

		let receivedInput = null;
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = {
			end: (value) => {
				receivedInput = value;
			},
		};
		const result = await defaultExecuteProvider({
			targetId: "vibe",
			harness: "vibe",
			descriptor: cases[1].descriptor,
			capability: "standard",
			prompt,
			worktreePath,
			timeoutMs: 1_000,
			spawnFn: () => {
				queueMicrotask(() => child.emit("close", 0, null));
				return child;
			},
		});
		strictEqual(result.success, true);
		strictEqual(receivedInput, prompt);
	});
});
