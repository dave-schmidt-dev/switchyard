#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_PHASES = ["test:serial", "test:other"];

export function defaultRun(phase) {
	const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(npmCmd, ["run", phase], {
		stdio: "inherit",
		env: process.env,
	});
	if (result.error) {
		throw result.error;
	}
	return result.status ?? 1;
}

export function runPhases({
	phases = DEFAULT_PHASES,
	run = defaultRun,
	log = console.log,
} = {}) {
	const results = [];
	for (const phase of phases) {
		const res = run(phase);
		const status =
			typeof res === "number" ? res : (res?.status ?? (res ? 0 : 1));
		results.push({ phase, status });
	}

	const summary = `Test phase summary: ${results.map((r) => `${r.phase} (exit ${r.status})`).join(", ")}`;
	log(summary);

	const firstNonZero = results.find((r) => r.status !== 0);
	return firstNonZero ? firstNonZero.status : 0;
}

if (
	process.argv[1] &&
	(fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
		(existsSync(process.argv[1]) &&
			import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href))
) {
	const status = runPhases();
	process.exit(status);
}
