// Codex adapter - write-enabled implementer
// Executes codex CLI inside the container (never host-spawn)
// CR-4: Adapters exec inside container, never host-spawn
// PW-4: Independent in-container login
//
// Auth is a real interactive login (`codex login --device-auth`, a
// device-code flow needing no local browser) run once by a human directly
// against the standing agent container — see `src/switchyard/auth/index.mjs`.
// TASKS.md Task 24: this replaces an earlier BWS-credential-injection design.

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

const CODEX_CMD = "codex";

// `codex login` persists the operative credential directly to
// /root/.codex/auth.json.
const CODEX_CREDENTIALS_PATH = "/root/.codex/auth.json";

// A real auth.json is hundreds of bytes; this floor rejects an empty file
// (the exact bug that shipped once — a printf writing nothing) and trivial
// JSON stubs (`{}`, `null`, `""`). It deliberately does NOT attempt
// server-side validity — a well-formed but revoked/garbage token still
// passes — because that needs a network round-trip the container can't make
// reliably. Scope: presence + substance, not liveness against the API.
const MIN_CREDENTIAL_BYTES = 16;

/**
 * Check that the persisted credential file exists inside the container and is
 * non-trivial (not empty, not a placeholder stub). INV-1: the credential
 * VALUE never crosses to the host and never appears in argv — only the
 * constant file path and byte threshold do, and `wc -c` reports a byte
 * count, not content. The host reads only the check's exit code.
 * @param {string} containerName
 * @returns {boolean}
 */
function hasNonTrivialCredential(containerName) {
	try {
		// D-10: authentication probes remain on the standing Docker credential vault.
		execFileSync(
			"docker",
			[
				"exec",
				containerName,
				"sh",
				"-c",
				`[ -f ${CODEX_CREDENTIALS_PATH} ] && [ "$(wc -c < ${CODEX_CREDENTIALS_PATH} | tr -d '[:space:]')" -ge ${MIN_CREDENTIAL_BYTES} ]`,
			],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if Codex is authenticated in the container. Supplements the binary
 * liveness check (`--version` responds) with a real credential check: the
 * persisted `auth.json` must exist and be non-trivial. Liveness alone treated
 * an installed-but-unauthenticated CLI as authenticated, so
 * ensureProvidersAuthenticated() skipped its headless login and the first
 * real dispatch failed instead of `npm run auth` catching it (TASKS.md Task 15).
 * @param {string} [containerName] Container to check (defaults to the standing agent container).
 * @returns {boolean}
 */
export function isCodexAuthenticated(containerName = AGENT_CONTAINER_NAME) {
	try {
		// D-10: authentication probes remain on the standing Docker credential vault.
		const result = execFileSync(
			"docker",
			["exec", containerName, CODEX_CMD, "--version"],
			{ encoding: "utf8", stdio: "pipe" },
		);
		if (!result.includes("codex")) {
			return false;
		}
	} catch {
		return false;
	}
	return hasNonTrivialCredential(containerName);
}

/**
 * Execute a task with Codex in the container.
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
export function executeCodex(prompt, workingContainerName, options = {}) {
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
			expectedHarness: "codex",
			expectedTargetId: options.resolvedTargetId,
			expectedModel: model,
		});
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}

	const argv = [
		CODEX_CMD,
		// Codex global `-c key=value` options must precede the `exec`
		// subcommand. Forward the descriptor's exact argv at this fixed position.
		...invocationArgs,
		// Codex's own `exec` subcommand, required for non-interactive dispatch —
		// `codex` bare forwards straight to the interactive TUI regardless of
		// whether stdout is a TTY (unlike `claude`, which auto-detects piped
		// output). Verified against the installed CLI's own --help.
		"exec",
		// Delegate containment to the working container instead of codex's own
		// sandbox (Task 25). Codex enforces `read-only`/`workspace-write` via
		// bubblewrap, which needs an unprivileged user namespace — but nested
		// unprivileged userns is disallowed inside the Docker/OrbStack container,
		// so bwrap can't initialize (`bwrap: No permissions to create a new
		// namespace`). Verified live 2026-07-26: the default (read-only) and
		// `-s workspace-write` BOTH fail to apply any edit in-container; only
		// this flag works. It is codex's own documented mode for "environments
		// that are externally sandboxed" — which the working container is
		// (INV-1: no host FS mount, no docker.sock, no host creds; disposable,
		// INV-3). INV-2's integration gate remains the real review point for
		// anything that leaves the container, so auto-approving in-container is
		// consistent with the accident-containment threat model, not a hole.
		"--dangerously-bypass-approvals-and-sandbox",
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
		const described = describeExecError(error, { provider: "codex" });
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
export async function executeCodexAsync(
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
			expectedHarness: "codex",
			expectedTargetId: options.resolvedTargetId,
			expectedModel: model,
		});
		const argv = [
			CODEX_CMD,
			...invocationArgs,
			"exec",
			"--dangerously-bypass-approvals-and-sandbox",
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
			provider: "codex",
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
 * Capture the diff produced by Codex in the working container.
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
