// Claude adapter - write-enabled implementer
// Executes claude CLI inside the container (never host-spawn)
// CR-4: Adapters exec inside container, never host-spawn
// PW-4: Independent in-container login

import { execSync } from "node:child_process";
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";

const CLAUDE_CMD = "claude";

/**
 * Check if Claude is authenticated in the container.
 * @returns {boolean}
 */
export function isClaudeAuthenticated() {
	try {
		const result = execSync(
			`docker exec ${AGENT_CONTAINER_NAME} sh -c '${CLAUDE_CMD} --version'`,
			{ encoding: "utf8", stdio: "pipe" },
		);
		return result.includes("Claude");
	} catch {
		return false;
	}
}

/**
 * Authenticate Claude in the container.
 * PW-4: Independent in-container login (subscription, never API keys)
 * Uses bws-run pattern for credential injection
 * @param {string} bwsPath Bitwarden path for credentials
 * @returns {boolean}
 */
export function authenticateClaude(bwsPath) {
	try {
		// Use bws-run to inject credentials into the container
		// This runs claude login inside the container with credentials from BWS
		const escapedBwsPath = bwsPath.replace(/'/g, "'\\''");
		execSync(
			`docker exec -e CLAUDE_CREDENTIALS=$(bws-get '${escapedBwsPath}') ${AGENT_CONTAINER_NAME} sh -c '\n\t\t\techo "$CLAUDE_CREDENTIALS" > /tmp/claude_creds.json\n\t\t\t${CLAUDE_CMD} login --file /tmp/claude_creds.json\n\t\t\trm /tmp/claude_creds.json\n\t\t'`,
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
 * @param {string} prompt The task prompt
 * @param {string} workingContainerName Working container to exec in
 * @param {object} options Execution options
 * @param {string} [options.model] Model to use
 * @returns {{output: string, success: boolean, error?: string}}
 */
export function executeClaude(prompt, workingContainerName, options = {}) {
	const { model } = options;

	try {
		// Build the claude command
		let cmd = CLAUDE_CMD;
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

		// Execute claude in the working container
		// The working container has the project code mounted at /project
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
 * Capture the diff produced by Claude in the working container.
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

export { CLAUDE_CMD };
