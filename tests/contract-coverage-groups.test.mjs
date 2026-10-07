import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import {
	CRITICAL_MODULE_COVERAGE,
	coverageFailures,
	criticalCoveragePlan,
	parseCoverageReport,
	parseLcovCoverageReport,
	runContractCoverage,
} from "../scripts/run-contract-coverage.mjs";

const ROOT = process.cwd();

function makeModule(overrides = {}) {
	return {
		path: "src/facade.mjs",
		lines: 70,
		branches: 50,
		functions: 50,
		...overrides,
	};
}

function lcovRecord(path, { LF, LH, BRF, BRH, FNF, FNH }) {
	return [
		`SF:${path}`,
		`LF:${LF}`,
		`LH:${LH}`,
		`BRF:${BRF}`,
		`BRH:${BRH}`,
		`FNF:${FNF}`,
		`FNH:${FNH}`,
		"end_of_record",
	].join("\n");
}

function passingCoverageFixture() {
	return CRITICAL_MODULE_COVERAGE.flatMap((module) =>
		[module.path, ...(module.members ?? [])].map((path) =>
			lcovRecord(path, {
				LF: 100,
				LH: 100,
				BRF: 100,
				BRH: 100,
				FNF: 100,
				FNH: 100,
			}),
		),
	).join("\n");
}

