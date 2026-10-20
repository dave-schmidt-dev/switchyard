// @test-phase: other
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readRun } from "../src/switchyard/run-store/run-records.mjs";
import { updateRunWithRetry } from "../src/switchyard/run-store/run-updates.mjs";
import { applyHeldIntegration } from "../src/switchyard/simple/held-apply.mjs";
import { runHeldRechecks } from "../src/switchyard/simple/held-recheck.mjs";
import {
	git,
	heldFixture,
	runHeld,
} from "./helpers/held-integration-fixtures.mjs";
import { nestedSandboxSkip } from "./helpers/nested-sandbox.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(
	tempDir("held-overlay-store-"),
	"runs",
);
const apply = (repo, runId, deps = {}) =>
	applyHeldIntegration(
		{ projectPath: repo.projectPath, runId, deadlineMs: Date.now() + 120_000 },
		deps,
	);
async function overlay() {
	const repo = heldFixture();
	writeFileSync(join(repo.projectPath, "a.txt"), "dirty writable\n");
	writeFileSync(join(repo.projectPath, "b.txt"), "dirty read only\n");
	const result = await runHeld(repo, {
		dirtyOverlay: true,
		readOnlyInputs: ["b.txt"],
	});
	strictEqual(result.status, "succeeded", JSON.stringify(result));
	return { repo, result };
}
function advance(repo) {
	writeFileSync(join(repo.projectPath, "c.txt"), "unrelated peer\n");
	git(repo.projectPath, ["add", "c.txt"]);
	git(repo.projectPath, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"peer",
	]);
}
test("held overlay preserves writable and readonly bytes until apply, without publishing raw inputs", async () => {
	const { repo, result } = await overlay();
	strictEqual(
		readFileSync(join(repo.projectPath, "a.txt"), "utf8"),
		"dirty writable\n",
	);
	const receipt = JSON.parse(readFileSync(result.integration.receiptPath));
	strictEqual(receipt.schemaVersion, 3);
	deepStrictEqual(
		receipt.dirtyOverlay.paths.map((p) => p.path),
		["a.txt", "b.txt"],
	);
	ok(receipt.dirtyOverlay.paths.every((p) => !Object.hasOwn(p, "bytes")));
	ok(
		!JSON.stringify(result).includes(
			Buffer.from("dirty read only\n").toString("base64"),
		),
	);
	const applied = await apply(repo, result.runId);
	strictEqual(applied.ok, true, JSON.stringify(applied));
	strictEqual(applied.outputsMatchHeld, true);
	strictEqual(
		readFileSync(join(repo.projectPath, "a.txt"), "utf8"),
		"candidate\n",
	);
	strictEqual(
		readFileSync(join(repo.projectPath, "b.txt"), "utf8"),
		"dirty read only\n",
	);
});
test("writable, readonly and malformed overlay drift refuses before mutation", async () => {
	for (const path of ["a.txt", "b.txt", "receipt"]) {
		const { repo, result } = await overlay();
		if (path !== "receipt")
			writeFileSync(join(repo.projectPath, path), "owner drift\n");
		else {
			const receipt = JSON.parse(readFileSync(result.integration.receiptPath));
			receipt.dirtyOverlay.paths[0].size = -1;
			const bytes = `${JSON.stringify(receipt)}\n`;
			writeFileSync(result.integration.receiptPath, bytes);
			const record = await readRun(result.runId);
			await updateRunWithRetry(result.runId, {
				terminalSummary: {
					...record.terminalSummary,
					integration: {
						...record.terminalSummary.integration,
						receiptSha256: createHash("sha256").update(bytes).digest("hex"),
					},
				},
			});
		}
		const applied = await apply(repo, result.runId);
		strictEqual(applied.ok, false, path);
		strictEqual(
			(await readRun(result.runId)).terminalSummary.integration.state,
			"held",
		);
		strictEqual(
			readFileSync(join(repo.projectPath, "a.txt"), "utf8"),
			path === "a.txt" ? "owner drift\n" : "dirty writable\n",
		);
	}
});
test("HEAD-advance recheck restores original overlay identity and baseline in checker options", async () => {
	const { repo, result } = await overlay();
	advance(repo);
	let seen;
	const applied = await apply(repo, result.runId, {
		runHeldRechecks: (input) =>
			runHeldRechecks(input, {
				tmpdir: repo.root,
				updateRunWithRetry: async () => {},
				createSimpleCheckSessions: (options) => {
					seen = options;
					return {
						prepare: async () => {},
						run: async () => ({ success: true }),
						remove: () => {},
					};
				},
				cleanupSimpleWorktree: async (_id, claim) => ({
					removed: true,
					path: claim.path,
				}),
			}),
	});
	strictEqual(applied.ok, true, JSON.stringify(applied));
	strictEqual(seen.baseTree, null);
	deepStrictEqual(
		seen.dirtyOverlayReceipt.paths.map((p) =>
			Buffer.from(p.bytes, "base64").toString(),
		),
		["dirty writable\n", "dirty read only\n"],
	);
	strictEqual(
		seen.dirtyOverlayReceipt.receiptHash,
		JSON.parse(readFileSync(result.integration.receiptPath)).dirtyOverlay
			.receiptHash,
	);
});
test("a real overlay checker at advanced HEAD runs against captured readonly input", {
	skip: nestedSandboxSkip,
}, async () => {
	const repo = heldFixture();
	writeFileSync(join(repo.projectPath, "a.txt"), "dirty writable\n");
	writeFileSync(join(repo.projectPath, "b.txt"), "dirty read only\n");
	const result = await runHeld(repo, {
		dirtyOverlay: true,
		readOnlyInputs: ["b.txt"],
		checks: ["grep -q 'dirty read only' b.txt"],
	});
	strictEqual(result.status, "succeeded", JSON.stringify(result));
	advance(repo);
	const applied = await apply(repo, result.runId, { tmpdir: repo.root });
	strictEqual(applied.ok, true, JSON.stringify(applied));
	strictEqual((await readRun(applied.applyRunId)).worktree.state, "removed");
});
