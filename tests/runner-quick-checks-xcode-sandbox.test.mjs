import { doesNotMatch, match, ok, strictEqual, throws } from "node:assert";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	isXcodebuildBuild,
	quickCheckSandboxProfile,
	safeEnv,
} from "../src/switchyard/runner/checks-sandbox.mjs";
import { validateCheckCommand } from "../src/switchyard/simple/check-validation.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const XCODE_SELECT_LINK = "/var/db/xcode_select_link";
const SWIFT_BUILD =
	"swift build --build-system native --disable-sandbox --scratch-path .sy/b --cache-path .sy/c";
// Absolute -packageCachePath (via $PWD) matters: a relative one silently breaks
// xcodebuild's package resolution. The manifest sandbox flag is required because
// a sandbox cannot be applied inside the check sandbox.
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
const MACH_PROBE = `
import ctypes, sys
lib = ctypes.CDLL(None)
lib.bootstrap_look_up.argtypes = [ctypes.c_uint, ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint)]
bp = ctypes.c_uint.in_dll(lib, "bootstrap_port")
for name in sys.argv[1:]:
    port = ctypes.c_uint(0)
    print(name, lib.bootstrap_look_up(bp, name.encode(), ctypes.byref(port)))
`;
const BOOTSTRAP_NOT_PRIVILEGED = "1100";

function xcodeSelected() {
	if (process.platform !== "darwin") return false;
	try {
		return readlinkSync(XCODE_SELECT_LINK).length > 0;
	} catch {
		return false;
	}
}

const xcodeSkip = xcodeSelected()
	? false
	: "requires a selected Xcode developer directory";

/** Resolve a confstr directory (DARWIN_USER_TEMP_DIR or DARWIN_USER_CACHE_DIR). */
function userDir(name) {
	const result = spawnSync("/usr/bin/getconf", [name], { encoding: "utf8" });
	strictEqual(result.status, 0);
	return realpathSync(result.stdout.trim());
}

function fixture() {
	const root = realpathSync(tempDir("switchyard-xcode-sandbox-"));
	const clone = join(root, "clone");
	const runtime = join(root, "runtime");
	mkdirSync(join(clone, "Sources/Fix"), { recursive: true });
	mkdirSync(runtime);
	writeFileSync(
		join(clone, "Package.swift"),
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
		join(clone, "Sources/Fix/Fix.swift"),
		"public func fix() -> Int { 1 }\n",
	);
	writeFileSync(join(clone, "probe.py"), MACH_PROBE);
	return { root, clone, runtime };
}

/** Run argv under the profile built for `profileCommand`, inside the sandbox. */
function sandboxed(repo, profileCommand, argv, timeout = 120_000) {
	const profile = quickCheckSandboxProfile(repo.clone, repo.runtime, [], {
		command: profileCommand,
	});
	return spawnSync("/usr/bin/sandbox-exec", ["-p", profile, ...argv], {
		cwd: repo.clone,
		env: safeEnv(repo.runtime),
		encoding: "utf8",
		timeout,
		maxBuffer: 16 * 1024 * 1024,
	});
}

function shell(repo, profileCommand, script, ...args) {
	return sandboxed(repo, profileCommand, [
		"/bin/sh",
		"-c",
		script,
		"sh",
		...args,
	]);
}

function unique(prefix) {
	return `${prefix}${randomBytes(6).toString("hex")}`;
}

const cleanup = [];
after(() => {
	for (const path of cleanup) rmSync(path, { recursive: true, force: true });
});
/** Track a host path a probe may have created for removal at the end. */
function track(path) {
	cleanup.push(path);
	return path;
}

/** SwiftPM names lock files in the temp dir after the locked path; track this fixture's. */
function trackLocks(repo) {
	const temp = userDir("DARWIN_USER_TEMP_DIR");
	const prefix = repo.root.replaceAll("/", "_");
	for (const name of readdirSync(temp))
		if (name.startsWith(prefix)) track(join(temp, name));
}

