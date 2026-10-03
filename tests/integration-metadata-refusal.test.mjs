// INV-2 gate test: incomplete git-apply metadata is refused, sanitized, at
// BOTH catch points — direct validateDiff calls and the integrationGate
// declaration precheck — and never mutates the host: no apply, stage, or
// commit happens on unconfirmed metadata, partial summary output never
// feeds the rename-source allowlist or the symlink/executable safeguards,
// and no refusal carries raw process output.

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { INTEGRATION_REFUSAL_KINDS } from "../src/switchyard/adapter/exec-error.mjs";
import {
	buildDiff,
	buildStagedDiff,
	commitFile,
	initRepo,
} from "./helpers/integration-gate-fixtures.mjs";
import {
	hostState,
	runMetadataScenario,
} from "./helpers/integration-metadata-fixtures.mjs";

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

function renameDiff() {
	commitFile(projectPath, "src/old.mjs", "original\n");
	const diff = buildStagedDiff(projectPath, (dir) => {
		execSync("git mv src/old.mjs src/new.mjs", { cwd: dir, stdio: "pipe" });
	});
	execSync("git reset -q HEAD -- src/", { cwd: projectPath, stdio: "pipe" });
	execSync("git checkout -q -- src/", { cwd: projectPath, stdio: "pipe" });
	rmSync(join(projectPath, "src", "new.mjs"), { force: true });
	return diff;
}

function symlinkDiff() {
	const diff = buildStagedDiff(projectPath, (dir) => {
		execSync("ln -s /etc/passwd evil-link", { cwd: dir });
	});
	execSync("git rm --cached -q evil-link", { cwd: projectPath, stdio: "pipe" });
	rmSync(join(projectPath, "evil-link"), { force: true });
	return diff;
}

function assertRefusalSanitized(scenario, sentinel) {
	ok(
		!scenario.watchdogFired,
		"the metadata command must return on its own before the outer watchdog",
	);
	strictEqual(
		scenario.code,
		0,
		`runner must exit without an uncaught exception, stderr: ${scenario.stderr}`,
	);
	ok(scenario.result !== null, "runner must report a parsed result");
	strictEqual(
		scenario.nonmetadataGitInvoked,
		false,
		"refusal must precede apply, fingerprint, stage, or commit Git commands",
	);
	ok(
		!JSON.stringify(scenario.result).includes(sentinel),
		"no raw process output may reach the refusal",
	);
}

