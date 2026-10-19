// @test-phase: other
// Executable opt-in (`simple --allow-executable <path>`): only an exact
// declared path may be created as, or changed from 100644 to, a regular
// executable file. Every other executable bit, and every symlink, still fails
// closed. Fixtures are diffs git itself produced.

import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	integrationGate,
	validateDiff,
} from "../src/switchyard/integrate/index.mjs";
import { parseSimpleArgs } from "../src/switchyard/simple/index.mjs";
import { routingTaskIdentityHash } from "../src/switchyard/simple/routing-task-identity.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

function git(cwd, args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(seed = {}) {
	const dir = tempDir("switchyard-exec-optin-");
	git(dir, ["init", "-q"]);
	git(dir, ["config", "user.email", "test@test.com"]);
	git(dir, ["config", "user.name", "Test"]);
	writeFileSync(join(dir, "base.txt"), "base\n");
	mkdirSync(join(dir, "bin"));
	writeFileSync(join(dir, "bin", ".keep"), "");
	for (const [
		path,
		{ content = "x\n", mode = 0o644, link } = {},
	] of Object.entries(seed)) {
		if (link) symlinkSync(link, join(dir, path));
		else {
			writeFileSync(join(dir, path), content);
			chmodSync(join(dir, path), mode);
		}
	}
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-qm", "base"]);
	return dir;
}

// Builds the patch in a throwaway clone so the project tree stays clean for
// the gate's own apply.
function patchFor(projectPath, mutate) {
	const clone = join(tempDir("switchyard-exec-optin-clone-"), "c");
	git(projectPath, ["clone", "-q", projectPath, clone]);
	mutate(clone);
	git(clone, ["add", "-A"]);
	return git(clone, ["diff", "--cached", "--binary", "HEAD"]);
}

function createExecutable(dir, path) {
	writeFileSync(join(dir, path), "#!/bin/sh\necho ok\n");
	chmodSync(join(dir, path), 0o755);
}

describe("validateDiff executable opt-in", () => {
	it("grants a new executable only at the opted-in path", () => {
		const repo = makeRepo();
		const patch = patchFor(repo, (c) => createExecutable(c, "bin/tool"));
		strictEqual(
			validateDiff(patch, repo).reasonKind,
			"executable_file_refused",
		);
		strictEqual(
			validateDiff(patch, repo, { allowExecutables: ["bin/other"] }).reasonKind,
			"executable_file_refused",
		);
		const granted = validateDiff(patch, repo, {
			allowExecutables: ["bin/tool"],
		});
		strictEqual(granted.safe, true);
		deepStrictEqual(granted.touchedPaths, ["bin/tool"]);
	});

	it("still refuses a second executable that was not opted in", () => {
		const repo = makeRepo();
		const patch = patchFor(repo, (c) => {
			createExecutable(c, "bin/tool");
			createExecutable(c, "bin/other");
		});
		const result = validateDiff(patch, repo, {
			allowExecutables: ["bin/tool"],
		});
		strictEqual(result.reasonKind, "executable_file_refused");
		ok(result.reason.endsWith("bin/other"));
	});

	it("grants a 100644 to 100755 change only on the opted-in path", () => {
		const repo = makeRepo({ "bin/tool": {}, "bin/other": {} });
		const patch = patchFor(repo, (c) => chmodSync(join(c, "bin/tool"), 0o755));
		strictEqual(
			validateDiff(patch, repo, { allowExecutables: ["bin/other"] }).reasonKind,
			"executable_file_refused",
		);
		strictEqual(
			validateDiff(patch, repo, { allowExecutables: ["bin/tool"] }).safe,
			true,
		);
	});

	it("refuses a symlink turned into an executable even when opted in", () => {
		const repo = makeRepo({ "bin/tool": { link: "../base.txt" } });
		const patch = patchFor(repo, (c) => {
			unlinkSync(join(c, "bin/tool"));
			createExecutable(c, "bin/tool");
		});
		ok(patch.includes("deleted file mode 120000"));
		strictEqual(
			validateDiff(patch, repo, { allowExecutables: ["bin/tool"] }).reasonKind,
			"executable_file_refused",
		);
	});

	it("refuses a rename that also sets the executable bit", () => {
		const repo = makeRepo({ "bin/old": { content: "a\nb\nc\nd\n" } });
		const patch = patchFor(repo, (c) => {
			git(c, ["mv", "bin/old", "bin/tool"]);
			chmodSync(join(c, "bin/tool"), 0o755);
		});
		ok(patch.includes("rename to bin/tool"));
		strictEqual(
			validateDiff(patch, repo, { allowExecutables: ["bin/tool"] }).reasonKind,
			"executable_file_refused",
		);
	});

	it("refuses a newline-bearing name that forges an opted-in summary path", () => {
		const repo = makeRepo();
		const patch = patchFor(repo, (c) => createExecutable(c, "bin/tool\nx"));
		strictEqual(
			validateDiff(patch, repo, { allowExecutables: ["bin/tool"] }).reasonKind,
			"executable_file_refused",
		);
	});

	it("refuses a non-UTF-8 name that decodes to an opted-in path", () => {
		const repo = makeRepo();
		// Byte 0xFF is not UTF-8, so it decodes to U+FFFD: a different
		// filename from an opted-in path that spells U+FFFD itself.
		const patch =
			'diff --git "a/bin/tool\\377" "b/bin/tool\\377"\nnew file mode 100755\n' +
			'--- /dev/null\n+++ "b/bin/tool\\377"\n@@ -0,0 +1 @@\n+x\n';
		strictEqual(
			validateDiff(patch, repo, { allowExecutables: ["bin/tool\uFFFD"] })
				.reasonKind,
			"executable_file_refused",
		);
	});

	it("still refuses deleting an executable on an opted-in path", () => {
		const repo = makeRepo({ "bin/tool": { mode: 0o755 } });
		const patch = patchFor(repo, (c) => unlinkSync(join(c, "bin/tool")));
		strictEqual(
			validateDiff(patch, repo, { allowExecutables: ["bin/tool"] }).reasonKind,
			"executable_file_refused",
		);
	});

	it("still refuses symlink creation on an opted-in path", () => {
		const repo = makeRepo();
		const patch = patchFor(repo, (c) =>
			symlinkSync("../base.txt", join(c, "bin/tool")),
		);
		strictEqual(
			validateDiff(patch, repo, { allowExecutables: ["bin/tool"] }).reasonKind,
			"symlink_creation_refused",
		);
	});
});

describe("integrationGate executable opt-in", () => {
	it("applies an opted-in executable on a declared-path integration", () => {
		const repo = makeRepo();
		const patch = patchFor(repo, (c) => createExecutable(c, "bin/tool"));
		const result = integrationGate(patch, repo, {
			allowedPaths: ["bin/tool"],
			allowExecutables: ["bin/tool"],
		});
		strictEqual(result.success, true, result.message);
		strictEqual(statSync(join(repo, "bin/tool")).mode & 0o777, 0o755);
	});

	it("ignores the opt-in when the integration declares no paths", () => {
		const repo = makeRepo();
		const patch = patchFor(repo, (c) => createExecutable(c, "bin/tool"));
		const result = integrationGate(patch, repo, {
			allowExecutables: ["bin/tool"],
		});
		strictEqual(result.success, false);
		strictEqual(result.reasonKind, "executable_file_refused");
	});
});

describe("simple --allow-executable arguments", () => {
	function base(repo, check = ["--check", "true"]) {
		const promptPath = join(tempDir("switchyard-exec-optin-prompt-"), "p.txt");
		writeFileSync(promptPath, "Create bin/tool");
		return [
			promptPath,
			"--project",
			repo,
			"--capability",
			"standard",
			...check,
			"--deadline",
			"1970-01-01T00:10:00Z",
		];
	}
	const parse = (argv) => parseSimpleArgs(argv, { now: () => 1_000 });
	const refusal = (argv) => {
		try {
			parse(argv);
		} catch (error) {
			return error.message;
		}
		return null;
	};

	it("records declared opt-ins and defaults to none", () => {
		const repo = makeRepo();
		const args = base(repo);
		deepStrictEqual(
			parse([...args, "--file", "bin/tool", "--allow-executable", "bin/tool"])
				.allowExecutables,
			["bin/tool"],
		);
		deepStrictEqual(
			parse([...args, "--file", "bin/tool"]).allowExecutables,
			[],
		);
	});

	it("refuses an opt-in that is not also a declared --file", () => {
		const repo = makeRepo();
		strictEqual(
			refusal([
				...base(repo),
				"--file",
				"bin/tool",
				"--allow-executable",
				"bin/other",
			]),
			"--allow-executable path must also be declared with --file: bin/other",
		);
	});

	it("refuses a repeated opt-in", () => {
		const repo = makeRepo();
		strictEqual(
			refusal([
				...base(repo),
				"--file",
				"bin/tool",
				"--allow-executable",
				"bin/tool",
				"--allow-executable",
				"bin/tool",
			]),
			"--allow-executable paths must be unique",
		);
	});

	it("refuses an opt-in in report mode", () => {
		const repo = makeRepo();
		strictEqual(
			refusal([
				...base(repo, []),
				"--report",
				"docs/report.md",
				"--allow-executable",
				"docs/report.md",
			]),
			"--report is mutually exclusive with --allow-executable",
		);
	});

	it("refuses an unsafe opt-in path by its own flag name", () => {
		const repo = makeRepo();
		strictEqual(
			refusal([
				...base(repo),
				"--file",
				"bin/tool",
				"--allow-executable",
				"../bin/tool",
			]),
			"unsafe --allow-executable path: ../bin/tool",
		);
	});

	it("refuses an existing symlink even under --dirty-overlay", () => {
		const repo = makeRepo({ "bin/link": { link: "../base.txt" } });
		const args = [...base(repo), "--dirty-overlay", "--file", "bin/link"];
		strictEqual(refusal(args), null);
		strictEqual(
			refusal([...args, "--allow-executable", "bin/link"]),
			"unsafe --allow-executable boundary: bin/link",
		);
	});
});

describe("routing task identity records the executable opt-in", () => {
	it("keeps prior hashes when unused and changes them when used", () => {
		const promptPath = join(tempDir("switchyard-exec-optin-id-"), "p.txt");
		writeFileSync(promptPath, "Create bin/tool");
		const options = { promptPath, capability: "standard", files: ["bin/tool"] };
		const hash = (extra) =>
			routingTaskIdentityHash({ ...options, ...extra }, "/project", "work");
		// Pinned from the module before the opt-in existed: an unused opt-in
		// must not move an identity a live routing run already bound.
		const priorHash =
			"7199814d779c7b7d52612aa67e3a9b17187415f474e9c0a1a25e057066564a54";
		strictEqual(hash({}), priorHash);
		strictEqual(hash({ allowExecutables: [] }), priorHash);
		notStrictEqual(hash({ allowExecutables: ["bin/tool"] }), priorHash);
	});
});
