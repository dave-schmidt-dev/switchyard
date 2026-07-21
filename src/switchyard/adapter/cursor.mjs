// Cursor Agent adapter - write-enabled implementer
// Executes cursor-agent CLI inside the container (never host-spawn)
// CR-4: Adapters exec inside container, never host-spawn
// PW-4: Independent in-container login
//
// Cursor's primary auth is a browser-based OAuth login (`cursor-agent
// login`), but that session isn't reproducible headlessly inside a
// container. Cursor's own docs (cursor.com/docs/cli/headless) document a
// separate, vendor-sanctioned mechanism for exactly this case: a
// CURSOR_API_KEY (Dashboard -> API Keys), read via env var or --api-key.
// That's what this adapter injects — never the interactive OAuth session.

import { execFileSync } from "node:child_process";
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";
import {
	validateEnvName,
	validateIdentifier,
	validateModelArg,
} from "./shell-safety.mjs";

const CURSOR_CMD = "cursor-agent";
const CURSOR_AUTHED_CMD = "cursor-agent-authed";

// The wrapper script's own body contains shell-special characters ($, ",
// (), @) that would otherwise have to survive three nested shell layers
// (the host zsh, the `docker exec ... sh -c '...'` it launches, and the
// resulting file being written by a printf inside that). Getting that
// nesting right by hand-balancing quotes failed in testing — the "$(...)"
// inside the wrapper body fell outside the intended single-quoted region
// and got command-substituted by the *host* shell instead of written
// literally. Base64-encoding the payload sidesteps the whole hazard: the
// only characters that ever cross a shell boundary are [A-Za-z0-9+/=],
// none of which are shell-special at any nesting level.
const CURSOR_WRAPPER_SCRIPT = [
	"#!/bin/sh",
	'export CURSOR_API_KEY="$(cat /root/.cursor-agent-env/api_key)"',
	'exec cursor-agent "$@"',
	"",
].join("\n");

/**
 * Build the in-container script that persists the CURSOR_API_KEY forwarded
 * via `docker exec -e ${secretName}` and generates a small wrapper binary
 * that exports it before invoking the real CLI. A wrapper is needed (rather
 * than exporting the var directly in executeCursor's own docker exec) because
 * a running container's environment can't be amended after `docker run` —
 * unlike claude/codex, cursor-agent has no on-disk credentials file to
 * write directly, so the wrapper is what gives later dispatches access to
 * the persisted secret without re-touching BWS on every task.
 * @param {string} secretName
 * @returns {string}
 */
export function buildAuthContainerScript(secretName) {
	const wrapperB64 = Buffer.from(CURSOR_WRAPPER_SCRIPT, "utf8").toString(
		"base64",
	);
	return (
		"mkdir -p /root/.cursor-agent-env && " +
		`printf '%s' "$${secretName}" > /root/.cursor-agent-env/api_key && ` +
		"chmod 600 /root/.cursor-agent-env/api_key && " +
		`printf '%s' '${wrapperB64}' | base64 -d > /usr/local/bin/${CURSOR_AUTHED_CMD} && ` +
		`chmod 755 /usr/local/bin/${CURSOR_AUTHED_CMD}`
	);
}

// The persisted credential IS the CURSOR_API_KEY file authenticateCursor
// writes (see buildAuthContainerScript above). The generated
// `cursor-agent-authed` wrapper is only a launcher that exports this key — the
// key file is the secret, so that is what the credential check targets.
// Unlike claude/codex/agy this is a raw key string, not JSON — the presence/
// non-triviality check applies identically.
const CURSOR_CREDENTIALS_PATH = "/root/.cursor-agent-env/api_key";

// A real CURSOR_API_KEY is a long token; this floor rejects an empty file
// (the exact bug class that shipped once elsewhere — a printf writing
// nothing) and trivial stubs. It deliberately does NOT attempt server-side
// validity — a well-formed but revoked/garbage key still passes — because
// that needs a network round-trip the container can't make reliably (and
// `cursor-agent status` is explicitly not a usable signal here; see above).
// Scope: presence + substance, not liveness against the API.
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
				`[ -f ${CURSOR_CREDENTIALS_PATH} ] && [ "$(wc -c < ${CURSOR_CREDENTIALS_PATH} | tr -d '[:space:]')" -ge ${MIN_CREDENTIAL_BYTES} ]`,
			],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if Cursor Agent is authenticated in the container. `cursor-agent
 * --version` is only a binary liveness signal (and `cursor-agent status`
 * reflects OAuth session state, not CURSOR_API_KEY validity — confirmed, so
 * it is unusable here); the real signal is the credential check that
 * supplements it — the persisted API-key file must exist and be non-trivial.
 * Liveness alone treated an installed-but-unauthenticated CLI as
 * authenticated, so ensureProvidersAuthenticated() skipped its headless login
 * and the first real dispatch failed instead of `npm run auth` catching it
 * (TASKS.md Task 15).
 * @param {string} [containerName] Container to check (defaults to the standing agent container).
 * @returns {boolean}
 */
export function isCursorAuthenticated(containerName = AGENT_CONTAINER_NAME) {
	try {
		const result = execFileSync(
			"docker",
			["exec", containerName, CURSOR_CMD, "--version"],
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
 * Authenticate Cursor Agent in the container via CURSOR_API_KEY.
 *
 * The secret is never fetched host-side and never appears in any process's
 * argv (visible via `ps`/`/proc`): `bws-run` injects `secretName` as an env
 * var into the `docker exec` process it launches, and `docker exec -e NAME`
 * (bare, no `=value`) forwards that host env var into the container by
 * reference. Requires `secretName` to be the exact BWS secret key
 * (project convention: UPPERCASE_SNAKE_CASE matching the env var).
 * @param {string} [secretName] BWS secret name for the Cursor API key.
 * @returns {boolean}
 */
export function authenticateCursor(secretName = "CURSOR_API_KEY") {
	try {
		validateEnvName(secretName, "secretName");
	} catch (error) {
		console.error("Failed to authenticate Cursor:", error.message);
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
		console.error("Failed to authenticate Cursor:", error.message);
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
 * @returns {{output: string, success: boolean, error?: string}}
 */
export function executeCursor(prompt, workingContainerName, options = {}) {
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
		CURSOR_AUTHED_CMD,
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
	args.push(prompt);

	try {
		const result = execFileSync("docker", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
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
 * Capture the diff produced by Cursor Agent in the working container.
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

export { CURSOR_AUTHED_CMD, CURSOR_CMD };
