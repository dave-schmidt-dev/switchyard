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
 * Check whether a Docker image is already present locally.
 * Used to make image builds idempotent — rebuilding the ~1.4GB agent image
 * on every dispatch would cost multiple minutes per run for no benefit once
 * it already exists.
 * @param {string} image Image name (e.g. "switchyard-agent:latest")
 * @returns {boolean}
 */
export function imageExists(image) {
	try {
		const output = execSync(`docker images -q ${image}`, {
			stdio: "pipe",
		})
			.toString()
			.trim();
		return output.length > 0;
	} catch {
		return false;
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
		// `--filter name=X` is a SUBSTRING match in Docker, not exact — an
		// unanchored filter would false-positive against any other container
		// whose name happens to contain AGENT_CONTAINER_NAME (e.g. a working
		// container, or in tests, a differently-named fixture). `^/X$`
		// anchors to the exact name (Docker stores names with a leading
		// slash internally), and comparing the returned Names list by exact
		// string keeps this from mismatching on a multi-line substring hit.
		const runningNames = execSync(
			`docker ps --filter "name=^/${AGENT_CONTAINER_NAME}$" --format '{{.Names}}'`,
			{ stdio: "pipe" },
		)
			.toString()
			.trim();

		if (runningNames === AGENT_CONTAINER_NAME) {
			return true;
		}

		const allNames = execSync(
			`docker ps -a --filter "name=^/${AGENT_CONTAINER_NAME}$" --format '{{.Names}}'`,
			{ stdio: "pipe" },
		)
			.toString()
			.trim();

		if (allNames === AGENT_CONTAINER_NAME) {
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

export { AGENT_CONTAINER_NAME, AGENT_IMAGE };
