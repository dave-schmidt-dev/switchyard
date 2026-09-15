// Small, local implementation path: one provider, one disposable checkout,
// one absolute deadline, one bounded result. The legacy VM queue remains the
// rollback path and deliberately does not call this module.

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import {
	boundProviderLifecycleSnapshot,
	runProviderProcess,
} from "../adapter/provider-lifecycle.mjs";
import { integrationGate, validateDiff } from "../integrate/index.mjs";
import {
	captureDirtyOverlay,
	materializeDirtyOverlay,
	validateDirtyOverlayReceipt,
} from "../lifecycle/index.mjs";
import {
	getConfiguredInvocationDescriptor,
	normalizeProviderName,
	resolveTargetIdentity,
} from "../roster/index.mjs";
import { route } from "../router/index.mjs";
import {
	acquireProjectLock,
	releaseProjectLockIfOwnedBy,
} from "../run-store/index.mjs";

export const SIMPLE_USAGE = `Usage: switchyard-dispatch simple <prompt-file> --project <path> --capability <low|standard|high> --file <path> [--input <path>] [--dirty-overlay] [--only-provider <provider>] --check <command> --deadline <RFC3339> [--json]

Runs one bounded assignment in a disposable local checkout. Repeat --file and
--input and --check as needed. --input is read-only and requires --dirty-overlay.
Output is always one JSON result; progress is written to stderr.`;

