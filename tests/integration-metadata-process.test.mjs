// INV-2 gate test: the git-apply metadata seam is one checked, bounded
// command execution path. Real subprocess regressions for BOTH metadata
// commands: a SIGTERM-ignoring stalled child is SIGKILLed and reaped within
// the injected short timeout behind an independent outer watchdog, and
// partial stdout/stderr from nonzero, signal, overflow, and spawn failures
// is discarded. Only git's own invalid-patch diagnostics keep the historical
// corrupt_patch/conflict classifications, and a confirmed successful empty
// summary remains valid.

import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { execSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setMetadataCommandTimeoutForTests } from "../src/switchyard/integrate/diff-validation.mjs";
import {
	integrationGate,
	METADATA_COMMAND_TIMEOUT_MS,
	validateDiff,
} from "../src/switchyard/integrate/index.mjs";
import {
	buildDiff,
	commitFile,
	initRepo,
} from "./helpers/integration-gate-fixtures.mjs";
import {
	hostState,
	runMetadataScenario,
} from "./helpers/integration-metadata-fixtures.mjs";
import { sourceText } from "./helpers/source-text.mjs";

let projectPath;

beforeEach(() => {
	projectPath = initRepo();
	commitFile(projectPath, "test.txt", "original content\n");
});

afterEach(() => {
	rmSync(projectPath, { recursive: true, force: true });
});

function plainDiff() {
	const diff = buildDiff(projectPath, (dir) => {
		writeFileSync(join(dir, "test.txt"), "modified content\n", "utf8");
	});
	execSync("git checkout -- test.txt", { cwd: projectPath, stdio: "pipe" });
	return diff;
}

function assertRunnerHealthy(scenario) {
	ok(
		!scenario.watchdogFired,
		"the metadata command must return on its own before the outer watchdog",
	);
	strictEqual(
		scenario.code,
		0,
		`runner must exit without an uncaught exception, stderr: ${scenario.stderr}`,
	);
	strictEqual(
		scenario.nonmetadataGitInvoked,
		false,
		"metadata checks must not reach apply, fingerprint, stage, or commit Git commands",
	);
	ok(scenario.result !== null, "runner must report a parsed result");
}

