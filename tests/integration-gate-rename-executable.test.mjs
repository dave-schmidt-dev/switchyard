// @test-phase: other
// A pure rename or copy patch states no mode, so the destination silently
// kept an executable source's bit without `executable_file_refused` or the
// `--allow-executable` opt-in. validateDiff now refuses every rename or copy
// spelling, and Switchyard's own captures are rename-free (`--no-renames`), so
// each mode is spelled out as a delete plus create. Fixtures are diffs git
// itself produced.

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { validateDiff } from "../src/switchyard/integrate/index.mjs";
import { gateCandidate } from "../src/switchyard/runner/reliability.mjs";
import { worktreeGit } from "../src/switchyard/simple/git-control.mjs";
import { planContinuation } from "../src/switchyard/simple/partial-continuation.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const SCRIPT = "#!/bin/sh\necho one\necho two\necho three\n";
const RENAMES = ["-M"];
const COPIES = ["-C", "--find-copies-harder"];
const RENAME_FREE = ["--no-renames"];

function git(cwd, args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(mode) {
	const dir = tempDir("switchyard-rename-exec-");
	git(dir, ["init", "-q"]);
	git(dir, ["config", "user.email", "test@test.com"]);
	git(dir, ["config", "user.name", "Test"]);
	mkdirSync(join(dir, "bin"));
	writeFileSync(join(dir, "bin", "run"), SCRIPT);
	chmodSync(join(dir, "bin", "run"), mode);
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-qm", "base"]);
	return dir;
}

// Builds the patch in a throwaway clone so the project tree stays clean.
function patchFor(projectPath, mutate, flags) {
	const clone = join(tempDir("switchyard-rename-exec-clone-"), "c");
	git(projectPath, ["clone", "-q", projectPath, clone]);
	mutate(clone);
	git(clone, ["add", "-A"]);
	return git(clone, [
		"diff",
		"--cached",
		"--binary",
		"--full-index",
		...flags,
		"HEAD",
	]);
}

const move = (c) => git(c, ["mv", "bin/run", "bin/tool"]);
const copy = (c) => {
	copyFileSync(join(c, "bin/run"), join(c, "bin/tool"));
	chmodSync(join(c, "bin/tool"), statSync(join(c, "bin/run")).mode);
};
const moveAndChmod = (c) => {
	move(c);
	chmodSync(join(c, "bin/tool"), 0o755);
};

// The three shapes the brief names, each spelled the way git's rename or
// copy detection prints it.
const DETECTED = [
	{
		name: "a rename of an executable",
		mode: 0o755,
		mutate: move,
		flags: RENAMES,
		markers: ["rename from bin/run"],
	},
	{
		name: "a copy of an executable",
		mode: 0o755,
		mutate: copy,
		flags: COPIES,
		markers: ["copy from bin/run"],
	},
	{
		name: "a rename that also sets the executable bit",
		mode: 0o644,
		mutate: moveAndChmod,
		flags: RENAMES,
		markers: ["rename from bin/run", "new mode 100755"],
	},
];

function detectedPatch(shape) {
	const repo = makeRepo(shape.mode);
	const patch = patchFor(repo, shape.mutate, shape.flags);
	for (const marker of shape.markers)
		ok(patch.includes(marker), `fixture must contain ${marker}`);
	return { repo, patch };
}

describe("validateDiff rename and copy spellings", () => {
	for (const shape of DETECTED) {
		it(`refuses ${shape.name} even when the destination is opted in`, () => {
			const { repo, patch } = detectedPatch(shape);
			const result = validateDiff(patch, repo, {
				allowExecutables: ["bin/tool"],
			});
			strictEqual(result.reasonKind, "executable_file_refused");
			ok(result.reason.includes("renames or copies"), result.reason);
		});
	}

	it("refuses a rename that clears the executable bit and a plain rename", () => {
		for (const [mode, mutate] of [
			[
				0o755,
				(c) => {
					move(c);
					chmodSync(join(c, "bin/tool"), 0o644);
				},
			],
			[0o644, move],
		]) {
			const repo = makeRepo(mode);
			const patch = patchFor(repo, mutate, RENAMES);
			ok(patch.includes("rename from bin/run"));
			strictEqual(
				validateDiff(patch, repo).reasonKind,
				"executable_file_refused",
			);
		}
	});
});

describe("validateDiff rename detection from patch headers", () => {
	it("refuses a rename whose quoted name holds a newline", () => {
		const repo = makeRepo(0o755);
		const patch = patchFor(
			repo,
			(c) => git(c, ["mv", "bin/run", "bin/r\nun"]),
			RENAMES,
		);
		ok(patch.includes('rename to "bin/r\\nun"'));
		strictEqual(
			validateDiff(patch, repo).reasonKind,
			"executable_file_refused",
		);
	});

	it("refuses the legacy rename old/new header spelling git apply still honours", () => {
		const repo = makeRepo(0o755);
		const patch =
			"diff --git a/bin/run b/bin/tool\nsimilarity index 100%\n" +
			"rename old bin/run\nrename new bin/tool\n";
		strictEqual(
			validateDiff(patch, repo).reasonKind,
			"executable_file_refused",
		);
	});

	it("accepts new plain files whose names spell a rename or copy line", () => {
		const repo = makeRepo(0o644);
		const patch = patchFor(
			repo,
			(c) => {
				writeFileSync(join(c, "foo\n rename bar"), "y\n");
				writeFileSync(join(c, "baz\n copy qux"), "y\n");
			},
			RENAMES,
		);
		strictEqual(validateDiff(patch, repo).safe, true);
	});

	it("accepts file content that spells a rename or copy line after a CR or line separator", () => {
		const repo = makeRepo(0o644);
		const patch = patchFor(
			repo,
			(c) =>
				writeFileSync(
					join(c, "notes.txt"),
					"foo\rrename from bar\nbaz\u2028copy to qux\nend\u2029rename to x\n",
				),
			RENAMES,
		);
		ok(patch.includes("\rrename from bar"));
		strictEqual(validateDiff(patch, repo).safe, true);
	});
});

describe("validateDiff rename-free spellings", () => {
	it("refuses moving an executable even with the destination opted in", () => {
		const repo = makeRepo(0o755);
		const patch = patchFor(repo, move, RENAME_FREE);
		const result = validateDiff(patch, repo, {
			allowExecutables: ["bin/tool"],
		});
		strictEqual(result.reasonKind, "executable_file_refused");
		ok(result.reason.endsWith("delete mode 100755 bin/run"), result.reason);
	});

	it("grants a copied executable only at the opted-in destination", () => {
		const repo = makeRepo(0o755);
		const patch = patchFor(repo, copy, RENAME_FREE);
		ok(patch.includes("new file mode 100755"));
		strictEqual(
			validateDiff(patch, repo).reasonKind,
			"executable_file_refused",
		);
		strictEqual(
			validateDiff(patch, repo, { allowExecutables: ["bin/tool"] }).safe,
			true,
		);
	});

	it("grants a move that sets the bit only at the opted-in destination", () => {
		const repo = makeRepo(0o644);
		const patch = patchFor(repo, moveAndChmod, RENAME_FREE);
		strictEqual(
			validateDiff(patch, repo).reasonKind,
			"executable_file_refused",
		);
		strictEqual(
			validateDiff(patch, repo, { allowExecutables: ["bin/tool"] }).safe,
			true,
		);
	});

	it("accepts moving a plain file", () => {
		const repo = makeRepo(0o644);
		const result = validateDiff(patchFor(repo, move, RENAME_FREE), repo);
		strictEqual(result.safe, true);
		deepStrictEqual(result.touchedPaths.sort(), ["bin/run", "bin/tool"]);
	});
});

describe("worktreeGit diff capture", () => {
	it("never detects a rename or copy, even when repo config asks for copies", () => {
		const repo = makeRepo(0o755);
		git(repo, ["config", "diff.renames", "copies"]);
		move(repo);
		copyFileSync(join(repo, "bin/tool"), join(repo, "bin/copy"));
		chmodSync(join(repo, "bin/copy"), 0o755);
		git(repo, ["add", "-A"]);
		ok(git(repo, ["diff", "--cached", "HEAD"]).includes("rename from"));
		const capture = worktreeGit(repo, [
			"diff",
			"--cached",
			"--binary",
			"--full-index",
			"HEAD",
		]);
		strictEqual(capture.status, 0);
		ok(!/^(?:rename|copy) (?:from|to) /mu.test(capture.stdout));
		ok(capture.stdout.includes("deleted file mode 100755"));
		strictEqual(capture.stdout.split("new file mode 100755").length, 3);
		const names = worktreeGit(repo, [
			"diff",
			"--cached",
			"--name-only",
			"-z",
			"HEAD",
		]);
		deepStrictEqual(names.stdout.split("\0").filter(Boolean).sort(), [
			"bin/copy",
			"bin/run",
			"bin/tool",
		]);
	});
});

describe("runner quick-check gate", () => {
	const env = { PATH: process.env.PATH, HOME: process.env.HOME };
	for (const shape of DETECTED) {
		it(`rejects ${shape.name}`, () => {
			const { repo, patch } = detectedPatch(shape);
			strictEqual(
				gateCandidate(repo, env, patch, ["bin/run", "bin/tool"], false),
				false,
			);
			strictEqual(existsSync(join(repo, "bin/tool")), false);
		});
	}

	it("passes a rename-free move of a plain file", () => {
		const repo = makeRepo(0o644);
		const patch = patchFor(repo, move, RENAME_FREE);
		strictEqual(
			gateCandidate(repo, env, patch, ["bin/run", "bin/tool"], false),
			true,
		);
		strictEqual(existsSync(join(repo, "bin/tool")), true);
	});
});

describe("partial-continuation carry", () => {
	const stopped = (repo, patch) => ({
		attemptId: "attempt-a",
		partialWorktree: "/retained/attempt-a",
		result: { recovery: { cleanup: { writer: { state: "stopped" } } } },
		record: { worktree: { writerStopped: true, path: "/retained/attempt-a" } },
		captured: {
			diff: patch,
			changedFiles: ["bin/run", "bin/tool"],
			baseRevision: git(repo, ["rev-parse", "HEAD"]).trim(),
		},
	});
	const plan = (repo, patch) =>
		planContinuation({
			source: stopped(repo, patch),
			options: { files: ["bin/run", "bin/tool"] },
			projectPath: repo,
		});

	for (const shape of DETECTED) {
		it(`does not carry ${shape.name}`, () => {
			const { repo, patch } = detectedPatch(shape);
			strictEqual(plan(repo, patch).skipped, "unsafe_diff");
		});
	}

	it("carries a rename-free move of a plain file", () => {
		const repo = makeRepo(0o644);
		const carried = plan(repo, patchFor(repo, move, RENAME_FREE));
		strictEqual(carried.skipped, undefined);
		deepStrictEqual(carried.files.sort(), ["bin/run", "bin/tool"]);
	});
});
