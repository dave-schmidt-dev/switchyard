import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import {
	CRITICAL_MODULE_COVERAGE,
	coverageFailures,
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
	return CRITICAL_MODULE_COVERAGE.map((module) =>
		lcovRecord(module.path, {
			LF: 100,
			LH: 100,
			BRF: 100,
			BRH: 100,
			FNF: 100,
			FNH: 100,
		}),
	).join("\n");
}

describe("contract coverage groups", () => {
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