describe("metadata command process bounds", () => {
	it("classifies real Git's explicit no-patches diagnostic as corrupt_patch", () => {
		const before = hostState(projectPath);
		const result = validateDiff("not a diff at all", projectPath);
		strictEqual(result.safe, false);
		strictEqual(result.reasonKind, "corrupt_patch");
		strictEqual(result.reason, "diff could not be parsed by git apply");
		ok(!JSON.stringify(result).includes("No valid patches in input"));
		deepStrictEqual(hostState(projectPath), before);
	});

	it("classifies real Git's explicit no-patches diagnostic at the declaration precheck", () => {
		const before = hostState(projectPath);
		const result = integrationGate("not a diff at all", projectPath, {
			requiredPaths: ["test.txt"],
		});
		strictEqual(result.success, false);
		strictEqual(result.reasonKind, "corrupt_patch");
		strictEqual(result.message, "diff could not be parsed by git apply");
		ok(!JSON.stringify(result).includes("No valid patches in input"));
		deepStrictEqual(hostState(projectPath), before);
	});

	it("SIGKILLs a SIGTERM-ignoring stalled --numstat child and reaps it", async () => {
		const patch = plainDiff();
		const before = hostState(projectPath);
		const scenario = await runMetadataScenario({
			patch,
			projectPath,
			numstatMode: "stall",
			summaryMode: "ok",
			timeoutMs: 1500,
		});
		assertRunnerHealthy(scenario);
		strictEqual(scenario.result.safe, false);
		strictEqual(scenario.result.reasonKind, "integration_state_unknown");
		strictEqual(scenario.result.reason, "diff metadata could not be confirmed");
		ok(
			scenario.readyPids.numstat,
			"the stalled child must confirm its SIGTERM handler before the timeout",
		);
		ok(
			!scenario.readyPids.numstat.alive,
			"the SIGTERM-ignoring child must be dead and reaped after the timeout",
		);
		ok(
			!scenario.termReceived,
			"the timeout kill must be SIGKILL, not a SIGTERM the child can ignore",
		);
		ok(
			!scenario.readyPids.summary,
			"the summary command must never run after unconfirmed numstat metadata",
		);
		deepStrictEqual(hostState(projectPath), before);
	});

	it("SIGKILLs a stalled --summary child after a successful --numstat", async () => {
		const patch = plainDiff();
		const before = hostState(projectPath);
		const scenario = await runMetadataScenario({
			patch,
			projectPath,
			numstatMode: "ok",
			summaryMode: "stall",
			timeoutMs: 1500,
		});
		assertRunnerHealthy(scenario);
		strictEqual(scenario.result.safe, false);
		strictEqual(scenario.result.reasonKind, "integration_state_unknown");
		ok(
			scenario.readyPids.numstat && !scenario.readyPids.numstat.alive,
			"the successful numstat child must have exited on its own",
		);
		ok(
			scenario.readyPids.summary && !scenario.readyPids.summary.alive,
			"the stalled SIGTERM-ignoring summary child must be dead and reaped",
		);
		ok(!scenario.termReceived, "the timeout kill must be SIGKILL");
		deepStrictEqual(hostState(projectPath), before);
	});

	it("bounds a stalled declaration-precheck metadata command through integrationGate", async () => {
		const patch = plainDiff();
		const before = hostState(projectPath);
		const scenario = await runMetadataScenario({
			patch,
			projectPath,
			numstatMode: "stall",
			summaryMode: "ok",
			timeoutMs: 1500,
			call: "integrationGate",
			gateOptions: { requiredPaths: ["test.txt"] },
		});
		assertRunnerHealthy(scenario);
		strictEqual(scenario.result.success, false);
		strictEqual(scenario.result.reasonKind, "integration_state_unknown");
		strictEqual(
			scenario.result.message,
			"diff metadata could not be confirmed",
		);
		ok(
			scenario.readyPids.numstat && !scenario.readyPids.numstat.alive,
			"the stalled child must be reaped by the production SIGKILL",
		);
		deepStrictEqual(hostState(projectPath), before);
	});

	it("discards plausible partial stdout from a nonzero --numstat exit", async () => {
		const sentinel = "SWITCHYARD-PARTIAL-NUMSTAT-7c1d";
		const scenario = await runMetadataScenario({
			patch: plainDiff(),
			projectPath,
			numstatMode: "nonzero",
			numstatOutput: `1\t1\ttest.txt\n${sentinel}\n`,
			timeoutMs: 5000,
		});
		assertRunnerHealthy(scenario);
		strictEqual(scenario.result.safe, false);
		strictEqual(scenario.result.reasonKind, "integration_state_unknown");
		ok(
			!JSON.stringify(scenario.result).includes(sentinel),
			"partial stdout must never reach the refusal",
		);
	});

	it("discards plausible partial stdout from a nonzero --summary exit after a successful --numstat", async () => {
		const sentinel = "SWITCHYARD-PARTIAL-SUMMARY-31af";
		const scenario = await runMetadataScenario({
			patch: plainDiff(),
			projectPath,
			numstatMode: "ok",
			summaryMode: "nonzero",
			summaryOutput: ` create mode 100644 src/new.txt\n${sentinel}\n`,
			timeoutMs: 5000,
		});
		assertRunnerHealthy(scenario);
		strictEqual(scenario.result.safe, false);
		strictEqual(scenario.result.reasonKind, "integration_state_unknown");
		ok(!JSON.stringify(scenario.result).includes(sentinel));
	});

	it("discards partial output when the metadata child dies by signal", async () => {
		const sentinel = "SWITCHYARD-SIGNAL-PARTIAL-52bb";
		const scenario = await runMetadataScenario({
			patch: plainDiff(),
			projectPath,
			numstatMode: "signal",
			numstatOutput: `1\t1\ttest.txt\n${sentinel}\n`,
			timeoutMs: 5000,
		});
		assertRunnerHealthy(scenario);
		strictEqual(scenario.result.safe, false);
		strictEqual(scenario.result.reasonKind, "integration_state_unknown");
		ok(!JSON.stringify(scenario.result).includes(sentinel));
	});

	it("discards partial output when --summary dies by signal", async () => {
		const sentinel = "SWITCHYARD-SUMMARY-SIGNAL-PARTIAL-63cc";
		const scenario = await runMetadataScenario({
			patch: plainDiff(),
			projectPath,
			numstatMode: "ok",
			summaryMode: "signal",
			summaryOutput: ` create mode 100644 new.txt\n${sentinel}\n`,
			timeoutMs: 5000,
		});
		assertRunnerHealthy(scenario);
		strictEqual(scenario.result.safe, false);
		strictEqual(scenario.result.reasonKind, "integration_state_unknown");
		ok(!JSON.stringify(scenario.result).includes(sentinel));
	});

	it("refuses when --numstat stdout overflows the 8 MiB metadata output bound", async () => {
		const scenario = await runMetadataScenario({
			patch: plainDiff(),
			projectPath,
			numstatMode: "overflow-stdout",
			timeoutMs: 10000,
		});
		assertRunnerHealthy(scenario);
		strictEqual(scenario.result.safe, false);
		strictEqual(scenario.result.reasonKind, "integration_state_unknown");
	});

	it("refuses when --numstat stderr overflows the 8 MiB metadata output bound", async () => {
		const scenario = await runMetadataScenario({
			patch: plainDiff(),
			projectPath,
			numstatMode: "overflow-stderr",
			timeoutMs: 10000,
		});
		assertRunnerHealthy(scenario);
		strictEqual(scenario.result.safe, false);
		strictEqual(scenario.result.reasonKind, "integration_state_unknown");
	});

	it("refuses when --summary stdout overflows the 8 MiB metadata output bound", async () => {
		const scenario = await runMetadataScenario({
			patch: plainDiff(),
			projectPath,
			numstatMode: "ok",
			summaryMode: "overflow-stdout",
			timeoutMs: 10000,
		});
		assertRunnerHealthy(scenario);
		strictEqual(scenario.result.safe, false);
		strictEqual(scenario.result.reasonKind, "integration_state_unknown");
	});

	it("refuses when --summary stderr overflows the 8 MiB metadata output bound", async () => {
		const scenario = await runMetadataScenario({
			patch: plainDiff(),
			projectPath,
			numstatMode: "ok",
			summaryMode: "overflow-stderr",
			timeoutMs: 10000,
		});
		assertRunnerHealthy(scenario);
		strictEqual(scenario.result.safe, false);
		strictEqual(scenario.result.reasonKind, "integration_state_unknown");
	});

	it("refuses when the metadata command cannot spawn", async () => {
		const scenario = await runMetadataScenario({
			patch: plainDiff(),
			projectPath,
			numstatMode: "ok",
			timeoutMs: 5000,
			fakeGitSpawnFailure: true,
		});
		assertRunnerHealthy(scenario);
		strictEqual(scenario.result.safe, false);
		strictEqual(scenario.result.reasonKind, "integration_state_unknown");
	});

	it("keeps corrupt_patch only when git's invalid-patch diagnostics establish it", async () => {
		const scenario = await runMetadataScenario({
			patch: plainDiff(),
			projectPath,
			numstatMode: "nonzero-corrupt",
			timeoutMs: 5000,
		});
		assertRunnerHealthy(scenario);
		strictEqual(scenario.result.safe, false);
		strictEqual(scenario.result.reasonKind, "corrupt_patch");
		strictEqual(
			scenario.result.reason,
			"diff could not be parsed by git apply",
		);
	});

	it("keeps conflict only when git's applicability diagnostics establish it", async () => {
		const scenario = await runMetadataScenario({
			patch: plainDiff(),
			projectPath,
			numstatMode: "nonzero-conflict",
			timeoutMs: 5000,
		});
		assertRunnerHealthy(scenario);
		strictEqual(scenario.result.safe, false);
		strictEqual(scenario.result.reasonKind, "conflict");
		strictEqual(
			scenario.result.reason,
			"diff could not be parsed by git apply",
		);
	});

	it("treats a confirmed successful empty summary as valid metadata", async () => {
		const scenario = await runMetadataScenario({
			patch: plainDiff(),
			projectPath,
			numstatMode: "ok",
			summaryMode: "ok",
			numstatOutput: "1\t1\ttest.txt\n",
			summaryOutput: "",
			timeoutMs: 5000,
		});
		assertRunnerHealthy(scenario);
		strictEqual(scenario.result.safe, true);
		deepStrictEqual(scenario.result.touchedPaths, ["test.txt"]);
	});
});

describe("metadata timeout seam", () => {
	afterEach(() => {
		setMetadataCommandTimeoutForTests(null);
	});

	it("pins the documented 30-second per-command production timeout", () => {
		strictEqual(METADATA_COMMAND_TIMEOUT_MS, 30000);
	});

	it("accepts only timeouts strictly shorter than the production bound", () => {
		setMetadataCommandTimeoutForTests(1500);
		setMetadataCommandTimeoutForTests(null);
		for (const invalid of [
			METADATA_COMMAND_TIMEOUT_MS,
			METADATA_COMMAND_TIMEOUT_MS + 1,
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			"1500",
		]) {
			throws(() => setMetadataCommandTimeoutForTests(invalid));
		}
	});

	it("never reads the timeout from the environment or provider input", () => {
		const source = sourceText("src/switchyard/integrate/diff-validation.mjs");
		ok(
			!source.includes("process.env"),
			"the metadata seam must not be env-controlled",
		);
	});
});
