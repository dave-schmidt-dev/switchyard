// Sandbox module - working container management
// INV-1: Agents have no rights to the Mac host
// INV-3: Working container is wiped at project end

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";

const WORK_DIR = "/tmp/switchyard-work";
const WORKING_PREFIX = "switchyard-work-";

/**
 * Generate a unique working container name for a project.
 * @param {string} projectPath Project path
 * @returns {string} Container name
 */
function generateWorkingContainerName(projectPath) {
	const projectName = basename(projectPath);
	return `${WORKING_PREFIX + projectName}-${randomUUID().slice(0, 8)}`;
}

/**
 * Get the working container name for a project.
 * @param {string} projectPath Project path
 * @returns {string|null} Container name or null
 */
export function getWorkingContainerName(projectPath) {
	const name = generateWorkingContainerName(projectPath);
	return name;
}

/**
 * Create a working container for a project and mount into agent container.
 * INV-1: No host FS mounts - only the working directory is mounted
 * @param {string} projectPath Host project path to copy
 * @returns {string|null} Working container name or null on failure
 */
export function createWorkingContainer(projectPath) {
	const containerName = generateWorkingContainerName(projectPath);
	const _projectName = basename(projectPath);

	try {
		// Create a temporary directory for the project copy
		const tempDir = join(WORK_DIR, containerName);
		mkdirSync(tempDir, { recursive: true });

		// Copy project files to temp directory (using host-side copy)
		// This is a simplified approach - real implementation would use rsync or similar
		const _files = readdirSync(projectPath, { recursive: true });
		// Note: Actual file copying would be implemented here

		// Create working container with project code mounted
		// INV-1: No host FS, Docker socket, or credential mounts
		execSync(
			"docker run -d --name " +
				containerName +
				" --volumes-from " +
				AGENT_CONTAINER_NAME +
				" -v " +
				tempDir +
				":/project -w /project " +
				"alpine:latest sleep infinity",
			{ stdio: "inherit" },
		);

		return containerName;
	} catch (error) {
		console.error("Failed to create working container:", error.message);
		return null;
	}
}

/**
 * Mount working container into agent container.
 * @param {string} workingContainerName Working container name
 * @returns {boolean}
 */
export function mountWorkingContainer(workingContainerName) {
	try {
		// Attach working container to agent container's network
		// This allows the agent container to access the working container
		execSync(
			"docker network connect " +
				AGENT_CONTAINER_NAME +
				" " +
				workingContainerName,
			{ stdio: "inherit" },
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Wipe working container at project end.
 * INV-3: Working container is wiped at project end
 * @param {string} workingContainerName Working container name
 * @returns {boolean}
 */
export function wipeWorkingContainer(workingContainerName) {
	try {
		// Stop and remove the working container
		execSync(`docker stop ${workingContainerName}`, { stdio: "inherit" });
		execSync(`docker rm ${workingContainerName}`, { stdio: "inherit" });

		// Clean up temp directory
		const tempDir = join(WORK_DIR, workingContainerName);
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}

		return true;
	} catch (error) {
		console.error("Failed to wipe working container:", error.message);
		return false;
	}
}

/**
 * Execute a command in the working container.
 * @param {string} workingContainerName Working container name
 * @param {string} command Command to execute
 * @returns {string} Command output
 */
export function execInWorkingContainer(workingContainerName, command) {
	const escapedCommand = command.replace(/'/g, "'\\''");
	const result = execSync(
		`docker exec ${workingContainerName} sh -c '${escapedCommand}'`,
		{ encoding: "utf8", stdio: "pipe" },
	);
	return result.trim();
}

/**
 * Check if working container exists.
 * @param {string} workingContainerName Working container name
 * @returns {boolean}
 */
export function workingContainerExists(workingContainerName) {
	try {
		const output = execSync(
			"docker ps -a --filter name=" +
				workingContainerName +
				" --format '{{.Names}}'",
			{ stdio: "pipe" },
		)
			.toString()
			.trim();
		return output === workingContainerName;
	} catch {
		return false;
	}
}
