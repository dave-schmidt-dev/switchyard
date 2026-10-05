import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { manifestReviewPaths } from "../integrate/index.mjs";
import { validateRoutingRunId } from "./routing-state.mjs";
export const SIMPLE_USAGE = `Usage: switchyard-dispatch simple <prompt-file> --project <path> --capability <low|standard|high> --file <path> [--allow-manifest <path>] [--input <path>] [--dirty-overlay] [--predecessor-receipt <path>] [--only-provider <provider>] [--routing-run-id <id>] [--baseline-check <command>] [--no-repair-checks] --check <command> --deadline <RFC3339> [--json]

Runs one bounded assignment in a disposable local checkout. Repeat --file and
--input and --check as needed. --input is read-only and requires --dirty-overlay.
--allow-manifest opts one declared --file that is a build/execution manifest
(package.json, lockfiles, Makefile, Dockerfile, *.sh/*.bash, CI configs) into
editing; repeat it per path. Any other manifest still fails closed.
--predecessor-receipt binds output of a previous run and requires --dirty-overlay.
--baseline-check repeats commands run before the provider; baseline checks never
replace acceptance checks. Acceptance-check repair is on by default: after a
failing acceptance check the provider gets one scoped correction within the
original deadline. --no-repair-checks disables it; --repair-checks is accepted
for compatibility.
Output is one JSON result; progress is written to stderr. SIGINT exits 130 and
SIGTERM exits 143. If a checkout is retained, its path is in partialWorktree
for attended recovery. An integration already in progress finishes before the
terminal result is recorded.`;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_DEADLINE_MS = 30 * 60 * 1000;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_DECLARED_FILES = 64;
const MAX_CHECKS = 16;
const MAX_PATH_CHARS = 1024;
const MAX_CHECK_CHARS = 8192;
const SIMPLE_PROVIDERS = Object.freeze([
	"claude-code",
	"codex",
	"antigravity",
	"antigravity-claude",
	"cursor",
	"opencode-go",
	"vibe",
	"vibe-code",
	"copilot",
	"copilot-student",
]);
const SIMPLE_TARGET_ADAPTERS = Object.freeze([
	Object.freeze({
		targetId: "codex",
		harness: "codex",
		kind: "codex",
		selectors: null,
	}),
	Object.freeze({
		targetId: "antigravity",
		harness: "agy",
		kind: "agy",
		selectors: Object.freeze([
			"gemini-3.8-flash-medium",
			"gemini-3.8-flash-high",
		]),
	}),
	Object.freeze({
		targetId: "antigravity-claude",
		harness: "agy",
		kind: "agy",
		selectors: Object.freeze(["claude-sonnet-4-6"]),
	}),
	Object.freeze({
		targetId: "copilot-student",
		harness: "copilot",
		kind: "copilot",
		selectors: Object.freeze(["auto"]),
	}),
	Object.freeze({
		targetId: "vibe",
		harness: "vibe",
		kind: "bridge",
		defaultEligible: true,
		defaultCapabilities: Object.freeze(["low", "standard"]),
		capabilities: Object.freeze(["low", "standard"]),
		selectors: Object.freeze(["glm-5-3", "glm-5-3-medium"]),
		validateInvocationArgs: (args) => Array.isArray(args) && args.length === 0,
		expectedDescriptors: Object.freeze({
			low: Object.freeze({
				selector: "glm-5-3-medium",
				invocationArgs: Object.freeze([]),
			}),
			standard: Object.freeze({
				selector: "glm-5-3",
				invocationArgs: Object.freeze([]),
			}),
		}),
	}),
	Object.freeze({
		// Claude Code is subscription-backed and must be explicitly pinned.
		targetId: "claude-code",
		harness: "claude",
		kind: "native",
		defaultEligible: false,
		capabilities: Object.freeze(["low", "standard", "high"]),
		selectors: Object.freeze([
			"claude-haiku-4-5-20251001",
			"claude-sonnet-5-5",
			"claude-opus-5-5",
		]),
		validateInvocationArgs: (args) =>
			Array.isArray(args) &&
			args.length === 2 &&
			args[0] === "--effort" &&
			["low", "medium", "high", "xhigh", "max"].includes(args[1]),
	}),
	Object.freeze({
		// Native headless Vibe on Vibe's own login: spends the Vibe Code allowance.
		targetId: "vibe-code",
		harness: "vibe",
		kind: "native",
		defaultEligible: true,
		defaultCapabilities: Object.freeze(["low", "standard"]),
		capabilities: Object.freeze(["low", "standard"]),
		selectors: Object.freeze(["glm-5-3", "glm-5-3-medium"]),
		validateInvocationArgs: (args) => Array.isArray(args) && args.length === 0,
		expectedDescriptors: Object.freeze({
			low: Object.freeze({
				selector: "glm-5-3-medium",
				invocationArgs: Object.freeze([]),
			}),
			standard: Object.freeze({
				selector: "glm-5-3",
				invocationArgs: Object.freeze([]),
			}),
		}),
	}),
	Object.freeze({
		targetId: "opencode-go",
		harness: "opencode",
		kind: "bridge",
		defaultEligible: true,
		capabilities: Object.freeze(["low", "standard"]),
		selectors: Object.freeze(["opencode-go/deepseek-v4.1-flash"]),
		validateInvocationArgs: (args) =>
			Array.isArray(args) &&
			args.length === 2 &&
			args[0] === "--variant" &&
			["low", "max"].includes(args[1]),
		expectedDescriptors: Object.freeze({
			low: Object.freeze({
				selector: "opencode-go/deepseek-v4.1-flash",
				invocationArgs: Object.freeze(["--variant", "low"]),
			}),
			standard: Object.freeze({
				selector: "opencode-go/deepseek-v4.1-flash",
				invocationArgs: Object.freeze(["--variant", "max"]),
			}),
		}),
	}),
]);
const CAPABILITIES = new Set(["low", "standard", "high"]);
const SECRET_PATHS = [
	/(^|\/)\.env(?:\.|$)/iu,
	/(^|\/)\.npmrc$/iu,
	/(^|\/)\.netrc$/iu,
	/(^|\/)\.ssh\//iu,
	/(^|\/)(?:id_rsa|id_ed25519)/iu,
	/\.(?:pem|key)$/iu,
	/(^|\/)credentials(?:\.|$)/iu,
	/(^|\/)secrets?(?:\.|$)/iu,
	/(^|\/)\.docker\/config\.json$/iu,
];
class SimpleUsageError extends Error {
	constructor(message) {
		super(message);
		this.name = "SimpleUsageError";
	}
}
function git(projectPath, args, options = {}) {
	return spawnSync("git", args, {
		cwd: projectPath,
		encoding: options.encoding ?? "utf8",
		input: options.input,
		maxBuffer: options.maxBuffer ?? MAX_CAPTURE_BYTES,
		timeout: options.timeout,
		stdio: ["pipe", "pipe", "pipe"],
	});
}
function requireGit(projectPath, args, code, options = {}) {
	const result = git(projectPath, args, options);
	if (result.status !== 0) {
		const failureCode =
			result.error?.code === "ETIMEDOUT" ? "deadline_expired" : code;
		const error = new Error(failureCode);
		error.code = failureCode;
		throw error;
	}
	return result.stdout;
}
const WORKTREE_GIT_CONFIG = [
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.untrackedCache=false",
	"-c",
	"diff.external=",
	"-c",
	"core.attributesFile=/dev/null",
];
function gitControlTampered(reason) {
	return Object.assign(new Error(`git_control_tampered: ${reason}`), {
		code: "git_control_tampered",
	});
}
/**
 * Host git against a provider-writable clone. The git-dir and work-tree are
 * pinned, system and global config are dropped, hooks, fsmonitor, the
 * untracked cache, attribute files and external diff drivers are disabled,
 * and replace refs are ignored.
 */
