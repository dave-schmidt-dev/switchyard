// Small, local implementation path: one provider, one disposable checkout,
// one absolute deadline, one bounded result. The legacy VM queue remains the
// rollback path and deliberately does not call this module.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { sanitizeFailureMetadata } from "../adapter/exec-error.mjs";
import {
	boundProviderLifecycleSnapshot,
	runProviderProcess,
} from "../adapter/provider-lifecycle.mjs";
import {
	integrationGate,
	manifestReviewPaths,
	validateDiff,
} from "../integrate/index.mjs";
import {
	captureDirtyOverlay,
	materializeDirtyOverlay,
	parsePredecessorReceipt,
	validateDirtyOverlayReceipt,
} from "../lifecycle/index.mjs";
import {
	getConfiguredInvocationDescriptor,
	normalizeProviderName,
	resolveTargetIdentity,
} from "../roster/index.mjs";
import { readSnapshotAtRoute, route } from "../router/index.mjs";
import {
	acquireProjectLock,
	createEvent,
	initializeRun,
	readRun,
	releaseProjectLockIfOwnedBy,
	updateRunWithRetry,
} from "../run-store/index.mjs";
import { settleSimpleWriterProcesses } from "./process-teardown.mjs";
import { cleanupSimpleWorktree } from "./worktree-cleanup.mjs";

