import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { execFileSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	assertContractSnapshotUnchanged,
	loadContractGateManifest,
	loadLedgerGateMapping,
	ownersForPaths,
	parseContractGateManifest,
	parseTapOutcome,
	statusReport,
	validateContractGateMapping,
	validateExecution,
	validateExecutionSnapshot,
} from "../scripts/check-contract-gates.mjs";
import { checkPreCommitReceipt } from "../scripts/check-contract-receipt.mjs";
import {
	CRITICAL_MODULE_COVERAGE,
	coverageFailures,
	parseCoverageReport,
} from "../scripts/run-contract-coverage.mjs";
import { loadIncidentMutations } from "../scripts/run-incident-mutations.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const ROOT = join(process.cwd());

function createReceiptFixture() {
	const fixture = tempDir("switchyard-contract-cli-");
	const manifest = loadContractGateManifest(ROOT);
	const paths = [
		"INVARIANTS.md",
		"ledger.yaml",
		"package.json",
		"scripts/check-contract-gates.mjs",
		"scripts/check-contract-receipt.mjs",
		"scripts/run-test-phases.mjs",
		"scripts/run-validate-phases.mjs",
		...manifest.flatMap((gate) => [...gate.areas, ...gate.tests]),
	];
	for (const sourcePath of new Set(paths)) {
		const source = join(ROOT, sourcePath);
		const destination = join(fixture, sourcePath);
		mkdirSync(join(destination, ".."), { recursive: true });
		cpSync(source, destination);
	}
	execFileSync("git", ["init", "-q"], { cwd: fixture });
	execFileSync("git", ["config", "user.email", "test@example.invalid"], {
		cwd: fixture,
	});
	execFileSync("git", ["config", "user.name", "Gate Test"], { cwd: fixture });
	execFileSync("git", ["add", "."], { cwd: fixture });
	execFileSync("git", ["commit", "-qm", "fixture"], { cwd: fixture });
	const diagnostics = join(fixture, "src/switchyard/diagnostics/index.mjs");
	writeFileSync(
		diagnostics,
		`${requireText(diagnostics)}\n// staged boundary edit\n`,
	);
	execFileSync("git", ["add", "src/switchyard/diagnostics/index.mjs"], {
		cwd: fixture,
	});
	return fixture;
}

function requireText(path) {
	return readFileSync(path, "utf8");
}

function createValidationFixture() {
	const fixture = createReceiptFixture();
	const packagePath = join(fixture, "package.json");
	const packageJson = JSON.parse(requireText(packagePath));
	packageJson.scripts = {
		...packageJson.scripts,
		lint: `${process.execPath} -e "process.exit(0)"`,
		deadcode: `${process.execPath} -e "process.exit(0)"`,
		test: `${process.execPath} -e "process.exit(0)"`,
		"roster:coherence": `${process.execPath} -e "process.exit(0)"`,
	};
	writeFileSync(packagePath, `${JSON.stringify(packageJson)}\n`);
	writeFileSync(
		join(fixture, "tests/diagnostics.test.mjs"),
		'import { test } from "node:test";\ntest("mapped suite skipped", { skip: "fixture" }, () => {});\n',
	);
	execFileSync("git", ["add", "package.json", "tests/diagnostics.test.mjs"], {
		cwd: fixture,
	});
	return fixture;
}

