// Agy (Antigravity CLI) adapter - write-enabled implementer
// Executes agy CLI inside the container (never host-spawn)
// CR-4: Adapters exec inside container, never host-spawn
// PW-4: Independent in-container login
//
// Agy has no explicit login subcommand: running it unauthenticated
// auto-triggers a real Google OAuth flow (prints a URL to visit, then waits
// for a pasted authorization code) — run once by a human directly against
// the standing agent container, see `src/switchyard/auth/index.mjs`.
// TASKS.md Task 24: this replaces an earlier BWS-credential-injection design.

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

const AGY_CMD = "agy";

/**
 * Check that Agy's macOS Keychain item is present. The static guest command
 * redirects all output and the host consumes only its exit status, so no
 * credential value or Keychain metadata crosses the process boundary.
 * @param {string} workspaceId
 * @param {import("../lifecycle/parallels-execution-backend.mjs").ParallelsExecutionBackend} executionBackend
 * @returns {boolean}
 */
function hasAgyKeychainLogin(workspaceId, executionBackend) {
	try {
		executionBackend.execGuest(
			workspaceId,
			"/bin/sh",
			[
				"-c",
				"/usr/bin/security find-generic-password -s gemini -a antigravity >/dev/null 2>&1",
			],
			{ cwd: "/" },
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if Agy is authenticated in the guest. `agy --version` has no vendor
 * keyword to match, so liveness here is just "binary runs, non-empty
 * output"; the real signal is the dedicated macOS Keychain item set by the
 * supported interactive login. Liveness alone treated an installed-but-
 * unauthenticated CLI as authenticated, so `npm run auth` would have skipped
 * a provider that still needed a real interactive login (TASKS.md Task 15).
 * @param {string} workspaceId
 * @param {import("../lifecycle/parallels-execution-backend.mjs").ParallelsExecutionBackend} executionBackend
 * @returns {boolean}
 */
export function isAgyAuthenticated(workspaceId, executionBackend) {
	try {
		const result = executionBackend
			.execGuest(workspaceId, AGY_CMD, ["--version"], { cwd: "/" })
			.toString();
		if (!(typeof result === "string" && result.trim().length > 0)) {
			return false;
		}
	} catch {
		return false;
	}
	return hasAgyKeychainLogin(workspaceId, executionBackend);
}

/**
 * Execute a task with Agy in the container.
 * Unlike claude/codex, agy's prompt is a `--print <value>` flag argument, not
 * stdin (confirmed against the installed CLI's own --help) — still delivered
 * as a single execFileSync argv element, never shell-interpolated.
 * `--new-project` is required so each task gets an isolated conversation
 * rather than resuming a stale prior one.
 *
 * `--dangerously-skip-permissions` is required to actually APPLY edits
 * headlessly: `--mode accept-edits` alone is NOT sufficient in `--print` mode
 * — agy's permission layer auto-denies the `write_file` tool ("headless mode
 * cannot prompt for it") and exits 0 having produced no diff (live-verified
 * 2026-07-26). This is NOT the nested-userns/bwrap limitation codex hit; it is
 * agy's own tool-permission gate. David approved full auto-approve here (the
 * same posture as codex's bypass): the working container is itself the
 * containment boundary (INV-1, disposable, no host rights), and INV-2's
 * integration gate remains the real review point. agy offers a narrower
 * settings.json `write_file` allow-rule as an alternative; the full-bypass
 * flag was chosen for consistency with codex and because it is verified.
 * @param {string} prompt The task prompt
 * @param {string} workingContainerName Working container to exec in
 * @param {object} options Execution options
 * @param {string} [options.model] Model to use
 * @param {number} [options.timeoutMs] Execution timeout in ms (defaults to PROVIDER_EXECUTION_TIMEOUT_MS)
 * @returns {{output: string, success: boolean, error?: string, timedOut?: boolean, errorKind?: string|null}}
 */
export function executeAgy(prompt, workingContainerName, options = {}) {
	const {
		model,
		timeoutMs = PROVIDER_EXECUTION_TIMEOUT_MS,
		cwd = "/project",
	} = options;
	const guardedPrompt = addProviderPromptGuardrail(prompt);

	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}
	try {
		validateAdapterInvocation(options, {
			expectedHarness: "agy",
			expectedTargetId: options.resolvedTargetId,
			expectedModel: model,
		});
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}

	const argv = [
		AGY_CMD,
		"--new-project",
		"--mode",
		"accept-edits",
		"--dangerously-skip-permissions",
	];
	if (model) {
		try {
			validateModelArg(model, "model");
		} catch (error) {
			return { output: "", success: false, error: error.message };
		}
		argv.push("--model", model);
	}
	argv.push(
		"--add-dir",
		cwd,
		"--print-timeout",
		"9m",
		"--print",
		guardedPrompt,
	);
	const { command, args } = getWorkspaceExecution(workingContainerName, {
		...options,
		cwd,
		argv,
	});

	try {
		const result = execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			// Should exceed the `--print-timeout 9m` passed above so the host
			// kill stays a backstop for a hung/unresponsive process rather than
			// the primary timeout mechanism — true for the default (30m). A
			// task's `Timeout:` override can still set this below 9m; that's a
			// deliberate per-task choice, and it degrades safely: the host kill
			// just fires before agy's own graceful timeout would have, and the
			// orphan-kill + diff-capture path below still applies.
			timeout: timeoutMs,
			maxBuffer: 128 * 1024 * 1024, // 128 MB
		});

		return { output: result, success: true };
	} catch (error) {
		const timedOut = error.code === "ETIMEDOUT";
		if (timedOut) {
			killOrphanedProcesses(workingContainerName, {
				executionBackend: options.executionBackend,
				command,
				args,
			});
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
		const described = describeExecError(error, { provider: "agy" });
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
export async function executeAgyAsync(
	prompt,
	workingContainerName,
	options = {},
) {
	const {
		model,
		timeoutMs = PROVIDER_EXECUTION_TIMEOUT_MS,
		cwd = "/project",
		signal,
		onPoll,
	} = options;
	const guardedPrompt = addProviderPromptGuardrail(prompt);
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
		validateAdapterInvocation(options, {
			expectedHarness: "agy",
			expectedTargetId: options.resolvedTargetId,
			expectedModel: model,
		});
		const argv = [
			AGY_CMD,
			"--new-project",
			"--mode",
			"accept-edits",
			"--dangerously-skip-permissions",
		];
		if (model) {
			validateModelArg(model, "model");
			argv.push("--model", model);
		}
		argv.push(
			"--add-dir",
			cwd,
			"--print-timeout",
			"9m",
			"--print",
			guardedPrompt,
		);
		const { command, args } = getWorkspaceExecution(workingContainerName, {
			...options,
			cwd,
			argv,
		});
		return await executeProviderInvocation(command, args, {
			...options,
			provider: "agy",
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
 * Capture the diff produced by Agy in the working container.
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