function worktreeGit(worktreePath, args, options = {}) {
	const hardenedArgs =
		args[0] === "diff"
			? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)]
			: args;
	return spawnSync(
		"git",
		[
			"--git-dir",
			join(worktreePath, ".git"),
			"--work-tree",
			worktreePath,
			...WORKTREE_GIT_CONFIG,
			...hardenedArgs,
		],
		{
			cwd: worktreePath,
			encoding: options.encoding ?? "utf8",
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				LANG: "C",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CEILING_DIRECTORIES: dirname(worktreePath),
				GIT_NO_REPLACE_OBJECTS: "1",
			},
			input: options.input,
			maxBuffer: options.maxBuffer ?? MAX_CAPTURE_BYTES,
			timeout: options.timeout,
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
}
function requireWorktreeGit(worktreePath, args, code, options = {}) {
	const result = worktreeGit(worktreePath, args, options);
	if (result.status !== 0) {
		const failureCode =
			result.error?.code === "ETIMEDOUT" ? "deadline_expired" : code;
		const error = new Error(failureCode);
		error.code = failureCode;
		throw error;
	}
	return result.stdout;
}
function gitControlEntry(stats) {
	return {
		type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
		dev: stats.dev,
		ino: stats.ino,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
	};
}
function collectGitControlEntries(gitDir) {
	const entries = new Map();
	const pending = [["", gitDir]];
	while (pending.length > 0) {
		const [relative, absolute] = pending.pop();
		for (const dirent of readdirSync(absolute, { withFileTypes: true })) {
			const childRelative = relative
				? `${relative}/${dirent.name}`
				: dirent.name;
			const childAbsolute = join(absolute, dirent.name);
			let stats;
			try {
				stats = lstatSync(childAbsolute);
			} catch (error) {
				if (error?.code === "ENOENT") continue;
				throw error;
			}
			const entry = gitControlEntry(stats);
			if (entry.type === "file") {
				entry.sha256 = createHash("sha256")
					.update(readFileSync(childAbsolute))
					.digest("hex");
			}
			entries.set(childRelative, entry);
			if (entry.type === "directory")
				pending.push([childRelative, childAbsolute]);
		}
	}
	return entries;
}
/** Record every path under the clone's `.git` before untrusted code runs. */
function snapshotGitControl(worktreePath) {
	const gitDir = join(worktreePath, ".git");
	let stats;
	try {
		stats = lstatSync(gitDir);
	} catch (error) {
		if (error?.code === "ENOENT") throw gitControlTampered("missing .git");
		throw error;
	}
	if (!stats.isDirectory()) throw gitControlTampered(".git is not a directory");
	return {
		dev: stats.dev,
		ino: stats.ino,
		entries: collectGitControlEntries(gitDir),
	};
}
function providerWritableGitPath(path) {
	if (
		[
			"index",
			"HEAD",
			"ORIG_HEAD",
			"FETCH_HEAD",
			"COMMIT_EDITMSG",
			"packed-refs",
		].includes(path)
	)
		return true;
	if (path === "objects" || path.startsWith("objects/"))
		return !(path === "objects/info" || path.startsWith("objects/info/"));
	if (path === "refs" || path.startsWith("refs/"))
		return !(path === "refs/replace" || path.startsWith("refs/replace/"));
	return path === "logs" || path.startsWith("logs/");
}
function packedRefsNamesReplaceRef(content) {
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("^"))
			continue;
		const name = trimmed.split(/\s+/u)[1];
		if (typeof name === "string" && name.startsWith("refs/replace/"))
			return true;
	}
	return false;
}
function packedRefsFileNamesReplaceRef(gitDir) {
	try {
		return packedRefsNamesReplaceRef(
			readFileSync(join(gitDir, "packed-refs"), "utf8"),
		);
	} catch {
		return true;
	}
}
function gitControlEntryChanged(before, current) {
	return (
		before.type !== current.type ||
		before.dev !== current.dev ||
		before.ino !== current.ino ||
		before.size !== current.size ||
		before.mtimeMs !== current.mtimeMs ||
		before.sha256 !== current.sha256
	);
}
/**
 * Fail closed before any host git call on a provider-writable clone: only the
 * object database, refs (never replace refs), the index, logs and a few HEAD
 * scratch files may differ from the pre-provider snapshot, and nothing under
 * `.git` may be a symlink, FIFO, socket or device.
 */
