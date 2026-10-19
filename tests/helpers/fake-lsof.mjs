/**
 * Stand-ins for `/usr/sbin/lsof` that reproduce the 2026-10-18 host, where
 * reverse-resolving socket names stretched a 0.2 s host-wide scan to 30.5 s.
 * Tests inject these; none of them runs the real lsof.
 *
 * Run as a script, this file is the fake binary behind `fakeSpawnLsof`.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Measured host-wide scan time without `-n` on 2026-10-18. */
export const NAME_RESOLUTION_STALL_MS = 30_500;
/** Measured host-wide scan time with `-n` on 2026-10-18. */
const RESOLVED_SCAN_MS = 210;
const FAKE_LSOF_SCRIPT = realpathSync(fileURLToPath(import.meta.url));

/**
 * True unless a short-option cluster sets `-n`. Letters after `F` are a field
 * list, so `-Fn` (the name field) does not count.
 * @param {string[]} args
 * @returns {boolean}
 */
export function lsofResolvesNames(args) {
	return !args.some(
		(arg) =>
			/^-[A-Za-z]+$/u.test(arg) && arg.slice(1).split("F")[0].includes("n"),
	);
}

/**
 * A `spawnSync`-shaped lsof on a virtual clock: the listing takes the stall
 * time when names resolve, and a `timeout` below the run time is a kill.
 * @param {string} stdout
 * @param {Array<{command: string, args: string[], options: object}>} [calls]
 */
export function fakeSpawnSyncLsof(stdout, calls = []) {
	return (command, args, options = {}) => {
		calls.push({ command, args, options });
		const runMs = lsofResolvesNames(args)
			? NAME_RESOLUTION_STALL_MS
			: RESOLVED_SCAN_MS;
		if (options.timeout > 0 && runMs > options.timeout) {
			const error = new Error(`spawnSync ${command} ETIMEDOUT`);
			error.code = "ETIMEDOUT";
			return {
				error,
				status: null,
				signal: options.killSignal ?? "SIGTERM",
				stdout: "",
				stderr: "",
			};
		}
		return { status: 0, signal: null, stdout, stderr: "" };
	};
}

/**
 * A `spawn`-shaped launcher that runs this file as lsof in a real child: it
 * prints `stdout` at once with `-n`, and otherwise stalls until killed, as
 * name resolution did. `stallAlways` stalls regardless of arguments. Other
 * commands go to the real `spawn`.
 * @param {{stdout?: string, stallAlways?: boolean, calls?: object[]}} [fake]
 */
export function fakeSpawnLsof({
	stdout = "",
	stallAlways = false,
	calls = [],
} = {}) {
	return (command, args, options = {}) => {
		if (command !== "/usr/sbin/lsof") return spawn(command, args, options);
		calls.push({ command, args });
		return spawn(process.execPath, [FAKE_LSOF_SCRIPT, ...args], {
			...options,
			env: {
				...(options.env ?? process.env),
				FAKE_LSOF_STDOUT: stdout,
				FAKE_LSOF_STALL: stallAlways ? "always" : "",
			},
		});
	};
}

if (process.argv[1] && realpathSync(process.argv[1]) === FAKE_LSOF_SCRIPT) {
	const args = process.argv.slice(2);
	if (process.env.FAKE_LSOF_STALL === "always" || lsofResolvesNames(args)) {
		// Hold like a reverse lookup until the caller's bound kills this child,
		// and exit on its own if no bound ever does.
		setTimeout(() => process.exit(3), 2 * NAME_RESOLUTION_STALL_MS);
	} else {
		process.stdout.write(process.env.FAKE_LSOF_STDOUT ?? "");
	}
}
