// Container module - agent container lifecycle
// Manages standing agent container with provider CLIs
// INV-1: Container has no host FS / Docker socket / host cred mounts

import { execSync } from "node:child_process";

const AGENT_CONTAINER_NAME = "switchyard-agent";
const AGENT_IMAGE = "switchyard-agent:latest";

/**
 * Check if Docker/OrbStack is available.
 * @returns {boolean}
 */
export function isContainerRuntimeAvailable() {
	try {
		execSync("docker --version", { stdio: "pipe" });
		return true;
	} catch {
		try {
			execSync("orb --version", { stdio: "pipe" });
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * Build the agent container image with provider CLIs installed.
 * INV-1: No host mounts that grant host access
 * @returns {boolean} true if successful
 */
export function buildAgentImage() {
	try {
		execSync(`docker build -t ${AGENT_IMAGE} -f docker/Dockerfile docker`, {
			stdio: "inherit",
			cwd: process.cwd(),
		});
		return true;
	} catch (error) {
		console.error("Failed to build agent image:", error.message);
		return false;
	}
}

/**
 * Create or start the standing agent container.
 * INV-1: No host FS, Docker socket, or credential mounts
 * @returns {boolean} true if container is running
 */
export function startAgentContainer() {
	try {
		const running = execSync(
			"docker ps --filter name=" +
				AGENT_CONTAINER_NAME +
				" --format '{{.Status}}'",
			{ stdio: "pipe" },
		)
			.toString()
			.includes("Up");

		if (running) {
			return true;
		}

		const exists = execSync(
			"docker ps -a --filter name=" +
				AGENT_CONTAINER_NAME +
				" --format '{{.Names}}'",
			{ stdio: "pipe" },
		)
			.toString()
			.includes(AGENT_CONTAINER_NAME);

		if (exists) {
			execSync(`docker start ${AGENT_CONTAINER_NAME}`, { stdio: "inherit" });
			return true;
		}

		execSync(
			"docker run -d --name " +
				AGENT_CONTAINER_NAME +
				" --restart unless-stopped " +
				AGENT_IMAGE +
				" sleep infinity",
			{ stdio: "inherit" },
		);
		return true;
	} catch (error) {
		console.error("Failed to start agent container:", error.message);
		return false;
	}
}

/**
 * Stop the agent container.
 * @returns {boolean}
 */
export function stopAgentContainer() {
	try {
		execSync(`docker stop ${AGENT_CONTAINER_NAME}`, { stdio: "inherit" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if agent container is running.
 * @returns {boolean}
 */
export function isAgentContainerRunning() {
	try {
		const output = execSync(
			"docker ps --filter name=" +
				AGENT_CONTAINER_NAME +
				" --format '{{.Names}}'",
			{ stdio: "pipe" },
		)
			.toString()
			.trim();
		return output === AGENT_CONTAINER_NAME;
	} catch {
		return false;
	}
}

/**
 * Execute a command inside the agent container.
 * @param {string} command Command to execute
 * @returns {string} Command output
 */
export function execInAgentContainer(command) {
	const escapedCommand = command.replace(/'/g, "'\\''");
	const result = execSync(
		`docker exec ${AGENT_CONTAINER_NAME} sh -c '${escapedCommand}'`,
		{ encoding: "utf8", stdio: "pipe" },
	);
	return result.trim();
}

export { AGENT_CONTAINER_NAME, AGENT_IMAGE };
