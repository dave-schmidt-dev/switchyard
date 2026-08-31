export const RUN_STARTUP_GRACE_MS = 5 * 60_000;

const TERMINAL_STATES = new Set(["succeeded", "failed"]);

function probeWorker(pid) {
	try {
		process.kill(pid, 0);
		return "live";
	} catch (error) {
		if (error?.code === "EPERM") return "live";
		if (error?.code === "ESRCH") return "dead";
		return "unknown";
	}
}

/**
 * Classify durable run liveness without mutating the run store.
 *
 * @param {object} run validated or historical run snapshot
 * @param {object} [options]
 * @param {number} [options.now] epoch milliseconds used for age checks
 * @param {(pid:number) => "live"|"dead"|"unknown"} [options.probePid]
 * @param {number} [options.startupGraceMs]
 * @returns {"terminal_clean"|"live"|"startup_grace"|"dead"|"unknown"}
 */
export function classifyRunLiveness(run, options = {}) {
	if (run === null || typeof run !== "object" || Array.isArray(run)) {
		return "unknown";
	}

	if (TERMINAL_STATES.has(run.state) && run.cleanupState === "complete") {
		return "terminal_clean";
	}

	if (run.workerPid !== null) {
		if (!Number.isInteger(run.workerPid) || run.workerPid <= 0) {
			return "unknown";
		}
		try {
			const result = (options.probePid ?? probeWorker)(run.workerPid);
			return result === "live" || result === "dead" ? result : "unknown";
		} catch {
			return "unknown";
		}
	}

	if (!Object.hasOwn(run, "workerPid")) return "unknown";
	const createdMs = new Date(run.createdAt).getTime();
	const now = options.now ?? Date.now();
	const startupGraceMs = options.startupGraceMs ?? RUN_STARTUP_GRACE_MS;
	if (
		!Number.isFinite(createdMs) ||
		!Number.isFinite(now) ||
		!Number.isFinite(startupGraceMs) ||
		startupGraceMs < 0
	) {
		return "unknown";
	}
	const ageMs = now - createdMs;
	if (ageMs < 0) return "unknown";
	return ageMs <= startupGraceMs ? "startup_grace" : "dead";
}
