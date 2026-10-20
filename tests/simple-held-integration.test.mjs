// @test-phase: other
// `simple --integrate hold` verifies a diff and stores it without touching the
// project tree; `routing-run apply` later integrates exactly that diff against
// the current HEAD or refuses it with a closed reason (TASKS: "Let simple
// dispatch hold integration instead of forcing a kill").
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	acquireProjectLock,
	isProjectLockHeld,
	releaseProjectLockIfOwnedBy,
} from "../src/switchyard/run-store/project-locks.mjs";
import { readRun } from "../src/switchyard/run-store/run-records.mjs";
import {
	applyHeldIntegration,
	HELD_APPLY_REFUSALS,
} from "../src/switchyard/simple/held-apply.mjs";
import {
	commit,
	git,
	heldFixture,
	runHeld,
} from "./helpers/held-integration-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(
	tempDir("switchyard-held-store-"),
	"runs",
);

const read = (repo, path = "a.txt") =>
	readFileSync(join(repo.projectPath, path), "utf8");
const status = (repo) => git(repo.projectPath, ["status", "--porcelain"]);
const apply = (repo, runId, deps = {}) =>
	applyHeldIntegration(
		{
			projectPath: repo.projectPath,
			runId,
			deadlineMs: Date.now() + 60_000,
		},
		deps,
	);

async function held() {
	const repo = heldFixture();
	const result = await runHeld(repo);
	strictEqual(result.status, "succeeded", JSON.stringify(result));
	return { repo, result };
}

test("a held run verifies the diff but leaves the project tree and lock untouched", async () => {
	const { repo, result } = await held();
	strictEqual(read(repo), "base\n");
	strictEqual(status(repo), "");
	strictEqual(isProjectLockHeld(repo.projectPath), false);
	strictEqual(result.partialWorktree, null);
	strictEqual(result.integration.mode, "hold");
	strictEqual(result.integration.state, "held");
	strictEqual(
		result.integration.verifiedHead,
		git(repo.projectPath, ["rev-parse", "HEAD"]),
	);
	deepStrictEqual(result.changedFiles, ["a.txt"]);
	// The outputs are the ones the patch will produce, not the current tree.
	strictEqual(result.outputs[0].size, "candidate\n".length);
	for (const path of [
		result.integration.patchPath,
		result.integration.receiptPath,
	]) {
		ok(existsSync(path), path);
		strictEqual(statSync(path).mode & 0o777, 0o600);
	}
	ok(readFileSync(result.integration.patchPath, "utf8").includes("+candidate"));

	const record = await readRun(result.runId);
	strictEqual(record.state, "succeeded");
	strictEqual(record.terminalSummary.status, "held");
	deepStrictEqual(record.terminalSummary.integration, result.integration);
});

test("apply at the verified HEAD integrates the same diff once", async () => {
	const { repo, result } = await held();
	const applied = await apply(repo, result.runId);
	strictEqual(applied.ok, true, JSON.stringify(applied));
	strictEqual(applied.state, "applied");
	strictEqual(applied.recheck, "not_needed");
	strictEqual(applied.outputsMatchHeld, true);
	strictEqual(applied.heldRecord, "applied");
	strictEqual(applied.lockReleased, true);
	strictEqual(read(repo), "candidate\n");
	strictEqual(isProjectLockHeld(repo.projectPath), false);

	const record = await readRun(result.runId);
	strictEqual(record.terminalSummary.integration.state, "applied");
	strictEqual(
		record.terminalSummary.integration.applyRunId,
		applied.applyRunId,
	);
	const applyRecord = await readRun(applied.applyRunId);
	strictEqual(applyRecord.state, "succeeded");
	strictEqual(applyRecord.terminalSummary.status, "held_applied");

	const again = await apply(repo, result.runId);
	strictEqual(again.ok, false);
	strictEqual(again.reason, "held_receipt_consumed");
	strictEqual(read(repo), "candidate\n");
});

test("a peer commit to the declared file refuses as stale and leaves the tree alone", async () => {
	const { repo, result } = await held();
	writeFileSync(join(repo.projectPath, "a.txt"), "peer\n");
	commit(repo.projectPath, "peer");
	const refused = await apply(repo, result.runId);
	strictEqual(refused.reason, "held_receipt_stale");
	strictEqual(refused.detail, "declared_path_committed");
	strictEqual(read(repo), "peer\n");
	strictEqual(status(repo), "");
	strictEqual(isProjectLockHeld(repo.projectPath), false);
	const record = await readRun(result.runId);
	strictEqual(record.terminalSummary.integration.state, "held");
	strictEqual(
		record.terminalSummary.integration.lastApplyRefusal.reason,
		"held_receipt_stale",
	);
	strictEqual((await readRun(refused.applyRunId)).state, "failed");
});

