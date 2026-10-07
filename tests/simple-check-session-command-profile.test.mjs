import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import {
	isXcodebuildBuild,
	quickCheckSandboxProfile,
	safeEnv,
	xcodebuildActions,
} from "../src/switchyard/runner/checks-sandbox.mjs";
import { runCommand } from "../src/switchyard/runner/reliability.mjs";
import { createSimpleCheckSessions } from "../src/switchyard/simple/check-session.mjs";
import { validateCheckCommand } from "../src/switchyard/simple/check-validation.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const XCODE_SELECT_LINK = "/var/db/xcode_select_link";
const GRANT = /com\.apple\.bsd\.dirhelper/u;
const XCODEBUILD_BUILD = [
	"xcodebuild build",
	"-IDEPackageSupportDisableManifestSandbox=YES",
	"-scheme Fix",
	'-destination "generic/platform=macOS"',
	'-derivedDataPath "$PWD/.sy/dd"',
	'-resultBundlePath "$PWD/.sy/rb.xcresult"',
	'-clonedSourcePackagesDirPath "$PWD/.sy/sp"',
	'-packageCachePath "$PWD/.sy/pc"',
	"CODE_SIGNING_ALLOWED=NO",
].join(" ");

function xcodeSelected() {
	if (process.platform !== "darwin") return false;
	try {
		return readlinkSync(XCODE_SELECT_LINK).length > 0;
	} catch {
		return false;
	}
}
const darwinSkip =
	process.platform === "darwin" ? false : "requires macOS sandbox-exec";
const xcodeSkip = xcodeSelected()
	? false
	: "requires a selected Xcode developer directory";

function userTempDir() {
	const result = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
		encoding: "utf8",
	});
	strictEqual(result.status, 0);
	return realpathSync(result.stdout.trim());
}

const cleanup = [];
after(() => {
	for (const path of cleanup) rmSync(path, { recursive: true, force: true });
});