export const SIMPLE_USAGE = `Usage: switchyard-dispatch simple <prompt-file> --project <path> --capability <low|standard|high> --file <path> [--allow-manifest <path>] [--input <path>] [--dirty-overlay] [--predecessor-receipt <path>] [--only-provider <provider>] --check <command> --deadline <RFC3339> [--json]

Runs one bounded assignment in a disposable local checkout. Repeat --file and
--input and --check as needed. --input is read-only and requires --dirty-overlay.
--allow-manifest opts one declared --file that is a build/execution manifest
(package.json, lockfiles, Makefile, Dockerfile, *.sh/*.bash, CI configs) into
editing; repeat it per path. Any other manifest still fails closed.
--predecessor-receipt binds output of a previous run and requires --dirty-overlay.
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
// A pin is a routing contract, not an adapter promise. The simple lane keeps
// this target-aware registry as its one local-compatibility boundary. In
// particular, the two Agy targets share a CLI harness but do not share a
// model contract.
const SIMPLE_PROVIDERS = Object.freeze([
	"claude-code",
	"codex",
	"antigravity",
	"antigravity-claude",
	"cursor",
	"opencode-go",
	"vibe",
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
				deadline: { type: "string" },
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
		deadlineMs: parseDeadline(parsed.values.deadline, nowMs),
	};
}

function rosterPath() {
	return (
		process.env.SWITCHYARD_ROSTER_PATH ||
		join(homedir(), ".agent", "roster.json")
	);
}

const SIMPLE_INCLUDED_USAGE_FLOOR = 5;
const SIMPLE_INCLUDED_USAGE_WINDOWS = Object.freeze([
	"five_hour",
	"weekly",
	"monthly",
]);

/**
 * Return the funding admission failure for a simple target, if any.
 * OpenCode Go can use its included subscription headroom when its distinct
 * installed usage snapshot is fresh and every required window retains the
 * router's existing 5% reserve. This is a local admission check; it does not
 * change OpenCode's account-side balance fallback setting.
 *
 * @param {object} target
 * @param {{targetId?: string, snapshotRead?: object}} [options]
 * @returns {string|null}
 */
export function simpleRouteFundingFailure(target, options = {}) {
	if (
		target?.enabled !== true ||
		!["subscription", "quota"].includes(target.funding?.included?.mode)
	) {
		return "paid_overage_not_allowed";
	}
	if (target.funding?.overage?.enabled === false) return null;
	if (
		options.targetId !== "opencode-go" ||
		target.funding?.included?.mode !== "subscription"
	) {
		return "paid_overage_not_allowed";
	}

	const snapshotRead = options.snapshotRead ?? readSnapshotAtRoute(Date.now());
	if (
		snapshotRead?.snapshotStatus !== "fresh" ||
		!Array.isArray(snapshotRead.snapshot?.providers)
	) {
		return "included_usage_unverified";
	}
	const matchingProviders = snapshotRead.snapshot.providers.filter(
		(provider) =>
			typeof target.snapshot_name === "string" &&
			provider?.name === target.snapshot_name,
	);
	if (matchingProviders.length !== 1 || matchingProviders[0]?.ok !== true) {
		return "included_usage_unverified";
	}

	const providerWindows = matchingProviders[0].windows;
	if (!Array.isArray(providerWindows)) return "included_usage_unverified";
	const requiredWindows = new Map();
	for (const window of providerWindows) {
		if (!window || typeof window !== "object") {
			return "included_usage_unverified";
		}
		if (!SIMPLE_INCLUDED_USAGE_WINDOWS.includes(window.id)) continue;
		if (requiredWindows.has(window.id)) return "included_usage_unverified";
		requiredWindows.set(window.id, window);
	}
	for (const id of SIMPLE_INCLUDED_USAGE_WINDOWS) {
		const window = requiredWindows.get(id);
		if (
			!window ||
			typeof window.percent_left !== "number" ||
			!Number.isFinite(window.percent_left) ||
			window.percent_left < SIMPLE_INCLUDED_USAGE_FLOOR ||
			window.percent_left > 100
		) {
			return "included_usage_unverified";
		}
	}
	return null;
}

export function simpleRouteIsFunded(target, options = {}) {
	return simpleRouteFundingFailure(target, options) === null;
}

function assertFundedRoute(targetId) {
	let roster;
	try {
		roster = JSON.parse(readFileSync(rosterPath(), "utf8"));
	} catch {
		throw Object.assign(new Error("roster_unavailable"), {
			code: "roster_unavailable",
		});
	}
	const target = roster?.targets?.[targetId];
	const failure = simpleRouteFundingFailure(target, { targetId });
	if (failure) {
		throw Object.assign(new Error(failure), {
			code: failure,
		});
	}
}

function fileFingerprint(projectPath, files) {
	const hash = createHash("sha256");
	for (const path of [...files].sort()) {
		const absolute = resolve(projectPath, path);
		hash.update(path).update("\0");
		try {
			const stats = lstatSync(absolute);
			if (stats.isSymbolicLink()) hash.update(`symlink:${stats.mode}`);
			else if (stats.isFile())
				hash.update(`file:${stats.mode}:`).update(readFileSync(absolute));
			else hash.update(`other:${stats.mode}:${stats.size}`);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			hash.update("missing");
		}
		hash.update("\0");
	}
	return hash.digest("hex");
}

function dirtyBaselineScopeIdentity({ baseRevision, files, inputs }) {
	return sha256(
		JSON.stringify({
			baseRevision,
			writablePaths: files,
			readOnlyInputs: inputs,
		}),
	);
}

function canonicalJson(value) {
	if (typeof value === "string") {
		return JSON.stringify(value).replaceAll(
			/[\u007f-\uffff]/g,
			(unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
		);
	}
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${canonicalJson(key)}:${canonicalJson(value[key])}`)
		.join(",")}}`;
}

function makeDirtyBaseline({
	taskId,
	baseRevision,
	projectPath,
	files,
	inputs,
	receipt,
}) {
	const allPaths = [...files, ...inputs];
	const commonDir = git(projectPath, ["rev-parse", "--git-common-dir"]);
	if (commonDir.status !== 0)
		throw new Error("dirty baseline repository identity unavailable");
	const commonPath = commonDir.stdout.trim();
	const repositoryPath = realpathSync(
		isAbsolute(commonPath) ? commonPath : resolve(projectPath, commonPath),
	);
	const baseline = {
		task_id: taskId,
		base_commit: baseRevision,
		repository_identity: sha256Hex(repositoryPath),
		host_identity: hostname().trim() || "unknown-host",
		writable_paths: [...files],
		read_only_inputs: [...inputs],
		files: Object.fromEntries(
			allPaths.map((path) => {
				const entry = receipt.paths.find(
					(candidate) => candidate.path === path,
				);
				return [
					path,
					{
						sha256: entry.sha256,
						size: entry.size,
						mode: entry.mode & 0o111 ? 0o100755 : 0o100644,
						...(entry.tracked === false
							? { tracked: false, predecessor: entry.predecessor }
							: { tracked: true }),
					},
				];
			}),
		),
	};
	return {
		...baseline,
		receipt_sha256: sha256Hex(canonicalJson(baseline)),
	};
}

function extractErrno(error) {
	if (!error) return null;
	const candidates = [
		error.code,
		error.errno,
		error.cause?.code,
		error.cause?.errno,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && /^[A-Z0-9]+$/u.test(candidate)) {
			return candidate;
		}
	}
	if (typeof error.message === "string") {
		const match =
			/\b(EPERM|EACCES|EROFS|ENOSPC|EMFILE|ENFILE|EIO|EDQUOT|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|ENETDOWN)\b/u.exec(
				error.message,
			);
		if (match) return match[1];
	}
	return null;
}

function dirtyOverlayFailure(error, { taskId, baseRevision, files, inputs }) {
	const message = String(error?.message ?? "dirty overlay preflight failed");
	const errno = extractErrno(error);
	let code = errno ?? "dirty_overlay_preflight_failed";
	let condition = "declared dirty input could not be captured";
	let remedy =
		"keep the declared inputs tracked, regular, non-secret files and retry";
	if (errno === "EPERM" || errno === "EACCES") {
		code = errno;
		condition = "filesystem permission denied during overlay capture";
		remedy = "ensure read access to declared input files";
	} else if (errno) {
		code = errno;
		condition = "filesystem error during overlay capture";
		remedy = "resolve filesystem issue";
	} else if (
		/predecessor.*mismatch/iu.test(message) ||
		error?.code === "predecessor_receipt_mismatch"
	) {
		code = "predecessor_receipt_mismatch";
		condition = "predecessor receipt base revision or digest mismatched";
		remedy = "provide a valid matching predecessor receipt or track the file";
	} else if (
		/predecessor.*missing/iu.test(message) ||
		error?.code === "predecessor_receipt_missing"
	) {
		code = "predecessor_receipt_missing";
		condition = "predecessor receipt file is missing";
		remedy = "provide an existing predecessor receipt file";
	} else if (error?.code === "predecessor_receipt_unverified") {
		code = "predecessor_receipt_unverified";
		condition = "predecessor run is not a completed accepted result";
		remedy =
			"wait for predecessor cleanup to complete and use its durable receipt";
	} else if (
		/predecessor/iu.test(message) ||
		error?.code === "predecessor_receipt_invalid"
	) {
		code = "predecessor_receipt_invalid";
		condition = "predecessor receipt is invalid";
		remedy = "provide a valid predecessor receipt";
	} else if (/untracked/u.test(message)) {
		code = "dirty_overlay_untracked";
		condition = "a scoped input is untracked";
		remedy = "track the input or remove it from --file/--input";
	} else if (/deleted|ENOENT/u.test(message)) {
		code = "dirty_overlay_deleted";
		condition = "a scoped input is deleted or unavailable";
		remedy = "restore the input or remove it from --file/--input";
	} else if (/ignored/u.test(message)) {
		code = "dirty_overlay_ignored";
		condition = "a scoped input is ignored by Git";
		remedy = "remove the ignore rule or remove the input from --file/--input";
	} else if (/symlink/u.test(message)) {
		code = "dirty_overlay_symlink";
		condition = "a scoped input crosses or names a symlink";
		remedy = "declare a regular tracked file without symlink parents";
	} else if (/too large/u.test(message)) {
		code = "dirty_overlay_oversized";
		condition = "a scoped input exceeds the 8 MiB simple transport limit";
		remedy = "reduce the file below 8 MiB or remove it from the scope";
	} else if (/regular file/u.test(message)) {
		code = "dirty_overlay_not_regular";
		condition = "a scoped input is not one regular file";
		remedy = "replace the scoped path with a tracked regular file";
	} else if (/secret-shaped|credential/u.test(message)) {
		code = "dirty_overlay_secret_path";
		condition = "a scoped input matches a credential or secret path convention";
		remedy = "remove the secret-shaped path from the scope";
	}
	return {
		code,
		condition,
		remedy,
		identity: dirtyBaselineScopeIdentity({
			baseRevision,
			files,
			inputs,
		}),
		taskId,
	};
}

function declaredPathsAreClean(projectPath, files) {
	const result = git(projectPath, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
		"--",
		...files,
	]);
	return result.status === 0 && result.stdout.length === 0;
}

function remainingMs(deadlineMs, now) {
	return Math.max(0, deadlineMs - now());
}

function deadlineTimeout(deadlineMs, now) {
	const value = remainingMs(deadlineMs, now);
	if (value <= 0) {
		throw Object.assign(new Error("deadline_expired"), {
			code: "deadline_expired",
		});
	}
	return value;
}

const FIRST_CHANGE_PROBE_INTERVAL_MS = 5_000;

function emitStatus(onStatus, taskId, phase, details = {}) {
	try {
		onStatus?.({ schemaVersion: 1, taskId, phase, ...details });
	} catch {
		// Status reporting cannot change execution.
	}
}

export function buildSimpleProviderInvocation(
	harness,
	descriptor,
	_prompt,
	worktreePath,
	targetId = descriptor?.target_id ?? null,
	capability = null,
) {
	const compatibility = simpleProviderCompatibility({
		targetId,
		harness,
		descriptor,
		capability,
	});
	if (!compatibility.compatible) {
		throw Object.assign(new Error(compatibility.reason), {
			code: compatibility.reason,
		});
	}
	if (harness === "codex") {
		const invocationArgs = descriptor.invocation_args ?? [];
		for (let index = 0; index < invocationArgs.length; index += 2) {
			if (
				!["-c", "--config"].includes(invocationArgs[index]) ||
				!/^model_reasoning_effort=(?:none|minimal|low|medium|high|xhigh|max|ultra)$/u.test(
					invocationArgs[index + 1] ?? "",
				)
			) {
				throw Object.assign(new Error("local_descriptor_args_unsafe"), {
					code: "local_descriptor_args_unsafe",
				});
			}
		}
		return {
			command: "codex",
			args: [
				"exec",
				"--ephemeral",
				"--ignore-user-config",
				"--ignore-rules",
				"-c",
				'approval_policy="never"',
				"-C",
				worktreePath,
				"-s",
				"workspace-write",
				"-m",
				descriptor.selector,
				...invocationArgs,
				"-",
			],
		};
	}
	if (harness === "agy") {
		return {
			command: "agy",
			args: [
				"--new-project",
				"--mode",
				"accept-edits",
				"--dangerously-skip-permissions",
				"--sandbox",
				"--model",
				descriptor.selector,
				"--add-dir",
				worktreePath,
				"--output-format",
				"json",
				"--print-timeout",
				"30m",
				"--print",
				_prompt,
			],
		};
	}
	if (harness === "vibe") {
		return {
			command: "/Users/dave/.agent/bin/bws-secret-exec",
			args: [
				"switchyard-simple-vibe-dispatch",
				"--",
				"--target",
				"vibe",
				"--model",
				descriptor.selector,
				"--worktree",
				worktreePath,
			],
		};
	}
	if (harness === "opencode") {
		return {
			command: "/Users/dave/.agent/bin/bws-secret-exec",
			args: [
				"switchyard-simple-opencode-go-dispatch",
				"--",
				"--target",
				"opencode-go",
				"--model",
				descriptor.selector,
				"--worktree",
				worktreePath,
				"--variant",
				descriptor.invocation_args[1],
			],
		};
	}
	return {
		command: "copilot",
		args: [
			"--experimental",
			"--sandbox",
			"-C",
			worktreePath,
			"--model",
			descriptor.selector,
			"--available-tools",
			"apply_patch,create,edit,view,glob,grep",
			"--allow-tool",
			"read,write",
			"--disallow-temp-dir",
			"--disable-builtin-mcps",
			"--no-custom-instructions",
			"--no-ask-user",
			"--no-auto-update",
			"--output-format",
			"json",
			"--stream",
			"off",
			"-p",
			_prompt,
		],
	};
}

/**
 * Check the exact target, harness, and descriptor before it may enter the
 * simple lane. Target identity is intentional: Antigravity and Antigravity
 * (Claude) share the `agy` harness but are separate owner-selected routes.
 */
export function simpleProviderCompatibility({
	targetId,
	harness,
	descriptor,
	capability = null,
}) {
	if (!descriptor || descriptor.target_id !== targetId) {
		return { compatible: false, reason: "invocation_descriptor_unavailable" };
	}
	const adapter = SIMPLE_TARGET_ADAPTERS.find(
		(candidate) => candidate.targetId === targetId,
	);
	if (!adapter || adapter.harness !== harness) {
		return { compatible: false, reason: "local_adapter_unavailable" };
	}
	if (adapter.capabilities && !adapter.capabilities.includes(capability)) {
		return { compatible: false, reason: "local_adapter_unavailable" };
	}
	if (adapter.selectors && !adapter.selectors.includes(descriptor.selector)) {
		return { compatible: false, reason: "local_descriptor_model_unavailable" };
	}
	if (
		adapter.validateInvocationArgs &&
		!adapter.validateInvocationArgs(descriptor.invocation_args)
	) {
		return { compatible: false, reason: "local_descriptor_args_unsafe" };
	}
	const expectedDescriptor = adapter.expectedDescriptors?.[capability];
	if (expectedDescriptor?.selector !== undefined) {
		if (descriptor.selector !== expectedDescriptor.selector) {
			return {
				compatible: false,
				reason: "local_descriptor_model_unavailable",
			};
		}
		if (
			descriptor.invocation_args.length !==
				expectedDescriptor.invocationArgs.length ||
			descriptor.invocation_args.some(
				(value, index) => value !== expectedDescriptor.invocationArgs[index],
			)
		) {
			return { compatible: false, reason: "local_descriptor_args_unsafe" };
		}
	}
	return { compatible: true, reason: null };
}

export async function runSimpleWriter(command, args, options = {}) {
	// Test-injected spawns retain their own lifecycle contract. Production spawns
	// create a session and settle both its group and any escaped worktree holder.
	if (options.spawnFn) return runProviderProcess(command, args, options);
	let pgid = null;
	const launchedAt = Date.now();
	const result = await runProviderProcess(command, args, {
		...options,
		spawnFn: (cmd, argv, spawnOptions) => {
			const child = spawn(cmd, argv, { ...spawnOptions, detached: true });
			pgid = child.pid;
			return child;
		},
	});
	const writerLifecycle =
		result.writerLifecycle === "never_started"
			? "never_started"
			: await settleSimpleWriterProcesses({
					processGroupId: pgid,
					processScopePath: options.processScopePath,
					launchedAt,
					onProgress: options.onPoll,
				});
	return { ...result, writerLifecycle, processGroupId: pgid };
}

/** Execute one local provider without changing its observed process exit code. */
export async function defaultExecuteProvider(context) {
	const invocation = buildSimpleProviderInvocation(
		context.harness,
		context.descriptor,
		context.prompt,
		context.worktreePath,
		context.targetId,
		context.capability,
	);
	const result = await runSimpleWriter(invocation.command, invocation.args, {
		input: context.prompt,
		cwd: context.worktreePath,
		processScopePath: context.worktreePath,
		timeoutMs: context.timeoutMs,
		silenceTimeoutMs: Math.min(5 * 60 * 1000, context.timeoutMs),
		maxBuffer: MAX_CAPTURE_BYTES,
		progressStage: "running",
		onPoll: () => context.onProgress?.(),
		signal: context.signal,
		...(context.spawnFn ? { spawnFn: context.spawnFn } : {}),
	});
	if (context.harness === "opencode" && !result.success) {
		const providerVerdictCode = parseOpenCodeGoBridgeDiagnostic(result.output);
		return {
			...result,
			output: "",
			stderr: "",
			...(providerVerdictCode ? { providerVerdictCode } : {}),
		};
	}
	if (context.harness !== "agy" || !result.success) return result;
	try {
		return {
			...result,
			providerVerdictCode:
				JSON.parse(result.output)?.status === "SUCCESS"
					? "agy_success"
					: "agy_non_success",
		};
	} catch {
		return { ...result, providerVerdictCode: "agy_unparseable" };
	}
}

/** Parse only the fixed numeric diagnostic emitted by the OpenCode Go bridge. */
export function parseOpenCodeGoBridgeDiagnostic(output) {
	if (typeof output !== "string") return null;
	const match =
		/^SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=(0|[1-9]\d{0,5}) upstream_status=(0|[1-5]\d{2}) proxy_rejections=(0|[1-9]\d{0,5})\r?\n?$/u.exec(
			output,
		);
	if (!match) return null;
	const [, requests, upstreamStatus, proxyRejections] = match;
	return `opencode_go_diag_requests_${requests}_status_${upstreamStatus}_rejections_${proxyRejections}`;
}

async function defaultRunCheck({
	command,
	worktreePath,
	timeoutMs,
	onProgress,
	signal,
}) {
	return runSimpleWriter(
		"/bin/sh",
		[
			"-lc",
			'cd "$1" && exec /bin/sh -lc "$2"',
			"switchyard-check",
			worktreePath,
			command,
		],
		{
			processScopePath: worktreePath,
			timeoutMs,
			silenceTimeoutMs: Math.min(60 * 1000, timeoutMs),
			maxBuffer: MAX_CAPTURE_BYTES,
			progressStage: "running",
			onPoll: onProgress,
			signal,
		},
	);
}

function captureWorktreeDiff(worktreePath, baseRevision, deadlineMs, now) {
	requireGit(worktreePath, ["add", "-A", "--", "."], "diff_stage_failed", {
		timeout: deadlineTimeout(deadlineMs, now),
	});
	const changed = requireGit(
		worktreePath,
		["diff", "--cached", "--name-only", "-z", baseRevision],
		"diff_names_failed",
		{ timeout: deadlineTimeout(deadlineMs, now) },
	);
	const changedFiles = changed.split("\0").filter(Boolean);
	const diff = requireGit(
		worktreePath,
		["diff", "--cached", "--binary", "--full-index", baseRevision],
		"diff_capture_failed",
		{
			maxBuffer: MAX_CAPTURE_BYTES,
			timeout: deadlineTimeout(deadlineMs, now),
		},
	);
	return { changedFiles, diff };
}

function safeChangedFiles(files) {
	return files.every(
		(path) =>
			typeof path === "string" &&
			!SECRET_PATHS.some((pattern) => pattern.test(path)) &&
			!path.split("/").includes(".git"),
	)
		? files
		: [];
}

function classifyExecutionFailure(result) {
	if (result?.silenceTimedOut) return "provider_silence_timeout";
	if (result?.timedOut) return "provider_deadline_exceeded";
	if (result?.cancelled) return "provider_cancelled";
	if (result?.error && result.code === null) return "provider_launch_failed";
	return "provider_exit_nonzero";
}

const SIMPLE_RECOVERY_SCHEMA_VERSION = 1;
const RECOVERY_WRITER_STATES = new Set([
	"stopped",
	"never_started",
	"unavailable",
]);
const RECOVERY_WORKTREE_STATES = new Set([
	"not_created",
	"retained",
	"removed",
	"unavailable",
]);
const RECOVERY_LOCK_STATES = new Set([
	"not_acquired",
	"released",
	"unavailable",
]);

function aggregateWriterLifecycle(previous, current) {
	if (
		!RECOVERY_WRITER_STATES.has(previous) ||
		!RECOVERY_WRITER_STATES.has(current) ||
		previous === "unavailable" ||
		current === "unavailable"
	)
		return "unavailable";
	if (previous === "never_started") return current;
	if (current === "never_started") return previous;
	return "stopped";
}

function sha256Hex(value) {
	return createHash("sha256").update(value).digest("hex");
}

function sha256(value) {
	return `sha256:${sha256Hex(value)}`;
}

function recoveryScope(files, checks) {
	if (
		!Array.isArray(files) ||
		!Array.isArray(checks) ||
		!files.every((path) => typeof path === "string") ||
		!checks.every((command) => typeof command === "string")
	)
		return null;
	const declaredFiles = files.map((path) => path);
	const declaredChecks = checks.map((command, index) => ({
		index: index + 1,
		digest: sha256(command),
	}));
	return {
		files: declaredFiles,
		checks: declaredChecks,
		digest: sha256(
			JSON.stringify({ files: declaredFiles, checks: declaredChecks }),
		),
	};
}

function recoveryContract(options) {
	return {
		taskId: options.taskId,
		attemptId: options.attemptId,
		baseRevision: options.baseRevision,
		...(options.dirtyBaseline ? { dirtyBaseline: options.dirtyBaseline } : {}),
		scope: recoveryScope(options.files, options.checks),
	};
}

function recoveryUnavailable() {
	return {
		schemaVersion: SIMPLE_RECOVERY_SCHEMA_VERSION,
		identity: {
			taskId: null,
			attemptId: null,
			baseRevision: null,
			scope: null,
		},
		result: {
			status: "failed",
			failureReason: "recovery_evidence_unavailable",
			failurePhase: "preflight",
		},
		partialWorktree: null,
		cleanup: {
			writer: { state: "unavailable" },
			worktree: { state: "unavailable", path: null },
			projectLock: { state: "unavailable" },
		},
		continuation: { available: false, reason: "recovery_evidence_unavailable" },
	};
}

function expectedRecoveryScope(expected) {
	if (expected?.scope) return expected.scope;
	return recoveryScope(expected?.files, expected?.checks);
}

/**
 * Assess whether a simple result has enough closed evidence for attended
 * continuation. This never infers safety from a path, PID, or missing field.
 */
export function assessSimpleRecoveryEvidence(
	recovery,
	expected = {},
	{ allowUnfinalized = false } = {},
) {
	const unavailable = (reason) => ({ available: false, reason });
	if (!recovery || typeof recovery !== "object")
		return unavailable("recovery_evidence_unavailable");
	const identity = recovery.identity;
	const scope = identity?.scope;
	const expectedScope = expectedRecoveryScope(expected);
	if (
		recovery.schemaVersion !== SIMPLE_RECOVERY_SCHEMA_VERSION ||
		!identity ||
		typeof identity.taskId !== "string" ||
		typeof identity.attemptId !== "string" ||
		!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(identity.baseRevision ?? "") ||
		!scope ||
		!Array.isArray(scope.files) ||
		!Array.isArray(scope.checks) ||
		typeof scope.digest !== "string"
	)
		return unavailable("recovery_evidence_unavailable");
	if (
		!scope.files.every(
			(path) =>
				typeof path === "string" &&
				path.length > 0 &&
				!isAbsolute(path) &&
				!path.split("/").includes(".git"),
		) ||
		!scope.checks.every(
			(check, index) =>
				check &&
				check.index === index + 1 &&
				typeof check.digest === "string" &&
				/^sha256:[0-9a-f]{64}$/u.test(check.digest),
		) ||
		scope.digest !==
			sha256(JSON.stringify({ files: scope.files, checks: scope.checks }))
	)
		return unavailable("recovery_evidence_unavailable");
	if (
		identity.taskId !== expected.taskId ||
		identity.attemptId !== expected.attemptId ||
		identity.baseRevision !== expected.baseRevision ||
		JSON.stringify(scope) !== JSON.stringify(expectedScope)
	)
		return unavailable("recovery_identity_mismatch");
	const cleanup = recovery.cleanup;
	if (
		!recovery.result ||
		!new Set(["succeeded", "failed"]).has(recovery.result.status) ||
		(typeof recovery.result.failureReason !== "string" &&
			recovery.result.failureReason !== null) ||
		(typeof recovery.result.failurePhase !== "string" &&
			recovery.result.failurePhase !== null)
	)
		return unavailable("recovery_evidence_unavailable");
	const writerState = cleanup?.writer?.state;
	const worktreeState = cleanup?.worktree?.state;
	const lockState = cleanup?.projectLock?.state;
	if (
		!RECOVERY_WRITER_STATES.has(writerState) ||
		!RECOVERY_WORKTREE_STATES.has(worktreeState) ||
		!RECOVERY_LOCK_STATES.has(lockState)
	)
		return unavailable("recovery_evidence_unavailable");
	if (recovery.continuation?.available !== true && !allowUnfinalized)
		return unavailable(
			recovery.continuation?.reason ?? "recovery_evidence_unavailable",
		);
	if (
		worktreeState !== "retained" ||
		typeof recovery.partialWorktree !== "string" ||
		!isAbsolute(recovery.partialWorktree)
	)
		return unavailable("no_partial_work");
	if (cleanup.worktree.path !== recovery.partialWorktree)
		return unavailable("recovery_evidence_unavailable");
	if (writerState !== "stopped" && writerState !== "never_started")
		return unavailable("writer_stop_unconfirmed");
	if (lockState !== "released" && lockState !== "not_acquired")
		return unavailable("project_lock_release_unconfirmed");
	if (recovery.result?.status === "succeeded")
		return unavailable("no_partial_work");
	return { available: true, reason: null };
}

function createRecoveryEvidence({
	contract,
	result,
	partialWorktree,
	cleanup,
}) {
	const evidence = {
		schemaVersion: SIMPLE_RECOVERY_SCHEMA_VERSION,
		identity: contract,
		result: {
			status: result.status,
			failureReason: result.failureReason,
			failurePhase: result.failurePhase,
		},
		partialWorktree,
		cleanup,
		continuation: { available: false, reason: "pending" },
	};
	const assessment = assessSimpleRecoveryEvidence(evidence, contract, {
		allowUnfinalized: true,
	});
	evidence.continuation = assessment;
	return evidence;
}

function terminalResult(base, overrides = {}) {
	const status = overrides.status ?? "failed";
	return {
		schemaVersion: 1,
		runId: overrides.runId ?? base.runId ?? `simple-${base.taskId}`,
		taskId: base.taskId,
		attemptId: base.attemptId,
		status,
		provider: overrides.provider ?? null,
		targetId: overrides.targetId ?? null,
		elapsedMs: Math.max(0, base.now() - base.startedAt),
		changedFiles: safeChangedFiles(overrides.changedFiles ?? []),
		outputs: overrides.outputs ?? [],
		baseRevision: overrides.baseRevision ?? null,
		checks: overrides.checks ?? [],
		failureReason: overrides.failureReason ?? null,
		failurePhase: overrides.failurePhase ?? null,
		errorKind:
			overrides.errorKind ??
			(status === "succeeded" ? null : "unclassified_failure"),
		providerLifecycle: overrides.providerLifecycle ?? null,
		providerVerdictCode: overrides.providerVerdictCode ?? null,
		...(overrides.preflightDetail
			? { preflightDetail: overrides.preflightDetail }
			: {}),
		dirtyBaseline: overrides.dirtyBaseline ?? null,
		partialWorktree: overrides.partialWorktree ?? null,
		recovery: overrides.recovery ?? recoveryUnavailable(),
	};
}

async function resolvePredecessorReceipt(input, projectPath, dependencies) {
	const supplied = parsePredecessorReceipt(input, { projectPath });
	let predecessor;
	try {
		predecessor = await (dependencies.readRun ?? readRun)(supplied.runId);
	} catch {
		const error = new Error("predecessor run record is unavailable");
		error.code = "predecessor_receipt_unverified";
		throw error;
	}
	if (
		predecessor.state !== "succeeded" ||
		predecessor.cleanupState !== "complete" ||
		realpathSync(predecessor.projectPath) !== realpathSync(projectPath) ||
		predecessor.terminalSummary?.status !== "succeeded"
	) {
		const error = new Error(
			"predecessor run is not an accepted project result",
		);
		error.code = "predecessor_receipt_unverified";
		throw error;
	}
	const durable = parsePredecessorReceipt(
		{ runId: predecessor.runId, ...predecessor.terminalSummary },
		{ projectPath },
	);
	if (
		supplied.baseRevision !== durable.baseRevision ||
		JSON.stringify(supplied.outputs) !== JSON.stringify(durable.outputs)
	) {
		const error = new Error(
			"predecessor receipt does not match durable result",
		);
		error.code = "predecessor_receipt_unverified";
		throw error;
	}
	return durable;
}

export async function runSimpleTask(options, dependencies = {}) {
	const now = dependencies.now ?? Date.now;
	const taskId = dependencies.taskId ?? randomUUID();
	const attemptId = dependencies.attemptId ?? randomUUID();
	// A caller may bind an explicit run id for durable recovery or inspection.
	// Otherwise allocate a unique id: test seams and attended callers can reuse
	// a task id across attempts, while run-store records are create-only.
	const runId = dependencies.runId ?? `simple-${taskId}-${randomUUID()}`;
	const startedAt = now();
	const base = { taskId, attemptId, runId, startedAt, now };
	const onStatus = dependencies.onStatus;
	const signal = dependencies.signal;
	let provider = null;
	let targetId = null;
	let projectLocked = false;
	let canonicalParent = null;
	let candidateChild = null;
	let candidatePath = null;
	let worktreeRoot = null;
	let worktreePath = null;
	let keepWorktree = false;
	let changedFiles = [];
	let finalResult = null;
	let currentPhase = "preflight";
	let baseRevision = null;
	let worktreeBaseRevision = null;
	let dirtyOverlayReceipt = null;
	let dirtyBaseline = null;
	let preflightDetail = null;
	let providerLifecycle = null;
	let providerVerdictCode = null;
	let writerLifecycle = "never_started";
	let projectLockState = "not_acquired";
	let worktreeCreated = false;
	let worktreeIdentity = null;
	let worktreeCleanupReason = null;
	let executionFailureCaptureComplete = false;
	let lastMilestoneAt = startedAt;
	let firstChangeObserved = false;
	let lastFirstChangeProbeAt = Number.NEGATIVE_INFINITY;
	let runInitialized = false;
	let failureTerminalDurable = true;
	const pendingDurability = new Set();
	const checks = [];
	const acquireLock = dependencies.acquireProjectLock ?? acquireProjectLock;
	const releaseLock =
		dependencies.releaseProjectLock ?? releaseProjectLockIfOwnedBy;
	const executeProvider =
		dependencies.executeProvider ?? defaultExecuteProvider;
	const runCheck = dependencies.runCheck ?? defaultRunCheck;
	const routeProvider = dependencies.route ?? route;
	const descriptorFor =
		dependencies.getInvocationDescriptor ?? getConfiguredInvocationDescriptor;
	const resolveIdentity =
		dependencies.resolveTargetIdentity ?? resolveTargetIdentity;

	const classifyErrorKind = (failureReason, failurePhase, error = null) => {
		const errno =
			extractErrno(error) ??
			(typeof failureReason === "string" && /^[A-Z0-9]+$/u.test(failureReason)
				? failureReason
				: null);
		if (errno === "EPERM" || errno === "EACCES") {
			return "permission_denied";
		}
		if (
			[
				"EROFS",
				"ENOSPC",
				"EMFILE",
				"ENFILE",
				"EIO",
				"EDQUOT",
				"ETIMEDOUT",
				"ECONNREFUSED",
				"ENETUNREACH",
				"ENETDOWN",
			].includes(errno)
		) {
			return "environment_failure";
		}
		if (failureReason === "run_store_write_failed") {
			return "run_store_write_failed";
		}
		if (
			failureReason === "paid_overage_not_allowed" ||
			failureReason === "included_usage_unverified" ||
			failureReason === "ambiguous_combined_rename_spelling"
		) {
			return "policy_violation";
		}
		if (failureReason === "manifest_review_required") {
			return failurePhase === "input_validation"
				? "validation_failed"
				: "policy_violation";
		}
		if (
			failureReason === "invalid_invocation" ||
			failureReason === "predecessor_receipt_invalid" ||
			failureReason === "predecessor_receipt_missing" ||
			failureReason === "predecessor_receipt_mismatch" ||
			failureReason === "predecessor_receipt_unverified" ||
			(failureReason?.startsWith("dirty_overlay_") &&
				failureReason !== "dirty_overlay_drift")
		) {
			return "validation_failed";
		}
		if (
			failureReason === "dirty_overlay_drift" ||
			failureReason === "project_head_changed_concurrently" ||
			failureReason === "declared_path_changed_concurrently" ||
			failureReason === "read_only_input_changed" ||
			failureReason === "undeclared_paths_changed" ||
			failureReason === "unsafe_diff" ||
			failureReason === "empty_diff" ||
			failureReason === "integration_failed"
		) {
			return "policy_violation";
		}
		if (
			failurePhase === "checks" ||
			failureReason === "check_failed" ||
			failureReason === "check_deadline_exceeded" ||
			failureReason === "check_silence_timeout"
		) {
			return "check_failed";
		}
		if (
			failureReason === "provider_silence_timeout" ||
			failureReason === "provider_deadline_exceeded" ||
			failureReason === "provider_cancelled" ||
			failureReason === "provider_exit_nonzero" ||
			failureReason === "provider_launch_failed" ||
			failurePhase === "execute"
		) {
			return "execution_failed";
		}
		if (
			failureReason === "worktree_cleanup_failed" ||
			failureReason === "project_lock_release_unconfirmed" ||
			failurePhase === "cleanup"
		) {
			return "cleanup_failed";
		}
		if (failureReason === "deadline_expired") {
			if (failurePhase === "preflight" || failurePhase === "input_validation")
				return "validation_failed";
			if (failurePhase === "execute") return "execution_failed";
			if (failurePhase === "checks") return "check_failed";
			if (failurePhase === "cleanup") return "cleanup_failed";
			return "policy_violation";
		}
		if (
			failureReason === "project_revision_unavailable" ||
			failureReason === "workspace_clone_failed" ||
			failureReason === "workspace_checkout_failed" ||
			failureReason === "dirty_overlay_stage_failed" ||
			failureReason === "dirty_overlay_baseline_failed"
		) {
			return "environment_failure";
		}
		if (failurePhase === "input_validation") {
			return "validation_failed";
		}
		return "unclassified_failure";
	};
	const milestone = (phase, name, details = {}) => {
		const observedAt = now();
		const elapsedSinceLastMilestoneMs = Math.max(
			0,
			observedAt - lastMilestoneAt,
		);
		emitStatus(onStatus, taskId, phase, {
			milestone: name,
			elapsedMs: Math.max(0, observedAt - startedAt),
			elapsedSinceLastMilestoneMs,
			firstChangeObserved,
			...details,
		});
		lastMilestoneAt = observedAt;
		if (runInitialized) {
			try {
				const eventWrite = (dependencies.createEvent ?? createEvent)(runId, {
					phase,
					event: "milestone",
					milestone: name,
					status: details.status ?? "in_progress",
					elapsedMs: Math.max(0, observedAt - startedAt),
					elapsedSinceLastMilestoneMs,
					...(details.checkIndex !== undefined
						? { checkIndex: details.checkIndex }
						: {}),
					...(details.checkIdentity !== undefined
						? { checkIdentity: details.checkIdentity }
						: {}),
					...(details.checkStatus !== undefined
						? { checkStatus: details.checkStatus }
						: {}),
					firstChangeObserved,
				}).catch(() => {});
				pendingDurability.add(eventWrite);
				void eventWrite.finally(() => pendingDurability.delete(eventWrite));
			} catch {}
		}
	};
	const heartbeat = (phase, details = {}) => {
		const observedAt = now();
		emitStatus(onStatus, taskId, phase, {
			elapsedMs: Math.max(0, observedAt - startedAt),
			elapsedSinceLastMilestoneMs: Math.max(0, observedAt - lastMilestoneAt),
			firstChangeObserved,
			...details,
		});
	};
	let cleanupAttempted = false;
	const removeNonSalvageWorktree = async () => {
		if (cleanupAttempted || !worktreeRoot) return !worktreeRoot;
		cleanupAttempted = true;
		try {
			if (
				dependencies.rmSync ||
				dependencies.executeProvider ||
				dependencies.runCheck
			) {
				const safeParent =
					canonicalParent ??
					realpathSync(dependencies.tmpdir ? dependencies.tmpdir() : tmpdir());
				if (!worktreeRoot.startsWith(`${safeParent}${sep}`))
					throw new Error("unsafe workspace root");
				(dependencies.rmSync ?? rmSync)(worktreeRoot, {
					recursive: true,
					force: true,
				});
			} else {
				const outcome = await cleanupSimpleWorktree(
					runId,
					{
						canonicalParent,
						candidateChild,
						path: candidatePath,
						...worktreeIdentity,
					},
					{
						writerStopped:
							writerLifecycle === "stopped" ||
							writerLifecycle === "never_started",
						onStatus: (processPhase) => heartbeat("cleanup", { processPhase }),
					},
				);
				if (outcome.path && outcome.path !== candidatePath) {
					canonicalParent = dirname(outcome.path);
					candidateChild = basename(outcome.path);
					candidatePath = outcome.path;
					worktreeRoot = outcome.path;
					worktreePath = join(outcome.path, "worktree");
				}
				if (!outcome.removed) {
					worktreeCleanupReason = outcome.reason;
					throw new Error(outcome.reason);
				}
			}
			worktreePath = null;
			worktreeRoot = null;
			return true;
		} catch {
			worktreeCleanupReason ??= "worktree_cleanup_failed";
			keepWorktree = true;
			return false;
		}
	};
	const fail = (
		failureReason,
		failurePhase,
		errorKind = null,
		error = null,
	) => {
		const computedErrorKind =
			errorKind ?? classifyErrorKind(failureReason, failurePhase, error);
		if (
			worktreePath &&
			!signal?.aborted &&
			!(currentPhase === "execute" && executionFailureCaptureComplete) &&
			(remainingMs(options.deadlineMs, now) <= 0 ||
				(currentPhase === "execute" && !keepWorktree))
		) {
			keepWorktree = true;
		}
		if (keepWorktree && worktreePath) {
			milestone(failurePhase, "salvage_retained");
		}
		milestone("terminal", "failed", { failurePhase });
		finalResult = terminalResult(base, {
			provider,
			targetId,
			changedFiles,
			checks,
			failureReason,
			failurePhase,
			errorKind: computedErrorKind,
			preflightDetail,
			dirtyBaseline,
			providerLifecycle,
			providerVerdictCode,
			partialWorktree: keepWorktree ? worktreePath : null,
		});
		if (runInitialized) {
			failureTerminalDurable = false;
			try {
				const terminalWrite = (
					dependencies.updateRunWithRetry ?? updateRunWithRetry
				)(runId, {
					state: "failed",
					finishedAt: new Date(now()).toISOString(),
					lastFailure: sanitizeFailureMetadata({
						taskId,
						result: failureReason,
						errorKind: computedErrorKind,
						failurePhase,
					}),
				}).then(
					() => {
						failureTerminalDurable = true;
					},
					() => {},
				);
				pendingDurability.add(terminalWrite);
				void terminalWrite.finally(() =>
					pendingDurability.delete(terminalWrite),
				);
			} catch {}
		}
		return finalResult;
	};
	const failForSignal = (failurePhase = currentPhase) => {
		if (!signal?.aborted) return null;
		if (worktreePath) {
			if (
				writerLifecycle !== "stopped" &&
				writerLifecycle !== "never_started"
			) {
				keepWorktree = true;
			} else if (changedFiles.length > 0) {
				keepWorktree = true;
			} else {
				const status = git(worktreePath, [
					"status",
					"--porcelain=v1",
					"--untracked-files=all",
				]);
				keepWorktree = status.status !== 0 || status.stdout.length > 0;
			}
		}
		return fail("provider_cancelled", failurePhase, "execution_failed");
	};

	try {
		try {
			await (dependencies.initializeRun ?? initializeRun)({
				runId,
				tasksFilePath: options.promptPath,
				projectPath: options.projectPath,
				orderedTaskIds: [taskId],
				initialHostFingerprint: "simple",
				workerPid: process.pid,
				workerNonce: randomUUID(),
			});
			runInitialized = true;
		} catch (error) {
			return fail(
				"run_store_write_failed",
				"preflight",
				classifyErrorKind("run_store_write_failed", "preflight", error),
				error,
			);
		}
		if (signal?.aborted) return failForSignal("preflight");

		if (
			manifestReviewPaths(options.files).some(
				(path) => !(options.allowManifests ?? []).includes(path),
			)
		) {
			return fail(
				"manifest_review_required",
				"input_validation",
				"validation_failed",
			);
		}
		if (remainingMs(options.deadlineMs, now) <= 0) {
			return fail("deadline_expired", "preflight");
		}
		emitStatus(onStatus, taskId, "lock");
		try {
			await acquireLock(options.projectPath, runId);
			projectLocked = true;
			projectLockState = "held";
		} catch (error) {
			return fail(
				error?.code ?? "project_lock_failed",
				"preflight",
				classifyErrorKind(
					error?.code ?? "project_lock_failed",
					"preflight",
					error,
				),
				error,
			);
		}
		if (signal?.aborted) return failForSignal("preflight");
		baseRevision = requireGit(
			options.projectPath,
			["rev-parse", "HEAD"],
			"project_revision_unavailable",
		).trim();
		const baselinePaths = [...options.files, ...(options.readOnlyInputs ?? [])];
		if (options.dirtyOverlay) {
			try {
				const predecessorInput =
					options.predecessorReceiptPath ??
					options.predecessorReceipt ??
					dependencies.predecessorReceipt ??
					null;
				const predecessorReceipt = predecessorInput
					? await resolvePredecessorReceipt(
							predecessorInput,
							options.projectPath,
							dependencies,
						)
					: null;
				dirtyOverlayReceipt = captureDirtyOverlay(
					options.projectPath,
					baselinePaths,
					{
						allowUnrelated: true,
						maxFileBytes: MAX_CAPTURE_BYTES,
						enforceTarPathLimit: false,
						secretPaths: SECRET_PATHS,
						predecessorReceipt,
					},
				);
				dirtyBaseline = makeDirtyBaseline({
					taskId,
					baseRevision,
					projectPath: options.projectPath,
					files: options.files,
					inputs: options.readOnlyInputs ?? [],
					receipt: dirtyOverlayReceipt,
				});
			} catch (error) {
				preflightDetail = dirtyOverlayFailure(error, {
					taskId,
					baseRevision,
					files: options.files,
					inputs: options.readOnlyInputs ?? [],
				});
				return fail(
					preflightDetail.code,
					"preflight",
					classifyErrorKind(preflightDetail.code, "preflight", error),
					error,
				);
			}
		} else if (!declaredPathsAreClean(options.projectPath, options.files)) {
			return fail("declared_path_has_owner_edits", "preflight");
		}
		const initialFingerprint = fileFingerprint(
			options.projectPath,
			options.dirtyOverlay ? baselinePaths : options.files,
		);

		currentPhase = "route";
		emitStatus(onStatus, taskId, "route");
		const requestedSimpleTargets = (options.onlyProviders ?? []).length
			? options.onlyProviders
			: SIMPLE_TARGET_ADAPTERS.filter(
					(adapter) =>
						adapter.defaultEligible !== false &&
						(!adapter.defaultCapabilities ||
							adapter.defaultCapabilities.includes(options.capability)),
				).map((adapter) => adapter.targetId);
		const compatibleSimpleTargets = [];
		let pinnedIncompatibility = null;
		for (const candidate of requestedSimpleTargets) {
			const candidateIdentity = resolveIdentity(candidate);
			const candidateTargetId = candidateIdentity.targetId;
			const candidateHarness = candidateIdentity.harnessKey
				? normalizeProviderName(candidateIdentity.harnessKey)
				: null;
			const candidateDescriptor = candidateTargetId
				? descriptorFor(candidateTargetId, options.capability)
				: null;
			const compatibility = simpleProviderCompatibility({
				targetId: candidateTargetId,
				harness: candidateHarness,
				descriptor: candidateDescriptor,
				capability: options.capability,
			});
			if (compatibility.compatible) {
				compatibleSimpleTargets.push(candidateTargetId);
			} else if ((options.onlyProviders ?? []).length) {
				pinnedIncompatibility = compatibility.reason;
			}
		}
		if (
			(options.onlyProviders ?? []).length &&
			compatibleSimpleTargets.length === 0
		) {
			return fail(
				pinnedIncompatibility ?? "local_adapter_unavailable",
				"route",
			);
		}
		const routed = routeProvider({
			requiredCapability: options.capability,
			availableProviders: compatibleSimpleTargets,
			platform: "direct",
			nowMs: now(),
			hasInvocationDescriptor: (name, capability) =>
				Boolean(descriptorFor(name, capability)),
			modelForCapability: (name, capability) =>
				descriptorFor(name, capability)?.selector ?? null,
			only: options.onlyProviders ?? [],
		});
		if (!routed?.provider)
			return fail(routed?.reason ?? "no_eligible_provider", "route");
		provider = routed.provider;
		const identity = resolveIdentity(provider);
		targetId = identity.targetId;
		if (!targetId || !identity.harnessKey) {
			return fail("target_identity_unavailable", "route");
		}
		const descriptor = descriptorFor(provider, options.capability);
		if (!descriptor || descriptor.target_id !== targetId) {
			return fail("invocation_descriptor_unavailable", "route");
		}
		const compatibility = simpleProviderCompatibility({
			targetId,
			harness: normalizeProviderName(identity.harnessKey),
			descriptor,
			capability: options.capability,
		});
		if (!compatibility.compatible) {
			return fail(compatibility.reason, "route");
		}
		(dependencies.assertFundedRoute ?? assertFundedRoute)(targetId);

		milestone("route", "route_selected", { provider, targetId });
		if (runInitialized) {
			try {
				await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(runId, {
					resolvedTargetId: targetId,
					activeTaskProvider: provider,
					activeTaskModel: descriptor?.selector ?? null,
				});
			} catch (error) {
				return fail(
					"run_store_write_failed",
					"route",
					classifyErrorKind("run_store_write_failed", "route", error),
					error,
				);
			}
		}

		currentPhase = "prepare";
		emitStatus(onStatus, taskId, "prepare");
		const tempBase =
			typeof dependencies.tmpdir === "function"
				? dependencies.tmpdir()
				: (dependencies.tmpdir ?? tmpdir());
		canonicalParent = realpathSync(tempBase);
		candidateChild = `switchyard-simple-${randomUUID()}`;
		candidatePath = join(canonicalParent, candidateChild);

		if (runInitialized) {
			try {
				await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(runId, {
					worktree: {
						canonicalParent,
						candidateChild,
						path: candidatePath,
						state: "allocating",
						reason: null,
						retainedAt: null,
					},
				});
			} catch (error) {
				return fail(
					"run_store_write_failed",
					"prepare",
					classifyErrorKind("run_store_write_failed", "prepare", error),
					error,
				);
			}
		}

		try {
			(dependencies.mkdirSync ?? mkdirSync)(candidatePath, { mode: 0o700 });
		} catch (error) {
			// An allocation error does not prove the candidate is absent. Keep the
			// durable claim until recovery can inspect the exact path.
			keepWorktree = true;
			return fail(
				"worktree_allocation_failed",
				"prepare",
				"environment_failure",
				error,
			);
		}
		worktreeRoot = candidatePath;
		worktreeCreated = true;
		worktreePath = join(worktreeRoot, "worktree");
		try {
			const rootStat = statSync(candidatePath, { bigint: true });
			if (!rootStat.isDirectory()) throw new Error("root_not_directory");
			const nonce = randomUUID();
			const markerPath = join(candidatePath, ".switchyard-cleanup-owner.json");
			let markerFd = null;
			try {
				markerFd = openSync(markerPath, "wx", 0o600);
				writeSync(markerFd, `${JSON.stringify({ runId, nonce })}\n`);
				fsyncSync(markerFd);
			} finally {
				if (markerFd !== null) closeSync(markerFd);
			}
			let dirFd = null;
			try {
				dirFd = openSync(candidatePath, "r");
				fsyncSync(dirFd);
			} finally {
				if (dirFd !== null) closeSync(dirFd);
			}
			const confirmed = statSync(candidatePath, { bigint: true });
			if (confirmed.dev !== rootStat.dev || confirmed.ino !== rootStat.ino) {
				throw new Error("root_identity_changed");
			}
			worktreeIdentity = {
				device: rootStat.dev.toString(),
				inode: rootStat.ino.toString(),
				nonce,
			};
		} catch (error) {
			keepWorktree = true;
			return fail(
				"worktree_ownership_failed",
				"prepare",
				"cleanup_failed",
				error,
			);
		}
		if (runInitialized) {
			try {
				await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(runId, {
					worktree: {
						canonicalParent,
						candidateChild,
						path: candidatePath,
						state: "active",
						reason: null,
						retainedAt: null,
						...worktreeIdentity,
					},
				});
			} catch (error) {
				return fail(
					"run_store_write_failed",
					"prepare",
					classifyErrorKind("run_store_write_failed", "prepare", error),
					error,
				);
			}
		}
		requireGit(
			worktreeRoot,
			[
				"clone",
				"--shared",
				"--no-checkout",
				"--quiet",
				"--",
				options.projectPath,
				worktreePath,
			],
			"workspace_clone_failed",
			{ timeout: deadlineTimeout(options.deadlineMs, now) },
		);
		requireGit(
			worktreePath,
			["checkout", "--detach", "--quiet", baseRevision],
			"workspace_checkout_failed",
			{ timeout: deadlineTimeout(options.deadlineMs, now) },
		);
		worktreeBaseRevision = baseRevision;
		if (dirtyOverlayReceipt) {
			materializeDirtyOverlay(worktreePath, dirtyOverlayReceipt, {
				maxFileBytes: MAX_CAPTURE_BYTES,
				secretPaths: SECRET_PATHS,
			});
			requireGit(
				worktreePath,
				["add", "-A", "--", ...baselinePaths],
				"dirty_overlay_stage_failed",
				{ timeout: deadlineTimeout(options.deadlineMs, now) },
			);
			const overlayDiff = git(worktreePath, ["diff", "--cached", "--quiet"], {
				timeout: deadlineTimeout(options.deadlineMs, now),
			});
			if (overlayDiff.status === 1) {
				requireGit(
					worktreePath,
					[
						"-c",
						"user.name=switchyard",
						"-c",
						"user.email=switchyard@localhost",
						"commit",
						"-qm",
						"switchyard-dirty-overlay",
					],
					"dirty_overlay_baseline_failed",
					{ timeout: deadlineTimeout(options.deadlineMs, now) },
				);
			} else if (overlayDiff.status !== 0) {
				throw Object.assign(new Error("dirty_overlay_baseline_failed"), {
					code: "dirty_overlay_baseline_failed",
				});
			}
			worktreeBaseRevision = requireGit(
				worktreePath,
				["rev-parse", "HEAD"],
				"dirty_overlay_baseline_revision_unavailable",
				{ timeout: deadlineTimeout(options.deadlineMs, now) },
			).trim();
		}

		const readOnlyNotice = (options.readOnlyInputs ?? []).length
			? ` Read-only input paths (do not modify): ${(options.readOnlyInputs ?? []).join(", ")}.`
			: "";
		const guardedPrompt = `${readFileSync(options.promptPath, "utf8")}\n\nWork only in the current disposable checkout. Change only these writable files: ${options.files.join(", ")}.${readOnlyNotice} Do not delegate, plan recursively, commit, push, access credentials, or change any other path.`;
		const harness = normalizeProviderName(identity.harnessKey);
		currentPhase = "execute";
		milestone("execute", "provider_started");
		const executionBudget = remainingMs(options.deadlineMs, now);
		if (executionBudget <= 0) {
			return fail("deadline_expired", "execute");
		}
		if (signal?.aborted) return failForSignal("execute");
		writerLifecycle = "unavailable";
		const providerResult = await executeProvider({
			targetId,
			harness,
			descriptor,
			capability: options.capability,
			prompt: guardedPrompt,
			worktreePath,
			timeoutMs: executionBudget,
			signal,
			onProgress: () => {
				const progressObservedAt = now();
				if (
					!firstChangeObserved &&
					progressObservedAt - lastFirstChangeProbeAt >=
						FIRST_CHANGE_PROBE_INTERVAL_MS
				) {
					lastFirstChangeProbeAt = progressObservedAt;
					const observed = git(worktreePath, [
						"status",
						"--porcelain=v1",
						"--untracked-files=all",
						"--",
						...options.files,
					]);
					if (observed.status === 0 && observed.stdout.length > 0) {
						firstChangeObserved = true;
						milestone("execute", "first_change_observed");
						return;
					}
				}
				heartbeat("execute", { processPhase: "provider_running" });
			},
		});
		providerLifecycle = boundProviderLifecycleSnapshot(
			providerResult?.providerLifecycle,
		);
		providerVerdictCode = providerResult?.providerVerdictCode ?? null;
		writerLifecycle = aggregateWriterLifecycle(
			"never_started",
			providerResult?.writerLifecycle,
		);

		if (signal?.aborted) return failForSignal("execute");
		if (
			executeProvider === defaultExecuteProvider &&
			writerLifecycle === "unavailable"
		) {
			keepWorktree = true;
			return fail("provider_group_unconfirmed", "execute", "cleanup_failed");
		}
		if (!providerResult?.success) {
			if (remainingMs(options.deadlineMs, now) > 0) {
				const captured = captureWorktreeDiff(
					worktreePath,
					worktreeBaseRevision,
					options.deadlineMs,
					now,
				);
				changedFiles = captured.changedFiles;
				executionFailureCaptureComplete = true;
				keepWorktree = changedFiles.length > 0;
			} else {
				keepWorktree = true;
			}
			return fail(classifyExecutionFailure(providerResult), "execute");
		}
		if (remainingMs(options.deadlineMs, now) <= 0) {
			keepWorktree = true;
			return fail("deadline_expired", "checks");
		}
		currentPhase = "diff";
		milestone("diff", "capture_started");
		const captured = captureWorktreeDiff(
			worktreePath,
			worktreeBaseRevision,
			options.deadlineMs,
			now,
		);
		changedFiles = captured.changedFiles;
		if (changedFiles.length > 0 && !firstChangeObserved) {
			firstChangeObserved = true;
			milestone("diff", "first_change_observed");
		}
		if (changedFiles.length === 0) return fail("empty_diff", "diff");
		const undeclared = changedFiles.filter(
			(path) => !options.files.includes(path),
		);
		if (undeclared.length > 0) {
			keepWorktree = true;
			return fail(
				(options.readOnlyInputs ?? []).some((path) => undeclared.includes(path))
					? "read_only_input_changed"
					: "undeclared_paths_changed",
				"diff",
			);
		}
		const validated = validateDiff(captured.diff, options.projectPath);
		if (
			!validated.safe ||
			(validated.requiresReview &&
				!(validated.sensitivePaths ?? []).every((path) =>
					(options.allowManifests ?? []).includes(path),
				))
		) {
			keepWorktree = true;
			return fail(
				validated.requiresReview ? "manifest_review_required" : "unsafe_diff",
				"diff",
			);
		}

		for (let index = 0; index < options.checks.length; index += 1) {
			currentPhase = "checks";
			if (signal?.aborted) return failForSignal("checks");
			const remaining = remainingMs(options.deadlineMs, now);
			if (remaining <= 0) {
				keepWorktree = true;
				return fail("deadline_expired", "checks");
			}
			const checkIdentity = createHash("sha256")
				.update(options.checks[index])
				.digest("hex");
			milestone("checks", "check_started", {
				checkIndex: index + 1,
				checkIdentity,
			});
			const settledWriterLifecycle = writerLifecycle;
			// A check may still be writing the checkout until it resolves.
			writerLifecycle = "unavailable";
			const check = await runCheck({
				command: options.checks[index],
				worktreePath,
				timeoutMs: remaining,
				signal,
				onProgress: () =>
					heartbeat("checks", {
						processPhase: "check_running",
						checkIndex: index + 1,
						checkIdentity,
					}),
			});
			writerLifecycle = aggregateWriterLifecycle(
				settledWriterLifecycle,
				check?.writerLifecycle,
			);
			if (signal?.aborted) return failForSignal("checks");
			if (runCheck === defaultRunCheck && writerLifecycle === "unavailable") {
				keepWorktree = true;
				return fail("check_group_unconfirmed", "checks", "cleanup_failed");
			}
			checks.push({
				index: index + 1,
				status: check?.success ? "passed" : "failed",
			});
			milestone("checks", "check_finished", {
				checkIndex: index + 1,
				checkIdentity,
				checkStatus: check?.success ? "passed" : "failed",
			});
			if (!check?.success) {
				keepWorktree = true;
				return fail(
					check?.silenceTimedOut
						? "check_silence_timeout"
						: check?.timedOut
							? "check_deadline_exceeded"
							: "check_failed",
					"checks",
				);
			}
		}
		if (signal?.aborted) return failForSignal("integrate");
		if (
			providerVerdictCode === "agy_non_success" ||
			providerVerdictCode === "agy_unparseable"
		) {
			// Keep the checked diff available for salvage without applying a provider-
			// reported failure to the host checkout.
			keepWorktree = true;
			return fail("provider_verdict_rejected", "integrate", "execution_failed");
		}

		if (remainingMs(options.deadlineMs, now) <= 0) {
			keepWorktree = true;
			return fail("deadline_expired", "integrate");
		}
		currentPhase = "integrate";
		if (
			requireGit(
				options.projectPath,
				["rev-parse", "HEAD"],
				"project_revision_unavailable",
				{ timeout: deadlineTimeout(options.deadlineMs, now) },
			).trim() !== baseRevision
		) {
			keepWorktree = true;
			return fail("project_head_changed_concurrently", "integrate");
		}
		if (dirtyOverlayReceipt) {
			const checked = validateDirtyOverlayReceipt(
				options.projectPath,
				dirtyOverlayReceipt,
				baselinePaths,
				{
					allowUnrelated: true,
					maxFileBytes: MAX_CAPTURE_BYTES,
					enforceTarPathLimit: false,
					secretPaths: SECRET_PATHS,
				},
			);
			if (
				!checked.ok ||
				checked.receiptHash !== dirtyOverlayReceipt.receiptHash
			) {
				keepWorktree = true;
				return fail("dirty_overlay_drift", "integrate");
			}
		}
		if (
			fileFingerprint(
				options.projectPath,
				options.dirtyOverlay ? baselinePaths : options.files,
			) !== initialFingerprint
		) {
			keepWorktree = true;
			return fail("declared_path_changed_concurrently", "integrate");
		}
		emitStatus(onStatus, taskId, "integrate");
		milestone("integrate", "integration_started");
		const integration = dependencies.integrate
			? await dependencies.integrate({
					diff: captured.diff,
					projectPath: options.projectPath,
					changedFiles,
					allowedPaths: options.files,
					allowSensitiveManifests: (options.allowManifests ?? []).length > 0,
				})
			: integrationGate(captured.diff, options.projectPath, {
					allowedPaths: options.files,
					allowSensitiveManifests: (options.allowManifests ?? []).length > 0,
				});
		if (!integration?.success) {
			keepWorktree = true;
			return fail(
				integration?.message === "ambiguous_combined_rename_spelling"
					? "ambiguous_combined_rename_spelling"
					: integration?.message === "undeclared_paths_touched"
						? "undeclared_paths_changed"
						: "integration_failed",
				"integrate",
			);
		}
		milestone("integrate", "integration_completed");
		const terminalOutputs = changedFiles.map((path) => {
			const absolute = resolve(options.projectPath, path);
			try {
				const stats = lstatSync(absolute);
				const bytes = stats.isFile() ? readFileSync(absolute) : Buffer.alloc(0);
				return {
					path,
					size: bytes.length,
					sha256: createHash("sha256").update(bytes).digest("hex"),
					mode: stats.mode & 0o777,
				};
			} catch {
				return { path, size: 0, sha256: null, mode: 0 };
			}
		});
		if (runInitialized) {
			try {
				await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(runId, {
					state: "running",
					cleanupState: "pending",
					terminalSummary: {
						status: "integration_applied",
						baseRevision,
						changedFiles,
						outputs: terminalOutputs,
					},
				});
			} catch (error) {
				keepWorktree = true;
				return fail(
					"run_store_write_failed",
					"integrate",
					classifyErrorKind("run_store_write_failed", "integrate", error),
					error,
				);
			}
			// Publish the accepted output receipt and cleanup intent before any
			// root removal. A crash here leaves a terminal, recoverable claim.
			try {
				await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(runId, {
					state: "succeeded",
					cleanupState: "pending",
					finishedAt: new Date(now()).toISOString(),
					terminalSummary: {
						status: "succeeded",
						baseRevision,
						changedFiles,
						outputs: terminalOutputs,
					},
					...(candidateChild
						? {
								worktree: {
									canonicalParent,
									candidateChild,
									path: candidatePath,
									state: keepWorktree ? "retained" : "active",
									reason: keepWorktree ? "salvage_retained" : null,
									retainedAt: keepWorktree
										? new Date(now()).toISOString()
										: null,
									writerStopped:
										writerLifecycle === "stopped" ||
										writerLifecycle === "never_started",
									...(worktreeIdentity ?? {}),
								},
							}
						: {}),
				});
			} catch (error) {
				keepWorktree = true;
				return fail(
					"run_store_write_failed",
					"cleanup",
					classifyErrorKind("run_store_write_failed", "cleanup", error),
					error,
				);
			}
		}
		emitStatus(onStatus, taskId, "cleanup");
		currentPhase = "cleanup";
		const cleanupMetadata = (input) => ({
			...sanitizeFailureMetadata(input),
			result: input.result,
		});
		let cleanupFailure = null;
		let cleanupState = "complete";
		const cleanupBudget = remainingMs(options.deadlineMs, now);
		if (cleanupBudget <= 0) {
			keepWorktree = true;
			cleanupFailure = cleanupMetadata({
				taskId,
				result: "deadline_expired",
				errorKind: "cleanup_failed",
				failurePhase: "cleanup",
			});
			cleanupState = "failed";
		}
		if (projectLocked) {
			try {
				const released = await releaseLock(options.projectPath, runId);
				if (released === true) {
					projectLockState = "released";
					projectLocked = false;
				} else {
					projectLockState = "unavailable";
					if (!cleanupFailure) {
						cleanupFailure = cleanupMetadata({
							taskId,
							result: "project_lock_release_unconfirmed",
							errorKind: "cleanup_failed",
							failurePhase: "cleanup",
						});
						cleanupState = "failed";
					}
				}
			} catch {
				projectLockState = "unavailable";
				if (!cleanupFailure) {
					cleanupFailure = cleanupMetadata({
						taskId,
						result: "project_lock_release_unconfirmed",
						errorKind: "cleanup_failed",
						failurePhase: "cleanup",
					});
					cleanupState = "failed";
				}
			}
		}
		if (!cleanupFailure && remainingMs(options.deadlineMs, now) <= 0) {
			keepWorktree = true;
			cleanupFailure = cleanupMetadata({
				taskId,
				result: "deadline_expired",
				errorKind: "cleanup_failed",
				failurePhase: "cleanup",
			});
			cleanupState = "failed";
		}

		let worktreeTerminalState = "removed";
		let worktreeReason = null;
		let worktreeRetainedAt = null;

		if (keepWorktree) {
			worktreeTerminalState = "retained";
			worktreeReason = cleanupFailure?.result ?? "salvage_retained";
			worktreeRetainedAt = new Date(now()).toISOString();
		} else {
			if (!(await removeNonSalvageWorktree())) {
				keepWorktree = true;
				worktreeTerminalState = "retained";
				worktreeReason = worktreeCleanupReason;
				worktreeRetainedAt = new Date(now()).toISOString();
				if (!cleanupFailure) {
					cleanupFailure = cleanupMetadata({
						taskId,
						result: "worktree_cleanup_failed",
						errorKind: "cleanup_failed",
						failurePhase: "cleanup",
					});
					cleanupState = "failed";
				}
			}
		}

		if (runInitialized) {
			try {
				await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(runId, {
					cleanupState,
					...(cleanupFailure ? { cleanupFailure } : {}),
					finishedAt: new Date(now()).toISOString(),
					terminalSummary: {
						status: "succeeded",
						baseRevision,
						changedFiles,
						outputs: terminalOutputs,
					},
					...(candidateChild
						? {
								worktree: {
									canonicalParent,
									candidateChild,
									path: candidatePath,
									state: worktreeTerminalState,
									reason: worktreeReason,
									retainedAt: worktreeRetainedAt,
									writerStopped:
										writerLifecycle === "stopped" ||
										writerLifecycle === "never_started",
									...(worktreeIdentity ?? {}),
								},
							}
						: {}),
				});
			} catch (error) {
				return fail(
					"run_store_write_failed",
					"cleanup",
					classifyErrorKind("run_store_write_failed", "cleanup", error),
					error,
				);
			}
		}
		milestone(
			"cleanup",
			cleanupFailure ? "cleanup_failed" : "cleanup_completed",
		);

		finalResult = terminalResult(base, {
			status: "succeeded",
			provider,
			targetId,
			changedFiles,
			checks,
			dirtyBaseline,
			providerLifecycle,
			providerVerdictCode,
			outputs: terminalOutputs,
			baseRevision,
			partialWorktree: keepWorktree ? (worktreePath ?? candidatePath) : null,
		});
		milestone("terminal", "succeeded");
		return finalResult;
	} catch (error) {
		const failureReason =
			typeof error?.code === "string" ? error.code : "simple_execution_failed";
		return fail(
			failureReason,
			currentPhase,
			classifyErrorKind(failureReason, currentPhase, error),
			error,
		);
	} finally {
		if (pendingDurability.size > 0) {
			await Promise.allSettled([...pendingDurability]);
		}
		if (!failureTerminalDurable && worktreePath) {
			keepWorktree = true;
			if (finalResult?.status === "failed")
				finalResult.partialWorktree = worktreePath;
		}
		if (worktreePath && !keepWorktree) {
			await removeNonSalvageWorktree();
			if (worktreePath && finalResult?.status === "failed") {
				keepWorktree = true;
				finalResult.partialWorktree = worktreePath;
			}
		}
		if (projectLocked) {
			try {
				const released = await releaseLock(options.projectPath, runId);
				if (released === true) {
					projectLockState = "released";
					projectLocked = false;
				} else {
					projectLockState = "unavailable";
				}
			} catch {
				projectLockState = "unavailable";
				// The terminal result stays bounded; existing lock recovery owns repair.
			}
		}
		if (finalResult) {
			finalResult.elapsedMs = Math.max(0, now() - startedAt);
			const worktreeState = finalResult.partialWorktree
				? "retained"
				: !worktreeCreated
					? "not_created"
					: worktreeRoot === null && worktreePath === null
						? "removed"
						: "unavailable";
			finalResult.recovery = createRecoveryEvidence({
				contract: recoveryContract({
					taskId,
					attemptId,
					baseRevision,
					files: options.files,
					...(dirtyBaseline ? { dirtyBaseline } : {}),
					checks: options.checks,
				}),
				result: finalResult,
				partialWorktree: finalResult.partialWorktree,
				cleanup: {
					writer: { state: writerLifecycle },
					worktree: {
						state: worktreeState,
						path: finalResult.partialWorktree,
					},
					projectLock: {
						state:
							projectLockState === "held" ? "unavailable" : projectLockState,
					},
				},
			});
		}
		if (
			runInitialized &&
			candidateChild &&
			finalResult?.status !== "succeeded"
		) {
			const isRetained = Boolean(keepWorktree || worktreePath);
			const cleanupFailed = cleanupAttempted && isRetained;
			const terminalState = isRetained ? "retained" : "removed";
			const reason = isRetained
				? (worktreeCleanupReason ??
					finalResult?.failureReason ??
					"salvage_retained")
				: null;
			const retainedAt = isRetained ? new Date(now()).toISOString() : null;
			try {
				await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(runId, {
					cleanupState: cleanupFailed
						? "failed"
						: isRetained
							? "pending"
							: "complete",
					...(cleanupFailed
						? {
								cleanupFailure: cleanupMetadata({
									taskId,
									result: "worktree_cleanup_failed",
									errorKind: "cleanup_failed",
									failurePhase: "cleanup",
								}),
							}
						: {}),
					worktree: {
						canonicalParent,
						candidateChild,
						path: candidatePath,
						state: terminalState,
						reason,
						retainedAt,
						writerStopped:
							writerLifecycle === "stopped" ||
							writerLifecycle === "never_started",
						...(worktreeIdentity ?? {}),
					},
				});
			} catch {}
		}
	}
}

export async function handleSimple(argv, dependencies = {}) {
	const now = dependencies.now ?? Date.now;
	const startedAt = now();
	const signalProcess = dependencies.signalProcess ?? process;
	const abortController = new AbortController();
	let receivedSignal = null;
	let integrationStarted = false;
	let signalDuringIntegration = false;
	const reportStatus =
		dependencies.onStatus ??
		((event) =>
			console.error(
				`dispatch: simple task=${event.taskId} phase=${event.phase}${event.milestone ? ` milestone=${event.milestone}` : ""}${event.checkIndex ? ` check=${event.checkIndex}` : ""}`,
			));
	const onInterrupt = (signal) => {
		if (receivedSignal !== null) return;
		receivedSignal = signal;
		if (integrationStarted) {
			signalDuringIntegration = true;
			try {
				console.error(
					`dispatch: simple received ${signal} during integration; waiting for it to finish`,
				);
			} catch {}
		}
		abortController.abort(signal);
	};
	const onSigint = () => onInterrupt("SIGINT");
	const onSigterm = () => onInterrupt("SIGTERM");
	signalProcess.on("SIGINT", onSigint);
	signalProcess.on("SIGTERM", onSigterm);
	let result;
	try {
		try {
			const options = parseSimpleArgs(argv, { now });
			if (options.help) {
				console.log(SIMPLE_USAGE);
				return;
			}
			result = await runSimpleTask(options, {
				...dependencies,
				now,
				signal: abortController.signal,
				onStatus: (event) => {
					if (event.milestone === "integration_started") {
						integrationStarted = true;
					} else if (event.milestone === "integration_completed") {
						integrationStarted = false;
					}
					reportStatus(event);
				},
			});
		} catch (error) {
			result = {
				schemaVersion: 1,
				taskId: null,
				status: "failed",
				provider: null,
				targetId: null,
				elapsedMs: Math.max(0, now() - startedAt),
				changedFiles: [],
				checks: [],
				failureReason:
					error instanceof SimpleUsageError
						? "invalid_invocation"
						: "preflight_failed",
				failurePhase: "preflight",
				errorKind:
					error instanceof SimpleUsageError
						? "validation_failed"
						: "unclassified_failure",
				partialWorktree: null,
				recovery: recoveryUnavailable(),
			};
		}
		(dependencies.writeResult ?? console.log)(JSON.stringify(result));
		if (
			receivedSignal !== null &&
			!(signalDuringIntegration && result?.status !== "succeeded")
		) {
			signalProcess.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
		} else if (result.status !== "succeeded") {
			signalProcess.exitCode =
				result.failureReason === "invalid_invocation" ? 2 : 1;
		}
	} finally {
		signalProcess.removeListener("SIGINT", onSigint);
		signalProcess.removeListener("SIGTERM", onSigterm);
	}
}
