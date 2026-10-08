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
import { parseSimpleArgs } from "../src/switchyard/simple/index.mjs";
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
	it("requires one bounded absolute deadline and rejects missing or excessive values", () => {
		const repo = makeRepo();
		const base = [
			repo.promptPath,
			"--project",
			repo.projectPath,
			"--capability",
			"low",
			"--file",
			"src/a.txt",
			"--check",
			"true",
		];
		for (const extra of [
			[],
			["--deadline", "not-a-date"],
			["--deadline", "1970-01-01T00:00:00Z"],
			["--deadline", "1970-01-01T01:00:01Z"],
		]) {
			let threw = false;
			try {
				parseSimpleArgs([...base, ...extra], { now: () => 1_000 });
			} catch {
				threw = true;
			}
			strictEqual(threw, true);
		}
		const parsed = parseSimpleArgs(
			[...base, "--deadline", "1970-01-01T00:10:00Z"],
			{ now: () => 1_000 },
		);
		strictEqual(parsed.deadlineMs, 600_000);
	});
	it("accepts RFC3339 fractions with UTC and numeric offsets at millisecond precision", () => {
		const repo = makeRepo();
		const base = [
			repo.promptPath,
			"--project",
			repo.projectPath,
			"--capability",
			"low",
			"--file",
			"src/a.txt",
			"--check",
			"true",
		];
		const parseAt = (deadline, nowMs = 0) =>
			parseSimpleArgs([...base, "--deadline", deadline], {
				now: () => nowMs,
				onWarning: () => {},
			}).deadlineMs;
		for (const [fraction, expectedMillis] of [
			["1", 100],
			["12", 120],
			["123", 123],
			["123456", 123],
			["123456789", 123],
		]) {
			const expected = 600_000 + expectedMillis;
			strictEqual(parseAt(`1970-01-01T00:10:00.${fraction}Z`), expected);
			strictEqual(parseAt(`1970-01-01T01:10:00.${fraction}+01:00`), expected);
		}
		const leapDay = "2024-02-29T00:05:00.000Z";
		strictEqual(
			parseAt(leapDay, Date.parse("2024-02-28T23:50:00.000Z")),
			Date.parse(leapDay),
		);
		const centuryLeapDay = "2000-02-29T00:05:00.000Z";
		strictEqual(
			parseAt(centuryLeapDay, Date.parse("2000-02-28T23:50:00.000Z")),
			Date.parse(centuryLeapDay),
		);
		const earlyYearLeapDay = "0096-02-29T00:05:00.000Z";
		strictEqual(
			parseAt(earlyYearLeapDay, Date.parse("0096-02-28T23:50:00.000Z")),
			Date.parse(earlyYearLeapDay),
		);
	});
	it("rejects malformed RFC3339 fractions and separators", () => {
		const repo = makeRepo();
		const base = [
			repo.promptPath,
			"--project",
			repo.projectPath,
			"--capability",
			"low",
			"--file",
			"src/a.txt",
			"--check",
			"true",
		];
		const parseAt = (deadline, nowMs = 0) =>
			parseSimpleArgs([...base, "--deadline", deadline], {
				now: () => nowMs,
				onWarning: () => {},
			}).deadlineMs;
		for (const deadline of [
			"1970-01-01T00:10:00.Z",
			"1970-01-01T00:10:00.12xZ",
			"1970-01-01T00:10:00.123",
			"1970-01-01t00:10:00Z",
			"1970-01-01T00:10:00z",
			"1970-01-01T00:00:60Z",
		]) {
			throws(
				() => parseAt(deadline),
				/--deadline must be an RFC3339 timestamp/u,
			);
		}
	});
	it("rejects invalid Gregorian dates before Date.parse normalization", () => {
		const repo = makeRepo();
		const base = [
			repo.promptPath,
			"--project",
			repo.projectPath,
			"--capability",
			"low",
			"--file",
			"src/a.txt",
			"--check",
			"true",
		];
		const parseAt = (deadline, nowMs) =>
			parseSimpleArgs([...base, "--deadline", deadline], {
				now: () => nowMs,
				onWarning: () => {},
			}).deadlineMs;
		for (const [deadline, nowMs] of [
			["2025-02-29T00:00:00Z", Date.parse("2025-02-28T23:50:00Z")],
			["1900-02-29T00:00:00Z", Date.parse("1900-02-28T23:50:00Z")],
			["2025-04-31T00:00:00Z", Date.parse("2025-04-30T23:50:00Z")],
		]) {
			throws(
				() => parseAt(deadline, nowMs),
				/--deadline must be an RFC3339 timestamp/u,
			);
		}
	});
	it("rejects out-of-range clock and offset components", () => {
		const repo = makeRepo();
		const base = [
			repo.promptPath,
			"--project",
			repo.projectPath,
			"--capability",
			"low",
			"--file",
			"src/a.txt",
			"--check",
			"true",
		];
		const parseAt = (deadline, nowMs) =>
			parseSimpleArgs([...base, "--deadline", deadline], {
				now: () => nowMs,
				onWarning: () => {},
			}).deadlineMs;
		for (const [deadline, nowMs] of [
			["1970-01-01T24:00:00Z", Date.parse("1970-01-01T23:50:00Z")],
			["1970-01-01T00:60:00Z", Date.parse("1970-01-01T00:50:00Z")],
			["1970-01-01T00:10:00+24:00", Date.parse("1969-12-30T23:50:00Z")],
			["1970-01-01T00:10:00+00:60", Date.parse("1969-12-31T23:50:00Z")],
		]) {
			throws(
				() => parseAt(deadline, nowMs),
				/--deadline must be an RFC3339 timestamp/u,
			);
		}
	});
	it("enforces future and 30-minute bounds without admitting sub-millisecond excess", () => {
		const repo = makeRepo();
		const base = [
			repo.promptPath,
			"--project",
			repo.projectPath,
			"--capability",
			"low",
			"--file",
			"src/a.txt",
			"--check",
			"true",
		];
		const parseAt = (deadline, nowMs = 0) =>
			parseSimpleArgs([...base, "--deadline", deadline], {
				now: () => nowMs,
				onWarning: () => {},
			}).deadlineMs;
		strictEqual(parseAt("1970-01-01T00:30:00.000Z"), 1_800_000);
		for (const deadline of [
			"1970-01-01T00:30:00.001Z",
			"1970-01-01T00:30:00.000001Z",
		]) {
			throws(() => parseAt(deadline));
		}
		strictEqual(parseAt("1970-01-01T00:00:00.001Z"), 1);
		throws(() => parseAt("1970-01-01T00:00:00.000001Z"));
		throws(() => parseAt("1970-01-01T00:00:00Z"));
		throws(() => parseAt("1969-12-31T23:59:59.999Z"));
	});
	it("accepts one supported provider pin and rejects ambiguous or unsupported pins", () => {
		const repo = makeRepo();
		const base = [
			repo.promptPath,
			"--project",
			repo.projectPath,
			"--capability",
			"standard",
			"--file",
			"src/a.txt",
			"--check",
			"true",
			"--deadline",
			"1970-01-01T00:10:00Z",
		];
		strictEqual(
			parseSimpleArgs([...base, "--only-provider", "antigravity-claude"], {
				now: () => 1_000,
			}).onlyProviders[0],
			"antigravity-claude",
		);
		strictEqual(
			parseSimpleArgs([...base, "--only-provider", "cursor"], {
				now: () => 1_000,
			}).onlyProviders[0],
			"cursor",
		);
		for (const pin of ["antigravity-claude, codex", "agy"]) {
			throws(() =>
				parseSimpleArgs([...base, "--only-provider", pin], {
					now: () => 1_000,
				}),
			);
		}
		throws(() =>
			parseSimpleArgs(
				[
					...base,
					"--only-provider",
					"codex",
					"--only-provider",
					"antigravity-claude",
				],
				{ now: () => 1_000 },
			),
		);
	});
});
