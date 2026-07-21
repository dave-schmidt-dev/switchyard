// Claude adapter - write-enabled implementer
// Executes claude CLI inside the container (never host-spawn)
// CR-4: Adapters exec inside container, never host-spawn
// PW-4: Independent in-container login

import { execFileSync } from "node:child_process";
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";
import {
	validateEnvName,
	validateIdentifier,
	validateModelArg,
} from "./shell-safety.mjs";

const CLAUDE_CMD = "claude";

/**
 * Build the in-container script that persists the Claude credentials JSON
 * forwarded via `docker exec -e ${secretName}` into a file `claude login`
 * can read. Pure/testable: exported separately from the `bws-run` wrapper so
 * a test can verify the *actual file content* ends up correct without
 * needing real BWS access — this exact bug (script reading from stdin
 * instead of referencing the forwarded env var, silently writing an empty
 * file with exit code 0) shipped once already.
 *
 * The trailing cleanup (`rm -f`) must not run as an unconditional `;`
 * continuation after the login chain — that would make `rm -f`'s own exit
 * code (almost always 0) the script's final status, masking a real `claude
 * login` failure as success. Capture the chain's exit status first, always
 * clean up, then exit with the captured status.
 * @param {string} secretName
 * @returns {string}
 */
export function buildAuthContainerScript(secretName) {
	return `printf '%s' "$${secretName}" > /tmp/claude_creds.json && chmod 600 /tmp/claude_creds.json && ${CLAUDE_CMD} login --file /tmp/claude_creds.json; login_status=$?; rm -f /tmp/claude_creds.json; exit $login_status`;
}

/**
 * Check if Claude is authenticated in the container.
 * @returns {boolean}
 */
export function isClaudeAuthenticated() {
	try {
		const result = execFileSync(
			"docker",
			["exec", AGENT_CONTAINER_NAME, CLAUDE_CMD, "--version"],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return result.includes("Claude");
	} catch {
		return false;
	}
}

/**
 * Authenticate Claude in the container.
 * PW-4: Independent in-container login (subscription, never API keys).
 *
 * The secret is never fetched host-side and never appears in any process's
 * argv (visible via `ps`/`/proc`): `bws-run` injects `secretName` as an env
 * var into the `docker exec` process it launches, and `docker exec -e NAME`
 * (bare, no `=value`) forwards that host env var into the container by
 * reference. Requires `secretName` to be the exact BWS secret key
 * (project convention: UPPERCASE_SNAKE_CASE matching the env var).
 * @param {string} [secretName] BWS secret name for the Claude credentials JSON.
 * @returns {boolean}
 */
export function authenticateClaude(secretName = "CLAUDE_CREDENTIALS") {
	try {
		validateEnvName(secretName, "secretName");
	} catch (error) {
		console.error("Failed to authenticate Claude:", error.message);
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
		console.error("Failed to authenticate Claude:", error.message);
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
 * @returns {{output: string, success: boolean, error?: string}}
 */
export function executeClaude(prompt, workingContainerName, options = {}) {
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
		CLAUDE_CMD,
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

export { CLAUDE_CMD };
