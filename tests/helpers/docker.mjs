import { execFileSync } from "node:child_process";

/**
 * The single Docker reachability probe for the whole suite.
 *
 * Eight adapter test files used to carry a private copy of this, and
 * `tests/docker-required.test.mjs` now fails the gate on exactly the condition
 * those files skip on. Sharing one probe is what keeps the two from drifting:
 * a skip criterion that disagreed with the fail criterion would put the suite
 * back in the state this helper exists to prevent, where container coverage
 * silently disappears and every phase still exits 0.
 */
export const DOCKER_PROBE_COMMAND = "docker info";
const DOCKER_PROBE_ARGV = ["info"];

/**
 * Probe the Docker daemon once.
 * @returns {{available: boolean, reason: string|null}} `reason` is a bounded,
 *   single-line summary suitable for a failure message, never the probe's full
 *   output.
 */
export function probeDocker() {
	try {
		// execFileSync, not execSync: no shell, so nothing here can ever grow
		// into a shell-interpolation site if the probe gains arguments later.
		execFileSync("docker", DOCKER_PROBE_ARGV, { stdio: "pipe" });
		return { available: true, reason: null };
	} catch (error) {
		const stderr = String(error?.stderr ?? "");
		const firstLine =
			stderr
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line.length > 0) ?? String(error?.code ?? "unknown");
		return { available: false, reason: firstLine.slice(0, 200) };
	}
}

const probe = probeDocker();

/** @type {boolean} True when `docker info` succeeded at module load. */
export const dockerAvailable = probe.available;

/** @type {string|null} Why the probe failed, or null when it succeeded. */
export const dockerUnavailableReason = probe.reason;
