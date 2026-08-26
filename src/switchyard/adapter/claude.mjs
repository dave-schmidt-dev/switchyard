// Claude adapter - write-enabled implementer
// Executes claude CLI inside the container (never host-spawn)
// CR-4: Adapters exec inside container, never host-spawn
// PW-4: Independent in-container login
//
// Auth is a real interactive OAuth login (`claude auth login`) run once by
// a human directly against the standing agent container — see
// `src/switchyard/auth/index.mjs`. TASKS.md Task 24: this replaces an
// earlier BWS-credential-injection design.

import { execFileSync } from "node:child_process";
import { PROVIDER_EXECUTION_TIMEOUT_MS } from "./constants.mjs";
import { describeExecError } from "./exec-error.mjs";
import { validateAdapterInvocation } from "./invocation.mjs";
import {
	killOrphanedProcesses,
	killOrphanedProcessesAsync,
} from "./orphan-kill.mjs";
import { addProviderPromptGuardrail } from "./prompt-guardrails.mjs";
import {
	captureProviderDiff,
	captureProviderDiffAsync,
	executeProviderInvocation,
	getWorkspaceExecution,
} from "./provider-lifecycle.mjs";
import { validateIdentifier, validateModelArg } from "./shell-safety.mjs";

const CLAUDE_CMD = "claude";

/**
 * Check if Claude is authenticated in the guest. Retains the executable
 * liveness check (`--version` responds) and probes authentication using
 * `claude auth status` exit code only. Fails closed on missing binary,
 * non-zero exit status, or status command failure.
 * @param {string} workspaceId
 * @param {import("../lifecycle/parallels-execution-backend.mjs").ParallelsExecutionBackend} executionBackend
 * @returns {boolean}
 */