describe("source-boundary contract gate mapping", () => {
	it("declares mapped critical modules with explicit native coverage thresholds", () => {
		const manifest = loadContractGateManifest(ROOT);
		const mapped = new Set(manifest.flatMap((gate) => gate.areas));
		ok(CRITICAL_MODULE_COVERAGE.length >= 8);
		for (const module of CRITICAL_MODULE_COVERAGE) {
			ok(
				mapped.has(module.path),
				`critical module is not mapped: ${module.path}`,
			);
			for (const kind of ["lines", "branches", "functions"])
				ok(
					Number.isInteger(module[kind]) &&
						module[kind] > 0 &&
						module[kind] <= 100,
					`explicit ${kind} threshold missing for ${module.path}`,
				);
		}
	});

	it("parses native coverage and rejects missing or below-threshold modules", () => {
		const modules = [
			{ path: "src/one.mjs", lines: 80, branches: 60, functions: 70 },
			{ path: "src/two.mjs", lines: 50, branches: 40, functions: 50 },
		];
		const report = [
			"src/one.mjs | 81.00 | 61.00 | 71.00 |",
			"src/two.mjs | 49.00 | 40.00 | 50.00 |",
		].join("\n");
		const metrics = parseCoverageReport(report, modules);
		strictEqual(coverageFailures(metrics, modules).length, 1);
		strictEqual(
			coverageFailures(metrics, [
				...modules,
				{ path: "src/missing.mjs", lines: 1, branches: 1, functions: 1 },
			]).length,
			2,
		);
	});

	it("keeps every historical incident mutation explicit and disposable", () => {
		const mutations = loadIncidentMutations(ROOT);
		strictEqual(mutations.length, 7);
		strictEqual(new Set(mutations.map((mutation) => mutation.id)).size, 7);
		deepStrictEqual(
			new Set(mutations.map((mutation) => mutation.defectClass)),
			new Set([
				"field-drop",
				"vacuous-consumer-guard",
				"failure-overwrite",
				"duplicate-terminal-count",
				"omitted-boundary-suite",
				"false-command-success",
				"unsafe-retry",
			]),
		);
		for (const mutation of mutations) {
			ok(
				mutation.source.startsWith("src/") ||
					mutation.source.startsWith("scripts/"),
			);
			ok(mutation.tests.every((suite) => suite.startsWith("tests/")));
		}
	});

	it("CI pins the local Node major and fails when live gates are unavailable", () => {
		strictEqual(readFileIfPresent(join(ROOT, ".node-version")), "26\n");
		const workflow = readFileIfPresent(
			join(ROOT, ".github/workflows/validate.yml"),
		);
		ok(workflow?.includes("node-version-file: .node-version"));
		ok(workflow?.includes("npm run validate"));
		ok(workflow?.includes("npm run test:contracts"));
		ok(workflow?.includes("npm run test:mutation:contracts"));
		const packageJson = JSON.parse(requireText(join(ROOT, "package.json")));
		ok(
			packageJson.scripts["test:contracts"].includes(
				"run-contract-coverage.mjs",
			),
		);
		ok(workflow?.includes("status=1"));
	});

	it("maps each declared production boundary to existing suites", () => {
		const manifest = loadContractGateManifest(ROOT);
		const ledger = loadLedgerGateMapping(ROOT);
		strictEqual(manifest.length, 10);
		strictEqual(
			validateContractGateMapping({ manifest, ledger, root: ROOT }),
			true,
		);
		deepStrictEqual(
			ownersForPaths(manifest, ["src/switchyard/outcome/reducer.mjs"]).map(
				(owner) => owner.id,
			),
			["outcome-schema-reducer"],
		);
	});

	it("rejects an unmapped owner, stale test path, and stale ledger key", () => {
		const manifest = [
			{
				id: "dead-code-owner",
				areas: ["src/no-longer-here.mjs"],
				tests: ["tests/no-longer-here.test.mjs"],
			},
		];
		throws(
			() =>
				validateContractGateMapping({
					manifest,
					ledger: { "old-owner": "not-run" },
					root: ROOT,
				}),
			(error) =>
				error.code === "contract_gate_mapping_invalid" &&
				error.errors.includes(
					"owner_missing:dead-code-owner:src/no-longer-here.mjs",
				) &&
				error.errors.includes(
					"test_path_stale:dead-code-owner:tests/no-longer-here.test.mjs",
				) &&
				error.errors.includes("ledger_mapping_missing:dead-code-owner") &&
				error.errors.includes("ledger_mapping_unmapped:old-owner"),
		);
	});

	it("rejects malformed or duplicate declarations", () => {
		const text = `<!-- contract-gates/v1 -->\n### Contract gate: one\narea: ["src/a.mjs"]\ngate_test: tests/a.test.mjs\n### Contract gate: one\narea: ["src/b.mjs"]\ngate_test: tests/b.test.mjs\n<!-- /contract-gates/v1 -->`;
		throws(() => parseContractGateManifest(text), /contract_gate_duplicate/);
	});

	it("requires every mapped suite to execute and reports omission/skip", () => {
		const manifest = [
			{
				id: "one",
				areas: ["src/a.mjs"],
				tests: ["tests/a.test.mjs", "tests/b.test.mjs"],
			},
		];
		for (const suites of [
			{ "tests/a.test.mjs": { status: "executed" } },
			{
				"tests/a.test.mjs": { status: "executed" },
				"tests/b.test.mjs": { status: "skipped" },
			},
		]) {
			throws(
				() => validateExecution({ manifest, execution: { suites } }),
				/contract_gate_execution_invalid/,
			);
		}
		deepStrictEqual(
			validateExecution({
				manifest,
				execution: {
					suites: {
						"tests/a.test.mjs": { status: "executed" },
						"tests/b.test.mjs": { status: "executed" },
					},
				},
			}).requiredSuites,
			["tests/a.test.mjs", "tests/b.test.mjs"],
		);
	});

	it("rejects real node:test all-skipped and zero-test TAP output", () => {
		const skipped =
			"1..1\nok 1 - skipped fixture # SKIP\n# tests 1\n# pass 0\n# skipped 1\n# fail 0\n";
		strictEqual(parseTapOutcome(skipped, 0).status, "skipped");
		strictEqual(
			parseTapOutcome("1..0\n# tests 0\n# pass 0\n# skipped 0\n", 0).status,
			"skipped",
		);
		strictEqual(
			parseTapOutcome(
				"1..1\nok 1 - runs\n# tests 1\n# pass 1\n# skipped 0\n",
				0,
			).status,
			"executed",
		);
	});

	it("rejects execution evidence after the staged snapshot changes", () => {
		const snapshot = {
			head: "head-a",
			indexTree: "tree-a",
			stagedDigest: "bytes-a",
			manifestHash: "manifest-a",
			paths: ["src/a.mjs"],
		};
		const execution = { snapshot };
		throws(
			() =>
				validateExecutionSnapshot(execution, {
					...snapshot,
					stagedDigest: "bytes-b",
				}),
			/error.*stale|contract_gate_execution_snapshot_stale/,
		);
		throws(
			() =>
				assertContractSnapshotUnchanged(snapshot, {
					...snapshot,
					paths: ["src/b.mjs"],
				}),
			/contract_gate_snapshot_changed_after_suites/,
		);
	});

	it("selects only exact boundary owners and emits status for mapped staged paths", () => {
		const manifest = loadContractGateManifest(ROOT);
		const status = statusReport({ root: ROOT });
		ok(Array.isArray(status.changedPaths));
		strictEqual(status.owners.length, 0);
		deepStrictEqual(
			ownersForPaths(manifest, [
				"src/switchyard/run-store/index.mjs",
				"src/switchyard/runner/index.mjs",
			]).map((owner) => owner.id),
			["production-runner", "run-store"],
		);
	});

	it("does not require a receipt when no mapped production path is staged", () => {
		const result = checkPreCommitReceipt({ root: ROOT });
		strictEqual(result.required, false);
	});

	it("runs the real contract CLI, validates its receipt, and rejects a post-gate staged edit", () => {
		const fixture = createReceiptFixture();
		try {
			execFileSync(
				process.execPath,
				["scripts/check-contract-gates.mjs", "--run"],
				{
					cwd: fixture,
					stdio: "inherit",
				},
			);
			const valid = execFileSync(
				process.execPath,
				["scripts/check-contract-receipt.mjs", "--pre-commit"],
				{ cwd: fixture, encoding: "utf8" },
			);
			ok(valid.includes("valid for 1 mapped owner"));
			const diagnostics = join(fixture, "src/switchyard/diagnostics/index.mjs");
			writeFileSync(
				diagnostics,
				`${requireText(diagnostics)}\n// post-gate edit\n`,
			);
			execFileSync("git", ["add", "src/switchyard/diagnostics/index.mjs"], {
				cwd: fixture,
			});
			throws(
				() =>
					execFileSync(
						process.execPath,
						["scripts/check-contract-receipt.mjs", "--pre-commit"],
						{ cwd: fixture, stdio: "pipe" },
					),
				(error) =>
					error.status === 1 &&
					String(error.stderr ?? error.message).includes(
						"contract_gate_execution_snapshot_stale",
					),
			);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("normal validate runs contract suites after all phases and rejects an all-skipped mapped suite", () => {
		const fixture = createValidationFixture();
		try {
			throws(
				() =>
					execFileSync(process.execPath, ["scripts/run-validate-phases.mjs"], {
						cwd: fixture,
						stdio: "pipe",
					}),
				(error) =>
					error.status === 1 &&
					String(error.stdout ?? "").includes("# skipped 1") &&
					!String(error.stdout ?? "").includes("MODULE_NOT_FOUND") &&
					!String(error.stderr ?? "").includes("MODULE_NOT_FOUND") &&
					!readFileIfPresent(
						join(fixture, ".logs/contract-gates/receipt.json"),
					),
			);
			mkdirSync(join(fixture, ".logs/contract-gates"), { recursive: true });
			writeFileSync(
				join(fixture, ".logs/contract-gates/execution.json"),
				JSON.stringify({
					schemaVersion: 1,
					suites: { "tests/diagnostics.test.mjs": { status: "skipped" } },
				}),
			);
			throws(
				() =>
					execFileSync(
						process.execPath,
						["scripts/check-contract-gates.mjs", "--validate"],
						{ cwd: fixture, stdio: "pipe" },
					),
				(error) =>
					error.status === 1 &&
					String(error.stdout ?? "").includes("# skipped 1") &&
					!readFileIfPresent(
						join(fixture, ".logs/contract-gates/receipt.json"),
					),
			);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});
});

function readFileIfPresent(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}
