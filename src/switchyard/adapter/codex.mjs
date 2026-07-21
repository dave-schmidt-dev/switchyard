// Codex adapter - write-enabled implementer
// Executes codex CLI inside the container (never host-spawn)
// CR-4: Adapters exec inside container, never host-spawn
// PW-4: Independent in-container login

import { execSync } from "node:child_process";
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";

const CODEX_CMD = "codex";

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
 * PW-4: Independent in-container login
 * TODO: INV-1 - This currently copies host auth file, which violates no-host-cred mount.
 * Need BWS-based injection pattern instead.
 * @returns {boolean}
 */
export function authenticateCodex() {
	try {
		// TODO: Replace with BWS-based credential injection
		// Current implementation copies host auth file (INV-1 violation)
		execSync(
			`docker cp ~/.codex/auth.json ${AGENT_CONTAINER_NAME}:/root/.codex/auth.json`,
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

	try {
		// Build the codex command
		let cmd = CODEX_CMD;
		if (model) {
			cmd += ` --model ${model}`;
		}

		// Escape the prompt for shell execution
		const escapedPrompt = prompt
			.replace(/\\/g, "\\\\")
			.replace(/'/g, "'\\''")
			.replace(/"/g, '\\"')
			.replace(/\n/g, "\\n")
			.replace(/\$/g, "\\$");

		// Execute codex in the working container
		const result = execSync(
			`docker exec -w /project ${workingContainerName} sh -c '\n\t\t\techo "${escapedPrompt}" | ${cmd}\n\t\t'`,
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
