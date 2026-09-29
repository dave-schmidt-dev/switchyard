import { deepStrictEqual, strictEqual, throws } from "node:assert";
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
import {
	buildSimpleProviderInvocation,
	simpleProviderCompatibility,
	simpleRouteIsFunded,
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
	it("rejects malformed bridge descriptors and harness mismatches", () => {
		const opencode = {
			target_id: "opencode-go",
			selector: "opencode-go/deepseek-v4.1-flash",
		};
		for (const invocation_args of [
			undefined,
			[],
			["--variant", "standard"],
			["--variant", "low", "--extra", "value"],
		]) {
			throws(
				() =>
					buildSimpleProviderInvocation(
						"opencode",
						{ ...opencode, invocation_args },
						"work",
						"/tmp/worktree",
						"opencode-go",
						"low",
					),
				{ code: "local_descriptor_args_unsafe" },
			);
		}
		throws(
			() =>
				buildSimpleProviderInvocation(
					"vibe",
					{
						target_id: "vibe",
						selector: "glm-5-3",
						invocation_args: ["--variant", "low"],
					},
					"work",
					"/tmp/worktree",
					"vibe",
					"standard",
				),
			{ code: "local_descriptor_args_unsafe" },
		);
		deepStrictEqual(
			simpleProviderCompatibility({
				targetId: "vibe",
				harness: "opencode",
				descriptor: {
					target_id: "vibe",
					selector: "glm-5-3",
					invocation_args: [],
				},
			}),
			{ compatible: false, reason: "local_adapter_unavailable" },
		);
		deepStrictEqual(
			simpleProviderCompatibility({
				targetId: "vibe",
				harness: "vibe",
				capability: "standard",
				descriptor: {
					target_id: "vibe",
					selector: "glm-5-3-unknown",
					invocation_args: [],
				},
			}),
			{ compatible: false, reason: "local_descriptor_model_unavailable" },
		);
	});
	it("admits included subscription and quota funding without paid overage", () => {
		for (const mode of ["subscription", "quota"]) {
			strictEqual(
				simpleRouteIsFunded({
					enabled: true,
					funding: {
						included: { mode },
						overage: { enabled: false },
					},
				}),
				true,
			);
		}
		strictEqual(
			simpleRouteIsFunded({
				enabled: true,
				funding: {
					included: { mode: "quota" },
					overage: { enabled: true },
				},
			}),
			false,
		);
	});
});
