/**
 * `switchyard-dispatch doctor`: one read-only command that reports what
 * stops or will soon stop dispatch on this host.
 *
 * Usage: switchyard-dispatch doctor [--quick] [--json]
 *
 * Each check prints one status line, then one indented `fix:` line per
 * action it needs. `--quick` runs only the file-read checks (qualification
 * expiry, repair holds, stranded attempts). Exit status: 0 when no check
 * failed (warnings included), 1 when any check failed, 2 on a usage error.
 */

import { parseArgs } from "node:util";
import {
	checkBridgePins,
	checkLaunchAgents,
	checkProviderClis,
	checkQualificationExpiry,
	checkRepairHolds,
	checkSandboxToolchain,
	checkStrandedPending,
	overallStatus,
	STATUS,
} from "./checks.mjs";
import {
	readQualificationSlots,
	readRepairHolds,
	readStrandedPending,
} from "./state.mjs";

const DOCTOR_USAGE = `Usage: switchyard-dispatch doctor [--quick] [--json]

Read-only host diagnosis: sandbox toolchain, provider CLI versions, bridge
content pins, qualification expiry, repair holds, stranded pending attempts
and the canary/reaper LaunchAgents. --quick runs only the state-file checks.
Exit status: 0 no failures (warnings allowed), 1 a check failed, 2 usage.`;

const QUICK_PROBES = Object.freeze({
	qualification: () => readQualificationSlots(),
	holds: () => readRepairHolds(),
	pending: () => readStrandedPending(),
});

async function hostProbes() {
	const host = await import("./host.mjs");
	return {
		sandbox: host.probeSandboxToolchain,
		clis: host.probeProviderClis,
		bridges: host.probeBridgePins,
		agents: host.probeLaunchAgents,
	};
}

/**
 * Gather every probe concurrently and evaluate the checks.
 * @param {{quick?: boolean, probes?: object, now?: () => number}} [options]
 *   `probes` replaces any of the default probe functions by name.
 * @returns {Promise<{schemaVersion: 1, status: string, checks: object[]}>}
 */
export async function runDoctor({
	quick = false,
	probes = {},
	now = Date.now,
} = {}) {
	const all = {
		...QUICK_PROBES,
		...(quick ? {} : await hostProbes()),
		...probes,
	};
	const answer = (name) =>
		Promise.resolve()
			.then(() => all[name]())
			.catch((error) => ({
				error: String(error?.code ?? error?.message ?? error),
			}));
	const names = quick
		? ["qualification", "holds", "pending"]
		: [
				"sandbox",
				"clis",
				"bridges",
				"qualification",
				"holds",
				"pending",
				"agents",
			];
	const answers = Object.fromEntries(
		await Promise.all(names.map(async (name) => [name, await answer(name)])),
	);
	const nowMs = now();
	const checks = [];
	if (!quick) {
		checks.push(checkSandboxToolchain(answers.sandbox));
		checks.push(checkProviderClis(answers.clis?.pins, answers.clis?.probes));
		checks.push(checkBridgePins(answers.bridges));
	}
	checks.push(checkQualificationExpiry(answers.qualification, nowMs));
	checks.push(checkRepairHolds(answers.holds));
	checks.push(checkStrandedPending(answers.pending));
	if (!quick) checks.push(checkLaunchAgents(answers.agents, nowMs));
	return { schemaVersion: 1, status: overallStatus(checks), checks };
}

/** Human report: a header, one line per check, indented fix lines. */
export function formatDoctorReport(report) {
	const count = (status) =>
		report.checks.filter((check) => check.status === status).length;
	const width = Math.max(...report.checks.map((check) => check.id.length));
	const lines = [
		`switchyard doctor: ${report.status} (${report.checks.length} checks: ${count(STATUS.FAIL)} fail, ${count(STATUS.WARN)} warn)`,
	];
	for (const check of report.checks) {
		lines.push(
			`${check.status.padEnd(4)}  ${check.id.padEnd(width)}  ${check.summary}`,
		);
		for (const fix of check.fixes) lines.push(`      fix: ${fix}`);
	}
	return `${lines.join("\n")}\n`;
}

/**
 * CLI entry. Returns the exit status instead of exiting.
 * @param {string[]} argv
 * @param {{probes?: object, now?: () => number, stdout?: (s: string) => void,
 *   stderr?: (s: string) => void}} [dependencies]
 */
export async function handleDoctor(argv, dependencies = {}) {
	const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text));
	const stderr = dependencies.stderr ?? ((text) => process.stderr.write(text));
	let values;
	try {
		({ values } = parseArgs({
			args: argv,
			options: {
				quick: { type: "boolean" },
				json: { type: "boolean" },
				help: { type: "boolean" },
			},
			strict: true,
			allowPositionals: false,
		}));
	} catch (error) {
		stderr(`doctor: ${error.message}\n${DOCTOR_USAGE}\n`);
		return 2;
	}
	if (values.help) {
		stdout(`${DOCTOR_USAGE}\n`);
		return 0;
	}
	if (!values.quick)
		stderr("switchyard doctor: probing sandbox, CLIs, bridges and state...\n");
	const report = await runDoctor({
		quick: values.quick === true,
		probes: dependencies.probes,
		now: dependencies.now,
	});
	stdout(
		values.json ? `${JSON.stringify(report)}\n` : formatDoctorReport(report),
	);
	return report.status === STATUS.FAIL ? 1 : 0;
}
