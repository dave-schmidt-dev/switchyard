#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	loadContractGateManifest,
	loadLedgerGateMapping,
	ownersForPaths,
	suitesForOwners,
	validateContractGateMapping,
} from "./check-contract-gates.mjs";

/** Critical production modules and their minimum native Node coverage. */
export const CRITICAL_MODULE_COVERAGE = Object.freeze([
	{
		path: "src/switchyard/outcome/schema.mjs",
		lines: 80,
		branches: 60,
		functions: 80,
	},
	{
		path: "src/switchyard/outcome/reducer.mjs",
		lines: 80,
		branches: 60,
		functions: 80,
	},
	{
		path: "src/switchyard/broker/schema.mjs",
		lines: 70,
		branches: 45,
		functions: 70,
	},
	{
		path: "src/switchyard/broker/executor.mjs",
		lines: 65,
		branches: 40,
		functions: 65,
	},
	// The runner is intentionally a large compatibility adapter; its focused
	// contract suites exercise the shared seams without claiming whole-file
	// coverage. Keep that floor explicit and let the smaller critical modules
	// carry the stronger thresholds below.
	{
		path: "src/switchyard/runner/index.mjs",
		lines: 10,
		branches: 50,
		functions: 3,
	},
	{
		path: "src/switchyard/dispatch/worker-bootstrap.mjs",
		lines: 55,
		branches: 30,
		functions: 55,
	},
	{
		path: "src/switchyard/dispatch/index.mjs",
		lines: 55,
		branches: 30,
		functions: 55,
	},
	{
		path: "src/switchyard/dispatch/run-finalization.mjs",
		lines: 65,
		branches: 40,
		functions: 65,
	},
	{
		path: "src/switchyard/run-store/index.mjs",
		lines: 60,
		branches: 35,
		functions: 60,
	},
	{
		path: "src/switchyard/diagnostics/index.mjs",
		lines: 80,
		branches: 55,
		functions: 80,
	},
	{
		path: "src/switchyard/lifecycle/mutation-protocol.mjs",
		lines: 75,
		branches: 50,
		functions: 75,
	},
	{
		path: "src/switchyard/adapter/provider-lifecycle.mjs",
		lines: 55,
		branches: 30,
		functions: 55,
	},
]);

function fail(message) {
	const error = new Error(message);
	error.code = message;
	throw error;
}

function number(value) {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Parse native Node's text coverage table into module metrics. */
export function parseCoverageReport(
	output,
	modules = CRITICAL_MODULE_COVERAGE,
) {
	const found = new Map();
	const hierarchy = [];
	for (const line of String(output).split(/\r?\n/u)) {
		const left = line.replace(/^\s*ℹ\s?/u, "").split("|")[0] ?? "";
		const name = left.trim();
		if (!name || name === "file") continue;
		const indent = left.match(/^\s*/u)?.[0].length ?? 0;
		while (hierarchy.at(-1)?.indent >= indent) hierarchy.pop();
		const file = name.match(/([A-Za-z0-9._/-]+\.mjs)$/u)?.[1];
		const metrics = line.match(
			/\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/u,
		);
		if (!file || !metrics) {
			hierarchy.push({ indent, name });
			continue;
		}
		const path = [...hierarchy.map((entry) => entry.name), file]
			.join("/")
			.replace(/^all files\//u, "");
		found.set(path, {
			lines: number(metrics[1]),
			branches: number(metrics[2]),
			functions: number(metrics[3]),
		});
	}
	return Object.fromEntries(
		modules.map(({ path }) => [path, found.get(path) ?? null]),
	);
}

/** Resolve the mapped suites for critical modules and reject missing coverage. */
export function criticalCoveragePlan(root = process.cwd()) {
	const manifest = loadContractGateManifest(root);
	const ledger = loadLedgerGateMapping(root);
	validateContractGateMapping({ manifest, ledger, root });
	const suites = suitesForOwners(
		CRITICAL_MODULE_COVERAGE.flatMap(({ path }) => {
			const owners = ownersForPaths(manifest, [path]);
			if (owners.length === 0) fail(`critical_module_unmapped:${path}`);
			return owners;
		}),
	);
	if (suites.length === 0) fail("critical_suite_set_empty");
	return { modules: CRITICAL_MODULE_COVERAGE, suites };
}

export function coverageFailures(metrics, modules = CRITICAL_MODULE_COVERAGE) {
	return modules.flatMap((module) => {
		const actual = metrics[module.path];
		if (!actual) return [`coverage_missing:${module.path}`];
		return ["lines", "branches", "functions"].flatMap((kind) =>
			actual[kind] < module[kind]
				? [
						`coverage_below_threshold:${module.path}:${kind}:${actual[kind]}<${module[kind]}`,
					]
				: [],
		);
	});
}

export function runContractCoverage({
	root = process.cwd(),
	run = spawnSync,
} = {}) {
	const plan = criticalCoveragePlan(root);
	const global = ["lines", "branches", "functions"].map((kind) =>
		Math.min(...plan.modules.map((module) => module[kind])),
	);
	const args = [
		"--experimental-test-coverage",
		"--test-coverage-include-all",
		`--test-coverage-lines=${global[0]}`,
		`--test-coverage-branches=${global[1]}`,
		`--test-coverage-functions=${global[2]}`,
		...plan.modules.map(({ path }) => `--test-coverage-include=${path}`),
		"--test",
		...plan.suites,
	];
	const result = run(process.execPath, args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env },
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	process.stdout.write(result.stdout ?? "");
	process.stderr.write(result.stderr ?? "");
	const metrics = parseCoverageReport(output, plan.modules);
	const failures = coverageFailures(metrics, plan.modules);
	if (result.error || result.status !== 0)
		failures.unshift("coverage_test_process_failed");
	if (failures.length) fail(failures.join(","));
	for (const module of plan.modules) {
		const metric = metrics[module.path];
		console.log(
			`coverage: ${module.path} lines=${metric.lines}% branches=${metric.branches}% functions=${metric.functions}% (thresholds ${module.lines}/${module.branches}/${module.functions})`,
		);
	}
	return { status: 0, metrics, suites: plan.suites };
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
	try {
		runContractCoverage();
	} catch (error) {
		console.error(`contract coverage: ${error.code ?? error.message}`);
		process.exitCode = 1;
	}
}