describe("metadata refusal at both catch points", () => {
	it("validateDiff refuses unconfirmed numstat metadata without raw output", async () => {
		const sentinel = "SWITCHYARD-REFUSAL-NUMSTAT-9a41";
		const scenario = await runMetadataScenario({
			patch: plainDiff(),
			projectPath,
			numstatMode: "nonzero",
			numstatOutput: `1\t1\ttest.txt\n${sentinel}\n`,
			timeoutMs: 5000,
		});
		assertRefusalSanitized(scenario, sentinel);
		strictEqual(scenario.result.safe, false);
		strictEqual(scenario.result.reasonKind, "integration_state_unknown");
		ok(INTEGRATION_REFUSAL_KINDS.includes(scenario.result.reasonKind));
		strictEqual(scenario.result.reason, "diff metadata could not be confirmed");
		ok(
			scenario.result.touchedPaths === undefined,
			"no touched paths may be derived from unconfirmed metadata",
		);
	});

	it("validateDiff refuses a failed summary after a successful numstat for a rename-shaped patch", async () => {
		const diff = renameDiff();
		const before = hostState(projectPath);
		const sentinel = "SWITCHYARD-REFUSAL-RENAME-4d7e";
		const scenario = await runMetadataScenario({
			patch: diff,
			projectPath,
			numstatMode: "ok",
			numstatOutput: "0\t0\tsrc/new.mjs\n",
			summaryMode: "nonzero",
			summaryOutput: ` rename src/old.mjs => src/new.mjs (100%)\n${sentinel}\n`,
			timeoutMs: 5000,
		});
		assertRefusalSanitized(scenario, sentinel);
		strictEqual(scenario.result.safe, false);
		strictEqual(scenario.result.reasonKind, "integration_state_unknown");
		deepStrictEqual(hostState(projectPath), before);
	});

	it("validateDiff refuses a failed summary for a symlink-shaped patch without applying safeguards to partial data", async () => {
		const diff = symlinkDiff();
		const before = hostState(projectPath);
		const sentinel = "SWITCHYARD-REFUSAL-SYMLINK-b2c3";
		const scenario = await runMetadataScenario({
			patch: diff,
			projectPath,
			numstatMode: "ok",
			numstatOutput: "0\t0\tevil-link\n",
			summaryMode: "nonzero",
			summaryOutput: ` create mode 120000 evil-link\n${sentinel}\n`,
			timeoutMs: 5000,
		});
		assertRefusalSanitized(scenario, sentinel);
		strictEqual(scenario.result.safe, false);
		strictEqual(
			scenario.result.reasonKind,
			"integration_state_unknown",
			"partial summary output must not drive the symlink safeguard",
		);
		ok(
			!existsSync(join(projectPath, "evil-link")),
			"no symlink may be created on the host",
		);
		deepStrictEqual(hostState(projectPath), before);
	});

	it("integrationGate refuses unconfirmed metadata on the bare path and preserves a dirty host", async () => {
		const patch = plainDiff();
		commitFile(projectPath, "staged.txt", "original staged content\n");
		writeFileSync(
			join(projectPath, "test.txt"),
			"pre-existing unstaged edit\n",
			"utf8",
		);
		writeFileSync(
			join(projectPath, "staged.txt"),
			"pre-existing staged edit\n",
			"utf8",
		);
		execSync("git add -- staged.txt", { cwd: projectPath, stdio: "pipe" });
		writeFileSync(
			join(projectPath, "unrelated.txt"),
			"pre-existing dirty state\n",
			"utf8",
		);
		const before = hostState(projectPath);
		const sentinel = "SWITCHYARD-REFUSAL-GATE-8f0a";
		const scenario = await runMetadataScenario({
			patch,
			projectPath,
			numstatMode: "nonzero",
			numstatOutput: `1\t1\ttest.txt\n${sentinel}\n`,
			timeoutMs: 5000,
			call: "integrationGate",
			gateOptions: {},
		});
		assertRefusalSanitized(scenario, sentinel);
		strictEqual(scenario.result.success, false);
		strictEqual(scenario.result.reasonKind, "integration_state_unknown");
		strictEqual(
			scenario.result.message,
			"diff metadata could not be confirmed",
		);
		deepStrictEqual(hostState(projectPath), before);
	});

	it("the declaration precheck refuses unconfirmed numstat metadata without staging or committing", async () => {
		const patch = plainDiff();
		const before = hostState(projectPath);
		const scenario = await runMetadataScenario({
			patch,
			projectPath,
			numstatMode: "nonzero",
			timeoutMs: 5000,
			call: "integrationGate",
			gateOptions: { requiredPaths: ["test.txt"] },
		});
		assertRefusalSanitized(scenario, "unused");
		strictEqual(scenario.result.success, false);
		strictEqual(scenario.result.reasonKind, "integration_state_unknown");
		strictEqual(
			scenario.result.message,
			"diff metadata could not be confirmed",
		);
		deepStrictEqual(hostState(projectPath), before);
		ok(
			before.index.length > 0,
			"the exact pre-call index must be present in the snapshot",
		);
	});

	it("the declaration precheck refuses a failed summary for a rename-shaped patch instead of judging partial rename data", async () => {
		const diff = renameDiff();
		const before = hostState(projectPath);
		const sentinel = "SWITCHYARD-REFUSAL-PRECHECK-RENAME-6e11";
		const scenario = await runMetadataScenario({
			patch: diff,
			projectPath,
			numstatMode: "ok",
			numstatOutput: "0\t0\tsrc/new.mjs\n",
			summaryMode: "nonzero",
			summaryOutput: ` rename src/old.mjs => src/new.mjs (100%)\n${sentinel}\n`,
			timeoutMs: 5000,
			call: "integrationGate",
			gateOptions: { requiredPaths: ["src/old.mjs", "src/new.mjs"] },
		});
		assertRefusalSanitized(scenario, sentinel);
		strictEqual(scenario.result.success, false);
		strictEqual(
			scenario.result.message,
			"diff metadata could not be confirmed",
		);
		strictEqual(scenario.result.reasonKind, "integration_state_unknown");
		ok(
			!("extraPaths" in scenario.result),
			"partial summary output must not feed the rename-source allowlist",
		);
		deepStrictEqual(hostState(projectPath), before);
	});

	it("the declaration precheck refuses a failed summary for a symlink-shaped patch", async () => {
		const diff = symlinkDiff();
		const before = hostState(projectPath);
		const sentinel = "SWITCHYARD-REFUSAL-PRECHECK-SYMLINK-c5d6";
		const scenario = await runMetadataScenario({
			patch: diff,
			projectPath,
			numstatMode: "ok",
			numstatOutput: "0\t0\tevil-link\n",
			summaryMode: "nonzero",
			summaryOutput: ` create mode 120000 evil-link\n${sentinel}\n`,
			timeoutMs: 5000,
			call: "integrationGate",
			gateOptions: { requiredPaths: ["evil-link"] },
		});
		assertRefusalSanitized(scenario, sentinel);
		strictEqual(scenario.result.success, false);
		strictEqual(
			scenario.result.message,
			"diff metadata could not be confirmed",
		);
		strictEqual(
			scenario.result.reasonKind,
			"integration_state_unknown",
			"partial summary output must not drive the symlink safeguard",
		);
		ok(
			!existsSync(join(projectPath, "evil-link")),
			"no symlink may be created on the host",
		);
		deepStrictEqual(hostState(projectPath), before);
	});

	it("identical garbage output yields byte-identical sanitized refusals", async () => {
		const run = (sentinel) =>
			runMetadataScenario({
				patch: plainDiff(),
				projectPath,
				numstatMode: "nonzero",
				numstatOutput: `1\t1\ttest.txt\n${sentinel}\n`,
				timeoutMs: 5000,
			});
		const first = await run("SWITCHYARD-GARBAGE-ONE-1111");
		const second = await run("SWITCHYARD-GARBAGE-TWO-2222");
		strictEqual(first.code, 0);
		strictEqual(second.code, 0);
		strictEqual(first.nonmetadataGitInvoked, false);
		strictEqual(second.nonmetadataGitInvoked, false);
		deepStrictEqual(first.result, second.result);
	});
});
