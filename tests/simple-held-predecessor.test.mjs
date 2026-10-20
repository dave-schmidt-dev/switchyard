// @test-phase: other
import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readRun } from "../src/switchyard/run-store/run-records.mjs";
import { updateRunWithRetry } from "../src/switchyard/run-store/run-updates.mjs";
import { applyHeldIntegration } from "../src/switchyard/simple/held-apply.mjs";
import { resolvePredecessorReceipt } from "../src/switchyard/simple/recovery.mjs";
import {
	git,
	heldFixture,
	runHeld,
} from "./helpers/held-integration-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(
	tempDir("held-predecessor-store-"),
	"runs",
);
async function fixture(path = "new.txt") {
	const repo = heldFixture();
	const held = await runHeld(
		repo,
		{ files: [path] },
		{
			executeProvider: async ({ worktreePath }) => {
				mkdirSync(dirname(join(worktreePath, path)), { recursive: true });
				writeFileSync(join(worktreePath, path), "predecessor output\n");
				return { success: true, writerLifecycle: "stopped" };
			},
		},
	);
	strictEqual(held.status, "succeeded", JSON.stringify(held));
	return { repo, held };
}
const apply = (repo, runId, deps = {}) =>
	applyHeldIntegration(
		{ projectPath: repo.projectPath, runId, deadlineMs: Date.now() + 60_000 },
		deps,
	);
const resolve = (receipt, repo, deps = {}) =>
	resolvePredecessorReceipt(receipt, repo.projectPath, deps);
