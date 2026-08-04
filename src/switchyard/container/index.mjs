// Container module - agent container lifecycle
// Manages standing agent container with provider CLIs
// INV-1: Container has no host FS / Docker socket / host cred mounts

import { execFileSync, execSync } from "node:child_process";
import { arch as getHostArch } from "node:os";

const AGENT_CONTAINER_NAME = "switchyard-agent";
const AGENT_IMAGE = "switchyard-agent:latest";

// Docker's architecture naming differs from Node's `os.arch()` naming for
// the same CPU family (Docker: "amd64", Node: "x64") — comparing the two
// raw strings would report a mismatch on every ordinary amd64 host running
// an amd64 image. This map normalizes Node's naming to Docker's before any
// comparison happens.
const NODE_ARCH_TO_DOCKER_ARCH = {
	x64: "amd64",
	arm64: "arm64",
};

/**
 * Result of container runtime preflight check.
 * @typedef {Object} ContainerRuntimeStatus
 * @property {boolean} available - Whether a container runtime daemon is reachable
 * @property {"binary-missing" | "daemon-unreachable" | "other-exec-error" | null} classification -
 *   Failure mode classification if not available
 * @property {Error | null} error - Raw execution error if probe failed
 */

/**
 * Perform an authoritative container runtime availability check.
 * Probes `docker info` (or `orb info`) with an explicit 5000ms timeout.
 * Distinguishes binary-missing, daemon-unreachable, and other-exec-error.
 *
 * @param {object | function} [options]
 * @param {(command: string, args: string[], options: object) => Buffer | string} [options.execFn]
 *   Defaults to `execFileSync`
 * @returns {ContainerRuntimeStatus}
 */
export function checkContainerRuntime(options = {}) {
	const opts = typeof options === "function" ? { execFn: options } : options;
	const { execFn = execFileSync } = opts;

	const isEnoent = (err) =>
		Boolean(
			err &&
				(err.code === "ENOENT" ||
					(typeof err.message === "string" && err.message.includes("ENOENT")) ||
					(typeof err.message === "string" &&
						err.message.toLowerCase().includes("not found"))),
		);

	// Primary probe: `docker info` with explicit 5000ms timeout
	try {
		execFn("docker", ["info"], { timeout: 5000, stdio: "pipe" });
		return { available: true, classification: null, error: null };
	} catch (dockerInfoError) {
		// Probe whether docker CLI binary exists
		let dockerBinaryExists = false;
		let dockerVersionError = null;
		try {
			execFn("docker", ["--version"], { timeout: 5000, stdio: "pipe" });
			dockerBinaryExists = true;
		} catch (vErr) {
			dockerVersionError = vErr;
		}

		if (dockerBinaryExists) {
			// Binary is present, but docker info failed -> daemon unreachable
			return {
				available: false,
				classification: "daemon-unreachable",
				error: dockerInfoError,
			};
		}

		// Fallback probe for OrbStack runtime
		try {
			execFn("orb", ["info"], { timeout: 5000, stdio: "pipe" });
			return { available: true, classification: null, error: null };
		} catch (orbInfoError) {
			let orbBinaryExists = false;
			let orbVersionError = null;
			try {
				execFn("orb", ["--version"], { timeout: 5000, stdio: "pipe" });
				orbBinaryExists = true;
			} catch (vErr) {
				orbVersionError = vErr;
			}

			if (orbBinaryExists) {
				return {
					available: false,
					classification: "daemon-unreachable",
					error: orbInfoError,
				};
			}

			// Neither binary is present or executable.
			const dockerEnoent = isEnoent(dockerVersionError ?? dockerInfoError);
			const orbEnoent = isEnoent(orbVersionError ?? orbInfoError);

			if (dockerEnoent && orbEnoent) {
				return {
					available: false,
					classification: "binary-missing",
					error: dockerInfoError,
				};
			}

			// If timeout or signal or daemon error occurred on docker info
			if (
				dockerInfoError?.code === "ETIMEDOUT" ||
				dockerInfoError?.signal === "SIGTERM"
			) {
				return {
					available: false,
					classification: "daemon-unreachable",
					error: dockerInfoError,
				};
			}

			return {
				available: false,
				classification: "other-exec-error",
				error: dockerInfoError,
			};
		}
	}
}

