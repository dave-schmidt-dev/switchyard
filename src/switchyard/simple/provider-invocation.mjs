import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	classifyProviderStreams,
	providerDiagnosticCodeForKind,
} from "../adapter/exec-error.mjs";
import { runProviderProcess } from "../adapter/provider-lifecycle.mjs";
import {
	MAX_CAPTURE_BYTES,
	requireGit,
	SECRET_PATHS,
	SIMPLE_TARGET_ADAPTERS,
} from "./args.mjs";
import { resolveCheckExecution } from "./check-execution.mjs";
import { settleSimpleWriterProcesses } from "./process-teardown.mjs";

const VIBE_CODE_LAUNCHER = fileURLToPath(
	new URL("../../../ops/simple-vibe-code-launcher.mjs", import.meta.url),
);
const CLAUDE_CODE_LAUNCHER = fileURLToPath(
	new URL("../../../ops/simple-claude-code-launcher.mjs", import.meta.url),
);

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
	if (targetId === "vibe-code") {
		return {
			command: process.execPath,
			args: [
				VIBE_CODE_LAUNCHER,
				"--model",
				descriptor.selector,
				"--worktree",
				worktreePath,
			],
		};
	}
	if (targetId === "claude-code") {
		return {
			command: process.execPath,
			args: [
				CLAUDE_CODE_LAUNCHER,
				"--model",
				descriptor.selector,
				"--effort",
				descriptor.invocation_args[1],
				"--worktree",
				worktreePath,
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
		onStderrChunk: context.onStderrChunk,
		signal: context.signal,
		...(context.spawnFn ? { spawnFn: context.spawnFn } : {}),
	});
	const diagnosticEvidence = !result.success
		? classifyProviderStreams({
				stdout: result.output,
				stderr: result.stderr,
				code: result.code,
				provider: context.harness,
				command: invocation.command,
			})
		: null;
	const bridgeDiagnostic =
		context.harness === "opencode"
			? parseOpenCodeGoBridgeDiagnosticEvidence(result.output)
			: null;
	const bridgeDiagnosticCode =
		providerCodeForOpenCodeGoBridgeEvidence(bridgeDiagnostic) ??
		(context.harness === "claude" && !result.success
			? providerCodeForClaudeCodeDiagnostic(result.stderr)
			: null) ??
		(context.harness === "vibe" && !result.success
			? providerCodeForVibeBudgetEvidence(result.stderr)
			: null);
	const diagnosticCode = bridgeDiagnosticCode
		? bridgeDiagnosticCode
		: providerDiagnosticCodeForKind(diagnosticEvidence?.diagnosticKind);
	const classified = diagnosticCode
		? {
				...result,
				diagnosticCode,
				diagnosticOrigin: "adapter",
				diagnosticEvidenceAvailable: true,
			}
		: result;
	if (context.harness === "opencode" && !result.success) {
		const providerVerdictCode = parseOpenCodeGoBridgeDiagnostic(result.output);
		return {
			...classified,
			output: "",
			stderr: "",
			...(providerVerdictCode ? { providerVerdictCode } : {}),
		};
	}
	if (context.harness !== "agy" || !result.success) return classified;
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
export function providerCodeForClaudeCodeDiagnostic(stderr) {
	if (typeof stderr !== "string" || stderr.length > 1_000_000) return null;
	for (const line of stderr.split(/\r?\n/u)) {
		const match =
			/^SWITCHYARD_CLAUDE_CODE_DIAG_V1 subtype=([a-z_]{1,40}|unknown) api_status=(\d{3}|none) limit=([01])$/u.exec(
				line,
			);
		if (!match) continue;
		if (match[3] === "1") return "quota_exhausted";
		if (match[2] === "401" || match[2] === "403") return "auth_expired";
		if (match[2] === "404") return "model_unavailable";
	}
	return null;
}
export function parseOpenCodeGoBridgeDiagnostic(output) {
	const evidence = parseOpenCodeGoBridgeDiagnosticEvidence(output);
	if (!evidence) return null;
	return `opencode_go_diag_requests_${evidence.requests}_status_${evidence.upstreamStatus}_rejections_${evidence.proxyRejections}`;
}

export function parseOpenCodeGoBridgeDiagnosticEvidence(output) {
	if (typeof output !== "string") return null;
	const match =
		/^SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=(0|[1-9]\d{0,5}) upstream_status=(0|[1-5]\d{2}) proxy_rejections=(0|[1-9]\d{0,5})\r?\n?$/u.exec(
			output,
		);
	if (!match) return null;
	return {
		requests: Number(match[1]),
		upstreamStatus: Number(match[2]),
		proxyRejections: Number(match[3]),
	};
}

export function providerCodeForOpenCodeGoBridgeEvidence(evidence) {
	return evidence &&
		evidence.requests > 0 &&
		evidence.requests <= 999_999 &&
		evidence.upstreamStatus === 429 &&
		evidence.proxyRejections === 0
		? "quota_exhausted"
		: null;
}
/**
 * Vibe prints its own upstream error block on stderr when Mistral rejects a
 * request. Only that block counts; model output on stdout never does. The
 * upstream status decides the code: 402 with a billing budget-exhausted type
 * is quota_exhausted, 401/403 are auth_expired, 404 is model_unavailable, and
 * anything else (429, 5xx, ...) is not recognised.
 */
export function providerCodeForVibeBudgetEvidence(stderr) {
	if (typeof stderr !== "string" || stderr.length > 1_000_000) return null;
	const start = /^Error: API error from mistral\b/mu.exec(stderr)?.index;
	if (start === undefined) return null;
	// Read status only from Vibe's own block, never from earlier output.
	const block = stderr.slice(start);
	const status = /^\s*status: (\d{3})\b/mu.exec(block)?.[1];
	if (status === "402")
		return /"type":\s*"billing_[a-z_]*budget_exhausted"/u.test(block)
			? "quota_exhausted"
			: null;
	if (status === "401" || status === "403") return "auth_expired";
	if (status === "404") return "model_unavailable";
	return null;
}
async function defaultRunCheck({
	command,
	worktreePath,
	timeoutMs,
	onProgress,
	signal,
}) {
	if (signal?.aborted) {
		onProgress?.();
		return {
			success: false,
			code: null,
			output: "",
			stderr: "",
			cancelled: true,
			writerLifecycle: "never_started",
		};
	}
	const execution = resolveCheckExecution(command, worktreePath);
	if (execution.kind === "rejected") {
		onProgress?.();
		return {
			success: false,
			code: 1,
			output: "",
			stderr: "",
			diagnosticCode: "check_dependencies_unverified",
			writerLifecycle: "never_started",
		};
	}
	return runSimpleWriter(
		execution.kind === "local" ? execution.command : "/bin/sh",
		execution.kind === "local"
			? execution.args
			: [
					"-lc",
					'cd "$1" && exec /bin/sh -lc "$2"',
					"switchyard-check",
					worktreePath,
					command,
				],
		{
			...(execution.kind === "local" ? { cwd: worktreePath } : {}),
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
	const lifecycle = result?.providerLifecycle;
	const exitCode = Number.isSafeInteger(result?.code)
		? result.code
		: Number.isSafeInteger(lifecycle?.exitCode)
			? lifecycle.exitCode
			: null;
	const signal = result?.signal ?? lifecycle?.signal ?? null;
	const cleanupStatus = result?.cleanupStatus ?? lifecycle?.cleanupStatus;
	const cleanupUnconfirmed =
		result?.cleanupFailed === true ||
		cleanupStatus === "failed" ||
		cleanupStatus === "uncertain" ||
		result?.writerLifecycle === "unavailable" ||
		lifecycle?.writerLifecycle === "unavailable";
	if (exitCode !== null && exitCode !== 0) return "provider_exit_nonzero";
	if (exitCode === 0) {
		if (cleanupUnconfirmed) return "provider_cleanup_failed";
		if (result?.error) return "provider_adapter_error";
		return "provider_result_inconsistent";
	}
	if (signal) return "provider_signalled";
	if (cleanupUnconfirmed) return "provider_cleanup_failed";
	if (result?.error && result.code === null) return "provider_launch_failed";
	return "provider_result_inconsistent";
}

export {
	captureWorktreeDiff,
	classifyExecutionFailure,
	deadlineTimeout,
	defaultRunCheck,
	remainingMs,
	safeChangedFiles,
};
