// @test-phase: other
import { deepStrictEqual, strictEqual } from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseSimpleArgs } from "../src/switchyard/simple/args.mjs";
import { applyHeldIntegration } from "../src/switchyard/simple/held-apply.mjs";
import { heldFixture, runHeld } from "./helpers/held-integration-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(
	tempDir("held-report-store-"),
	"runs",
);
test("report hold preserves verified metadata and leaves host empty until exact apply", async () => {
	const repo = heldFixture();
	const options = parseSimpleArgs([
		repo.promptPath,
		"--project",
		repo.projectPath,
		"--capability",
		"standard",
		"--report",
		"report.md",
		"--integrate",
		"hold",
		"--timeout",
		"5",
	]);
	const report = "Observed source a.txt:1.\n";
	const held = await runHeld(repo, options, {
		executeProvider: async ({ worktreePath }) => {
			writeFileSync(join(worktreePath, "report.md"), report);
			return { success: true, writerLifecycle: "stopped" };
		},
	});
	strictEqual(held.status, "succeeded", JSON.stringify(held));
	strictEqual(held.resultKind, "report");
	strictEqual(existsSync(join(repo.projectPath, "report.md")), false);
	const receipt = JSON.parse(readFileSync(held.integration.receiptPath));
	deepStrictEqual(receipt.report, held.report);
	const applied = await applyHeldIntegration({
		projectPath: repo.projectPath,
		runId: held.runId,
		deadlineMs: Date.now() + 60_000,
	});
	strictEqual(applied.ok, true, JSON.stringify(applied));
	deepStrictEqual(applied.report, held.report);
	strictEqual(
		readFileSync(join(repo.projectPath, "report.md"), "utf8"),
		report,
	);
	strictEqual(
		(
			await applyHeldIntegration({
				projectPath: repo.projectPath,
				runId: held.runId,
			})
		).reason,
		"held_receipt_consumed",
	);
});