/**
 * Check if Docker/OrbStack is available.
 * @param {object | function} [options]
 * @param {(command: string, args: string[], options: object) => Buffer | string} [options.execFn]
 * @returns {boolean}
 */
export function isContainerRuntimeAvailable(options = {}) {
	return checkContainerRuntime(options).available;
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

/**
 * Compare the host's CPU architecture against a Docker image's actual
 * architecture and report whether they mismatch. Exists because
 * docker/Dockerfile:13-18 deliberately pins the agent image to
 * `linux/amd64` regardless of build host — on an arm64 host (e.g. Apple
 * Silicon) that produces an unexplained Docker stderr warning today, with
 * nothing surfacing *why* the mismatch is intentional.
 *
 * Naming caveat: Docker and Node name the same CPU family differently
 * ("amd64" vs "x64") — `hostArch` is normalized via
 * `NODE_ARCH_TO_DOCKER_ARCH` before comparison so an ordinary amd64 host
 * running an amd64 image is never reported as a mismatch.
 *
 * Rosetta caveat: `hostArch` defaults to Node's own `os.arch()`, which
 * reports the architecture the *Node process* was compiled for — not
 * necessarily the physical host's. Under Rosetta 2 translation on Apple
 * Silicon, an x64-compiled Node binary reports `os.arch() === 'x64'` even
 * though the underlying silicon is arm64. This field can only describe
 * what Node/Docker report, not verified ground truth about the physical
 * host.
 *
 * Degrades gracefully: if the `docker image inspect` probe fails (Docker
 * unavailable, image not built yet, etc.), returns a no-mismatch result
 * with `imageArch: null` instead of throwing — this is a diagnostic
 * nicety and must never crash or block a caller.
 *
 * @param {string} [image] Image to inspect (defaults to AGENT_IMAGE)
 * @param {object} [deps] Injectable dependencies (tests only)
 * @param {(command: string, args: string[], options: object) => Buffer | string} [deps.execFn]
 *   Defaults to the real `execFileSync`
 * @param {string} [deps.hostArch] Defaults to the real `os.arch()`
 * @returns {{mismatch: boolean, hostArch: string, imageArch: (string|null), note: (string|null)}}
 *   `hostArch` is Docker-normalized. `note` is populated only when
 *   `mismatch` is true, with an actionable explanation drawn from
 *   docker/Dockerfile's documented pinning rationale.
 */
export function getPlatformInfo(
	image = AGENT_IMAGE,
	{ execFn = execFileSync, hostArch: rawHostArch = getHostArch() } = {},
) {
	const normalizedHostArch =
		NODE_ARCH_TO_DOCKER_ARCH[rawHostArch] ?? rawHostArch;

	let imageArch;
	try {
		// Explicit timeout (matches probeProviderProcess's precedent in
		// dispatch/index.mjs): this is now called unconditionally on every
		// `switchyard status`/`switchyard result` read (dispatch/index.mjs's
		// envelope builders), not just from its own isolated unit tests, so an
		// unresponsive Docker daemon must not be able to hang a status read
		// indefinitely.
		imageArch = execFn(
			"docker",
			["image", "inspect", image, "--format", "{{.Architecture}}"],
			{ timeout: 5000 },
		)
			.toString()
			.trim();
	} catch {
		return {
			mismatch: false,
			hostArch: normalizedHostArch,
			imageArch: null,
			note: null,
		};
	}

	const mismatch = imageArch.length > 0 && imageArch !== normalizedHostArch;

	return {
		mismatch,
		hostArch: normalizedHostArch,
		imageArch,
		note: mismatch
			? `This image is intentionally pinned to linux/amd64 regardless of host architecture: provider CLI Linux support is most mature on amd64, and cursor-agent has documented ARM64 dynamic-linker issues on some distros (missing/mismatched libc6:arm64 / libgcc-s1:arm64). OrbStack and Docker Desktop both run amd64 images transparently on Apple Silicon (Rosetta/QEMU), so this costs emulation overhead, not correctness. See docker/Dockerfile:13-18.`
			: null,
	};
}

export { AGENT_CONTAINER_NAME, AGENT_IMAGE };