describe("xcodebuild build profile gating", () => {
	it("recognises only a single xcodebuild build invocation", () => {
		for (const command of [
			"xcodebuild build -scheme Fix",
			XCODEBUILD_BUILD,
			"xcodebuild -scheme Fix build",
		])
			ok(isXcodebuildBuild(command), command);
		for (const command of [
			undefined,
			"",
			"xcodebuild",
			"xcodebuild -version",
			"xcodebuild test -scheme Fix",
			"xcodebuild build test",
			"xcodebuild clean build",
			"CI=1 xcodebuild -scheme Fix build",
			"xcodebuild build-for-testing -scheme Fix",
			"xcodebuild test-without-building",
			"xcodebuild build && make",
			"make; xcodebuild build",
			"cd sub && xcodebuild build",
			"xcodebuild build | cat",
			"sh -c 'xcodebuild build'",
			"swift build",
			SWIFT_BUILD,
			"make",
		])
			ok(!isXcodebuildBuild(command), String(command));
	});

	it("adds the xcodebuild grants only for an xcodebuild build command", () => {
		const repo = fixture();
		const grants = (command) =>
			quickCheckSandboxProfile(repo.clone, repo.runtime, [], { command });
		const base = grants(undefined);
		strictEqual(grants("make"), base);
		strictEqual(grants(SWIFT_BUILD), base);
		strictEqual(grants("xcodebuild test -scheme Fix"), base);
		strictEqual(grants("xcodebuild build -scheme Fix && make"), base);
		strictEqual(quickCheckSandboxProfile(repo.clone, repo.runtime), base);
		doesNotMatch(base, /dirhelper|user-preference-read|iokit-open/u);
		const widened = grants(XCODEBUILD_BUILD);
		match(widened, /com\.apple\.bsd\.dirhelper/u);
		doesNotMatch(widened, /user-preference-read/u);
		match(widened, /\(allow ipc-posix-shm\*\)/u);
		match(widened, /\(allow iokit-open\)/u);
		// Writes outside the clone are limited to unique per-invocation temp names;
		// the per-user cache dir and every com.apple.* cache stay denied.
		const temp = userDir("DARWIN_USER_TEMP_DIR");
		doesNotMatch(widened, /xcrun_db|ResultBundle_|swbuild\.tmp|org\.swift/u);
		ok(!widened.includes(userDir("DARWIN_USER_CACHE_DIR")));
		const extraWrites = widened
			.split("\n")
			.filter(
				(line) => line.includes("file-write") && !line.includes("subpath"),
			);
		strictEqual(extraWrites.length, 3);
		for (const line of extraWrites) {
			match(line, /^\(allow file-read\* file-write\* \(regex #"\^/u);
			ok(line.includes(temp), line);
		}
	});
});

describe("xcodebuild build preflight", () => {
	const project = "/Users/example/project";
	const refusal = (command) => {
		try {
			validateCheckCommand(command, project);
		} catch (error) {
			return error;
		}
		return null;
	};

	it("keeps xcodebuild test, simctl, codesign and security rejected", () => {
		for (const command of [
			"xcodebuild test -scheme Fix",
			"xcodebuild -scheme Fix test",
			"xcrun simctl list",
			"simctl list",
			"codesign -dv thing",
			"security find-identity",
		]) {
			const error = refusal(command);
			ok(error, command);
			strictEqual(error.code, "check_tool_denied", command);
		}
	});

	it("accepts xcodebuild build and flagged swift build", () => {
		strictEqual(refusal(XCODEBUILD_BUILD), null);
		strictEqual(refusal("xcodebuild -version"), null);
		strictEqual(refusal(SWIFT_BUILD), null);
		strictEqual(
			refusal(
				"swift build --build-system=native --disable-sandbox --scratch-path=.sy/b --cache-path=.sy/c",
			),
			null,
		);
		strictEqual(refusal("swift test"), null);
	});

	it("rejects plain swift build with the working command as the hint", () => {
		for (const command of [
			"swift build",
			"swift build --disable-sandbox",
			"swift build --build-system native --disable-sandbox",
			"cd sub && swift build -c release",
		]) {
			const error = refusal(command);
			ok(error, command);
			strictEqual(error.code, "check_tool_denied");
			ok(error.message.includes(SWIFT_BUILD), error.message);
		}
		throws(() => validateCheckCommand("swift build", project));
	});
});

describe("xcodebuild build in the sandbox", { skip: xcodeSkip }, () => {
	it("passes xcodebuild build with every cache and output in the clone", {
		timeout: 600_000,
	}, () => {
		const repo = fixture();
		try {
			const result = shell(repo, XCODEBUILD_BUILD, XCODEBUILD_BUILD);
			const output = `${result.stdout}\n${result.stderr}`;
			strictEqual(result.status, 0, output.slice(-3000));
			match(result.stdout, /BUILD SUCCEEDED/u);
			ok(existsSync(join(repo.clone, ".sy/dd")), "DerivedData in the clone");
			ok(existsSync(join(repo.clone, ".sy/rb.xcresult")), "result bundle");
		} finally {
			trackLocks(repo);
		}
	});

	it("passes the flagged swift build in the sandbox", {
		timeout: 600_000,
	}, () => {
		const repo = fixture();
		try {
			const result = shell(repo, SWIFT_BUILD, SWIFT_BUILD);
			const output = `${result.stdout}\n${result.stderr}`;
			strictEqual(result.status, 0, output.slice(-3000));
			ok(existsSync(join(repo.clone, ".sy/b")), "scratch path in the clone");
			ok(existsSync(join(repo.clone, ".sy/c")), "cache path in the clone");
		} finally {
			trackLocks(repo);
		}
	});

	it("denies a write to $TMPDIR/other, even under the xcodebuild grants", () => {
		const repo = fixture();
		const hostTmp = realpathSync(tmpdir());
		for (const command of [XCODEBUILD_BUILD, "make"]) {
			const target = track(join(hostTmp, unique("other-")));
			const result = shell(repo, command, 'echo x > "$1"', target);
			ok(result.status !== 0, `${command} wrote ${target}`);
			ok(!existsSync(target), target);
		}
	});

	it("denies com.apple.unrelated-test and other shared names in the cache dir", () => {
		const repo = fixture();
		const cache = userDir("DARWIN_USER_CACHE_DIR");
		const temp = userDir("DARWIN_USER_TEMP_DIR");
		for (const target of [
			join(cache, unique("com.apple.unrelated-test-")),
			join(cache, unique("org.swift.swiftpm-")),
			join(cache, unique("xcodebuild-")),
			join(temp, unique("com.apple.unrelated-test-")),
			join(temp, unique("xcrun_db-")),
		]) {
			track(target);
			const result = shell(repo, XCODEBUILD_BUILD, 'echo x > "$1"', target);
			ok(result.status !== 0, `wrote ${target}`);
			ok(!existsSync(target), target);
		}
	});

	it("denies writes to an existing file under the cache dir's org.swift.swiftpm", () => {
		const repo = fixture();
		const swiftpm = join(userDir("DARWIN_USER_CACHE_DIR"), "org.swift.swiftpm");
		if (!existsSync(swiftpm)) {
			mkdirSync(swiftpm);
			track(swiftpm);
		}
		const existing = track(join(swiftpm, unique("existing-")));
		writeFileSync(existing, "original\n");
		for (const script of ['echo x > "$1"', 'echo x >> "$1"']) {
			const result = shell(repo, XCODEBUILD_BUILD, script, existing);
			ok(result.status !== 0, `${script} wrote ${existing}`);
			strictEqual(readFileSync(existing, "utf8"), "original\n");
		}
	});

	it("allows only unique SwiftPM temp dirs and this clone's lock files in the temp dir", () => {
		const repo = fixture();
		const temp = userDir("DARWIN_USER_TEMP_DIR");
		const directory = track(join(temp, unique("TemporaryDirectory.")));
		const made = shell(
			repo,
			XCODEBUILD_BUILD,
			'mkdir "$1" && echo x > "$1/file"',
			directory,
		);
		strictEqual(made.status, 0, made.stderr);
		const own = track(
			join(temp, `${repo.clone.replaceAll("/", "_")}_probe.json.lock`),
		);
		strictEqual(
			shell(repo, XCODEBUILD_BUILD, 'echo x > "$1"', own).status,
			0,
			"own lock file",
		);
		const foreign = track(join(temp, `${unique("_not_this_clone_")}.lock`));
		ok(
			shell(repo, XCODEBUILD_BUILD, 'echo x > "$1"', foreign).status !== 0,
			"foreign lock file",
		);
		ok(!existsSync(foreign));
		// The same writes stay denied without the xcodebuild grants.
		const plain = track(join(temp, unique("TemporaryDirectory.")));
		ok(shell(repo, "make", 'mkdir "$1"', plain).status !== 0);
		ok(!existsSync(plain));
	});

	it("allows the listed mach services and refuses others", () => {
		const repo = fixture();
		const names = [
			"com.apple.trustd",
			"com.apple.system.opendirectoryd.libinfo",
			"com.apple.bsd.dirhelper",
			"com.apple.pasteboard.1",
			"com.apple.windowserver.active",
		];
		const lookups = (profileCommand) => {
			const result = sandboxed(repo, profileCommand, [
				"/bin/sh",
				"-c",
				`python3 probe.py ${names.join(" ")}`,
			]);
			strictEqual(result.status, 0, result.stderr);
			return Object.fromEntries(
				result.stdout
					.trim()
					.split("\n")
					.map((line) => line.split(" ")),
			);
		};
		const allowed = lookups(XCODEBUILD_BUILD);
		for (const name of names.slice(0, 3))
			ok(
				allowed[name] !== BOOTSTRAP_NOT_PRIVILEGED,
				`${name} ${allowed[name]}`,
			);
		for (const name of names.slice(3))
			strictEqual(allowed[name], BOOTSTRAP_NOT_PRIVILEGED, name);
		const plain = lookups("make");
		for (const name of names)
			strictEqual(plain[name], BOOTSTRAP_NOT_PRIVILEGED);
	});
});
