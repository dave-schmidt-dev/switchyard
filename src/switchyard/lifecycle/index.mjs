// Lifecycle module - working container lifecycle
// INV-3: Working container is wiped at project end
// Manages create, mount, wipe operations

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
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
	return `${WORKING_PREFIX}${projectName}-${randomUUID().slice(0, 8)}`;
}

/**
 * Create a working container for a project.
 * INV-1: No host FS mounts - uses isolated volume
 * @param {string} projectPath Host project path
 * @returns {string|null} Working container name or null on failure
 */
export function createWorkingContainer(projectPath) {
	const containerName = generateWorkingContainerName(projectPath);

	try {
		// Create a Docker volume for the project (INV-1: no host FS mount)
		execSync(`docker volume create ${containerName}-vol`, { stdio: "inherit" });

		// Create working container with isolated volume
		execSync(
			`docker run -d --name ${containerName} ` +
				`--volumes-from ${AGENT_CONTAINER_NAME} ` +
				`-v ${containerName}-vol:/project -w /project ` +
				`alpine:latest sleep infinity`,
			{ stdio: "inherit" },
		);

		return containerName;
	} catch (error) {
		console.error("Failed to create working container:", error.message);
		return null;
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

		// Remove the associated volume
		execSync(`docker volume rm ${workingContainerName}-vol`, {
			stdio: "inherit",
		});

		return true;
	} catch (error) {
		console.error("Failed to wipe working container:", error.message);
		return false;
	}
}

/**
 * Check if working container exists.
 * @param {string} workingContainerName Working container name
 * @returns {boolean}
 */
export function workingContainerExists(workingContainerName) {
	try {
		const output = execSync(
			`docker ps -a --filter name=${workingContainerName} --format '{{.Names}}'`,
			{ stdio: "pipe" },
		)
			.toString()
			.trim();
		return output === workingContainerName;
	} catch {
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

export { WORK_DIR, WORKING_PREFIX };
