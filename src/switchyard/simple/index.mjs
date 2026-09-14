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
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { runProviderProcess } from "../adapter/provider-lifecycle.mjs";
import { integrationGate, validateDiff } from "../integrate/index.mjs";
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

export const SIMPLE_USAGE = `Usage: switchyard-dispatch simple <prompt-file> --project <path> --capability <low|standard|high> --file <path> --check <command> --deadline <RFC3339> [--json]

Runs one bounded assignment in a disposable local checkout. Repeat --file and
--check as needed. Output is always one JSON result; progress is written to stderr.`;

const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_DEADLINE_MS = 30 * 60 * 1000;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_DECLARED_FILES = 64;
const MAX_CHECKS = 16;
const MAX_PATH_CHARS = 1024;
const MAX_CHECK_CHARS = 8192;
const SIMPLE_PROVIDERS = Object.freeze(["codex"]);
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

function normalizeDeclaredPath(projectPath, value) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new SimpleUsageError("--file requires a non-empty relative path");
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
		throw new SimpleUsageError(`unsafe --file path: ${value}`);
	}
	const absolute = resolve(projectPath, path);
	if (
		absolute !== projectPath &&
		!absolute.startsWith(`${projectPath}${sep}`)
	) {
		throw new SimpleUsageError(`--file escapes project: ${value}`);
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
	for (const path of files) {
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
		files,
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
	return runProviderProcess(invocation.command, invocation.args, {
		input: context.prompt,
		timeoutMs: context.timeoutMs,
		silenceTimeoutMs: Math.min(5 * 60 * 1000, context.timeoutMs),
		maxBuffer: MAX_CAPTURE_BYTES,
		progressStage: "running",
		onPoll: () => context.onProgress?.(),
	});
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

function terminalResult(base, overrides = {}) {
	return {
		schemaVersion: 1,
		taskId: base.taskId,
		status: overrides.status ?? "failed",
		provider: overrides.provider ?? null,
		targetId: overrides.targetId ?? null,
		elapsedMs: Math.max(0, base.now() - base.startedAt),
		changedFiles: safeChangedFiles(overrides.changedFiles ?? []),
		checks: overrides.checks ?? [],
		failureReason: overrides.failureReason ?? null,
		failurePhase: overrides.failurePhase ?? null,
		partialWorktree: overrides.partialWorktree ?? null,
	};
}

export async function runSimpleTask(options, dependencies = {}) {
	const now = dependencies.now ?? Date.now;
	const taskId = dependencies.taskId ?? randomUUID();
	const runId = `simple-${taskId}`;
	const startedAt = now();
	const base = { taskId, startedAt, now };
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
		if (worktreePath && remainingMs(options.deadlineMs, now) <= 0) {
			keepWorktree = true;
		}
		finalResult = terminalResult(base, {
			provider,
			targetId,
			changedFiles,
			checks,
			failureReason,
			failurePhase,
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
		if (!declaredPathsAreClean(options.projectPath, options.files)) {
			return fail("declared_path_has_owner_edits", "preflight");
		}
		const initialFingerprint = fileFingerprint(
			options.projectPath,
			options.files,
		);
		const baseRevision = requireGit(
			options.projectPath,
			["rev-parse", "HEAD"],
			"project_revision_unavailable",
		).trim();

		currentPhase = "route";
		emitStatus(onStatus, taskId, "route");
		const routed = routeProvider({
			requiredCapability: options.capability,
			availableProviders: SIMPLE_PROVIDERS,
			platform: "direct",
			nowMs: now(),
			hasInvocationDescriptor: (name, capability) =>
				Boolean(descriptorFor(name, capability)),
			modelForCapability: (name, capability) =>
				descriptorFor(name, capability)?.selector ?? null,
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

		const guardedPrompt = `${readFileSync(options.promptPath, "utf8")}\n\nWork only in the current disposable checkout. Change only these declared files: ${options.files.join(", ")}. Do not delegate, plan recursively, commit, push, access credentials, or change any other path.`;
		const harness = normalizeProviderName(identity.harnessKey);
		currentPhase = "execute";
		emitStatus(onStatus, taskId, "execute");
		const executionBudget = remainingMs(options.deadlineMs, now);
		if (executionBudget <= 0) {
			return fail("deadline_expired", "execute");
		}
		const providerResult = await executeProvider({
			harness,
			descriptor,
			prompt: guardedPrompt,
			worktreePath,
			timeoutMs: executionBudget,
			onProgress: () => emitStatus(onStatus, taskId, "execute"),
		});

		if (!providerResult?.success) {
			if (remainingMs(options.deadlineMs, now) > 0) {
				const captured = captureWorktreeDiff(
					worktreePath,
					baseRevision,
					options.deadlineMs,
					now,
				);
				changedFiles = captured.changedFiles;
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
			baseRevision,
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
			return fail("undeclared_paths_changed", "diff");
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
			const check = await runCheck({
				command: options.checks[index],
				worktreePath,
				timeoutMs: remaining,
				onProgress: () => emitStatus(onStatus, taskId, "checks"),
			});
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
			fileFingerprint(options.projectPath, options.files) !== initialFingerprint
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
		await releaseLock(options.projectPath, runId);
		projectLocked = false;
		if (remainingMs(options.deadlineMs, now) <= 0) {
			return fail("deadline_expired", "cleanup");
		}
		finalResult = terminalResult(base, {
			status: "succeeded",
			provider,
			targetId,
			changedFiles,
			checks,
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
				await releaseLock(options.projectPath, runId);
			} catch {
				// The terminal result stays bounded; existing lock recovery owns repair.
			}
		}
		if (finalResult) finalResult.elapsedMs = Math.max(0, now() - startedAt);
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
		};
	}
	console.log(JSON.stringify(result));
	if (result.status !== "succeeded")
		process.exitCode = result.failureReason === "invalid_invocation" ? 2 : 1;
}
