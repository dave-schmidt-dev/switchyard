import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
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
import { fileURLToPath } from "node:url";
import { buildSimpleProviderInvocation } from "../src/switchyard/simple/index.mjs";
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
	it("keeps Gemini and Claude Antigravity targets distinct", () => {
		const gemini = buildSimpleProviderInvocation(
			"agy",
			{
				target_id: "antigravity",
				selector: "gemini-3.8-flash-high",
			},
			"work",
			"/tmp/worktree",
			"antigravity",
		);
		strictEqual(gemini.command, "agy");
		deepStrictEqual(gemini.args, [
			"--new-project",
			"--mode",
			"accept-edits",
			"--dangerously-skip-permissions",
			"--sandbox",
			"--model",
			"gemini-3.8-flash-high",
			"--add-dir",
			"/tmp/worktree",
			"--output-format",
			"json",
			"--print-timeout",
			"30m",
			"--print",
			"work",
		]);
		const claude = buildSimpleProviderInvocation(
			"agy",
			{
				target_id: "antigravity-claude",
				selector: "claude-sonnet-4-6",
			},
			"work",
			"/tmp/worktree",
			"antigravity-claude",
		);
		strictEqual(
			claude.args[claude.args.indexOf("--model") + 1],
			"claude-sonnet-4-6",
		);
		throws(() =>
			buildSimpleProviderInvocation(
				"agy",
				{ target_id: "antigravity", selector: "claude-sonnet-4-6" },
				"work",
				"/tmp/worktree",
				"antigravity",
			),
		);
	});
	it("runs Copilot with a session-only sandbox and no shell or broad permissions", () => {
		const invocation = buildSimpleProviderInvocation(
			"copilot",
			{ target_id: "copilot-student", selector: "auto" },
			"work",
			"/tmp/worktree",
			"copilot-student",
		);
		strictEqual(invocation.command, "copilot");
		for (const flag of [
			"--experimental",
			"--sandbox",
			"--disallow-temp-dir",
			"--disable-builtin-mcps",
			"--no-custom-instructions",
			"--no-ask-user",
			"--no-auto-update",
		]) {
			ok(invocation.args.includes(flag), flag);
		}
		strictEqual(
			invocation.args[invocation.args.indexOf("--available-tools") + 1],
			"apply_patch,create,edit,view,glob,grep",
		);
		strictEqual(invocation.args.includes("shell"), false);
		strictEqual(invocation.args.includes("--allow-all"), false);
		strictEqual(invocation.args.includes("--allow-all-paths"), false);
		strictEqual(invocation.args.includes("--yolo"), false);
		strictEqual(
			invocation.args[invocation.args.indexOf("-C") + 1],
			"/tmp/worktree",
		);
	});
});
