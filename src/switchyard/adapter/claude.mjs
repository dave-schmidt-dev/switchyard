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
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";
import { PROVIDER_EXECUTION_TIMEOUT_MS } from "./constants.mjs";
import { killOrphanedProcesses } from "./orphan-kill.mjs";
import { validateIdentifier, validateModelArg } from "./shell-safety.mjs";

const CLAUDE_CMD = "claude";

// `claude auth login` persists the operative credential to Claude Code's own
// store, which on Linux (the container runs as root) is
// /root/.claude/.credentials.json —
// mode 0600, holding the OAuth access/refresh tokens + expiry. Verified
// against Claude Code's own authentication docs, not assumed. (Unverifiable
// end-to-end until the agent image exists — TASKS.md Task 14 — but a wrong
// path only causes a needless, idempotent re-auth, never a false "authed".)
const CLAUDE_CREDENTIALS_PATH = "/root/.claude/.credentials.json";

// A real OAuth/token credential is hundreds of bytes; this floor rejects an
// empty file (the exact bug that shipped once — a printf writing nothing)
// and trivial JSON stubs (`{}`, `null`, `""`). It deliberately does NOT
// attempt server-side validity — a well-formed but revoked/garbage token
// still passes — because that needs a network round-trip the container
// can't make reliably (the same reason `cursor-agent status` was rejected
// as an auth signal; see cursor.mjs). Scope: presence + substance, not
// liveness of the token against the provider's API.
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
		execFileSync(
			"docker",
			[
				"exec",
				containerName,
				"sh",
				"-c",
				`[ -f ${CLAUDE_CREDENTIALS_PATH} ] && [ "$(wc -c < ${CLAUDE_CREDENTIALS_PATH} | tr -d '[:space:]')" -ge ${MIN_CREDENTIAL_BYTES} ]`,
			],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if Claude is authenticated in the container. Supplements the binary
 * liveness check (`--version` responds) with a real credential check: the
 * persisted credential must exist and be non-trivial. Liveness alone treated
 * an installed-but-unauthenticated CLI as authenticated, so
 * ensureProvidersAuthenticated() skipped its headless login and the first
 * real dispatch failed instead of `npm run auth` catching it (TASKS.md Task 15).
 * @param {string} [containerName] Container to check (defaults to the standing agent container).
 * @returns {boolean}
 */
export function isClaudeAuthenticated(containerName = AGENT_CONTAINER_NAME) {
	try {
		const result = execFileSync(
			"docker",
			["exec", containerName, CLAUDE_CMD, "--version"],
			{ encoding: "utf8", stdio: "pipe" },
		);
		if (!result.includes("Claude")) {
			return false;
		}
	} catch {
		return false;
	}
	return hasNonTrivialCredential(containerName);
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
 * @returns {{output: string, success: boolean, error?: string, timedOut?: boolean}}
 */
export function executeClaude(prompt, workingContainerName, options = {}) {
	const { model, timeoutMs = PROVIDER_EXECUTION_TIMEOUT_MS } = options;

	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}

	const args = [
		"exec",
		"-i",
		"-w",
		"/project",
		workingContainerName,
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
	];
	if (model) {
		try {
			validateModelArg(model, "model");
		} catch (error) {
			return { output: "", success: false, error: error.message };
		}
		args.push("--model", model);
	}

	try {
		const result = execFileSync("docker", args, {
			input: prompt,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: timeoutMs,
			maxBuffer: 128 * 1024 * 1024, // 128 MB
		});

		return { output: result, success: true };
	} catch (error) {
		const timedOut = error.code === "ETIMEDOUT";
		if (timedOut) {
			// The host-side kill above only stops the `docker exec` client; the
			// process it started keeps running inside the container's PID
			// namespace until explicitly killed there (see orphan-kill.mjs).
			killOrphanedProcesses(workingContainerName);
		}
		return {
			output: error.stdout || "",
			success: false,
			error: error.message,
			timedOut,
		};
	}
}

/**
 * Capture the diff produced by Claude in the working container.
 * @param {string} workingContainerName Working container name
 * @returns {string|null} Git diff or null
 */
export function captureDiff(workingContainerName) {
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch {
		return null;
	}
	try {
		// Stage first so NEWLY CREATED files are captured too — plain `git diff`
		// reports only unstaged edits to already-tracked files, so a "write a new
		// module/test" task (the most common agent output) would otherwise diff
		// empty, be recorded success_no_diff, and silently lose the work before
		// the integration gate (INV-2) ever ran. `git add -A` honors the seeded
		// .gitignore, so agent-created build artifacts / stray .env files are
		// deliberately left unshipped. `git diff --cached HEAD` then shows the
		// full change set (new files included) against the seeded baseline.
		execFileSync(
			"docker",
			["exec", "-w", "/project", workingContainerName, "git", "add", "-A"],
			{ stdio: "pipe" },
		);
		const diff = execFileSync(
			"docker",
			[
				"exec",
				"-w",
				"/project",
				workingContainerName,
				"git",
				"diff",
				"--cached",
				"HEAD",
			],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return diff.trim() || null;
	} catch {
		return null;
	}
}
