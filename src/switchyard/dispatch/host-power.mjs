import { spawnSync } from "node:child_process";

const PMSET_PATH = "/usr/bin/pmset";
const PMSET_ARGS = Object.freeze(["-g", "batt"]);
const DEFAULT_TIMEOUT_MS = 1_000;
const MAX_OUTPUT_BYTES = 16 * 1024;

export const HOST_POWER_STATES = Object.freeze({
	AC: "ac",
	BATTERY: "battery",
	UNKNOWN: "unknown",
});

/**
 * Normalize the bounded output of `pmset -g batt` without retaining host text.
 * @param {unknown} output
 * @returns {"ac"|"battery"|"unknown"}
 */
export function normalizeHostPower(output) {
	const text = typeof output === "string" ? output : "";
	if (/Now drawing from ['"]?AC Power/i.test(text)) {
		return HOST_POWER_STATES.AC;
	}
	if (/Now drawing from ['"]?Battery Power/i.test(text)) {
		return HOST_POWER_STATES.BATTERY;
	}
	return HOST_POWER_STATES.UNKNOWN;
}

function defaultPmsetProbe(timeoutMs) {
	const result = spawnSync(PMSET_PATH, PMSET_ARGS, {
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: MAX_OUTPUT_BYTES,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		status: result.status,
		stdout: typeof result.stdout === "string" ? result.stdout : "",
	};
}

/**
 * Probe host power through the fixed, bounded macOS pmset command.
 * An unavailable, timed-out, malformed, or non-zero probe is unknown.
 * @param {{timeoutMs?: number, execFn?: (path: string, args: string[], options: object) => object}} [options]
 * @returns {{state: "ac"|"battery"|"unknown", diagnosticCode: string}}
 */
export function probeHostPower({
	timeoutMs = DEFAULT_TIMEOUT_MS,
	execFn = defaultPmsetProbe,
} = {}) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return {
			state: HOST_POWER_STATES.UNKNOWN,
			diagnosticCode: "host_power_unknown",
		};
	}
	try {
		const result = execFn(PMSET_PATH, PMSET_ARGS, {
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer: MAX_OUTPUT_BYTES,
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result?.status !== 0) {
			return {
				state: HOST_POWER_STATES.UNKNOWN,
				diagnosticCode: "host_power_unknown",
			};
		}
		const state = normalizeHostPower(result.stdout);
		return {
			state,
			diagnosticCode:
				state === HOST_POWER_STATES.BATTERY
					? "host_on_battery"
					: state === HOST_POWER_STATES.UNKNOWN
						? "host_power_unknown"
						: null,
		};
	} catch {
		return {
			state: HOST_POWER_STATES.UNKNOWN,
			diagnosticCode: "host_power_unknown",
		};
	}
}

/**
 * Resolve an injected power result or perform the production probe.
 * @param {{hostPowerProbe?: (() => object)|object}} [options]
 * @returns {{state: "ac"|"battery"|"unknown", diagnosticCode: string}}
 */
export function readHostPower(options = {}) {
	const value = options.hostPowerProbe;
	let result;
	try {
		result = typeof value === "function" ? value() : value;
	} catch {
		result = null;
	}
	if (result && typeof result === "object") {
		const state = Object.values(HOST_POWER_STATES).includes(result.state)
			? result.state
			: HOST_POWER_STATES.UNKNOWN;
		return {
			state,
			diagnosticCode:
				state === HOST_POWER_STATES.BATTERY
					? "host_on_battery"
					: state === HOST_POWER_STATES.UNKNOWN
						? "host_power_unknown"
						: null,
		};
	}
	return probeHostPower(options);
}

export const HOST_POWER_PROBE = Object.freeze({
	path: PMSET_PATH,
	args: PMSET_ARGS,
	timeoutMs: DEFAULT_TIMEOUT_MS,
});