test("an uncommitted edit to the declared file refuses as stale", async () => {
	const { repo, result } = await held();
	writeFileSync(join(repo.projectPath, "a.txt"), "owner edit\n");
	const refused = await apply(repo, result.runId);
	strictEqual(refused.reason, "held_receipt_stale");
	strictEqual(refused.detail, "declared_path_dirty");
	strictEqual(read(repo), "owner edit\n");
});

test("a peer manifest change refuses as stale even off the declared paths", async () => {
	const { repo, result } = await held();
	writeFileSync(join(repo.projectPath, "package.json"), "{}\n");
	commit(repo.projectPath, "peer manifest");
	const refused = await apply(repo, result.runId);
	strictEqual(refused.reason, "held_receipt_stale");
	strictEqual(refused.detail, "peer_history_unsafe");
	strictEqual(read(repo), "base\n");
});

test("an unrelated peer commit re-runs the acceptance checks at the new HEAD", async () => {
	const { repo, result } = await held();
	writeFileSync(join(repo.projectPath, "b.txt"), "peer\n");
	commit(repo.projectPath, "peer");
	const head = git(repo.projectPath, ["rev-parse", "HEAD"]);
	const seen = [];
	const passed = await apply(repo, result.runId, {
		runHeldRechecks: async (input) => {
			seen.push(input);
			return { ok: true };
		},
	});
	strictEqual(passed.ok, true, JSON.stringify(passed));
	strictEqual(passed.recheck, "passed");
	strictEqual(passed.appliedHead, head);
	strictEqual(seen.length, 1);
	strictEqual(seen[0].head, head);
	deepStrictEqual(seen[0].receipt.checks, ["grep -q candidate a.txt"]);
	strictEqual(
		seen[0].patch,
		readFileSync(result.integration.patchPath, "utf8"),
	);
	strictEqual(read(repo), "candidate\n");
});

test("a failing recheck refuses and never applies", async () => {
	const { repo, result } = await held();
	writeFileSync(join(repo.projectPath, "b.txt"), "peer\n");
	commit(repo.projectPath, "peer");
	const refused = await apply(repo, result.runId, {
		runHeldRechecks: async () => ({
			ok: false,
			detail: "check_failed",
			checkIndex: 1,
		}),
	});
	strictEqual(refused.reason, "held_recheck_failed");
	strictEqual(refused.checkIndex, 1);
	strictEqual(read(repo), "base\n");
});

test("a git apply conflict refuses with a closed reason", async () => {
	const { repo, result } = await held();
	const refused = await apply(repo, result.runId, {
		integrationGate: () => ({
			success: false,
			message: "Diff apply failed",
			reasonKind: "conflict",
		}),
	});
	strictEqual(refused.reason, "held_patch_conflict");
	strictEqual(read(repo), "base\n");
	strictEqual(isProjectLockHeld(repo.projectPath), false);
});

test("an edited patch or receipt is refused, never applied", async () => {
	for (const target of ["patchPath", "receiptPath"]) {
		const { repo, result } = await held();
		const path = result.integration[target];
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace("candidate", "tampered"),
		);
		const refused = await apply(repo, result.runId);
		strictEqual(refused.reason, "held_receipt_invalid", target);
		strictEqual(read(repo), "base\n");
	}
});

test("a held project lock refuses before any check", async () => {
	const { repo, result } = await held();
	await acquireProjectLock(repo.projectPath, "simple-peer-holder");
	try {
		const refused = await apply(repo, result.runId);
		strictEqual(refused.reason, "project_lock_held");
		strictEqual(refused.holderRunId, "simple-peer-holder");
	} finally {
		await releaseProjectLockIfOwnedBy(repo.projectPath, "simple-peer-holder");
	}
	strictEqual(read(repo), "base\n");
});

test("a run that was not held, or is unknown, is refused", async () => {
	const repo = heldFixture();
	const normal = await runHeld(repo, { integrateMode: "apply" });
	strictEqual(normal.status, "succeeded");
	strictEqual(normal.integration, undefined);
	strictEqual(read(repo), "candidate\n");
	strictEqual((await apply(repo, normal.runId)).reason, "held_receipt_invalid");
	strictEqual(
		(await apply(repo, "simple-missing")).reason,
		"held_run_not_found",
	);
	for (const reason of [
		"held_receipt_invalid",
		"held_run_not_found",
		"held_receipt_consumed",
		"held_receipt_stale",
		"held_recheck_failed",
		"held_patch_conflict",
		"project_lock_held",
	])
		ok(HELD_APPLY_REFUSALS.includes(reason), reason);
});