describe("contract coverage groups", () => {
	it("preserves every existing critical module and adds the four 70/50/70 floors", () => {
		const additions = [
			"check-session",
			"failure-finalization",
			"failure-accountability",
			"launcher-preflight",
		].map((name) => `src/switchyard/simple/${name}.mjs`);
		deepStrictEqual(
			CRITICAL_MODULE_COVERAGE.filter(({ path }) => additions.includes(path)),
			additions.map((path) => ({
				path,
				lines: 70,
				branches: 50,
				functions: 70,
			})),
		);
		strictEqual(
			createHash("sha256")
				.update(
					JSON.stringify(
						CRITICAL_MODULE_COVERAGE.filter(
							({ path }) => !additions.includes(path),
						),
					),
				)
				.digest("hex"),
			"3cdc7af676aa8a91afa95e67cc34d85215411a697ea211deaf641d6d1925a0e6",
		);
	});

	it("runs the complete mapped suite set once, serially, with unchanged global floors and live output", () => {
		const plan = criticalCoveragePlan(ROOT);
		const regressions = [
			"simple-check-session",
			"simple-check-execution",
			"simple-guarded-prompt",
			"simple-failure-finalization",
			"simple-failure-accountability",
			"simple-launcher-preflight",
			"integration-metadata-process",
			"integration-metadata-refusal",
		].map((name) => `tests/${name}.test.mjs`);
		strictEqual(new Set(plan.suites).size, plan.suites.length);
		for (const path of regressions)
			ok(plan.suites.includes(path), `focused suite missing: ${path}`);
		strictEqual(
			createHash("sha256")
				.update(
					JSON.stringify(
						plan.suites.filter((path) => !regressions.includes(path)),
					),
				)
				.digest("hex"),
			"3cc72b1272dd44da6432d65c8f9f0f3ef7c0db81ec2e41510c4650b5bbf57b7e",
		);
		let calls = 0;
		const result = runContractCoverage({
			root: ROOT,
			run(command, args, options) {
				calls += 1;
				strictEqual(command, process.execPath);
				deepStrictEqual(args.slice(args.indexOf("--test") + 1), plan.suites);
				deepStrictEqual(
					args.filter((arg) => arg.startsWith("--test-concurrency=")),
					["--test-concurrency=1"],
				);
				for (const floor of [
					"--test-coverage-lines=10",
					"--test-coverage-branches=30",
					"--test-coverage-functions=3",
				])
					ok(args.includes(floor));
				deepStrictEqual(options.stdio, ["ignore", "inherit", "inherit"]);
				ok(args.includes("--test-coverage-include-all"));
				deepStrictEqual(
					args.filter((arg) => arg.startsWith("--test-coverage-include=")),
					[
						...new Set(
							plan.modules.flatMap(({ path, members = [] }) => [
								path,
								...members,
							]),
						),
					].map((path) => `--test-coverage-include=${path}`),
				);
				strictEqual(
					args.some((arg) => arg.startsWith("--test-coverage-exclude=")),
					false,
				);
				strictEqual(
					args.filter((arg) => arg === "--test-reporter=lcov").length,
					1,
				);
				const destinations = args
					.filter((arg) => arg.startsWith("--test-reporter-destination="))
					.map((arg) => arg.slice("--test-reporter-destination=".length));
				writeFileSync(destinations.at(-1), passingCoverageFixture());
				writeFileSync(
					destinations[1],
					CRITICAL_MODULE_COVERAGE.map(
						({ path }) => `${path} | 100.00 | 100.00 | 100.00 |`,
					).join("\n"),
				);
				return { status: 0 };
			},
		});
		strictEqual(calls, 1);
		deepStrictEqual(result.suites, plan.suites);
		for (const { path } of plan.modules)
			strictEqual(result.textMetrics[path].lines, 100);
	});

	it("rejects a failing or signalled coverage process and removes all report files", () => {
		for (const status of [1, null]) {
			let directory;
			throws(
				() =>
					runContractCoverage({
						root: ROOT,
						run(_command, args) {
							const destination = args
								.filter((arg) => arg.startsWith("--test-reporter-destination="))
								.at(-1)
								.slice("--test-reporter-destination=".length);
							directory = dirname(destination);
							writeFileSync(destination, passingCoverageFixture());
							return { status };
						},
					}),
				/coverage_test_process_failed/u,
			);
			ok(directory);
			strictEqual(existsSync(directory), false);
		}
	});

	it("aggregates line, branch, and function counters across a façade and members", () => {
		const module = makeModule({ members: ["src/part.mjs"] });
		const metrics = parseLcovCoverageReport(
			[
				lcovRecord(module.path, {
					LF: 2,
					LH: 1,
					BRF: 2,
					BRH: 1,
					FNF: 1,
					FNH: 1,
				}),
				lcovRecord("src/part.mjs", {
					LF: 2,
					LH: 2,
					BRF: 2,
					BRH: 1,
					FNF: 1,
					FNH: 0,
				}),
			].join("\n"),
			[module],
			ROOT,
		);
		deepStrictEqual(metrics[module.path], {
			lines: 75,
			branches: 50,
			functions: 50,
		});
	});

	it("reads zero-found metrics as 100 percent", () => {
		const module = makeModule({ lines: 100, branches: 100, functions: 100 });
		const metrics = parseLcovCoverageReport(
			lcovRecord(module.path, {
				LF: 0,
				LH: 0,
				BRF: 0,
				BRH: 0,
				FNF: 0,
				FNH: 0,
			}),
			[module],
			ROOT,
		);
		deepStrictEqual(metrics[module.path], {
			lines: 100,
			branches: 100,
			functions: 100,
		});
		deepStrictEqual(coverageFailures(metrics, [module]), []);
	});

	it("fails a group below its threshold", () => {
		const module = makeModule({ members: ["src/part.mjs"], lines: 80 });
		const metrics = parseLcovCoverageReport(
			[
				lcovRecord(module.path, {
					LF: 1,
					LH: 1,
					BRF: 0,
					BRH: 0,
					FNF: 0,
					FNH: 0,
				}),
				lcovRecord("src/part.mjs", {
					LF: 3,
					LH: 2,
					BRF: 0,
					BRH: 0,
					FNF: 0,
					FNH: 0,
				}),
			].join("\n"),
			[module],
			ROOT,
		);
		deepStrictEqual(coverageFailures(metrics, [module]), [
			"coverage_below_threshold:src/facade.mjs:lines:75<80",
		]);
	});

	it("fails when a declared member has no lcov record", () => {
		const module = makeModule({ members: ["src/missing.mjs"] });
		const metrics = parseLcovCoverageReport(
			lcovRecord(module.path, {
				LF: 1,
				LH: 1,
				BRF: 1,
				BRH: 1,
				FNF: 1,
				FNH: 1,
			}),
			[module],
			ROOT,
		);
		strictEqual(metrics[module.path], null);
		deepStrictEqual(coverageFailures(metrics, [module]), [
			"coverage_missing:src/facade.mjs",
		]);
	});

	it("uses the final lcov row when Node repeats a source path", () => {
		const module = makeModule();
		const metrics = parseLcovCoverageReport(
			[
				lcovRecord(module.path, {
					LF: 10,
					LH: 9,
					BRF: 10,
					BRH: 8,
					FNF: 10,
					FNH: 7,
				}),
				lcovRecord(module.path, {
					LF: 100,
					LH: 50,
					BRF: 20,
					BRH: 10,
					FNF: 10,
					FNH: 5,
				}),
			].join("\n"),
			[module],
			ROOT,
		);
		deepStrictEqual(metrics[module.path], {
			lines: 50,
			branches: 50,
			functions: 50,
		});
	});

	it("matches the text table to lcov metrics rounded to two decimals", () => {
		const module = makeModule({ members: ["src/part.mjs"] });
		const textMetrics = parseCoverageReport(
			"src/facade.mjs | 66.67 | 50.00 | 50.00 |",
			[module],
		);
		const lcovMetrics = parseLcovCoverageReport(
			[
				lcovRecord(module.path, {
					LF: 1,
					LH: 1,
					BRF: 2,
					BRH: 1,
					FNF: 1,
					FNH: 1,
				}),
				lcovRecord("src/part.mjs", {
					LF: 2,
					LH: 1,
					BRF: 2,
					BRH: 1,
					FNF: 1,
					FNH: 0,
				}),
			].join("\n"),
			[module],
			ROOT,
		);
		for (const kind of ["lines", "branches", "functions"])
			strictEqual(
				lcovMetrics[module.path][kind].toFixed(2),
				textMetrics[module.path][kind].toFixed(2),
			);
	});

	it("deletes the lcov temp directory after success and runner failure", () => {
		let successDirectory;
		const report = CRITICAL_MODULE_COVERAGE.map(
			({ path }) => `${path} | 100.00 | 100.00 | 100.00 |`,
		).join("\n");
		runContractCoverage({
			root: ROOT,
			run(_command, args) {
				const destination = args
					.filter((argument) =>
						argument.startsWith("--test-reporter-destination="),
					)
					.at(-1)
					.slice("--test-reporter-destination=".length);
				successDirectory = dirname(destination);
				writeFileSync(destination, passingCoverageFixture());
				return { status: 0, stdout: report, stderr: "" };
			},
		});
		ok(successDirectory);
		strictEqual(existsSync(successDirectory), false);

		let failureDirectory;
		throws(
			() =>
				runContractCoverage({
					root: ROOT,
					run(_command, args) {
						const destination = args
							.filter((argument) =>
								argument.startsWith("--test-reporter-destination="),
							)
							.at(-1)
							.slice("--test-reporter-destination=".length);
						failureDirectory = dirname(destination);
						throw new Error("mock runner failure");
					},
				}),
			/mock runner failure/u,
		);
		ok(failureDirectory);
		strictEqual(existsSync(failureDirectory), false);
	});
});
