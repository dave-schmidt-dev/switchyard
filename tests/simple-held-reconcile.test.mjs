// @test-phase: other
import { ok, strictEqual } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { integrationGate } from "../src/switchyard/integrate/index.mjs";
import { acquireProjectLock } from "../src/switchyard/run-store/project-locks.mjs";
import { readRun } from "../src/switchyard/run-store/run-records.mjs";
import { updateRunWithRetry } from "../src/switchyard/run-store/run-updates.mjs";
import { applyHeldIntegration } from "../src/switchyard/simple/held-apply.mjs";
import {
	git,
	heldFixture,
	runHeld,
} from "./helpers/held-integration-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(
	tempDir("held-reconcile-store-"),
	"runs",
);
const dead = () => {
	throw Object.assign(new Error("gone"), { code: "ESRCH" });
};
const apply = (repo, runId, deps = {}, reconcileOnly = false) =>
	applyHeldIntegration(
		{
			projectPath: repo.projectPath,
			runId,
			deadlineMs: Date.now() + 60_000,
			reconcileOnly,
		},
		deps,
	);
async function stuck(reasonKind = "conflict", keptOnly = false) {
	const repo = heldFixture();
	const held = await runHeld(
		repo,
		{},
		keptOnly
			? {
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(join(worktreePath, "b.txt"), "kept candidate\n");
						return { success: true, writerLifecycle: "stopped" };
					},
				}
			: {},
	);
	strictEqual(held.status, "succeeded");
	const failed = await apply(repo, held.runId, {
		integrationGate: () => ({
			success: false,
			message: "Diff apply failed",
			reasonKind,
		}),
		updateRunWithRetry: (id, part, ...rest) =>
			part.terminalSummary?.integration?.state === "held"
				? Promise.reject(new Error("lost annotation"))
				: updateRunWithRetry(id, part, ...rest),
	});
	strictEqual(
		(await readRun(held.runId)).terminalSummary.integration.state,
		"applying",
	);
	return { repo, held, failed };
}
test("reconciliation retries only a lost pre-mutation annotation and audits it once", async () => {
	const { repo, held, failed } = await stuck();
	const before = git(repo.projectPath, ["status", "--porcelain"]);
	const fixed = await apply(repo, held.runId, { probePid: dead }, true);
	strictEqual(fixed.ok, true, JSON.stringify(fixed));
	strictEqual(fixed.state, "held");
	const record = await readRun(held.runId);
	strictEqual(
		record.terminalSummary.integration.reconciliation.earlierApplyRunId,
		failed.applyRunId,
	);
	strictEqual(
		record.terminalSummary.integration.reconciliation.reconciledBy,
		fixed.applyRunId,
	);
	strictEqual(git(repo.projectPath, ["status", "--porcelain"]), before);
	strictEqual(readFileSync(join(repo.projectPath, "a.txt"), "utf8"), "base\n");
	strictEqual(
		(await apply(repo, held.runId, { probePid: dead }, true)).ok,
		false,
	);
	strictEqual((await apply(repo, held.runId)).ok, true);
});
test("live, unknown, missing and forged earlier proofs refuse", async () => {
	for (const kind of [
		"live",
		"unknown",
		"missing",
		"binding",
		"cleanup",
		"checker",
	]) {
		const { repo, held, failed } = await stuck();
		if (kind === "binding")
			await updateRunWithRetry(failed.applyRunId, {
				terminalSummary: {
					...(await readRun(failed.applyRunId)).terminalSummary,
					heldBinding: null,
				},
			});
		if (kind === "cleanup")
			await updateRunWithRetry(failed.applyRunId, { cleanupState: "failed" });
		const refused = await apply(
			repo,
			held.runId,
			{
				probePid:
					kind === "live"
						? () => {}
						: kind === "unknown"
							? () => {
									throw new Error("unknown");
								}
							: dead,
				...(kind === "checker"
					? {
							readRun: async (id) => {
								const record = await readRun(id);
								return id === failed.applyRunId
									? {
											...record,
											worktree: { state: "retained", writerStopped: false },
										}
									: record;
							},
						}
					: {}),
				...(kind === "missing"
					? {
							readRun: (id) =>
								id === failed.applyRunId
									? Promise.reject(new Error("gone"))
									: readRun(id),
						}
					: {}),
			},
			true,
		);
		strictEqual(refused.ok, false, kind);
		strictEqual(
			(await readRun(held.runId)).terminalSummary.integration.state,
			"applying",
			kind,
		);
	}
});
test("unknown mutation and already-consumed output refuse even after inputs restored", async () => {
	const unknown = await stuck("integration_state_unknown");
	strictEqual(
		(await apply(unknown.repo, unknown.held.runId, { probePid: dead }, true))
			.ok,
		false,
	);
	const repo = heldFixture();
	const held = await runHeld(repo);
	const applied = await apply(repo, held.runId, {
		updateRunWithRetry: (id, part, ...rest) =>
			part.terminalSummary?.integration?.state === "applied"
				? Promise.reject(new Error("lost applied"))
				: updateRunWithRetry(id, part, ...rest),
	});
	strictEqual(applied.ok, true);
	git(repo.projectPath, ["checkout", "--", "a.txt"]);
	strictEqual(
		(await apply(repo, held.runId, { probePid: dead }, true)).ok,
		false,
	);
});
test("full scope drift and reset persistence failure retain the applying claim", async () => {
	for (const kind of ["drift", "write"]) {
		const { repo, held } = await stuck();
		if (kind === "drift")
			writeFileSync(join(repo.projectPath, "a.txt"), "owner\n");
		const result = await apply(
			repo,
			held.runId,
			{
				probePid: dead,
				...(kind === "write"
					? {
							updateRunWithRetry: (id, part, ...rest) =>
								part.terminalSummary?.integration?.state === "held"
									? Promise.reject(new Error("disk"))
									: updateRunWithRetry(id, part, ...rest),
						}
					: {}),
			},
			true,
		);
		strictEqual(result.ok, false);
		strictEqual(
			(await readRun(held.runId)).terminalSummary.integration.state,
			"applying",
		);
	}
});
test("concurrent reconciliation cannot consume the same claim twice", async () => {
	const { repo, held } = await stuck();
	const results = await Promise.all([
		apply(repo, held.runId, { probePid: dead }, true),
		apply(repo, held.runId, { probePid: dead }, true),
	]);
	strictEqual(results.filter((r) => r.ok).length, 1);
	ok(results.some((r) => !r.ok));
});

