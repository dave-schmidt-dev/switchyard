// @test-phase: other
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createSimpleCheckSessions } from "../src/switchyard/simple/check-session.mjs";
import {
	npmCiFailureDetails,
	sandboxDeniedPath,
} from "../src/switchyard/simple/check-setup-evidence.mjs";
import { nestedSandboxSkip } from "./helpers/nested-sandbox.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const failed = (stderr, output = "") => ({
	success: false,
	code: 1,
	output,
	stderr,
});

test("names the denied path in each tool's denial shape", () => {
	for (const [stderr, path] of [
		["/bin/sh: /Users/x/out.txt: Operation not permitted", "/Users/x/out.txt"],
		["touch: /Users/x/a b.txt: Operation not permitted", "/Users/x/a b.txt"],
		["touch: /Users/x/a:b: Operation not permitted", "/Users/x/a:b"],
		["/bin/sh: /Users/x/a:b: Operation not permitted", "/Users/x/a:b"],
		["sh: line 1: /Users/x/out: Operation not permitted", "/Users/x/out"],
		[
			"fatal: cannot mkdir /Users/x/repo: Operation not permitted",
			"/Users/x/repo",
		],
		[
			"Error: EPERM: operation not permitted, open '/Users/x/out.txt'",
			"/Users/x/out.txt",
		],
		[
			"PermissionError: [Errno 1] Operation not permitted: '/Users/x/out.txt'",
			"/Users/x/out.txt",
		],
		[
			"Sandbox: touch(42) deny(1) file-write-create /private/etc/out",
			"/private/etc/out",
		],
	])
		strictEqual(sandboxDeniedPath(failed(`noise\n${stderr}\nmore`)), path);
	// stdout is read when stderr names nothing.
	strictEqual(
		sandboxDeniedPath(failed("", "mkdir: /Users/x/d: Operation not permitted")),
		"/Users/x/d",
	);
	// The first denial is the root cause; later lines may only cascade from it.
	strictEqual(
		sandboxDeniedPath(
			failed(
				"touch: /first: Operation not permitted\ntouch: /second: Operation not permitted",
			),
		),
		"/first",
	);
});

test("names nothing without a bounded absolute denied path", () => {
	for (const check of [
		null,
		{ success: true, stderr: "touch: /x: Operation not permitted" },
		failed("Operation not permitted"),
		failed("ls: relative/path: Operation not permitted"),
		// A `: /` inside the path is indistinguishable from a tool prefix.
		failed("/bin/sh: /Users/x/a: /b: Operation not permitted"),
		failed("touch: /Users/x/a: /b: Operation not permitted"),
		failed("fatal: cannot mkdir /Users/x/a: /b: Operation not permitted"),
		failed("expected /a/b to equal /c/d"),
		failed(`touch: /${"p".repeat(1024)}: Operation not permitted`),
	])
		strictEqual(sandboxDeniedPath(check), null);
});

test("redacts credential shapes before naming the path", () => {
	const token = "sk-fixture-denied-path-token-0000";
	const path = sandboxDeniedPath(
		failed(`touch: /Users/x/${token}/out: Operation not permitted`),
	);
	strictEqual(path, "/Users/x/[REDACTED]/out");
	ok(!path.includes(token));
});

test("only the tail the evidence file keeps is searched", () => {
	const early = "touch: /early: Operation not permitted\n";
	strictEqual(sandboxDeniedPath(failed(`${early}${"x".repeat(20_000)}`)), null);
});

test("a failed npm ci setup names its denied path", () => {
	const details = npmCiFailureDetails(
		failed("npm error EPERM: operation not permitted, mkdir '/Users/x/.npm'"),
		null,
	);
	strictEqual(details.sandboxDeniedPath, "/Users/x/.npm");
	deepStrictEqual(npmCiFailureDetails({ success: true }, null), {
		dependencyCheck: "npm_ci_failed",
	});
});

function git(path, args) {
	return execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
}

test("a check that writes outside its grants fails naming the denied path", {
	skip: nestedSandboxSkip,
}, async () => {
	const root = tempDir("switchyard-check-denied-path-");
	const projectPath = join(root, "project");
	mkdirSync(projectPath);
	writeFileSync(join(projectPath, "a.txt"), "base\n");
	git(projectPath, ["init", "-q"]);
	git(projectPath, ["add", "."]);
	git(projectPath, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"fixture",
	]);
	// The task root is outside every checker grant: only the checker's own
	// clone and runtime are writable.
	const outside = join(root, "outside.txt");
	const evidenceDir = join(root, "evidence");
	const session = createSimpleCheckSessions({
		taskRoot: root,
		projectPath,
		baseRevision: git(projectPath, ["rev-parse", "HEAD"]),
		baseTree: git(projectPath, ["rev-parse", "HEAD^{tree}"]),
		files: ["a.txt"],
		commands: ["test -f a.txt"],
		taskId: "denied-path-check",
		deadlineMs: Date.now() + 120_000,
		evidenceDir,
	});
	try {
		await session.prepare();
		const result = await session.run({
			command: `sh -c 'echo x > ${outside}'`,
		});
		strictEqual(result.success, false);
		strictEqual(result.sandboxDeniedPath, outside);
		strictEqual(existsSync(outside), false);
		ok(
			readFileSync(result.outputPath, "utf8").includes(
				"Operation not permitted",
			),
		);
		const passed = await session.run({ command: "test -f a.txt" });
		strictEqual(passed.success, true);
		strictEqual("sandboxDeniedPath" in passed, false);
	} finally {
		session.remove();
	}
});