function git(project, args) {
	const result = spawnSync("git", args, { cwd: project, encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

/** A committed Swift package project inside a fresh task root. */
function project() {
	const root = realpathSync(tempDir("switchyard-command-profile-"));
	const path = join(root, "project");
	mkdirSync(join(path, "Sources/Fix"), { recursive: true });
	writeFileSync(
		join(path, "Package.swift"),
		[
			"// swift-tools-version:5.9",
			"import PackageDescription",
			"let package = Package(",
			'\tname: "Fix",',
			'\tproducts: [.library(name: "Fix", targets: ["Fix"])],',
			'\ttargets: [.target(name: "Fix")]',
			")",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(path, "Sources/Fix/Fix.swift"),
		"public func fix() -> Int { 1 }\n",
	);
	writeFileSync(join(path, ".gitignore"), ".sy/\n");
	git(path, ["init", "-q"]);
	git(path, ["add", "."]);
	git(path, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"base",
	]);
	return { root, path };
}

function session(repo, commands) {
	return createSimpleCheckSessions({
		taskRoot: repo.root,
		projectPath: repo.path,
		baseRevision: git(repo.path, ["rev-parse", "HEAD"]),
		baseTree: git(repo.path, ["rev-parse", "HEAD^{tree}"]),
		files: ["Sources/Fix/Fix.swift"],
		commands,
		taskId: "command-profile",
		deadlineMs: Date.now() + 600_000,
	});
}

/** Track SwiftPM lock files named after this task root's paths. */
function trackLocks(root) {
	const temp = userTempDir();
	const prefix = root.replaceAll("/", "_");
	for (const name of readdirSync(temp))
		if (name.startsWith(prefix)) cleanup.push(join(temp, name));
}

describe("xcodebuild action parsing", () => {
	it("grants only an exact build action list without an env prefix", () => {
		for (const command of [
			"xcodebuild build",
			"xcodebuild -scheme Fix build",
			"xcodebuild -scheme test build",
			"xcodebuild build -quiet -scheme Fix CODE_SIGNING_ALLOWED=NO",
			XCODEBUILD_BUILD,
		])
			ok(isXcodebuildBuild(command), command);
		ok(isXcodebuildBuild(["xcodebuild", "build", "-scheme", "a b"]));
		for (const command of [
			"xcodebuild -scheme build archive",
			"xcodebuild -target build install",
			"DYLD_INSERT_LIBRARIES=/x xcodebuild build",
			"CI=1 xcodebuild build",
			"xcodebuild clean build",
			"xcodebuild build archive",
			"xcodebuild -scheme build",
			"xcodebuild build -scheme",
			"xcodebuild build -scheme $X",
			"xcodebuild build -scheme Fix*",
			"xcodebuild build > out",
			"xcodebuild build &",
			"/usr/bin/xcodebuild build",
			"xcodebuild build -$FLAG",
			["env", "xcodebuild", "build"],
			["xcodebuild", "build", "test"],
		])
			ok(!isXcodebuildBuild(command), JSON.stringify(command));
		deepStrictEqual(xcodebuildActions("xcodebuild -scheme build archive"), [
			"archive",
		]);
		deepStrictEqual(xcodebuildActions("xcodebuild -target build install"), [
			"install",
		]);
		strictEqual(xcodebuildActions("make"), null);
	});

	it("validation reads xcodebuild actions with the same parser", () => {
		const denied = (command) => {
			try {
				validateCheckCommand(command, "/Users/example/project");
				return false;
			} catch (error) {
				strictEqual(error.code, "check_tool_denied", command);
				return true;
			}
		};
		strictEqual(denied("xcodebuild -scheme test build"), false);
		strictEqual(denied("xcodebuild -scheme build archive"), false);
		strictEqual(denied("xcodebuild -scheme Fix test"), true);
		strictEqual(denied("xcodebuild build test"), true);
		strictEqual(denied("CI=1 xcodebuild test"), true);
		// An unreadable invocation falls back to refusing any `test` word.
		strictEqual(denied("xcodebuild -scheme $X test"), true);
	});
});

describe("quick-check runner profile command", { skip: darwinSkip }, () => {
	function profileFor(argv, options) {
		const root = realpathSync(tempDir("switchyard-runner-profile-"));
		let payload;
		runCommand(root, { HOME: root }, argv, 1000, {
			...options,
			spawnSync: (_node, args) => {
				payload = JSON.parse(args[2]);
				return { status: 0, stdout: "{}" };
			},
		});
		return payload.profile;
	}

	it("passes an owner check's argv to the profile builder", () => {
		const argv = ["xcodebuild", "build"];
		ok(GRANT.test(profileFor(argv, { command: argv })));
		ok(!GRANT.test(profileFor(argv, {})), "no command, no grants");
		const test = ["xcodebuild", "test"];
		ok(!GRANT.test(profileFor(test, { command: test })));
		strictEqual(profileFor(argv, { command: argv, sandbox: false }), null);
	});
});

describe("check session profile command", { skip: darwinSkip }, () => {
	it("gives xcodebuild build, and only it, the grants in run()", async () => {
		const repo = project();
		const checks = session(repo, ["xcodebuild build"]);
		try {
			const clone = await checks.prepare();
			const runtimeBin = join(dirname(clone), "runtime", "bin");
			// A PATH-first stub stands in for xcodebuild; it can create a SwiftPM
			// style temp dir only when the profile carries the xcodebuild grants.
			const probe = (command) => {
				const target = join(
					userTempDir(),
					`TemporaryDirectory.syprobe${randomBytes(6).toString("hex")}`,
				);
				cleanup.push(target);
				writeFileSync(
					join(runtimeBin, "xcodebuild"),
					`#!/bin/sh\nexec /bin/mkdir ${JSON.stringify(target)}\n`,
					{ mode: 0o700 },
				);
				return checks.run({ command }).then((result) => ({
					result,
					made: existsSync(target),
				}));
			};
			const build = await probe("xcodebuild build");
			strictEqual(build.result.success, true, build.result.stderr);
			strictEqual(build.made, true);
			for (const command of [
				"xcodebuild clean build",
				"xcodebuild test",
				"CI=1 xcodebuild build",
			]) {
				const denied = await probe(command);
				strictEqual(denied.result.success, false, command);
				strictEqual(denied.made, false, command);
			}
		} finally {
			checks.remove();
		}
	});

	it("runs a real xcodebuild build through run()", {
		skip: xcodeSkip,
		timeout: 600_000,
	}, async () => {
		const repo = project();
		const checks = session(repo, [XCODEBUILD_BUILD]);
		try {
			await checks.prepare();
			const result = await checks.run({ command: XCODEBUILD_BUILD });
			const output = `${result.output ?? ""}\n${result.stderr ?? ""}`;
			strictEqual(result.success, true, output.slice(-3000));
		} finally {
			trackLocks(repo.root);
			checks.remove();
		}
	});
});

describe("xcodebuild profile preference reads", { skip: darwinSkip }, () => {
	it("does not expose other user defaults domains", (t) => {
		const host = spawnSync("/usr/bin/defaults", ["read", "com.apple.dock"], {
			encoding: "utf8",
		});
		if (host.status !== 0 || host.stdout.trim().length < 3) {
			t.skip("host has no com.apple.dock defaults");
			return;
		}
		const root = realpathSync(tempDir("switchyard-prefs-"));
		const clone = join(root, "clone");
		const runtime = join(root, "runtime");
		mkdirSync(clone);
		mkdirSync(runtime);
		const profile = quickCheckSandboxProfile(clone, runtime, [], {
			command: "xcodebuild build",
		});
		ok(GRANT.test(profile));
		// A check controls its own environment, so try it with and without the
		// home override. Assertions never print the host's defaults.
		const env = safeEnv(runtime);
		const bare = { ...env };
		delete bare.CFFIXED_USER_HOME;
		const read = (sandboxProfile, readEnv) =>
			spawnSync(
				"/usr/bin/sandbox-exec",
				["-p", sandboxProfile, "/usr/bin/defaults", "read", "com.apple.dock"],
				{ env: readEnv, encoding: "utf8", timeout: 30_000 },
			).stdout;
		// Control: the same profile plus the dropped rule reads the real domain.
		const control = [env, bare].map((readEnv) =>
			read(`${profile}\n(allow user-preference-read)`, readEnv),
		);
		ok(
			control.includes(host.stdout),
			"control profile cannot read the dock domain",
		);
		for (const readEnv of [env, bare])
			ok(read(profile, readEnv) !== host.stdout, "dock defaults readable");
	});
});
