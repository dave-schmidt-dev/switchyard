#!/usr/bin/env node

/**
 * Strict host validation gate: aggregates ordinary validate phases and
 * the host sandbox canary before push.
 *
 * Ordinary `validate` remains unchanged for confinement usability.
 * `validate:host` is the explicit pre-push gate on the Mac host.
 */

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gatePrerequisiteProblems, PYTHON_HOST_SUITE } from "./pytest-venv.mjs";
import { defaultRun, runPhases } from "./run-test-phases.mjs";
import { supervisedSpawn } from "./sandbox-canary-daily.mjs";

export const HOST_VALIDATE_PHASES = [
	"validate",
	"canary:sandbox",
	"python:host",
];
const PYTHON_HOST_TIMEOUT_MS = 240_000;
const PYTHON_HOST_MAX_BYTES = 1024 * 1024;

/** Require six real successes, with a unique complete TAP summary. */
function completedPythonHostCases(output) {
	if (typeof output !== "string" || !/^TAP version 13$/mu.test(output))
		return false;
	for (const [field, expected] of Object.entries({
		tests: 6,
		pass: 6,
		fail: 0,
		cancelled: 0,
		skipped: 0,
		todo: 0,
	})) {
		const matches = [
			...output.matchAll(new RegExp(`^# ${field} ([0-9]+)$`, "gm")),
		];
		if (matches.length !== 1 || Number(matches[0][1]) !== expected)
			return false;
	}
	return (
		/^1\.\.1$/mu.test(output) &&
		/^ {4}1\.\.6$/mu.test(output) &&
		[...output.matchAll(/^ {4}ok [0-9]+ - .+$/gmu)].length === 6 &&
		!/^\s*not ok\b/mu.test(output) &&
		!/^\s*ok[^\n]*# (?:SKIP|TODO)\b/imu.test(output)
	);
}

/** Bounded host-only subprocess with live output and process-group teardown. */
export function runPythonHostChecks({
	spawn = supervisedSpawn,
	log = console.error,
} = {}) {
	log("host validation: requiring six executed Python host cases");
	try {
		const result = spawn(
			process.execPath,
			["--test", "--test-reporter=tap", PYTHON_HOST_SUITE],
			{
				cwd: resolve(fileURLToPath(new URL("..", import.meta.url))),
				env: Object.fromEntries(
					Object.entries(process.env).filter(
						([key]) => key !== "NODE_TEST_CONTEXT",
					),
				),
				timeout: PYTHON_HOST_TIMEOUT_MS,
				maxBuffer: PYTHON_HOST_MAX_BYTES,
				forwardOutput: true,
				progressLabel: "host validation: Python host checks still running",
			},
		);
		return !result.error &&
			!result.signal &&
			result.status === 0 &&
			completedPythonHostCases(result.stdout)
			? 0
			: 1;
	} catch {
		return 1;
	}
}

export function runHostValidation({ run, log = console.log } = {}) {
	return runPhases({
		phases: HOST_VALIDATE_PHASES,
		run:
			run ??
			((phase) =>
				phase === "python:host" ? runPythonHostChecks() : defaultRun(phase)),
		log: (message) =>
			log(
				message.replace(/^Test phase summary:/, "Host validate phase summary:"),
			),
	});
}

if (
	process.argv[1] &&
	(fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
		(existsSync(process.argv[1]) &&
			import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href))
) {
	// Every host phase needs the pytest fixture, so refuse in the first
	// second rather than after a full validate run.
	const missing = gatePrerequisiteProblems([PYTHON_HOST_SUITE], {
		root: process.cwd(),
	});
	if (missing.length > 0) {
		for (const line of missing) console.error(`validate:host: ${line}`);
		process.exit(1);
	}
	const status = runHostValidation();
	process.exit(status);
}
