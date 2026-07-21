// Codex adapter - write-enabled implementer
// Executes codex CLI inside the container (never host-spawn)
// CR-4: Adapters exec inside container, never host-spawn
// PW-4: Independent in-container login

import { execSync } from "node:child_process";
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";

const CODEX_CMD = "codex";

// Safe identifier pattern: Docker container names and model names.
// Allows alphanumeric, hyphen, underscore, dot, colon, forward-slash.
// Rejects spaces and shell metacharacters before any shell interpolation.
const SAFE_IDENTIFIER_RE = /^[\w./:@-]+$/;

/**
 * Validate that a string is a safe identifier for shell interpolation.
 * Throws on invalid input — fail closed so no malformed value reaches a shell.
 * @param {string} value
 * @param {string} label Human-readable name for error messages.
 */
function validateIdentifier(value, label) {
	if (!value || typeof value !== "string") {
		throw new Error(`${label} must be a non-empty string`);
	}
	if (!SAFE_IDENTIFIER_RE.test(value)) {
		throw new Error(
			`${label} contains unsafe characters: ${JSON.stringify(value)}`,
		);
	}
}

/**
 * Check if Codex is authenticated in the container.
 * @returns {boolean}
 */
export function isCodexAuthenticated() {
	try {
		const result = execSync(
			`docker exec ${AGENT_CONTAINER_NAME} sh -c '${CODEX_CMD} --version'`,
			{ encoding: "utf8", stdio: "pipe" },
		);
		return result.includes("codex");
	} catch {
		return false;
	}
}

/**
 * Authenticate Codex in the container.
 * PW-4: Independent in-container login via BWS-provided auth payload.
 * NOTE: bws-get is called host-side and the secret is passed via -e flag.
 * The secret appears in the docker exec command-line args (visible in ps)
 * while the command runs — acceptable for an attended auth operation but
 * not suitable for unattended automation. TODO: refactor to pass via stdin.
 * @param {string} bwsPath Bitwarden path for Codex auth payload JSON.
 * @returns {boolean}
 */
export function authenticateCodex(bwsPath) {
	if (!bwsPath || typeof bwsPath !== "string") {
		console.error("Failed to authenticate Codex: missing bwsPath");
		return false;
	}

	try {
		const escapedBwsPath = bwsPath.replace(/'/g, "'\\''");
		execSync(
			`docker exec -e CODEX_AUTH_JSON=$(bws-get '${escapedBwsPath}') ${AGENT_CONTAINER_NAME} sh -c '
			mkdir -p /root/.codex
			printf "%s" "$CODEX_AUTH_JSON" > /root/.codex/auth.json
			chmod 600 /root/.codex/auth.json
		'`,
			{ stdio: "inherit" },
		);
		return true;
	} catch (error) {
		console.error("Failed to authenticate Codex:", error.message);
		return false;
	}
}

/**
 * Execute a task with Codex in the container.
 * @param {string} prompt The task prompt
 * @param {string} workingContainerName Working container to exec in
 * @param {object} options Execution options
 * @param {string} [options.model] Model to use
 * @returns {{output: string, success: boolean, error?: string}}
 */
export function executeCodex(prompt, workingContainerName, options = {}) {
	const { model } = options;

	// Validate identifiers at the adapter boundary before any shell interpolation.
	// Fail closed: a malformed container name or model name is rejected here
	// rather than passed to the shell where it could be exploited.
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}

	let cmd = CODEX_CMD;
	if (model) {
		try {
			validateIdentifier(model, "model");
		} catch (error) {
			return { output: "", success: false, error: error.message };
		}
		cmd += ` --model ${model}`;
	}

	try {
		// Escape the prompt for insertion into a double-quoted echo argument
		// inside a single-quoted sh -c block. The outer single-quotes are the
		// actual shell boundary; the inner double-quotes are literal to sh -c.
		// NOTE: \n in the prompt is replaced with a space — echo does not
		// interpret \n portably and the single-quoted outer block prevents
		// using $'...' syntax. Multi-line prompts are flattened. TODO: pass
		// prompts via a temp file to preserve newlines correctly.
		const escapedPrompt = prompt
			.replace(/\\/g, "\\\\")
			.replace(/"/g, '\\"')
			.replace(/\n/g, " ")
			.replace(/\$/g, "\\$");

		// Execute codex in the working container
		const result = execSync(
			`docker exec -w /project ${workingContainerName} sh -c '
			echo "${escapedPrompt}" | ${cmd}
		'`,
			{ encoding: "utf8", stdio: "pipe", timeout: 300000 },
		);

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
		const diff = execSync(
			`docker exec -w /project ${workingContainerName} git diff`,
			{ encoding: "utf8", stdio: "pipe" },
		);
		return diff.trim() || null;
	} catch {
		return null;
	}
}

export { CODEX_CMD };