test("lost reconciliation terminal record never reports success", async () => {
	const { repo, held } = await stuck();
	const result = await apply(
		repo,
		held.runId,
		{
			probePid: dead,
			updateRunWithRetry: (id, part, ...rest) =>
				part.terminalSummary?.status === "held_reconciled"
					? Promise.reject(new Error("lost final record"))
					: updateRunWithRetry(id, part, ...rest),
		},
		true,
	);
	strictEqual(result.ok, false);
	strictEqual(result.reason, "run_store_write_failed");
	// The audited held annotation is durable, but no complete operation was claimed.
	strictEqual(
		(await readRun(held.runId)).terminalSummary.integration.state,
		"held",
	);
});

test("CLI reconcile-held dispatches metadata-only mode and emits one refusal envelope", async () => {
	const { handleRoutingRun } = await import(
		"../src/switchyard/simple/routing-cli.mjs"
	);
	const repo = heldFixture();
	const lines = [];
	const signalProcess = {};
	await handleRoutingRun(
		[
			"reconcile-held",
			"--project",
			repo.projectPath,
			"--run-id",
			"simple-held",
			"--timeout",
			"1",
		],
		{
			applyHeldIntegration: async (options, deps) => {
				strictEqual(options.reconcileOnly, true);
				deps.onProgress({ phase: "reconcile" });
				return {
					ok: false,
					state: "refused",
					reason: "held_apply_state_unknown",
				};
			},
			writeResult: (line) => lines.push(JSON.parse(line)),
			writeProgress: () => {},
			signalProcess,
		},
	);
	strictEqual(lines.length, 1);
	strictEqual(signalProcess.exitCode, 1);
});

