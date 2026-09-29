#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
		members: [
			"src/switchyard/runner/constants.mjs",
			"src/switchyard/runner/checkpoint-errors.mjs",
			"src/switchyard/runner/task-fields.mjs",
			"src/switchyard/runner/task-queue.mjs",
			"src/switchyard/runner/ledger-reporting.mjs",
			"src/switchyard/runner/review-results.mjs",
			"src/switchyard/runner/quick-checks.mjs",
			"src/switchyard/runner/checkpoint-store.mjs",
			"src/switchyard/runner/checkpoint-load.mjs",
			"src/switchyard/runner/reconciliation-intent.mjs",
			"src/switchyard/runner/reconciliation-validate.mjs",
			"src/switchyard/runner/external-completion.mjs",
			"src/switchyard/runner/artifacts.mjs",
			"src/switchyard/runner/queue-selection.mjs",
			"src/switchyard/runner/caller-inputs.mjs",
			"src/switchyard/runner/task-routing.mjs",
			"src/switchyard/runner/route-health.mjs",
			"src/switchyard/runner/task-base.mjs",
			"src/switchyard/runner/retry-transitions.mjs",
			"src/switchyard/runner/halts.mjs",
			"src/switchyard/runner/broker.mjs",
			"src/switchyard/runner/outcome-writer.mjs",
			"src/switchyard/runner/execute-task-unsafe.mjs",
			"src/switchyard/runner/execute-task-unsafe-prepare.mjs",
			"src/switchyard/runner/execute-task-unsafe-failure.mjs",
			"src/switchyard/runner/execute-task-unsafe-success.mjs",
			"src/switchyard/runner/execute-task-async-unsafe.mjs",
			"src/switchyard/runner/execute-task-async-unsafe-prepare.mjs",
			"src/switchyard/runner/execute-task-async-unsafe-failure.mjs",
			"src/switchyard/runner/execute-task-async-unsafe-success.mjs",
			"src/switchyard/runner/execute-task.mjs",
			"src/switchyard/runner/execute-orchestrator-unsafe.mjs",
			"src/switchyard/runner/queue-preflight.mjs",
			"src/switchyard/runner/queue-backend.mjs",
			"src/switchyard/runner/queue-launch.mjs",
			"src/switchyard/runner/run-queue-async-impl.mjs",
			"src/switchyard/runner/run-queue-async-loop.mjs",
			"src/switchyard/runner/run-queue-async-terminal.mjs",
			"src/switchyard/runner/run-queue-impl.mjs",
			"src/switchyard/runner/run-queue-task-attempt.mjs",
			"src/switchyard/runner/run-queue-task-settlement.mjs",
			"src/switchyard/runner/run-queue-terminal.mjs",
			"src/switchyard/runner/run-queue-orchestrator-impl.mjs",
			"src/switchyard/runner/run-queue-orchestrator-core.mjs",
		],
		lines: 10,
		branches: 50,
		functions: 3,
	},
	{
		path: "src/switchyard/dispatch/worker-bootstrap.mjs",
		members: [
			"src/switchyard/dispatch/worker-bootstrap-support.mjs",
			"src/switchyard/dispatch/worker-bootstrap-state.mjs",
		],
		lines: 55,
		branches: 30,
		functions: 55,
	},
	{
		path: "src/switchyard/dispatch/index.mjs",
		members: [
			"src/switchyard/dispatch/cli-usage.mjs",
			"src/switchyard/dispatch/cli-args.mjs",
			"src/switchyard/dispatch/cli-handlers.mjs",
			"src/switchyard/dispatch/run-dispatch.mjs",
			"src/switchyard/dispatch/launch-support.mjs",
			"src/switchyard/dispatch/launch.mjs",
			"src/switchyard/dispatch/status-envelope.mjs",
			"src/switchyard/dispatch/result.mjs",
			"src/switchyard/dispatch/recover-liveness.mjs",
			"src/switchyard/dispatch/recover-reclaim.mjs",
			"src/switchyard/dispatch/recover.mjs",
			"src/switchyard/dispatch/gc-roots.mjs",
			"src/switchyard/dispatch/gc.mjs",
		],
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
		members: [
			"src/switchyard/run-store/errors.mjs",
			"src/switchyard/run-store/constants.mjs",
			"src/switchyard/run-store/receipt-validation.mjs",
			"src/switchyard/run-store/validate-run.mjs",
			"src/switchyard/run-store/run-records.mjs",
			"src/switchyard/run-store/vm-slots.mjs",
			"src/switchyard/run-store/project-lock-files.mjs",
			"src/switchyard/run-store/run-updates.mjs",
			"src/switchyard/run-store/events.mjs",
			"src/switchyard/run-store/project-locks.mjs",
			"src/switchyard/run-store/project-lock-claims.mjs",
			"src/switchyard/run-store/run-locks.mjs",
			"src/switchyard/run-store/evidence.mjs",
			"src/switchyard/run-store/outcomes.mjs",
			"src/switchyard/run-store/checkpoint-artifacts.mjs",
			"src/switchyard/run-store/checkpoint-retention.mjs",
			"src/switchyard/run-store/retention.mjs",
		],
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
		members: [
			"src/switchyard/adapter/provider-lifecycle-progress.mjs",
			"src/switchyard/adapter/provider-lifecycle-completion.mjs",
			"src/switchyard/adapter/provider-lifecycle-process.mjs",
			"src/switchyard/adapter/provider-lifecycle-invocation.mjs",
			"src/switchyard/adapter/provider-lifecycle-diff-capture.mjs",
		],
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

function coveragePath(path, root) {
	const absolute = isAbsolute(path) ? path : resolve(root, path);
	return relative(root, absolute).split(sep).join("/");
}

function percentage(hit, found) {
	return found === 0 ? 100 : (hit / found) * 100;
}

/** Parse native Node's lcov output and aggregate each façade with its members. */
export function parseLcovCoverageReport(
	output,
	modules = CRITICAL_MODULE_COVERAGE,
	root = process.cwd(),
) {
	const records = new Map();
	let record = null;
	const finishRecord = () => {
		if (!record?.source) return;
		const path = coveragePath(record.source, root);
		const totals = record.totals;
		if (Object.values(totals).some((value) => value === null)) {
			records.set(path, null);
			return;
		}
		// Node emits repeated SF records across test workers. The text reporter
		// exposes the final row per path, so retain the same last-row semantics.
		records.set(path, totals);
	};
	for (const line of String(output).split(/\r?\n/u)) {
		if (line.startsWith("SF:")) {
			finishRecord();
			record = {
				source: line.slice(3).trim(),
				totals: {
					LF: null,
					LH: null,
					BRF: null,
					BRH: null,
					FNF: null,
					FNH: null,
				},
			};
			continue;
		}
		if (line === "end_of_record") {
			finishRecord();
			record = null;
			continue;
		}
		const match = line.match(/^(LF|LH|BRF|BRH|FNF|FNH):(\d+)$/u);
		if (record && match) record.totals[match[1]] = Number(match[2]);
	}
	finishRecord();

	return Object.fromEntries(
		modules.map((module) => {
			const paths = [...new Set([module.path, ...(module.members ?? [])])];
			const memberRecords = paths.map((path) =>
				records.get(coveragePath(path, root)),
			);
			if (memberRecords.some((entry) => !entry)) return [module.path, null];
			const totals = memberRecords.reduce(
				(sum, entry) => {
					for (const key of Object.keys(sum)) sum[key] += entry[key];
					return sum;
				},
				{ LF: 0, LH: 0, BRF: 0, BRH: 0, FNF: 0, FNH: 0 },
			);
			return [
				module.path,
				{
					lines: percentage(totals.LH, totals.LF),
					branches: percentage(totals.BRH, totals.BRF),
					functions: percentage(totals.FNH, totals.FNF),
				},
			];
		}),
	);
}

/** Resolve the mapped suites for critical modules and reject missing coverage. */
export function criticalCoveragePlan(root = process.cwd()) {
	const manifest = loadContractGateManifest(root);
	const ledger = loadLedgerGateMapping(root);
	validateContractGateMapping({ manifest, ledger, root });
	const suites = suitesForOwners(
		CRITICAL_MODULE_COVERAGE.flatMap(({ path, members = [] }) => {
			const owners = ownersForPaths(manifest, [path, ...members]);
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
	const temporaryDirectory = mkdtempSync(
		join(tmpdir(), "switchyard-coverage-"),
	);
	const lcovPath = join(temporaryDirectory, "coverage.lcov");
	const global = ["lines", "branches", "functions"].map((kind) =>
		Math.min(...plan.modules.map((module) => module[kind])),
	);
	const includedPaths = [
		...new Set(
			plan.modules.flatMap(({ path, members = [] }) => [path, ...members]),
		),
	];
	try {
		const args = [
			"--experimental-test-coverage",
			"--test-coverage-include-all",
			`--test-coverage-lines=${global[0]}`,
			`--test-coverage-branches=${global[1]}`,
			`--test-coverage-functions=${global[2]}`,
			...includedPaths.map((path) => `--test-coverage-include=${path}`),
			"--test-reporter=spec",
			"--test-reporter-destination=stdout",
			"--test-reporter=lcov",
			`--test-reporter-destination=${lcovPath}`,
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
		const textMetrics = parseCoverageReport(output, plan.modules);
		const lcov =
			!result.error && result.status === 0
				? readFileSync(lcovPath, "utf8")
				: "";
		const metrics = parseLcovCoverageReport(lcov, plan.modules, root);
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
		return { status: 0, metrics, textMetrics, suites: plan.suites };
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
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