function verifyGitControl(worktreePath, snapshot) {
	if (!snapshot) throw gitControlTampered("missing snapshot");
	const gitDir = join(worktreePath, ".git");
	let rootStats;
	try {
		rootStats = lstatSync(gitDir);
	} catch (error) {
		if (error?.code === "ENOENT") throw gitControlTampered("missing .git");
		throw error;
	}
	if (
		!rootStats.isDirectory() ||
		rootStats.dev !== snapshot.dev ||
		rootStats.ino !== snapshot.ino
	)
		throw gitControlTampered(".git replaced");
	const current = collectGitControlEntries(gitDir);
	for (const [path, entry] of current) {
		if (entry.type === "other")
			throw gitControlTampered(`non-regular .git entry: ${path}`);
		const before = snapshot.entries.get(path);
		if (before === undefined) {
			if (!providerWritableGitPath(path))
				throw gitControlTampered(`added .git/${path}`);
			if (path === "packed-refs" && packedRefsFileNamesReplaceRef(gitDir))
				throw gitControlTampered("packed-refs names refs/replace/");
			continue;
		}
		if (before.type !== entry.type)
			throw gitControlTampered(`retyped .git/${path}`);
		if (!providerWritableGitPath(path)) {
			if (gitControlEntryChanged(before, entry))
				throw gitControlTampered(`changed .git/${path}`);
			continue;
		}
		if (
			path === "packed-refs" &&
			gitControlEntryChanged(before, entry) &&
			packedRefsFileNamesReplaceRef(gitDir)
		)
			throw gitControlTampered("packed-refs names refs/replace/");
	}
	for (const path of snapshot.entries.keys()) {
		if (!current.has(path) && !providerWritableGitPath(path))
			throw gitControlTampered(`removed .git/${path}`);
	}
}
function normalizeDeclaredPath(projectPath, value, flagName = "--file") {
	if (typeof value !== "string" || value.trim() === "") {
		throw new SimpleUsageError(
			`${flagName} requires a non-empty relative path`,
		);
	}
	const path = value.trim();
	const components = path.split("/");
	if (
		path !== value ||
		path.length > MAX_PATH_CHARS ||
		isAbsolute(path) ||
		path.includes("\0") ||
		path.includes("\\") ||
		/[*?[\]]/u.test(path) ||
		components.some(
			(component) =>
				component === "" ||
				component === "." ||
				component === ".." ||
				component === ".git",
		) ||
		SECRET_PATHS.some((pattern) => pattern.test(path))
	) {
		throw new SimpleUsageError(`unsafe ${flagName} path: ${value}`);
	}
	const absolute = resolve(projectPath, path);
	if (
		absolute !== projectPath &&
		!absolute.startsWith(`${projectPath}${sep}`)
	) {
		throw new SimpleUsageError(`${flagName} escapes project: ${value}`);
	}
	return path;
}
function assertDeclaredPathBoundary(projectPath, path) {
	let current = projectPath;
	const components = path.split("/");
	for (let index = 0; index < components.length; index += 1) {
		current = join(current, components[index]);
		let stats;
		try {
			stats = lstatSync(current);
		} catch (error) {
			if (error?.code === "ENOENT") return;
			throw error;
		}
		const isFinal = index === components.length - 1;
		if (
			stats.isSymbolicLink() ||
			(isFinal ? !stats.isFile() : !stats.isDirectory())
		) {
			throw new SimpleUsageError(`unsafe --file boundary: ${path}`);
		}
	}
}
function parseDeadline(value, nowMs) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new SimpleUsageError("--deadline <RFC3339> is required");
	}
	if (
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
			value,
		)
	) {
		throw new SimpleUsageError("--deadline must be an RFC3339 timestamp");
	}
	const deadlineMs = Date.parse(value);
	if (!Number.isFinite(deadlineMs) || deadlineMs <= nowMs) {
		throw new SimpleUsageError("--deadline must be in the future");
	}
	if (deadlineMs - nowMs > MAX_DEADLINE_MS) {
		throw new SimpleUsageError("--deadline may be at most 30 minutes ahead");
	}
	return deadlineMs;
}
export function parseSimpleArgs(argv, { now = Date.now } = {}) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				project: { type: "string" },
				capability: { type: "string" },
				file: { type: "string", multiple: true },
				"allow-manifest": { type: "string", multiple: true },
				input: { type: "string", multiple: true },
				"dirty-overlay": { type: "boolean", default: false },
				"predecessor-receipt": { type: "string" },
				"only-provider": { type: "string", multiple: true },
				check: { type: "string", multiple: true },
				"baseline-check": { type: "string", multiple: true },
				"repair-checks": { type: "boolean", default: false },
				"no-repair-checks": { type: "boolean", default: false },
				deadline: { type: "string" },
				"routing-run-id": { type: "string" },
				json: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
		});
	} catch (error) {
		throw new SimpleUsageError(error.message);
	}
	if (parsed.values.help) return { help: true };
	if (parsed.positionals.length !== 1) {
		throw new SimpleUsageError("exactly one <prompt-file> is required");
	}
	if (!parsed.values.project) {
		throw new SimpleUsageError("--project <path> is required");
	}
	const projectPath = resolve(parsed.values.project);
	if (!existsSync(projectPath) || !lstatSync(projectPath).isDirectory()) {
		throw new SimpleUsageError("--project must be an existing directory");
	}
	const canonicalProjectPath = realpathSync(projectPath);
	const repo = git(canonicalProjectPath, ["rev-parse", "--show-toplevel"]);
	if (
		repo.status !== 0 ||
		realpathSync(repo.stdout.trim()) !== canonicalProjectPath
	) {
		throw new SimpleUsageError("--project must be a Git repository root");
	}
	const promptPath = resolve(parsed.positionals[0]);
	if (!existsSync(promptPath)) {
		throw new SimpleUsageError("prompt file does not exist");
	}
	const promptStats = lstatSync(promptPath);
	if (!promptStats.isFile() || promptStats.isSymbolicLink()) {
		throw new SimpleUsageError(
			"prompt file must be a regular non-symlink file",
		);
	}
	if (promptStats.size === 0 || promptStats.size > MAX_PROMPT_BYTES) {
		throw new SimpleUsageError("prompt file must contain 1 to 262144 bytes");
	}
	const capability = String(parsed.values.capability ?? "").toLowerCase();
	if (!CAPABILITIES.has(capability)) {
		throw new SimpleUsageError("--capability must be low, standard, or high");
	}
	const onlyProviders = parsed.values["only-provider"] ?? [];
	if (
		onlyProviders.length > 1 ||
		(onlyProviders.length === 1 &&
			(!SIMPLE_PROVIDERS.includes(onlyProviders[0]) ||
				onlyProviders[0].includes(",")))
	) {
		throw new SimpleUsageError(
			"--only-provider must name exactly one supported simple provider",
		);
	}
	const files = (parsed.values.file ?? []).map((path) =>
		normalizeDeclaredPath(canonicalProjectPath, path),
	);
	if (
		files.length === 0 ||
		files.length > MAX_DECLARED_FILES ||
		new Set(files).size !== files.length
	) {
		throw new SimpleUsageError("at least one unique --file is required");
	}
	const allowManifests = (parsed.values["allow-manifest"] ?? []).map((path) =>
		normalizeDeclaredPath(canonicalProjectPath, path, "--allow-manifest"),
	);
	if (new Set(allowManifests).size !== allowManifests.length) {
		throw new SimpleUsageError("--allow-manifest paths must be unique");
	}
	for (const path of allowManifests) {
		if (!files.includes(path)) {
			throw new SimpleUsageError(
				`--allow-manifest path must also be declared with --file: ${path}`,
			);
		}
		if (manifestReviewPaths([path]).length === 0) {
			throw new SimpleUsageError(
				`--allow-manifest path is not a build/execution manifest: ${path}`,
			);
		}
	}
	const dirtyOverlay = parsed.values["dirty-overlay"] === true;
	if (!dirtyOverlay) {
		for (const path of files)
			assertDeclaredPathBoundary(canonicalProjectPath, path);
	}
	const inputs = (parsed.values.input ?? []).map((path) =>
		normalizeDeclaredPath(canonicalProjectPath, path, "--input"),
	);
	if (inputs.some((path) => files.includes(path))) {
		throw new SimpleUsageError("--file and --input scopes must not overlap");
	}
	if (
		files.length + inputs.length > MAX_DECLARED_FILES ||
		new Set(inputs).size !== inputs.length
	) {
		throw new SimpleUsageError("--input paths must be unique and bounded");
	}
	if (inputs.length > 0 && !dirtyOverlay) {
		throw new SimpleUsageError("--input requires --dirty-overlay");
	}
	if (!dirtyOverlay) {
		for (const path of inputs)
			assertDeclaredPathBoundary(canonicalProjectPath, path);
	}
	const predecessorReceiptPath = parsed.values["predecessor-receipt"]
		? resolve(parsed.values["predecessor-receipt"])
		: null;
	if (predecessorReceiptPath) {
		if (!dirtyOverlay) {
			throw new SimpleUsageError(
				"--predecessor-receipt requires --dirty-overlay",
			);
		}
		if (!existsSync(predecessorReceiptPath)) {
			throw new SimpleUsageError("predecessor receipt file does not exist");
		}
		const predStats = lstatSync(predecessorReceiptPath);
		if (!predStats.isFile() || predStats.isSymbolicLink()) {
			throw new SimpleUsageError(
				"predecessor receipt must be a regular non-symlink file",
			);
		}
	}
	const checks = parsed.values.check ?? [];
	const baselineChecks = parsed.values["baseline-check"] ?? [];
	if (
		checks.length === 0 ||
		checks.length > MAX_CHECKS ||
		checks.some(
			(check) =>
				typeof check !== "string" ||
				check.trim() === "" ||
				check.length > MAX_CHECK_CHARS,
		)
	) {
		throw new SimpleUsageError("at least one non-empty --check is required");
	}
	if (
		baselineChecks.length > MAX_CHECKS ||
		baselineChecks.some(
			(check) =>
				typeof check !== "string" ||
				check.trim() === "" ||
				check.length > MAX_CHECK_CHARS,
		)
	) {
		throw new SimpleUsageError(
			"--baseline-check commands must be non-empty and bounded",
		);
	}
	const routingRunId =
		parsed.values["routing-run-id"] ??
		process.env.SWITCHYARD_ROUTING_RUN_ID ??
		null;
	if (routingRunId !== null) {
		try {
			validateRoutingRunId(routingRunId);
		} catch {
			throw new SimpleUsageError("invalid routing run id");
		}
	}
	if (
		parsed.values["repair-checks"] === true &&
		parsed.values["no-repair-checks"] === true
	) {
		throw new SimpleUsageError(
			"--repair-checks and --no-repair-checks are mutually exclusive",
		);
	}
	const nowMs = now();
	return {
		promptPath,
		projectPath: canonicalProjectPath,
		capability,
		onlyProviders,
		files,
		allowManifests,
		readOnlyInputs: inputs,
		dirtyOverlay,
		predecessorReceiptPath,
		checks: checks.map((check) => check.trim()),
		baselineChecks: baselineChecks.map((check) => check.trim()),
		repairChecks: parsed.values["no-repair-checks"] !== true,
		deadlineMs: parseDeadline(parsed.values.deadline, nowMs),
		routingRunId,
	};
}
export {
	git,
	MAX_CAPTURE_BYTES,
	requireGit,
	requireWorktreeGit,
	SECRET_PATHS,
	SIMPLE_TARGET_ADAPTERS,
	SimpleUsageError,
	snapshotGitControl,
	verifyGitControl,
	worktreeGit,
};
