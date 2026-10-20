// @test-phase: other
// Held-apply safety: a held receipt is bound to the run asked for, its store
// directory is never followed through a symlink, an apply that cannot record
// its outcome blocks every later apply, a failed mutating `git apply` is
// reported as unknown, and a recheck passes only with its checker stopped.
import { strictEqual, throws } from "node:assert";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	getRunRoot,
	readRun,
} from "../src/switchyard/run-store/run-records.mjs";
import { updateRunWithRetry } from "../src/switchyard/run-store/run-updates.mjs";
import { applyHeldIntegration } from "../src/switchyard/simple/held-apply.mjs";
import { holdVerifiedIntegration } from "../src/switchyard/simple/held-integration.mjs";
import { runHeldRechecks } from "../src/switchyard/simple/held-recheck.mjs";
import {
	commit,
	git,
	heldFixture,
	runHeld,
} from "./helpers/held-integration-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(
	tempDir("switchyard-held-safety-store-"),
	"runs",
);

const read = (repo) => readFileSync(join(repo.projectPath, "a.txt"), "utf8");
const apply = (repo, runId, deps = {}) =>
	applyHeldIntegration(
		{ projectPath: repo.projectPath, runId, deadlineMs: Date.now() + 60_000 },
		deps,
	);
const integrationOf = async (runId) =>
	(await readRun(runId)).terminalSummary.integration;

async function held() {
	const repo = heldFixture();
	const result = await runHeld(repo);
	strictEqual(result.status, "succeeded", JSON.stringify(result));
	return { repo, result };
}

test("another run's record at the requested run id is refused", async () => {
	const { repo, result: first } = await held();
	const second = await runHeld(repo);
	const refused = await apply(repo, first.runId, {
		readRun: (id) => readRun(id === first.runId ? second.runId : id),
	});
	strictEqual(refused.reason, "held_receipt_invalid");
	strictEqual(read(repo), "base\n");
});

test("hold refuses a planted held-integration symlink instead of following it", () => {
	const repo = heldFixture();
	const runId = "simple-held-planted-symlink";
	mkdirSync(getRunRoot(runId), { recursive: true, mode: 0o700 });
	symlinkSync(repo.projectPath, join(getRunRoot(runId), "held-integration"));
	const head = git(repo.projectPath, ["rev-parse", "HEAD"]);
	const diff = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-base\n+candidate\n";
	throws(() =>
		holdVerifiedIntegration({
			runId,
			taskId: "t",
			attemptId: "a",
			projectPath: repo.projectPath,
			diff: `diff --git a/a.txt b/a.txt\n${diff}`,
			baseRevision: head,
			verifiedHead: head,
			files: ["a.txt"],
			scopeFiles: ["a.txt"],
			readOnlyInputs: [],
			allowManifests: [],
			allowExecutables: [],
			checks: [],
			changedFiles: ["a.txt"],
			undeclaredPaths: [],
			declaredFingerprint: "unused",
			expectedOutputs: [],
		}),
	);
	strictEqual(existsSync(join(repo.projectPath, "held.patch")), false);
	strictEqual(existsSync(join(repo.projectPath, "receipt.json")), false);
	strictEqual(git(repo.projectPath, ["status", "--porcelain"]), "");
});

test("an apply whose outcome is unknown blocks every later apply", async () => {
	for (const gate of [
		() => ({ success: false, message: "Diff apply failed" }),
		() => {
			throw new Error("gate crashed");
		},
	]) {
		const { repo, result } = await held();
		const unknown = await apply(repo, result.runId, { integrationGate: gate });
		strictEqual(unknown.reason, "held_apply_state_unknown");
		const claim = await integrationOf(result.runId);
		strictEqual(claim.state, "applying");
		strictEqual(claim.applyRunId, unknown.applyRunId);
		const again = await apply(repo, result.runId);
		strictEqual(again.reason, "held_apply_state_unknown");
		strictEqual(again.detail, "interrupted_apply");
		strictEqual(again.earlierApplyRunId, unknown.applyRunId);
		strictEqual(read(repo), "base\n");
	}
});

test("a forward-check refusal returns the receipt to held", async () => {
	const { repo, result } = await held();
	const refused = await apply(repo, result.runId, {
		integrationGate: () => ({
			success: false,
			message: "Diff apply failed",
			reasonKind: "corrupt_patch",
		}),
	});
	strictEqual(refused.reason, "held_patch_conflict");
	const integration = await integrationOf(result.runId);
	strictEqual(integration.state, "held");
	strictEqual(integration.lastApplyRefusal.reason, "held_patch_conflict");
	strictEqual((await apply(repo, result.runId)).state, "applied");
	strictEqual(read(repo), "candidate\n");
});

test("an applied patch whose record write fails is never applied again", async () => {
	const { repo, result } = await held();
	const applied = await apply(repo, result.runId, {
		updateRunWithRetry: (runId, partial, ...rest) =>
			partial?.terminalSummary?.integration?.state === "applied"
				? Promise.reject(new Error("disk full"))
				: updateRunWithRetry(runId, partial, ...rest),
	});
	strictEqual(applied.ok, true);
	strictEqual(applied.heldRecord, "unconfirmed");
	strictEqual(read(repo), "candidate\n");
	// The owner discards the applied edit; the claim still blocks a re-apply.
	git(repo.projectPath, ["checkout", "--", "a.txt"]);
	const again = await apply(repo, result.runId);
	strictEqual(again.reason, "held_apply_state_unknown");
	strictEqual(again.detail, "interrupted_apply");
	strictEqual(read(repo), "base\n");
});

test("a recheck passes only when its checker writer is proven stopped", async () => {
	const repo = heldFixture();
	const head = git(repo.projectPath, ["rev-parse", "HEAD"]);
	const seen = [];
	const outcome = await runHeldRechecks(
		{
			applyRunId: "simple-apply-unstopped",
			projectPath: repo.projectPath,
			head,
			patch: "",
			receipt: {
				scopeFiles: ["a.txt"],
				allowManifests: [],
				allowExecutables: [],
				checks: ["true"],
				taskId: "t",
			},
			deadlineMs: Date.now() + 60_000,
		},
		{
			tmpdir: repo.root,
			updateRunWithRetry: async () => {},
			createSimpleCheckSessions: () => ({
				prepare: async () => {},
				run: async () => ({ success: true }),
				remove: () => {
					throw new Error("check_group_unconfirmed");
				},
			}),
			cleanupSimpleWorktree: async (_runId, claim, { writerStopped }) => {
				seen.push(writerStopped);
				return { removed: false, path: claim.path, reason: "writer_live" };
			},
		},
	);
	strictEqual(outcome.ok, false);
	strictEqual(outcome.detail, "checker_not_stopped");
	strictEqual(outcome.checker, "retained");
	strictEqual(seen[0], false);
});

test("a retained checker fails the apply run's cleanup", async () => {
	const { repo, result } = await held();
	writeFileSync(join(repo.projectPath, "b.txt"), "peer\n");
	commit(repo.projectPath, "peer");
	const refused = await apply(repo, result.runId, {
		runHeldRechecks: async () => ({
			ok: false,
			detail: "checker_not_stopped",
			checker: "retained",
		}),
	});
	strictEqual(refused.reason, "held_recheck_failed");
	strictEqual(refused.checker, "retained");
	strictEqual((await readRun(refused.applyRunId)).cleanupState, "failed");
	strictEqual((await integrationOf(result.runId)).state, "held");
	strictEqual(read(repo), "base\n");
});
