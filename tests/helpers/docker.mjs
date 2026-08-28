import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * The single Docker reachability probe for the whole suite, with auto-start.
 *
 * Eight adapter test files used to carry a private copy of the probe, and
 * `tests/docker-required.test.mjs` fails the gate on exactly the condition
 * those files skip on. Sharing one probe is what keeps the two from drifting:
 * a skip criterion that disagreed with the fail criterion would put the suite
 * back in the state this helper exists to prevent, where container coverage
 * silently disappears and every phase still exits 0.
 *
 * Docker is not a production dependency -- Parallels is the sole execution
 * backend and the Docker lane was removed 2026-08-19. It is a test harness:
 * these files run each adapter against a genuine out-of-process container,
 * standing in for the Parallels guest, which is the only way that execution
 * path is covered at all. That is why a stopped daemon must not be shrugged
 * off, and why starting one is fair game -- it is the same class of action as
 * creating a temp directory in a fixture, not a change to what is under test.
 * Failing to start it still fails loudly through the sentinel.
 */
export const DOCKER_PROBE_COMMAND = "docker info";
const DOCKER_PROBE_ARGV = ["info"];

/** Runtime apps that provide a Docker daemon, in preference order. */
const DOCKER_APPS = ["OrbStack", "Docker"];

/** How long to wait for a just-launched daemon to accept connections. */
const START_TIMEOUT_MS = 90_000;
const START_POLL_MS = 1_000;
const PROGRESS_EVERY_MS = 5_000;

/**
 * INV-1: a wait this long must not be silent. Test helpers have no status
 * channel, so stderr is the surface -- never stdout, which belongs to the TAP
 * stream the test runner parses.
 * @param {string} message
 */
function progress(message) {
	process.stderr.write(`docker: ${message}\n`);
}

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Probe the Docker daemon once, without trying to start anything.
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

function findDockerApp() {
	return (
		DOCKER_APPS.find((name) => existsSync(`/Applications/${name}.app`)) ?? null
	);
}

/**
 * Launch the installed Docker runtime and wait for its daemon.
 *
 * Concurrency is safe by construction: the parallel test phase runs many files
 * at once, every one of them calls this, and `open -ga` is idempotent -- extra
 * callers just activate an app that is already starting and then wait with the
 * rest.
 * @returns {{available: boolean, reason: string|null}}
 */
function startDocker() {
	if (process.env.SWITCHYARD_DOCKER_AUTOSTART === "0") {
		return { available: false, reason: "auto-start disabled by environment" };
	}
	if (process.platform !== "darwin") {
		return {
			available: false,
			reason: `auto-start is implemented for macOS only, not ${process.platform}`,
		};
	}
	const app = findDockerApp();
	if (!app) {
		return {
			available: false,
			reason: `no Docker runtime found in /Applications (looked for ${DOCKER_APPS.join(", ")})`,
		};
	}

	progress(`daemon unreachable, starting ${app}`);
	try {
		execFileSync("open", ["-ga", app], { stdio: "pipe" });
	} catch (error) {
		return {
			available: false,
			reason: `open -ga ${app} failed: ${String(error?.code ?? error?.message ?? "unknown").slice(0, 120)}`,
		};
	}

	const startedAt = Date.now();
	let lastProgressAt = startedAt;
	for (;;) {
		const probe = probeDocker();
		if (probe.available) {
			const elapsed = Math.round((Date.now() - startedAt) / 1000);
			progress(`${app} ready after ${elapsed}s`);
			return probe;
		}
		const elapsedMs = Date.now() - startedAt;
		if (elapsedMs >= START_TIMEOUT_MS) {
			return {
				available: false,
				reason: `${app} did not accept connections within ${START_TIMEOUT_MS}ms (last error: ${probe.reason})`,
			};
		}
		if (Date.now() - lastProgressAt >= PROGRESS_EVERY_MS) {
			lastProgressAt = Date.now();
			progress(`waiting for ${app} (${Math.round(elapsedMs / 1000)}s)`);
		}
		sleepSync(Math.min(START_POLL_MS, START_TIMEOUT_MS - elapsedMs));
	}
}

const firstProbe = probeDocker();
const probe = firstProbe.available ? firstProbe : startDocker();

/** @type {boolean} True when the Docker daemon is reachable. */
export const dockerAvailable = probe.available;

/** @type {string|null} Why it is not, or null when it is. */
export const dockerUnavailableReason = probe.reason;
