// Codex adapter - write-enabled implementer
// Executes codex CLI inside the container (never host-spawn)
// CR-4: Adapters exec inside container, never host-spawn
// PW-4: Independent in-container login

import { execFileSync } from "node:child_process";
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";
import {
	validateEnvName,
	validateIdentifier,
	validateModelArg,
} from "./shell-safety.mjs";

const CODEX_CMD = "codex";

/**
 * Build the in-container script that persists the Codex auth payload
 * forwarded via `docker exec -e ${secretName}` into `~/.codex/auth.json`.
 * Pure/testable: exported separately from the `bws-run` wrapper so a test
 * can verify the *actual file content* ends up correct without needing real
 * BWS access — this exact bug (script reading from stdin instead of
 * referencing the forwarded env var, silently writing an empty file with
 * exit code 0) shipped once already.
 *
 * The string returned here is NOT that script verbatim — it's that script
 * base64-encoded and wrapped as `echo <b64> | base64 -d | sh` (same
 * technique cursor.mjs's CURSOR_WRAPPER_SCRIPT uses, applied to the whole
 * script rather than one sub-payload). authenticateCodex() embeds the
 * return value via single quotes into a `zsh -c "... docker exec ... sh -c
 * '...'"` nesting; the base64 alphabet ([A-Za-z0-9+/=]) contains no shell
 * metacharacters, so the only characters that ever cross that boundary
 * cannot break out of the single-quoted region regardless of what the real
 * script above contains. A future edit introducing a bare single quote,
 * `$(...)`, or other special character into the real script text can no
 * longer reintroduce the quote-escaping bug that already shipped once (see
 * tests/codex-auth.test.mjs's boundary-crossing regression test).
 * @param {string} secretName
 * @returns {string}
 */
export function buildAuthContainerScript(secretName) {
	const realScript = `mkdir -p /root/.codex && printf '%s' "$${secretName}" > /root/.codex/auth.json && chmod 600 /root/.codex/auth.json`;
	const scriptB64 = Buffer.from(realScript, "utf8").toString("base64");
	return `echo ${scriptB64} | base64 -d | sh`;
}

// authenticateCodex persists the credential here (see buildAuthContainerScript
// above — it writes /root/.codex/auth.json directly), so unlike Claude this is
// the durable, adapter-controlled path.
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
 * Authenticate Codex in the container.
 * PW-4: Independent in-container login via BWS-provided auth payload.
 *
 * The secret is never fetched host-side and never appears in any process's
 * argv (visible via `ps`/`/proc`): `bws-run` injects `secretName` as an env
 * var into the `docker exec` process it launches, and `docker exec -e NAME`
 * (bare, no `=value`) forwards that host env var into the container by
 * reference. Requires `secretName` to be the exact BWS secret key
 * (project convention: UPPERCASE_SNAKE_CASE matching the env var).
 * @param {string} [secretName] BWS secret name for the Codex auth payload JSON.
 * @returns {boolean}
 */
export function authenticateCodex(secretName = "CODEX_AUTH_JSON") {
	try {
		validateEnvName(secretName, "secretName");
	} catch (error) {
		console.error("Failed to authenticate Codex:", error.message);
		return false;
	}

	const containerScript = buildAuthContainerScript(secretName);

	// Don't trust this call's exit code alone: `bws run` has been observed to
	// report success (exit 0) for a wrapped `docker exec ... sh -c '<script>'`
	// even when the script demonstrably failed inside the container (it
	// re-serializes trailing argv through a shell, which can mangle a
	// multi-word `sh -c` argument). The credential-presence check below is
	// the ground truth this function's return value is actually built on.
	try {
		execFileSync(
			"zsh",
			[
				"-i",
				"-c",
				`bws-run -- docker exec -e ${secretName} ${AGENT_CONTAINER_NAME} sh -c '${containerScript}'`,
			],
			{ stdio: "inherit" },
		);
	} catch (error) {
		console.error("Failed to authenticate Codex:", error.message);
	}

	return hasNonTrivialCredential(AGENT_CONTAINER_NAME);
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
 * @returns {{output: string, success: boolean, error?: string}}
 */
export function executeCodex(prompt, workingContainerName, options = {}) {
	const { model } = options;

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
		CODEX_CMD,
		// Codex's own `exec` subcommand, required for non-interactive dispatch —
		// `codex` bare forwards straight to the interactive TUI regardless of
		// whether stdout is a TTY (unlike `claude`, which auto-detects piped
		// output). Verified against the installed CLI's own --help.
		"exec",
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
			timeout: 300000,
		});

		return { output: result, success: true };
	} catch (error) {
		return {
			output: error.stdout || "",
			success: false,
			error: error.message,
		};
	}
}

/**
 * Capture the diff produced by Codex in the working container.
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
		const diff = execFileSync(
			"docker",
			["exec", "-w", "/project", workingContainerName, "git", "diff"],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return diff.trim() || null;
	} catch {
		return null;
	}
}