for (const firstReconciles of [true, false]) {
	test(`reconcile racing apply with ${firstReconciles ? "reconcile" : "apply"} holding the lock first never replays bytes`, {
		timeout: 15_000,
	}, async () => {
		const { repo, held } = await stuck();
		let acquired;
		let release;
		const acquiredBarrier = new Promise((resolve) => {
			acquired = resolve;
		});
		const releaseBarrier = new Promise((resolve) => {
			release = resolve;
		});
		let gateCalls = 0;
		const countedGate = (...args) => {
			gateCalls += 1;
			return integrationGate(...args);
		};
		const first = apply(
			repo,
			held.runId,
			{
				probePid: dead,
				integrationGate: countedGate,
				acquireProjectLock: async (projectPath, applyRunId) => {
					await acquireProjectLock(projectPath, applyRunId);
					acquired();
					await releaseBarrier;
				},
			},
			firstReconciles,
		);
		await acquiredBarrier;
		let second;
		try {
			second = await apply(
				repo,
				held.runId,
				{ probePid: dead, integrationGate: countedGate },
				!firstReconciles,
			);
		} finally {
			release();
		}
		const winner = await first;
		strictEqual(second.reason, "project_lock_held");
		strictEqual(winner.ok, firstReconciles);
		if (!firstReconciles)
			strictEqual(winner.reason, "held_apply_state_unknown");
		const record = await readRun(held.runId);
		strictEqual(
			record.terminalSummary.integration.state,
			firstReconciles ? "held" : "applying",
		);
		strictEqual(gateCalls, 0);
		strictEqual(
			readFileSync(join(repo.projectPath, "a.txt"), "utf8"),
			"base\n",
		);
		if (record.terminalSummary.integration.state === "applying") {
			const reconciled = await apply(
				repo,
				held.runId,
				{ probePid: dead, integrationGate: countedGate },
				true,
			);
			strictEqual(reconciled.ok, true, JSON.stringify(reconciled));
			strictEqual(reconciled.state, "held");
		}
		strictEqual(gateCalls, 0);
		strictEqual(
			(await apply(repo, held.runId, { integrationGate: countedGate })).ok,
			true,
		);
		strictEqual(gateCalls, 1);
		strictEqual(
			(await apply(repo, held.runId, { integrationGate: countedGate })).reason,
			"held_receipt_consumed",
		);
		strictEqual(gateCalls, 1);
		strictEqual(
			readFileSync(join(repo.projectPath, "a.txt"), "utf8"),
			"candidate\n",
		);
		strictEqual(
			(await readRun(held.runId)).terminalSummary.integration.state,
			"applied",
		);
	});
}

test("expired or cancelled reconciliation leaves the applying proof untouched", async () => {
	for (const cancelled of [false, true]) {
		const { repo, held } = await stuck();
		const result = await applyHeldIntegration(
			{
				projectPath: repo.projectPath,
				runId: held.runId,
				reconcileOnly: true,
				deadlineMs: cancelled ? Date.now() + 60_000 : Date.now() - 1,
				signal: cancelled ? AbortSignal.abort() : undefined,
			},
			{ probePid: dead },
		);
		strictEqual(result.ok, false);
		strictEqual(
			(await readRun(held.runId)).terminalSummary.integration.state,
			"applying",
		);
	}
});

test("kept output drift refuses even when the declared-input fingerprint still matches", async () => {
	const { repo, held } = await stuck("conflict", true);
	strictEqual(readFileSync(join(repo.projectPath, "a.txt"), "utf8"), "base\n");
	writeFileSync(join(repo.projectPath, "b.txt"), "owner changed kept path\n");
	const result = await apply(repo, held.runId, { probePid: dead }, true);
	strictEqual(result.ok, false);
	strictEqual(result.reason, "held_receipt_stale");
	strictEqual(
		(await readRun(held.runId)).terminalSummary.integration.state,
		"applying",
	);
});