const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_DEADLINE_MS = 30 * 60 * 1000;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_DECLARED_FILES = 64;
const MAX_CHECKS = 16;
const MAX_PATH_CHARS = 1024;
const MAX_CHECK_CHARS = 8192;
// A pin is a routing contract, not an adapter promise. Every known target may
// be selected explicitly; targets without a local adapter fail closed at the
// adapter boundary instead of silently falling back to Codex.
const SIMPLE_PROVIDERS = Object.freeze([
	"claude-code",
	"codex",
	"codex-spark",
	"antigravity",
	"antigravity-claude",
	"cursor",
	"opencode-go",
	"vibe",
	"copilot",
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
				input: { type: "string", multiple: true },
				"dirty-overlay": { type: "boolean", default: false },
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
		readOnlyInputs: inputs,
		dirtyOverlay,
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
	if (
		target?.enabled !== true ||
		target.funding?.included?.mode !== "subscription" ||
		target.funding?.overage?.enabled !== false
	) {
		throw Object.assign(new Error("paid_overage_not_allowed"), {
			code: "paid_overage_not_allowed",
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

function dirtyOverlayFailure(error, { taskId, baseRevision, files, inputs }) {
	const message = String(error?.message ?? "dirty overlay preflight failed");
	let code = "dirty_overlay_preflight_failed";
	let condition = "declared dirty input could not be captured";
	let remedy =
		"keep the declared inputs tracked, regular, non-secret files and retry";
	if (/untracked/u.test(message)) {
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

function emitStatus(onStatus, taskId, phase) {
	try {
		onStatus?.({ schemaVersion: 1, taskId, phase });
	} catch {
		// Status reporting cannot change execution.
	}
}

export function buildSimpleProviderInvocation(
	harness,
	descriptor,
	_prompt,
	worktreePath,
) {
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
		if (descriptor.selector !== "claude-sonnet-4-6") {
			throw Object.assign(new Error("local_descriptor_model_unavailable"), {
				code: "local_descriptor_model_unavailable",
			});
		}
		return {
			command: "agy",
			args: [
				"-p",
				_prompt,
				"--model",
				descriptor.selector,
				"--mode=accept-edits",
				"--sandbox",
				"--output-format",
				"json",
				"--print-timeout",
				"30m",
			],
		};
	}
	throw Object.assign(new Error("local_adapter_unavailable"), {
		code: "local_adapter_unavailable",
	});
}

async function defaultExecuteProvider(context) {
	const invocation = buildSimpleProviderInvocation(
		context.harness,
		context.descriptor,
		context.prompt,
		context.worktreePath,
	);
	const result = await runProviderProcess(invocation.command, invocation.args, {
		input: context.prompt,
		timeoutMs: context.timeoutMs,
		silenceTimeoutMs: Math.min(5 * 60 * 1000, context.timeoutMs),
		maxBuffer: MAX_CAPTURE_BYTES,
		progressStage: "running",
		onPoll: () => context.onProgress?.(),
	});
	if (context.harness !== "agy" || !result.success) return result;
	try {
		return JSON.parse(result.output)?.status === "SUCCESS"
			? result
			: { ...result, success: false, code: 1 };
	} catch {
		return { ...result, success: false, code: 1 };
	}
}

async function defaultRunCheck({
	command,
	worktreePath,
	timeoutMs,
	onProgress,
}) {
	return runProviderProcess(
		"/bin/sh",
		[
			"-lc",
			'cd "$1" && exec /bin/sh -lc "$2"',
			"switchyard-check",
			worktreePath,
			command,
		],
		{
			timeoutMs,
			silenceTimeoutMs: Math.min(60 * 1000, timeoutMs),
			maxBuffer: MAX_CAPTURE_BYTES,
			progressStage: "running",
			onPoll: onProgress,
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
	return {
		schemaVersion: 1,
		taskId: base.taskId,
		attemptId: base.attemptId,
		status: overrides.status ?? "failed",
		provider: overrides.provider ?? null,
		targetId: overrides.targetId ?? null,
		elapsedMs: Math.max(0, base.now() - base.startedAt),
		changedFiles: safeChangedFiles(overrides.changedFiles ?? []),
		checks: overrides.checks ?? [],
		failureReason: overrides.failureReason ?? null,
		failurePhase: overrides.failurePhase ?? null,
		providerLifecycle: overrides.providerLifecycle ?? null,
		...(overrides.preflightDetail
			? { preflightDetail: overrides.preflightDetail }
			: {}),
		dirtyBaseline: overrides.dirtyBaseline ?? null,
		partialWorktree: overrides.partialWorktree ?? null,
		recovery: overrides.recovery ?? recoveryUnavailable(),
	};
}

export async function runSimpleTask(options, dependencies = {}) {
	const now = dependencies.now ?? Date.now;
	const taskId = dependencies.taskId ?? randomUUID();
	const attemptId = dependencies.attemptId ?? randomUUID();
	const runId = `simple-${taskId}`;
	const startedAt = now();
	const base = { taskId, attemptId, startedAt, now };
	const onStatus = dependencies.onStatus;
	let provider = null;
	let targetId = null;
	let projectLocked = false;
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
	let writerLifecycle = "never_started";
	let projectLockState = "not_acquired";
	let worktreeCreated = false;
	let executionFailureCaptureComplete = false;
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

	const fail = (failureReason, failurePhase) => {
		if (
			worktreePath &&
			!(currentPhase === "execute" && executionFailureCaptureComplete) &&
			(remainingMs(options.deadlineMs, now) <= 0 ||
				(currentPhase === "execute" && !keepWorktree))
		) {
			keepWorktree = true;
		}
		finalResult = terminalResult(base, {
			provider,
			targetId,
			changedFiles,
			checks,
			failureReason,
			failurePhase,
			preflightDetail,
			dirtyBaseline,
			providerLifecycle,
			partialWorktree: keepWorktree ? worktreePath : null,
		});
		return finalResult;
	};

	try {
		if (remainingMs(options.deadlineMs, now) <= 0) {
			return fail("deadline_expired", "preflight");
		}
		emitStatus(onStatus, taskId, "lock");
		await acquireLock(options.projectPath, runId);
		projectLocked = true;
		projectLockState = "held";
		baseRevision = requireGit(
			options.projectPath,
			["rev-parse", "HEAD"],
			"project_revision_unavailable",
		).trim();
		const baselinePaths = [...options.files, ...(options.readOnlyInputs ?? [])];
		if (options.dirtyOverlay) {
			try {
				dirtyOverlayReceipt = captureDirtyOverlay(
					options.projectPath,
					baselinePaths,
					{
						allowUnrelated: true,
						maxFileBytes: MAX_CAPTURE_BYTES,
						enforceTarPathLimit: false,
						secretPaths: SECRET_PATHS,
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
				return fail(preflightDetail.code, "preflight");
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
		const routed = routeProvider({
			requiredCapability: options.capability,
			availableProviders: (options.onlyProviders ?? []).length
				? options.onlyProviders
				: ["codex"],
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
		(dependencies.assertFundedRoute ?? assertFundedRoute)(targetId);

		worktreeRoot = realpathSync(
			mkdtempSync(join(tmpdir(), "switchyard-simple-")),
		);
		worktreeCreated = true;
		worktreePath = join(worktreeRoot, "worktree");
		currentPhase = "prepare";
		emitStatus(onStatus, taskId, "prepare");
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
		emitStatus(onStatus, taskId, "execute");
		const executionBudget = remainingMs(options.deadlineMs, now);
		if (executionBudget <= 0) {
			return fail("deadline_expired", "execute");
		}
		writerLifecycle = "unavailable";
		const providerResult = await executeProvider({
			harness,
			descriptor,
			prompt: guardedPrompt,
			worktreePath,
			timeoutMs: executionBudget,
			onProgress: () => emitStatus(onStatus, taskId, "execute"),
		});
		providerLifecycle = boundProviderLifecycleSnapshot(
			providerResult?.providerLifecycle,
		);
		writerLifecycle = aggregateWriterLifecycle(
			"never_started",
			providerResult?.writerLifecycle,
		);

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
		const captured = captureWorktreeDiff(
			worktreePath,
			worktreeBaseRevision,
			options.deadlineMs,
			now,
		);
		changedFiles = captured.changedFiles;
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
		if (!validated.safe || validated.requiresReview) {
			keepWorktree = true;
			return fail(
				validated.requiresReview ? "manifest_review_required" : "unsafe_diff",
				"diff",
			);
		}

		for (let index = 0; index < options.checks.length; index += 1) {
			currentPhase = "checks";
			const remaining = remainingMs(options.deadlineMs, now);
			if (remaining <= 0) {
				keepWorktree = true;
				return fail("deadline_expired", "checks");
			}
			emitStatus(onStatus, taskId, "checks");
			const settledWriterLifecycle = writerLifecycle;
			// A check may still be writing the checkout until it resolves.
			writerLifecycle = "unavailable";
			const check = await runCheck({
				command: options.checks[index],
				worktreePath,
				timeoutMs: remaining,
				onProgress: () => emitStatus(onStatus, taskId, "checks"),
			});
			writerLifecycle = aggregateWriterLifecycle(
				settledWriterLifecycle,
				check?.writerLifecycle,
			);
			checks.push({
				index: index + 1,
				status: check?.success ? "passed" : "failed",
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
		const integration = dependencies.integrate
			? await dependencies.integrate({
					diff: captured.diff,
					projectPath: options.projectPath,
					changedFiles,
				})
			: integrationGate(captured.diff, options.projectPath, {
					requiredPaths: changedFiles,
				});
		if (!integration?.success) {
			keepWorktree = true;
			return fail("integration_failed", "integrate");
		}
		emitStatus(onStatus, taskId, "cleanup");
		currentPhase = "cleanup";
		const cleanupBudget = remainingMs(options.deadlineMs, now);
		if (cleanupBudget <= 0) {
			keepWorktree = true;
			return fail("deadline_expired", "cleanup");
		}
		try {
			if (!worktreeRoot?.startsWith(`${realpathSync(tmpdir())}${sep}`)) {
				throw new Error("unsafe workspace root");
			}
			rmSync(worktreeRoot, { recursive: true, force: true });
		} catch {
			keepWorktree = true;
			return fail("worktree_cleanup_failed", "cleanup");
		}
		worktreePath = null;
		worktreeRoot = null;
		const released = await releaseLock(options.projectPath, runId);
		if (released !== true) {
			projectLockState = "unavailable";
			return fail("project_lock_release_unconfirmed", "cleanup");
		}
		projectLocked = false;
		projectLockState = "released";
		if (remainingMs(options.deadlineMs, now) <= 0) {
			return fail("deadline_expired", "cleanup");
		}
		finalResult = terminalResult(base, {
			status: "succeeded",
			provider,
			targetId,
			changedFiles,
			checks,
			dirtyBaseline,
			providerLifecycle,
		});
		return finalResult;
	} catch (error) {
		return fail(
			typeof error?.code === "string" ? error.code : "simple_execution_failed",
			currentPhase,
		);
	} finally {
		if (worktreePath && !keepWorktree) {
			const cleanupBudget = remainingMs(options.deadlineMs, now);
			if (
				cleanupBudget > 0 &&
				worktreeRoot?.startsWith(`${realpathSync(tmpdir())}${sep}`)
			) {
				try {
					rmSync(worktreeRoot, { recursive: true, force: true });
					worktreePath = null;
				} catch {
					// Preserve the exact checkout path for attended recovery below.
				}
			}
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
	}
}

export async function handleSimple(argv, dependencies = {}) {
	const now = dependencies.now ?? Date.now;
	const startedAt = now();
	let result;
	try {
		const options = parseSimpleArgs(argv, { now });
		if (options.help) {
			console.log(SIMPLE_USAGE);
			return;
		}
		result = await runSimpleTask(options, {
			...dependencies,
			now,
			onStatus:
				dependencies.onStatus ??
				((event) =>
					console.error(
						`dispatch: simple task=${event.taskId} phase=${event.phase}`,
					)),
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
			partialWorktree: null,
			recovery: recoveryUnavailable(),
		};
	}
	console.log(JSON.stringify(result));
	if (result.status !== "succeeded")
		process.exitCode = result.failureReason === "invalid_invocation" ? 2 : 1;
}