test("applied hold publishes exact durable predecessor and transports untracked readonly input", async () => {
	const { repo, held } = await fixture();
	await rejects(resolve(held, repo), {
		code: "predecessor_receipt_unverified",
	});
	const applied = await apply(repo, held.runId);
	strictEqual(applied.ok, true, JSON.stringify(applied));
	const durable = await resolve(applied, repo);
	deepStrictEqual(durable.outputs, applied.outputs);
	strictEqual(durable.baseRevision, applied.appliedHead);
	const next = await runHeld(
		repo,
		{
			dirtyOverlay: true,
			readOnlyInputs: ["new.txt"],
			predecessorReceipt: applied,
		},
		{
			executeProvider: async ({ worktreePath }) => {
				strictEqual(
					readFileSync(join(worktreePath, "new.txt"), "utf8"),
					"predecessor output\n",
				);
				writeFileSync(join(worktreePath, "a.txt"), "dependent\n");
				return { success: true, writerLifecycle: "stopped" };
			},
		},
	);
	strictEqual(next.status, "succeeded", JSON.stringify(next));
	strictEqual((await apply(repo, next.runId)).ok, true);
	strictEqual(
		readFileSync(join(repo.projectPath, "a.txt"), "utf8"),
		"dependent\n",
	);
});
test("forged, drifted, cross-project, unconfirmed and cleanup-failed predecessors refuse", async () => {
	for (const kind of [
		"forged",
		"drift",
		"cross",
		"cleanup",
		"missing",
		"binding",
		"stale",
	]) {
		const { repo, held } = await fixture();
		const applied = await apply(repo, held.runId);
		strictEqual(applied.ok, true);
		let supplied = applied;
		let consumer = repo;
		if (kind === "forged")
			supplied = {
				...applied,
				outputs: applied.outputs.map((o) => ({ ...o, sha256: "0".repeat(64) })),
			};
		if (kind === "drift")
			writeFileSync(join(repo.projectPath, "new.txt"), "owner drift\n");
		if (kind === "cross") consumer = heldFixture();
		if (kind === "cleanup")
			await updateRunWithRetry(applied.applyRunId, { cleanupState: "failed" });
		if (kind === "binding")
			await updateRunWithRetry(applied.applyRunId, {
				terminalSummary: {
					...(await readRun(applied.applyRunId)).terminalSummary,
					heldBinding: null,
				},
			});
		if (kind === "stale") {
			writeFileSync(join(repo.projectPath, "b.txt"), "peer\n");
			git(repo.projectPath, ["add", "b.txt"]);
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
		await rejects(
			resolve(
				supplied,
				consumer,
				kind === "missing"
					? {
							readRun: (id) =>
								id === applied.applyRunId
									? Promise.reject(new Error("gone"))
									: readRun(id),
						}
					: {},
			),
			{ code: "predecessor_receipt_unverified" },
			kind,
		);
	}
});
test("successful mutation with lost held-state write remains unusable as predecessor", async () => {
	const { repo, held } = await fixture();
	const applied = await apply(repo, held.runId, {
		updateRunWithRetry: (id, part, ...rest) =>
			part.terminalSummary?.integration?.state === "applied"
				? Promise.reject(new Error("lost record"))
				: updateRunWithRetry(id, part, ...rest),
	});
	strictEqual(applied.ok, true);
	strictEqual(applied.heldRecord, "unconfirmed");
	await rejects(resolve(applied, repo), {
		code: "predecessor_receipt_unverified",
	});
});

test("wrong-kind, receipt and task provenance refuse despite matching outputs", async () => {
	for (const kind of ["kind", "receipt", "task"]) {
		const { repo, held } = await fixture();
		const applied = await apply(repo, held.runId);
		const record = await readRun(applied.applyRunId);
		const forged = {
			...record,
			...(kind === "kind" ? { initialHostFingerprint: "other-run-kind" } : {}),
			...(kind === "receipt"
				? { tasksFilePath: join(repo.root, "other-receipt") }
				: {}),
			...(kind === "task" ? { orderedTaskIds: ["other-task"] } : {}),
		};
		await rejects(
			resolve(applied, repo, {
				readRun: (id) =>
					id === applied.applyRunId ? Promise.resolve(forged) : readRun(id),
			}),
			{ code: "predecessor_receipt_unverified" },
		);
	}
});

test("static symlink parents refuse before reading an apparent matching output", async () => {
	const { repo, held } = await fixture("sub/new.txt");
	const applied = await apply(repo, held.runId);
	strictEqual(applied.ok, true);
	renameSync(join(repo.projectPath, "sub"), join(repo.root, "outside"));
	symlinkSync(join(repo.root, "outside"), join(repo.projectPath, "sub"));
	await rejects(resolve(applied, repo), {
		code: "predecessor_receipt_unverified",
	});
});

test("malformed durable output projections are refused before resolving live paths", async () => {
	const { appliedHeldPredecessor } = await import(
		"../src/switchyard/simple/held-predecessor.mjs"
	);
	const { createHash } = await import("node:crypto");
	for (const kind of ["escape", "shape"]) {
		const { repo, held } = await fixture();
		const applied = await apply(repo, held.runId);
		const record = await readRun(held.runId);
		const applyRecord = await readRun(applied.applyRunId);
		const outputs =
			kind === "escape"
				? [{ ...applied.outputs[0], path: "../outside.txt" }]
				: [{ ...applied.outputs[0], size: -1 }];
		writeFileSync(join(repo.root, "outside.txt"), "predecessor output\n");
		const receipt = JSON.parse(readFileSync(held.integration.receiptPath));
		receipt.expectedOutputs = outputs;
		const bytes = `${JSON.stringify(receipt)}\n`;
		writeFileSync(held.integration.receiptPath, bytes);
		const receiptSha256 = createHash("sha256").update(bytes).digest("hex");
		const forgedHeld = {
			...record,
			terminalSummary: {
				...record.terminalSummary,
				integration: {
					...record.terminalSummary.integration,
					receiptSha256,
				},
			},
		};
		const forgedApply = {
			...applyRecord,
			terminalSummary: {
				...applyRecord.terminalSummary,
				outputs,
				heldBinding: {
					...applyRecord.terminalSummary.heldBinding,
					receiptSha256,
				},
			},
		};
		await rejects(
			appliedHeldPredecessor(
				forgedHeld,
				repo.projectPath,
				async () => forgedApply,
			),
			{ code: "predecessor_receipt_unverified" },
		);
	}
});

test("lost apply terminal persistence refuses predecessor even with applied held annotation", async () => {
	const { repo, held } = await fixture();
	const applied = await apply(repo, held.runId, {
		updateRunWithRetry: (id, part, ...rest) =>
			part.terminalSummary?.status === "held_applied"
				? Promise.reject(new Error("lost terminal"))
				: updateRunWithRetry(id, part, ...rest),
	});
	strictEqual(applied.ok, true);
	strictEqual(applied.applyRecord, "unconfirmed");
	strictEqual(
		(await readRun(held.runId)).terminalSummary.integration.state,
		"applied",
	);
	await rejects(resolve(applied, repo), {
		code: "predecessor_receipt_unverified",
	});
});