export function isClaudeAuthenticated(workspaceId, executionBackend) {
	try {
		const result = executionBackend
			.execGuest(workspaceId, CLAUDE_CMD, ["--version"], { cwd: "/" })
			.toString();
		if (!result.includes("Claude")) {
			return false;
		}
		executionBackend.execGuest(workspaceId, CLAUDE_CMD, ["auth", "status"], {
			cwd: "/",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Execute a task with Claude in the container.
 * The prompt is delivered over stdin, never shell-interpolated — this
 * avoids both shell-injection and the multi-line-prompt-flattening problem
 * that string interpolation forced on us.
 * @param {string} prompt The task prompt
 * @param {string} workingContainerName Working container to exec in
 * @param {object} options Execution options
 * @param {string} [options.model] Model to use
 * @param {number} [options.timeoutMs] Execution timeout in ms (defaults to PROVIDER_EXECUTION_TIMEOUT_MS)
 * @returns {{output: string, success: boolean, error?: string, timedOut?: boolean, errorKind?: string|null}}
 */
export function executeClaude(prompt, workingContainerName, options = {}) {
	const { model, timeoutMs = PROVIDER_EXECUTION_TIMEOUT_MS } = options;
	const guardedPrompt = addProviderPromptGuardrail(prompt);

	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}
	let invocationArgs;
	try {
		invocationArgs = validateAdapterInvocation(options, {
			expectedHarness: "claude",
			expectedTargetId: options.resolvedTargetId,
			expectedModel: model,
		});
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}

	const argv = [
		CLAUDE_CMD,
		// Non-interactive dispatch (Task 25). claude's default is an interactive
		// TUI session; -p/--print makes it process the piped prompt and exit,
		// bringing it to parity with the other headless adapters (cursor already
		// passes --print, agy --mode accept-edits). Without this, the earlier
		// stdin-only invocation "worked" only by interactive mode happening to
		// read piped stdin then hit EOF — fragile, and it left edits blocked.
		"--print",
		// Auto-apply file edits without an interactive approval prompt no human
		// is present to answer (the live proof caught claude blocking its own
		// write here). acceptEdits accepts *edits* only and still gates other
		// tools (bash, etc.) — the deliberately conservative first step per the
		// user's Task 25 call ("try this before bypassing entirely"); escalate
		// to bypassPermissions only if edit-only gating stalls real tasks. Safe
		// posture because the disposable working container is itself the
		// containment boundary (INV-1) and INV-2's integration gate is the real
		// review point for anything that leaves it.
		"--permission-mode",
		"acceptEdits",
		// Provider-specific descriptor argv is forwarded verbatim at this fixed
		// position, immediately after Claude's headless safety flags.
		...invocationArgs,
	];
	if (model) {
		try {
			validateModelArg(model, "model");
		} catch (error) {
			return { output: "", success: false, error: error.message };
		}
		argv.push("--model", model);
	}
	const { command, args } = getWorkspaceExecution(workingContainerName, {
		...options,
		argv,
	});

	try {
		const result = execFileSync(command, args, {
			input: guardedPrompt,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: timeoutMs,
			maxBuffer: 128 * 1024 * 1024, // 128 MB
		});

		return { output: result, success: true };
	} catch (error) {
		const timedOut = error.code === "ETIMEDOUT";
		if (timedOut) {
			// The host-side kill above only stops the exec client; the process
			// it started keeps running in the container/guest until explicitly
			// killed there (see orphan-kill.mjs).
			const cleanup = killOrphanedProcesses(workingContainerName, {
				executionBackend: options.executionBackend,
				command,
				args,
			});
			// Keep error.message (carries ETIMEDOUT) so the runner classifies
			// this as execution_timed_out, not a generic failure.
			//
			// The cleanup fields ride along because runner/index.mjs reads
			// `execution.cleanupFailed` to decide between
			// `execution_timed_out` and `execution_timed_out_cleanup_failed`.
			// Omitting them left that branch permanently false on this path,
			// so a guest provider that survived the kill was reported as a
			// clean timeout — an INV-3 exposure the terminal state hid.
			return {
				output: error.stdout || "",
				success: false,
				error: error.message,
				timedOut,
				...cleanup,
			};
		}
		// Non-timeout failure: surface the provider's own diagnostic (and, on an
		// expired OAuth session, an actionable re-auth hint) instead of Node's
		// opaque "Command failed: docker exec …" wrapper — see exec-error.mjs.
		const described = describeExecError(error, { provider: "claude" });
		return {
			output: described.output,
			success: false,
			error: described.error,
			errorKind: described.errorKind,
			timedOut,
		};
	}
}

/** Async counterpart used by non-blocking queue workers. */
export async function executeClaudeAsync(
	prompt,
	workingContainerName,
	options = {},
) {
	const {
		model,
		timeoutMs = PROVIDER_EXECUTION_TIMEOUT_MS,
		signal,
		onPoll,
	} = options;
	const guardedPrompt = addProviderPromptGuardrail(prompt);
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
		const invocationArgs = validateAdapterInvocation(options, {
			expectedHarness: "claude",
			expectedTargetId: options.resolvedTargetId,
			expectedModel: model,
		});
		const argv = [
			CLAUDE_CMD,
			"--print",
			"--permission-mode",
			"acceptEdits",
			...invocationArgs,
		];
		if (model) {
			validateModelArg(model, "model");
			argv.push("--model", model);
		}
		const { command, args } = getWorkspaceExecution(workingContainerName, {
			...options,
			argv,
		});
		return await executeProviderInvocation(command, args, {
			...options,
			provider: "claude",
			input: guardedPrompt,
			timeoutMs,
			signal,
			onPoll,
			cleanup: () => killOrphanedProcessesAsync(workingContainerName),
		});
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}
}

/**
 * Capture the diff produced by Claude in the working container.
 * @param {string} workingContainerName Working container name
 * @returns {string|null} Git diff or null
 */
export function captureDiff(workingContainerName, options = {}) {
	return captureProviderDiff(workingContainerName, options);
}

export function captureDiffAsync(workingContainerName, options = {}) {
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch {
		return Promise.resolve(null);
	}
	return captureProviderDiffAsync(workingContainerName, options);
}
