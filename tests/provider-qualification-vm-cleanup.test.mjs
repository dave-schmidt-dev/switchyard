import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { vmTaskResult } from "../scripts/provider-qualification.mjs";
import { createQualificationFixture } from "../src/switchyard/diagnostics/provider-qualification-fixture.mjs";
import { vmRunCleanupProven } from "../src/switchyard/diagnostics/provider-qualification-vm-cleanup.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const RUN_ID = "142a8a9f-b934-4af5-8a77-05c7507a6e9f";

function projectWithRun({
	state = "succeeded",
	cleanupState = "complete",
	vmName = `switchyard-work-${RUN_ID}-1`,
	intents = true,
} = {}) {
	const project = tempDir("swy-vm-cleanup-test-");
	const runRoot = join(project, ".logs", "switchyard", "runs", RUN_ID);
	mkdirSync(join(runRoot, "resources"), { recursive: true });
	writeFileSync(
		join(runRoot, "run.json"),
		JSON.stringify({ state, cleanupState }),
	);
	if (intents) {
		writeFileSync(
			join(runRoot, "resources", "parallels-allocation-x.intent.json"),
			JSON.stringify({ vmName }),
		);
	}
	return project;
}
const report = (overrides = {}) => ({
	runId: RUN_ID,
	state: "succeeded",
	cleanupState: "complete",
	...overrides,
});

describe("vmRunCleanupProven", () => {
	test("proves cleanup when the run ended clean and its VM is gone", () => {
		const project = projectWithRun();
		assert.equal(
			vmRunCleanupProven(report(), project, { listVms: () => [] }),
			true,
		);
	});
	test("refuses when the allocated VM still exists", () => {
		const project = projectWithRun();
		const listVms = () => [`switchyard-work-${RUN_ID}-1`];
		assert.equal(vmRunCleanupProven(report(), project, { listVms }), false);
	});
	test("refuses when the VM listing failed", () => {
		const project = projectWithRun();
		assert.equal(
			vmRunCleanupProven(report(), project, { listVms: () => null }),
			false,
		);
	});
	test("refuses unfinished or failed run state", () => {
		const listVms = () => [];
		assert.equal(
			vmRunCleanupProven(report({ state: "failed" }), projectWithRun(), {
				listVms,
			}),
			false,
		);
		assert.equal(
			vmRunCleanupProven(
				report({ cleanupState: "pending" }),
				projectWithRun(),
				{ listVms },
			),
			false,
		);
		assert.equal(
			vmRunCleanupProven(
				report(),
				projectWithRun({ cleanupState: "pending" }),
				{ listVms },
			),
			false,
		);
	});
	test("refuses missing, malformed or unsafe evidence", () => {
		const listVms = () => [];
		assert.equal(
			vmRunCleanupProven(report(), projectWithRun({ intents: false }), {
				listVms,
			}),
			false,
		);
		assert.equal(
			vmRunCleanupProven(report(), projectWithRun({ vmName: "evil; rm" }), {
				listVms,
			}),
			false,
		);
		assert.equal(
			vmRunCleanupProven(report({ runId: "../x" }), projectWithRun(), {
				listVms,
			}),
			false,
		);
	});
});

describe("vmTaskResult", () => {
	test("reads the task result from the checkpoint and keeps the run id", () => {
		const dir = tempDir("swy-vm-cleanup-test-");
		const checkpoint = join(dir, "checkpoint.json");
		writeFileSync(
			checkpoint,
			JSON.stringify({ results: [{ taskId: "1", success: true }] }),
		);
		assert.deepEqual(vmTaskResult({ runId: RUN_ID }, checkpoint), {
			taskId: "1",
			success: true,
			runId: RUN_ID,
		});
	});
	test("prefers results carried by the report itself", () => {
		const missing = join(tempDir("swy-vm-cleanup-test-"), "absent.json");
		assert.deepEqual(
			vmTaskResult({ results: [{ taskId: "1", x: 1 }] }, missing),
			{ taskId: "1", x: 1 },
		);
	});
	test("returns null for a missing or malformed checkpoint", () => {
		const dir = tempDir("swy-vm-cleanup-test-");
		assert.equal(vmTaskResult({ runId: RUN_ID }, join(dir, "none.json")), null);
		const bad = join(dir, "bad.json");
		writeFileSync(bad, "{not json");
		assert.equal(vmTaskResult({ runId: RUN_ID }, bad), null);
	});
});

test("fixture status ignores the run store under .logs", () => {
	const fixture = createQualificationFixture(tempDir("swy-vm-cleanup-test-"));
	mkdirSync(join(fixture.projectPath, ".logs", "switchyard"), {
		recursive: true,
	});
	writeFileSync(
		join(fixture.projectPath, ".logs", "switchyard", "x.json"),
		"{}",
	);
	const status = execFileSync(
		"git",
		[
			"-C",
			fixture.projectPath,
			"status",
			"--porcelain",
			"--untracked-files=all",
		],
		{ encoding: "utf8" },
	);
	assert.equal(status, "");
});
