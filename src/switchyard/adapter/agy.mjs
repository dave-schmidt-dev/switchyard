// Agy (Antigravity CLI) adapter - write-enabled implementer
// Executes agy CLI inside the container (never host-spawn)
// CR-4: Adapters exec inside container, never host-spawn
// PW-4: Independent in-container login

import { execFileSync } from "node:child_process";
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";
import {
	validateEnvName,
	validateIdentifier,
	validateModelArg,
} from "./shell-safety.mjs";

const AGY_CMD = "agy";

/**
 * Build the in-container script that persists the Gemini/Antigravity
 * credentials JSON forwarded via `docker exec -e ${secretName}` into the
 * path `agy` reads (`~/.gemini/gemini-credentials.json` — confirmed against
 * a real local installation; the CLI still uses the `.gemini` directory
 * namespace internally despite the `agy` rename).
 *
 * The string returned here is NOT that script verbatim — it's that script
 * base64-encoded and wrapped as `echo <b64> | base64 -d | sh` (same
 * technique cursor.mjs's CURSOR_WRAPPER_SCRIPT uses, applied to the whole
 * script rather than one sub-payload). authenticateAgy() embeds the return
 * value via single quotes into a `zsh -c "... docker exec ... sh -c '...'"`
 * nesting; the base64 alphabet ([A-Za-z0-9+/=]) contains no shell
 * metacharacters, so the only characters that ever cross that boundary
 * cannot break out of the single-quoted region regardless of what the real
 * script above contains. A future edit introducing a bare single quote,
 * `$(...)`, or other special character into the real script text can no
 * longer reintroduce the quote-escaping bug that already shipped once (see
 * tests/agy-auth.test.mjs's boundary-crossing regression test).
 * @param {string} secretName
 * @returns {string}
 */
export function buildAuthContainerScript(secretName) {
	const realScript = `mkdir -p /root/.gemini && printf '%s' "$${secretName}" > /root/.gemini/gemini-credentials.json && chmod 600 /root/.gemini/gemini-credentials.json`;
	const scriptB64 = Buffer.from(realScript, "utf8").toString("base64");
	return `echo ${scriptB64} | base64 -d | sh`;
}

// authenticateAgy persists the credential here (see buildAuthContainerScript
// above — it writes /root/.gemini/gemini-credentials.json directly; the CLI
// still uses the pre-rename `.gemini` namespace), so like codex/cursor this is
// the durable, adapter-controlled path.
const AGY_CREDENTIALS_PATH = "/root/.gemini/gemini-credentials.json";

// A real credentials JSON is hundreds of bytes; this floor rejects an empty
// file (the exact bug that shipped once — a printf writing nothing) and
// trivial JSON stubs (`{}`, `null`, `""`). It deliberately does NOT attempt
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
				`[ -f ${AGY_CREDENTIALS_PATH} ] && [ "$(wc -c < ${AGY_CREDENTIALS_PATH} | tr -d '[:space:]')" -ge ${MIN_CREDENTIAL_BYTES} ]`,
			],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if Agy is authenticated in the container. `agy --version` has no
 * vendor keyword to match, so liveness here is just "binary runs, non-empty
 * output"; the real signal is the credential check that supplements it — the
 * persisted gemini-credentials.json must exist and be non-trivial. Liveness
 * alone treated an installed-but-unauthenticated CLI as authenticated, so
 * ensureProvidersAuthenticated() skipped its headless login and the first
 * real dispatch failed instead of `npm run auth` catching it (TASKS.md Task 15).
 * @param {string} [containerName] Container to check (defaults to the standing agent container).
 * @returns {boolean}
 */
export function isAgyAuthenticated(containerName = AGENT_CONTAINER_NAME) {
	try {
		const result = execFileSync(
			"docker",
			["exec", containerName, AGY_CMD, "--version"],
			{ encoding: "utf8", stdio: "pipe" },
		);
		if (!(typeof result === "string" && result.trim().length > 0)) {
			return false;
		}
	} catch {
		return false;
	}
	return hasNonTrivialCredential(containerName);
}

/**
 * Authenticate Agy in the container.
 * PW-4: Independent in-container login via BWS-provided credentials payload.
 *
 * The secret is never fetched host-side and never appears in any process's
 * argv (visible via `ps`/`/proc`): `bws-run` injects `secretName` as an env
 * var into the `docker exec` process it launches, and `docker exec -e NAME`
 * (bare, no `=value`) forwards that host env var into the container by
 * reference. Requires `secretName` to be the exact BWS secret key
 * (project convention: UPPERCASE_SNAKE_CASE matching the env var).
 * @param {string} [secretName] BWS secret name for the Gemini credentials JSON.
 * @returns {boolean}
 */
export function authenticateAgy(secretName = "GEMINI_CREDENTIALS") {
	try {
		validateEnvName(secretName, "secretName");
	} catch (error) {
		console.error("Failed to authenticate Agy:", error.message);
		return false;
	}

	const containerScript = buildAuthContainerScript(secretName);

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
		return true;
	} catch (error) {
		console.error("Failed to authenticate Agy:", error.message);
		return false;
	}
}

/**
 * Execute a task with Agy in the container.
 * Unlike claude/codex, agy's prompt is a `--print <value>` flag argument, not
 * stdin (confirmed against the installed CLI's own --help) — still delivered
 * as a single execFileSync argv element, never shell-interpolated.
 * `--new-project` is required so each task gets an isolated conversation
 * rather than resuming a stale prior one.
 * @param {string} prompt The task prompt
 * @param {string} workingContainerName Working container to exec in
 * @param {object} options Execution options
 * @param {string} [options.model] Model to use
 * @returns {{output: string, success: boolean, error?: string}}
 */
export function executeAgy(prompt, workingContainerName, options = {}) {
	const { model } = options;

	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}

	const args = [
		"exec",
		"-w",
		"/project",
		workingContainerName,
		AGY_CMD,
		"--new-project",
		"--mode",
		"accept-edits",
	];
	if (model) {
		try {
			validateModelArg(model, "model");
		} catch (error) {
			return { output: "", success: false, error: error.message };
		}
		args.push("--model", model);
	}
	args.push(
		"--add-dir",
		"/project",
		"--print-timeout",
		"9m",
		"--print",
		prompt,
	);

	try {
		const result = execFileSync("docker", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			// Must exceed the `--print-timeout 9m` passed above — the host
			// kill is a backstop for a hung/unresponsive process, not the
			// primary timeout mechanism. A shorter host timeout would force-
			// kill a run that Agy's own flag would otherwise let finish or
			// time out gracefully.
			timeout: 600000,
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
 * Capture the diff produced by Agy in the working container.
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
