// Cursor Agent adapter - write-enabled implementer
// Executes cursor-agent CLI inside the container (never host-spawn)
// CR-4: Adapters exec inside container, never host-spawn
// PW-4: Independent in-container login
//
// Auth is a real interactive OAuth login (`cursor-agent login`, or
// `NO_OPEN_BROWSER=1 cursor-agent login` inside a headless container) run
// once by a human directly against the standing agent container — see
// `src/switchyard/auth/index.mjs`. TASKS.md Task 24: this replaces an
// earlier CURSOR_API_KEY/BWS-credential-injection design; a real OAuth
// session persists to cursor-agent's own local credential store, not a
// project-invented file, so there is no headless auto-login here.

import { execFileSync } from "node:child_process";
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";
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

const CURSOR_CMD = "cursor-agent";

/**
 * Check if Cursor Agent is authenticated in the container: `--version`
 * liveness, supplemented by `cursor-agent status --format json`'s structured
 * `isAuthenticated` boolean (confirmed live against a real completed OAuth
 * session — status's exit code does NOT distinguish logged-in from
 * logged-out, so a structured field is required rather than the exit code).
 * Deliberately fails CLOSED: any exec failure, timeout, or unparseable/
 * unexpected JSON returns false, matching the other three adapters'
 * fail-closed posture (an earlier text-matching version of this check
 * inverted that — defaulting to "authenticated" unless the literal string
 * "not logged in" appeared — which read an empty, reworded, or error status
 * output as authenticated; caught in review before shipping).
 * @param {string} [containerName] Container to check (defaults to the standing agent container).
 * @returns {boolean}
 */
export function isCursorAuthenticated(containerName = AGENT_CONTAINER_NAME) {
	try {
		// D-10: authentication probes remain on the standing Docker credential vault.
		const versionResult = execFileSync(
			"docker",
			["exec", containerName, CURSOR_CMD, "--version"],
			{ encoding: "utf8", stdio: "pipe" },
		);
		if (
			!(typeof versionResult === "string" && versionResult.trim().length > 0)
		) {
			return false;
		}
	} catch {
		return false;
	}

	try {
		// D-10: authentication probes remain on the standing Docker credential vault.
		const statusResult = execFileSync(
			"docker",
			["exec", containerName, CURSOR_CMD, "status", "--format", "json"],
			{ encoding: "utf8", stdio: "pipe", timeout: 10000 },
		);
		return JSON.parse(statusResult).isAuthenticated === true;
	} catch {
		return false;
	}
}

/**
 * Execute a task with Cursor Agent in the container.
 * cursor-agent cannot read stdin (confirmed against the installed CLI's own
 * --help: the prompt is a positional argument) — delivered as the final
 * execFileSync argv element, never shell-interpolated. `--force` is required
 * for the CLI to actually apply edits in --print mode rather than only
 * proposing them; `--trust` skips the workspace-trust prompt.
 * @param {string} prompt The task prompt
 * @param {string} workingContainerName Working container to exec in
 * @param {object} options Execution options
 * @param {string} [options.model] Model to use
 * @param {number} [options.timeoutMs] Execution timeout in ms (defaults to PROVIDER_EXECUTION_TIMEOUT_MS)
 * @returns {{output: string, success: boolean, error?: string, timedOut?: boolean, errorKind?: string|null}}
 */
export function executeCursor(prompt, workingContainerName, options = {}) {
	const { model, timeoutMs = PROVIDER_EXECUTION_TIMEOUT_MS } = options;
	const guardedPrompt = addProviderPromptGuardrail(prompt);

	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}
	try {
		validateAdapterInvocation(options, {
			expectedHarness: "cursor",
			expectedTargetId: options.resolvedTargetId,
			expectedModel: model,
		});
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}

	const { command, args: workspaceArgs } = getWorkspaceExecution(
		workingContainerName,
		options,
	);
	const args = [
		...workspaceArgs,
		CURSOR_CMD,
		"--print",
		"--force",
		"--trust",
		"--output-format",
		"text",
	];
	if (model) {
		try {
			validateModelArg(model, "model");
		} catch (error) {
			return { output: "", success: false, error: error.message };
		}
		args.push("--model", model);
	}
	args.push(guardedPrompt);

	try {
		const result = execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutMs,
			maxBuffer: 128 * 1024 * 1024, // 128 MB
		});

		return { output: result, success: true };
	} catch (error) {
		const timedOut = error.code === "ETIMEDOUT";
		if (timedOut) {
			killOrphanedProcesses(workingContainerName);
			// Keep error.message (carries ETIMEDOUT) so the runner classifies
			// this as execution_timed_out, not a generic failure.
			return {
				output: error.stdout || "",
				success: false,
				error: error.message,
				timedOut,
			};
		}
		// Non-timeout failure: surface the provider's own diagnostic (and, on an
		// expired session, an actionable re-auth hint) instead of Node's opaque
		// "Command failed: docker exec …" wrapper — see exec-error.mjs.
		const described = describeExecError(error, { provider: "cursor" });
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
export async function executeCursorAsync(
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
		validateAdapterInvocation(options, {
			expectedHarness: "cursor",
			expectedTargetId: options.resolvedTargetId,
			expectedModel: model,
		});
		const { command, args: workspaceArgs } = getWorkspaceExecution(
			workingContainerName,
			options,
		);
		const args = [
			...workspaceArgs,
			CURSOR_CMD,
			"--print",
			"--force",
			"--trust",
			"--output-format",
			"text",
		];
		if (model) {
			validateModelArg(model, "model");
			args.push("--model", model);
		}
		args.push(guardedPrompt);
		return await executeProviderInvocation(command, args, {
			...options,
			provider: "cursor",
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
 * Capture the diff produced by Cursor Agent in the working container.
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
