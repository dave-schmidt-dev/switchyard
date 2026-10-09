import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const GIT_ARGS = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.attributesFile=/dev/null",
	"-c",
	"diff.external=",
	"-c",
	"diff.trustExitCode=false",
	"-c",
	"filter.lfs.smudge=",
	"-c",
	"filter.lfs.required=false",
];
const HOMEBREW_BIN = "/opt/homebrew/bin";
const HOMEBREW_ETC = "/opt/homebrew/etc";
const OPENSSL_SYSTEM_CONFIG = "/private/etc/ssl/openssl.cnf";
const HOST_HOME = realpathSync(userInfo().homedir);
const HOST_CARGO_BIN = join(HOST_HOME, ".cargo/bin");
const HOST_RUSTUP_HOME = join(HOST_HOME, ".rustup");
const HOST_RUSTUP_TOOLCHAINS = join(HOST_RUSTUP_HOME, "toolchains");
const XCODE_SELECT_LINK = "/var/db/xcode_select_link";
// The real xcrun needs xcode-select, the license check and a writable xcrun_db;
// the sandbox denies all three, so checks get a shim that answers xcrun's query
// flags from DEVELOPER_DIR and delegates every tool invocation to PATH.
const XCRUN_SHIM = `#!/bin/sh
while [ "$#" -gt 0 ]; do
	case "$1" in
	-sdk|--sdk|--toolchain)
		shift
		[ "$#" -gt 0 ] && shift
		;;
	-r|--run)
		shift
		;;
	--find)
		shift
		tool="$1"
		[ "$#" -gt 0 ] && shift
		for candidate in "$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/bin/$tool" "$DEVELOPER_DIR/usr/bin/$tool"; do
			if [ -x "$candidate" ]; then
				printf '%s\\n' "$candidate"
				exit 0
			fi
		done
		command -v "$tool"
		exit $?
		;;
	--show-sdk-path)
		if [ -n "$SDKROOT" ]; then
			printf '%s\\n' "$SDKROOT"
		elif [ -n "$DEVELOPER_DIR" ]; then
			printf '%s\\n' "$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
		else
			exit 1
		fi
		exit 0
		;;
	*)
		exec "$@"
		;;
	esac
done
exit 1
`;
function sha(value) {
	return createHash("sha256").update(value).digest("hex");
}
function developerDir() {
	try {
		const target = readlinkSync(XCODE_SELECT_LINK);
		return realpathSync(
			isAbsolute(target) ? target : join(dirname(XCODE_SELECT_LINK), target),
		);
	} catch {
		return null;
	}
}
// The selected developer directory is read through its enclosing Xcode.app
// bundle; a Command Line Tools selection is its own developer root.
function xcodeAppRoot(developer) {
	let current = developer;
	while (current !== "/" && current !== dirname(current)) {
		if (current.endsWith(".app")) return current;
		current = dirname(current);
	}
	return developer;
}
// Rustup is queried only on the host with a sanitized environment, a short
// timeout and auto-install disabled. The returned toolchain must resolve inside
// the fixed rustup tree; sandboxed checks receive no host rustup settings.
let selectedRustToolchain;
function rustToolchainPath() {
	if (selectedRustToolchain !== undefined) return selectedRustToolchain;
	selectedRustToolchain = null;
	let selectionResult = null;
	for (const candidate of [
		join(HOST_CARGO_BIN, "rustup"),
		join(HOMEBREW_BIN, "rustup"),
	]) {
		let executable;
		try {
			executable = realpathSync(candidate);
		} catch {
			continue;
		}
		if (
			![
				HOST_CARGO_BIN,
				HOMEBREW_BIN,
				"/opt/homebrew/Cellar",
				"/usr/bin",
				"/bin",
			].some((root) => executable.startsWith(`${root}/`))
		)
			continue;
		const result = spawnSync(executable, ["show", "active-toolchain"], {
			cwd: HOST_HOME,
			env: {
				HOME: HOST_HOME,
				PATH: [HOST_CARGO_BIN, HOMEBREW_BIN, "/usr/bin", "/bin"].join(":"),
				RUSTUP_HOME: HOST_RUSTUP_HOME,
				RUSTUP_AUTO_INSTALL: "0",
			},
			encoding: "utf8",
			timeout: 5000,
			maxBuffer: 8192,
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (result.error?.code === "ENOENT") continue;
		if (
			result.error ||
			result.status !== 0 ||
			typeof result.stdout !== "string"
		)
			return null;
		selectionResult = result;
		break;
	}
	if (!selectionResult) return null;
	const selector = selectionResult.stdout.trim().split(/\s+/u)[0];
	if (!selector || !/^[A-Za-z0-9_.+-]{1,128}$/u.test(selector)) return null;
	try {
		const toolchains = realpathSync(HOST_RUSTUP_TOOLCHAINS);
		const selected = realpathSync(join(toolchains, selector));
		if (!selected.startsWith(`${toolchains}/`)) return null;
		for (const binary of ["cargo", "rustc"]) {
			const resolved = realpathSync(join(selected, "bin", binary));
			if (!resolved.startsWith(`${selected}/`)) return null;
		}
		selectedRustToolchain = selected;
		return selected;
	} catch {
		return null;
	}
}
// Keep grants at the four fixed roots; never resolve Homebrew or Rust tool
// symlinks into additional host paths.
function fixedToolTrees() {
	return [
		HOMEBREW_BIN,
		"/opt/homebrew/Cellar",
		HOST_CARGO_BIN,
		HOST_RUSTUP_TOOLCHAINS,
	].filter((path) => {
		try {
			return lstatSync(path).isDirectory();
		} catch {
			return false;
		}
	});
}
/**
 * Every installed Homebrew OpenSSL config (`<etc>/openssl/openssl.cnf` and
 * `<etc>/openssl@<version>/openssl.cnf`) that is a regular file, sorted.
 *
 * Homebrew's Node links whichever OpenSSL major its formula pins (openssl@3,
 * then openssl@4) and aborts at startup when it cannot read that config, so the
 * list is enumerated rather than hard-coded. Callers grant each path as a
 * literal file, never its directory, so `private/` and `certs/` stay denied.
 * @param {string} [etcRoot]
 * @returns {string[]}
 */
export function homebrewOpenSslConfigs(etcRoot = HOMEBREW_ETC) {
	let names;
	try {
		names = readdirSync(etcRoot);
	} catch {
		return [];
	}
	return names
		.filter((name) => /^openssl(@\d+(\.\d+)*)?$/u.test(name))
		.sort()
		.map((name) => join(etcRoot, name, "openssl.cnf"))
		.filter((path) => {
			try {
				return lstatSync(path).isFile();
			} catch {
				return false;
			}
		});
}
function safeEnv(home) {
	home = realpathSync(home);
	const developer = developerDir();
	const runtimeBin = join(home, "bin");
	const cargoHome = join(home, "cargo-home");
	const rustupHome = join(home, "rustup-home");
	const cargoTarget = join(home, "cargo-target");
	mkdirSync(runtimeBin, { recursive: true, mode: 0o700 });
	mkdirSync(cargoHome, { recursive: true, mode: 0o700 });
	mkdirSync(rustupHome, { recursive: true, mode: 0o700 });
	mkdirSync(cargoTarget, { recursive: true, mode: 0o700 });
	writeFileSync(join(runtimeBin, "xcrun"), XCRUN_SHIM, { mode: 0o700 });
	const rustToolchain = rustToolchainPath();
	const rustBin = rustToolchain ? join(rustToolchain, "bin") : null;
	// Tools such as SwiftPM call /usr/bin/xcrun by absolute path; an explicit
	// SDKROOT keeps that shim from probing the Xcode license, which the
	// sandbox cannot read.
	const sdkPath = developer
		? join(developer, "Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk")
		: undefined;
	const sdk = sdkPath && existsSync(sdkPath) ? sdkPath : undefined;
	const path = developer
		? [
				runtimeBin,
				...(rustBin ? [rustBin] : []),
				HOST_CARGO_BIN,
				HOMEBREW_BIN,
				join(developer, "usr/bin"),
				join(developer, "Toolchains/XcodeDefault.xctoolchain/usr/bin"),
				"/usr/bin",
				"/bin",
			]
		: [
				runtimeBin,
				...(rustBin ? [rustBin] : []),
				HOST_CARGO_BIN,
				HOMEBREW_BIN,
				"/usr/bin",
				"/bin",
				"/usr/local/bin",
			];
	return {
		PATH: path.join(":"),
		HOME: home,
		TMPDIR: home,
		XDG_CONFIG_HOME: home,
		CI: "true",
		...(developer ? { DEVELOPER_DIR: developer } : {}),
		...(sdk ? { SDKROOT: sdk } : {}),
		// xcodebuild and SwiftPM resolve per-user caches from the passwd home, not
		// HOME; this keeps them inside the runtime directory.
		CFFIXED_USER_HOME: home,
		// SwiftPM's manifest compile otherwise writes the shared clang module
		// cache under the per-user cache dir.
		SWIFTPM_MODULECACHE_OVERRIDE: join(home, "clang-modules"),
		CARGO_HOME: cargoHome,
		CARGO_TARGET_DIR: cargoTarget,
		CARGO_NET_OFFLINE: "true",
		RUSTUP_HOME: rustupHome,
		RUSTUP_AUTO_INSTALL: "0",
		...(rustToolchain ? { RUSTUP_TOOLCHAIN: rustToolchain } : {}),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_LFS_SKIP_SMUDGE: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "/usr/bin/false",
	};
}
// xcodebuild flags that take no value; every other `-flag` (without `=`)
// consumes the next word, so a flag value is never read as an action and an
// unknown flag fails closed.
const XCODEBUILD_BOOLEAN_FLAGS = new Set([
	"-quiet",
	"-verbose",
	"-json",
	"-version",
	"-list",
	"-showsdks",
	"-showBuildSettings",
	"-showdestinations",
	"-showTestPlans",
	"-alltargets",
	"-parallelizeTargets",
	"-hideShellScriptEnvironment",
	"-allowProvisioningUpdates",
	"-allowProvisioningDeviceRegistration",
	"-skipUnavailableActions",
	"-skipPackagePluginValidation",
	"-skipMacroValidation",
	"-skipPackageUpdates",
	"-disableAutomaticPackageResolution",
	"-onlyUsePackageVersionsFromResolvedFile",
	"-disablePackageRepositoryCache",
	"-usePackageSupportBuiltinSCM",
	"-dry-run",
	"-n",
]);
// Split one shell command into words with quotes removed. Null when it holds
// shell grammar beyond a single simple command (separators, redirections,
// substitutions, an unbalanced quote) or an unquoted expansion or glob that
// could split into extra words.
function shellWords(command) {
	if (/[`\\]|\$\(/u.test(command)) return null;
	const words = [];
	let word = null;
	let quote = null;
	for (const char of command) {
		if (quote) {
			if (char === quote) quote = null;
			else word += char;
		} else if (char === "'" || char === '"') {
			quote = char;
			word ??= "";
		} else if (/\s/u.test(char)) {
			if (word !== null) words.push(word);
			word = null;
		} else if (/[;&|(){}<>$*?[~]/u.test(char)) {
			return null;
		} else {
			word = (word ?? "") + char;
		}
	}
	if (quote) return null;
	if (word !== null) words.push(word);
	return words;
}
/**
 * The action words of one `xcodebuild` invocation, or null when the words are
 * not a bare `xcodebuild` call whose actions can be read. `words` is either a
 * shell command string or an argv array (no shell, so no expansion).
 */
export function xcodebuildActions(words) {
	if (typeof words === "string") words = shellWords(words);
	if (!Array.isArray(words) || words[0] !== "xcodebuild") return null;
	const actions = [];
	for (let index = 1; index < words.length; index += 1) {
		const word = words[index];
		if (typeof word !== "string" || !word) return null;
		if (word.startsWith("-")) {
			if (word.includes("$")) return null;
			if (!word.includes("=") && !XCODEBUILD_BOOLEAN_FLAGS.has(word)) {
				if (index + 1 >= words.length) return null;
				index += 1;
			}
		} else if (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])*=/u.test(word)) {
			// A build setting assignment, never an action.
		} else if (/^[a-z][a-z-]*$/u.test(word)) actions.push(word);
		else return null;
	}
	return actions;
}
/**
 * True when a check is a single `xcodebuild` invocation whose action list is
 * exactly `build`. Env-assignment prefixes, other or extra actions, chains,
 * pipes, redirections and every other tool never earn the xcodebuild grants.
 */
export function isXcodebuildBuild(command) {
	const actions = xcodebuildActions(command);
	return actions?.length === 1 && actions[0] === "build";
}
function regexEscape(text) {
	return text.replace(/[.^$*+?()[\]{}|\\]/gu, "\\$&");
}
// The per-user temp dir (confstr DARWIN_USER_TEMP_DIR) resolved on the host.
// Anything that is not a /private/var/folders/<x>/<y>/T directory yields null,
// which leaves the xcodebuild profile without temp grants (it then fails closed).
function userTempDir() {
	const result = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
		encoding: "utf8",
		timeout: 5000,
	});
	if (result.status !== 0 || !result.stdout.trim()) return null;
	try {
		const resolved = realpathSync(result.stdout.trim());
		return /^\/private\/var\/folders\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+\/T$/u.test(
			resolved,
		)
			? resolved
			: null;
	} catch {
		return null;
	}
}
// Grants for one `xcodebuild build` check, appended to the base profile only
// when isXcodebuildBuild() holds. Rules marked "required" were each admitted
// from a recorded failure: with the fixture package of
// tests/runner-quick-checks-xcode-sandbox.test.mjs, removing any one of them
// fails the build. Rules marked "listed" come from the owner-approved Task 6.1
// list (verified on a larger project); the fixture builds without them, so they
// are not backed by a failure recorded here.
//
// Not granted, because no failure needed them: the per-user cache dir (C/), the
// xcrun_db, swbuild.tmp.*, ResultBundle_*, /private/var/db, and every
// com.apple.* or org.swift.swiftpm shared-cache namespace. The runtime shim
// answers xcrun, CFFIXED_USER_HOME and SWIFTPM_MODULECACHE_OVERRIDE (safeEnv)
// keep the remaining caches in the runtime directory.
function xcodebuildRules(clone, runtime) {
	const rules = [
		// required: xcodebuild exits 69 without the Xcode license preference.
		'(allow file-read* (literal "/Library/Preferences/com.apple.dt.Xcode.plist"))',
		// required: MobileDevice and friends; /System/Library/PrivateFrameworks is a
		// symlink into /Library/Apple on this macOS, so both prefixes are read.
		'(allow file-read* (subpath "/Library/Developer/PrivateFrameworks"))',
		'(allow file-read* (subpath "/Library/Apple/System/Library/PrivateFrameworks"))',
		// listed. user-preference-read is deliberately absent: with the cfprefsd
		// lookup below it would expose every user defaults domain to the check.
		"(allow ipc-posix-shm*)",
		"(allow iokit-open)",
		'(allow mach-lookup (global-name-prefix "com.apple.cfprefsd."))',
		// required (libinfo user lookup)
		'(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
		// listed
		'(allow mach-lookup (global-name "com.apple.FSEvents"))',
		'(allow mach-lookup (global-name "com.apple.coreservices.launchservicesd"))',
		// required (launch services map database)
		'(allow mach-lookup (global-name "com.apple.lsd.mapdb"))',
		// listed
		'(allow mach-lookup (global-name "com.apple.trustd"))',
		'(allow mach-lookup (global-name "com.apple.logd"))',
		'(allow mach-lookup (global-name "com.apple.diagnosticd"))',
		'(allow mach-lookup (global-name "com.apple.system.notification_center"))',
		'(allow mach-lookup (global-name "com.apple.distributed_notifications@1v3"))',
		// required, and not in the listed set: confstr(_CS_DARWIN_USER_DIR) in the
		// SwiftPM manifest-compile subprocess asks dirhelper; without it the
		// subprocess falls back to /tmp and fails with couldNotFindTmpDir.
		'(allow mach-lookup (global-name "com.apple.bsd.dirhelper"))',
	];
	const temp = userTempDir();
	if (!temp) return rules;
	const base = regexEscape(temp);
	// required: SwiftPM creates a unique TemporaryDirectory.<random> per
	// invocation here for the manifest compile. The random name cannot be known
	// in advance, so the prefix also matches another SwiftPM run's directory.
	rules.push(
		`(allow file-read* file-write* (regex #"^${base}/TemporaryDirectory\\.[A-Za-z0-9]+(/|$)"))`,
	);
	// required: SwiftPM lock files are named after the locked path with "/"
	// flattened to "_", so only this clone's and runtime's own locks match.
	for (const root of [clone, runtime]) {
		const flat = root.replaceAll("/", "_");
		if (/["\n\r]/u.test(flat)) continue;
		rules.push(
			`(allow file-read* file-write* (regex #"^${base}/${regexEscape(flat)}(_[^/]*)?\\.lock$"))`,
		);
	}
	return rules;
}
export function quickCheckSandboxProfile(
	clone,
	runtime,
	readOnlyPaths = [],
	{ command } = {},
) {
	clone = realpathSync(clone);
	runtime = realpathSync(runtime);
	const developer = developerDir();
	const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
	const npmRoot = dirname(dirname(realpathSync("/opt/homebrew/bin/npm")));
	const reads = [
		"/System",
		"/usr",
		"/bin",
		"/sbin",
		"/dev",
		"/opt/homebrew/Cellar",
		"/opt/homebrew/opt",
		nodeRoot,
		npmRoot,
		...fixedToolTrees(),
		// /bin/sh reads its target shell through this symlink.
		"/private/var/select",
		clone,
		runtime,
		...readOnlyPaths.map((path) => realpathSync(path)),
	];
	if (developer) reads.push(xcodeAppRoot(developer));
	// A read-only input reached through a symlink (uv's `cpython-3.x` alias of
	// its versioned interpreter dir) needs the link itself readable to resolve.
	const readLiterals = [
		OPENSSL_SYSTEM_CONFIG,
		...homebrewOpenSslConfigs(),
		...readOnlyPaths.filter(
			(path) => isAbsolute(path) && lstatSync(path).isSymbolicLink(),
		),
	];
	// The top-level symlinks need metadata access so realpath() of TMPDIR and
	// similar paths resolves; their targets stay governed by the read list.
	const ancestors = new Set(["/", "/var", "/tmp", "/etc"]);
	for (const path of [...reads, ...readLiterals]) {
		let current = dirname(path);
		while (current !== "/") {
			ancestors.add(current);
			current = dirname(current);
		}
	}
	const metadata = [...ancestors]
		.filter((path) => path !== "/")
		.map((path) => `(literal ${JSON.stringify(path)})`)
		.join(" ");
	const readRules = [
		...reads.map((path) => `(subpath ${JSON.stringify(path)})`),
		...readLiterals.map((path) => `(literal ${JSON.stringify(path)})`),
	].join(" ");
	return [
		"(version 1)",
		"(deny default)",
		"(allow process-exec)",
		"(allow process-fork)",
		// Checks may signal and probe their own process groups, never host processes.
		"(allow signal (target same-sandbox))",
		"(allow sysctl-read)",
		'(allow file-read* (literal "/"))',
		`(allow file-read-metadata ${metadata})`,
		`(allow file-read* ${readRules})`,
		`(allow file-write* (subpath ${JSON.stringify(clone)}) (subpath ${JSON.stringify(runtime)}) (literal "/dev/null"))`,
		...(isXcodebuildBuild(command) ? xcodebuildRules(clone, runtime) : []),
	].join("\n");
}
function git(cwd, env, args, input) {
	const result = spawnSync("git", [...GIT_ARGS, ...args], {
		cwd,
		env,
		input,
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (result.status !== 0 || result.error)
		throw new Error("git_operation_failed");
	return result.stdout.trim();
}
function validSnapshotPath(path) {
	return (
		typeof path === "string" &&
		path.length > 0 &&
		!isAbsolute(path) &&
		!path.includes("\0") &&
		!path.includes("\\") &&
		path
			.split("/")
			.every((part) => part && part !== "." && part !== ".." && part !== ".git")
	);
}
function prepareExactBase(clone, projectPath, env, baseTree, snapshotPaths) {
	if (
		!Array.isArray(snapshotPaths) ||
		snapshotPaths.length > 4096 ||
		!snapshotPaths.every(validSnapshotPath)
	)
		throw new Error("base_mismatch");
	const trusted = new Set(snapshotPaths);
	const observed = spawnSync(
		"git",
		[
			...GIT_ARGS,
			"status",
			"--porcelain=v1",
			"--no-renames",
			"-z",
			"--untracked-files=all",
		],
		{
			cwd: projectPath,
			env,
			encoding: "utf8",
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	if (
		observed.status !== 0 ||
		observed.error ||
		typeof observed.stdout !== "string"
	)
		throw new Error("base_mismatch");
	for (const row of observed.stdout.split("\0").filter(Boolean)) {
		const changedPath = row.slice(3);
		if (row.length < 4) throw new Error("base_mismatch");
		if (row.startsWith("?? ")) continue;
		if (!trusted.has(changedPath)) throw new Error("base_mismatch");
	}
	git(clone, env, ["read-tree", "HEAD"]);
	if (trusted.size) {
		git(
			clone,
			{ ...env, GIT_WORK_TREE: projectPath, GIT_LITERAL_PATHSPECS: "1" },
			["add", "-A", "--", ...trusted],
		);
	}
	if (git(clone, env, ["write-tree"]) !== baseTree)
		throw new Error("base_mismatch");
	git(clone, env, ["checkout-index", "-a", "-f"]);
	git(clone, env, ["diff", "--quiet"]);
}

export { git, prepareExactBase, safeEnv, sha };
