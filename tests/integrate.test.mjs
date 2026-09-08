import { deepStrictEqual, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	integrationGate,
	validateExactPathSet,
	validateIntegratedCommitAncestry,
	validateIntegratedCommitPaths,
	validateNoTrackedPathOverlap,
} from "../src/switchyard/integrate/index.mjs";
import {
	readLedgerFromStore,
	recordExternalCompletionToStore,
} from "../src/switchyard/ledger/index.mjs";
import { captureDirtyOverlay } from "../src/switchyard/lifecycle/index.mjs";
import {
	acquireCheckpointLease,
	claimCheckpointOwnership,
	reconcileExternalCompletion,
	releaseCheckpointLease,
	releaseCheckpointOwnership,
} from "../src/switchyard/runner/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const fixtures = [];
let savedRunStoreRoot;
let savedRunStoreRootSet = false;

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture() {
	const root = tempDir("switchyard-reconcile-");
	if (!savedRunStoreRootSet) {
		savedRunStoreRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		savedRunStoreRootSet = true;
	}
	process.env.SWITCHYARD_RUN_STORE_ROOT = root;
	fixtures.push(root);
	const project = join(root, "project");
	const tasks =
		"### Task 1.1: External\n- **Status:** pending\n- **Type:** implementation\n- **Executor:** switchyard\n- **Files:** src/changed.mjs\n";
	const tasksFilePath = join(project, "tasks.md");
	const sourceCheckpointPath = join(root, "source.checkpoint.json");
	const successorCheckpointPath = join(root, "successor.checkpoint.json");
	const sourceOwner = {
		runId: "external-run",
		processStartIdentity: "host",
		nonce: "source",
	};
	mkdirProject(project, root);
	git(project, "config", "user.email", "test@example.invalid");
	git(project, "config", "user.name", "Test");
	writeFileSync(tasksFilePath, tasks);
	git(project, "add", "tasks.md");
	git(project, "commit", "-qm", "base");
	writeFileSync(
		join(project, "src", "changed.mjs"),
		"export const done = true;\n",
	);
	git(project, "add", "src/changed.mjs");
	git(project, "commit", "-qm", "integrated");
	const integratedCommit = git(project, "rev-parse", "HEAD");
	writeFileSync(
		sourceCheckpointPath,
		JSON.stringify(
			{
				version: 3,
				revision: 4,
				owner: sourceOwner,
				ownershipReleased: false,
				tasksFilePath,
				completedTaskIds: [],
				results: [],
				taskAttempts: { 1.1: 1 },
				taskBases: {},
				integrationIntents: {},
			},
			null,
			2,
		),
	);
	const receiptPath = join(root, "receipt.json");
	const receipt = {
		version: 1,
		kind: "external_completion",
		taskId: "1.1",
		attempt: 1,
		sourceOwner,
		sourceRevision: 4,
		contractHash: createHash("sha256").update(tasks).digest("hex"),
		integratedCommit,
		changedPaths: ["src/changed.mjs"],
		requiredPaths: ["src/changed.mjs"],
		cleanup: { status: "complete" },
		providerSuccess: false,
		nextRunOptions: {
			platform: "macos",
			maxTasks: 1,
			stopOnFailure: true,
			checkpointPath: successorCheckpointPath,
		},
		ownerUid: typeof process.getuid === "function" ? process.getuid() : null,
		mode: 0o600,
	};
	writeFileSync(receiptPath, JSON.stringify(receipt));
	chmodSync(receiptPath, 0o600);
	receipt.ownerUid = statSync(receiptPath).uid;
	writeFileSync(receiptPath, JSON.stringify(receipt));
	chmodSync(receiptPath, 0o600);
	return {
		root,
		project,
		tasksFilePath,
		sourceCheckpointPath,
		successorCheckpointPath,
		receiptPath,
		receipt,
	};
}

function mkdirProject(project, root) {
	mkdirSync(join(project, "src"), { recursive: true });
	git(root, "init", "-q", project);
}

function inputFor(fixtureData, overrides = {}) {
	return {
		...fixtureData.receipt,
		receiptPath: fixtureData.receiptPath,
		sourceCheckpointPath: fixtureData.sourceCheckpointPath,
		successorCheckpointPath: fixtureData.successorCheckpointPath,
		tasksFilePath: fixtureData.tasksFilePath,
		projectPath: fixtureData.project,
		...overrides,
	};
}

afterEach(() => {
	for (const path of fixtures.splice(0))
		rmSync(path, { recursive: true, force: true });
	if (savedRunStoreRootSet) {
		if (savedRunStoreRoot === undefined)
			delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		else process.env.SWITCHYARD_RUN_STORE_ROOT = savedRunStoreRoot;
		savedRunStoreRoot = undefined;
		savedRunStoreRootSet = false;
	}
});

describe("external completion reconciliation", () => {
	it("records once, keeps provider success false, and tolerates unrelated untracked files", async () => {
		const f = fixture();
		writeFileSync(join(f.project, "unrelated.txt"), "not part of the task\n");
		const result = await reconcileExternalCompletion(inputFor(f));
		strictEqual(result.status, "recorded");
		strictEqual(result.providerSuccess, false);
		const successor = JSON.parse(
			readFileSync(f.successorCheckpointPath, "utf8"),
		);
		strictEqual(successor.externalCompletion.providerSuccess, false);
		strictEqual(successor.completedTaskIds.includes("1.1"), true);
		strictEqual(
			(await readLedgerFromStore(f.root)).filter(
				(entry) => entry.reconciliationId === result.reconciliationId,
			).length,
			1,
		);
	});

	it("publishes a released successor that the next run can claim and release", async () => {
		const f = fixture();
		const result = await reconcileExternalCompletion(inputFor(f));
		const successor = JSON.parse(
			readFileSync(f.successorCheckpointPath, "utf8"),
		);
		strictEqual(result.status, "recorded");
		strictEqual(successor.ownershipReleased, true);
		const nextOwner = {
			runId: "next-run",
			processStartIdentity: "host",
			nonce: "next",
		};
		const claimed = claimCheckpointOwnership(
			f.successorCheckpointPath,
			f.tasksFilePath,
			{
				queueIdentity: successor.queueIdentity,
				runOptions: successor.runOptions,
			},
			nextOwner,
		);
		strictEqual(claimed.owner.runId, nextOwner.runId);
		strictEqual(claimed.ownershipReleased, false);
		strictEqual(
			releaseCheckpointOwnership(f.successorCheckpointPath, claimed),
			true,
		);
	});

	it("preserves unrelated task bases, intents, allocations, retries, and cleanup markers", async () => {
		const f = fixture();
		const source = JSON.parse(readFileSync(f.sourceCheckpointPath, "utf8"));
		const unrelatedBase = {
			ref: "unrelated-ref",
			tree: "a".repeat(40),
			cleanupContext: {
				operation: "helper",
				runId: "other-run",
				taskId: "2.2",
				attemptId: "other-attempt",
				descriptorIdentity: "other-descriptor",
				workspaceId: "other-workspace",
				processStartIdentity: null,
			},
		};
		const unrelatedIntent = {
			operation: {
				taskId: "2.2",
				runId: "other-run",
				attempt: 1,
				baseTree: "b".repeat(40),
				patchHash: "c".repeat(64),
				paths: ["src/other.mjs"],
			},
			status: "pending",
			beforeState: "d".repeat(64),
		};
		source.taskAttempts["2.2"] = 1;
		source.taskBases = { 2.2: unrelatedBase };
		source.integrationIntents = { 2.2: unrelatedIntent };
		source.providerAttemptAllocations = [
			{ taskId: "2.2", reason: "quota_fallback", state: "allocated" },
		];
		source.retryState = { taskId: "2.2", attempt: 1, phase: "retry_started" };
		source.taskBaseReleaseUncertain = { taskId: "2.2", marker: "base" };
		source.providerCleanupUncertain = { taskId: "2.2", marker: "cleanup" };
		writeFileSync(f.sourceCheckpointPath, JSON.stringify(source, null, 2));
		const result = await reconcileExternalCompletion(inputFor(f));
		strictEqual(result.status, "recorded");
		const successor = JSON.parse(
			readFileSync(f.successorCheckpointPath, "utf8"),
		);
		deepStrictEqual(successor.taskBases["2.2"], unrelatedBase);
		deepStrictEqual(successor.integrationIntents["2.2"], unrelatedIntent);
		deepStrictEqual(
			successor.providerAttemptAllocations,
			source.providerAttemptAllocations,
		);
		deepStrictEqual(successor.retryState, source.retryState);
		deepStrictEqual(
			successor.taskBaseReleaseUncertain,
			source.taskBaseReleaseUncertain,
		);
		deepStrictEqual(
			successor.providerCleanupUncertain,
			source.providerCleanupUncertain,
		);
	});

	it("accepts a released source snapshot without rewriting it", async () => {
		const f = fixture();
		const source = JSON.parse(readFileSync(f.sourceCheckpointPath, "utf8"));
		source.ownershipReleased = true;
		writeFileSync(f.sourceCheckpointPath, JSON.stringify(source, null, 2));
		const before = readFileSync(f.sourceCheckpointPath, "utf8");
		const result = await reconcileExternalCompletion(inputFor(f));
		strictEqual(result.status, "recorded");
		strictEqual(readFileSync(f.sourceCheckpointPath, "utf8"), before);
	});

	it("archives only a finalized retry history for the reconciled task", async () => {
		const f = fixture();
		const source = JSON.parse(readFileSync(f.sourceCheckpointPath, "utf8"));
		source.retryState = null;
		source.retryAttempts = [
			{
				taskId: "1.1",
				attempt: 1,
				result: "execution_failed",
				success: false,
				timedOut: false,
				resolvedTargetId: "claude-target",
			},
		];
		source.retryTransitions = [
			{
				transitionId: 1,
				type: "finalized",
				taskId: "1.1",
				attempt: 1,
				resolvedTargetId: "claude-target",
			},
		];
		source.quarantinedTargetIds = ["claude-target"];
		writeFileSync(f.sourceCheckpointPath, JSON.stringify(source, null, 2));
		const result = await reconcileExternalCompletion(inputFor(f));
		strictEqual(result.status, "recorded");
		const successor = JSON.parse(
			readFileSync(f.successorCheckpointPath, "utf8"),
		);
		strictEqual(successor.retryAttempts.length, 0);
		strictEqual(successor.retryTransitions.length, 0);
		strictEqual(
			successor.quarantinedTargetIds.includes("claude-target"),
			false,
		);
	});

	it("replays exactly as already-recorded and does not duplicate ledger state", async () => {
		const f = fixture();
		const first = await reconcileExternalCompletion(inputFor(f));
		const second = await reconcileExternalCompletion(inputFor(f));
		strictEqual(first.status, "recorded");
		strictEqual(second.status, "already-recorded");
		strictEqual(
			(await readLedgerFromStore(f.root)).filter(
				(entry) => entry.reconciliationId === first.reconciliationId,
			).length,
			1,
		);
	});

	it("reacquires and holds the source lease while replaying an intent", async () => {
		const f = fixture();
		await reconcileExternalCompletion(
			inputFor(f, { __testFault: "after_intent" }),
		).catch(() => {});
		const blocker = acquireCheckpointLease(f.sourceCheckpointPath, {
			runId: "blocking-run",
			processStartIdentity: "host",
			nonce: "blocking",
		});
		const blocked = await reconcileExternalCompletion(inputFor(f));
		strictEqual(blocked.status, "refused");
		strictEqual(blocked.reasonCode, "source_checkpoint_lock_unavailable");
		releaseCheckpointLease(blocker);
		const recovered = await reconcileExternalCompletion(inputFor(f));
		strictEqual(recovered.status, "recorded");
	});

	it("refuses replay when the leased source bytes no longer match the intent", async () => {
		const f = fixture();
		const sourceBefore = readFileSync(f.sourceCheckpointPath, "utf8");
		await reconcileExternalCompletion(
			inputFor(f, { __testFault: "after_intent" }),
		).catch(() => {});
		writeFileSync(f.sourceCheckpointPath, `${sourceBefore}\n`);
		const refused = await reconcileExternalCompletion(inputFor(f));
		strictEqual(refused.status, "refused");
		strictEqual(refused.reasonCode, "source_checkpoint_changed");
	});

	it("recovers every durable crash window through the versioned intent", async () => {
		for (const fault of [
			"before_intent",
			"after_intent",
			"after_successor",
			"after_ledger",
			"during_finalization",
		]) {
			const f = fixture();
			let crashed = false;
			try {
				await reconcileExternalCompletion(inputFor(f, { __testFault: fault }));
			} catch {
				crashed = true;
			}
			strictEqual(crashed, true, fault);
			const recovered = await reconcileExternalCompletion(inputFor(f));
			strictEqual(recovered.recorded, true, fault);
			strictEqual(
				(await readLedgerFromStore(f.root)).filter(
					(entry) => entry.reconciliationId === recovered.reconciliationId,
				).length,
				1,
			);
		}
	});

	it("replays from immutable intent after the external receipt is gone", async () => {
		const f = fixture();
		let crashed = false;
		try {
			await reconcileExternalCompletion(
				inputFor(f, { __testFault: "after_intent" }),
			);
		} catch {
			crashed = true;
		}
		strictEqual(crashed, true);
		rmSync(f.receiptPath, { force: true });
		const recovered = await reconcileExternalCompletion(inputFor(f));
		strictEqual(recovered.status, "recorded");
		strictEqual(recovered.providerSuccess, false);
	});

	it("replays from immutable intent with the CLI's path-only input", async () => {
		const f = fixture();
		await reconcileExternalCompletion(
			inputFor(f, { __testFault: "after_intent" }),
		).catch(() => {});
		rmSync(f.receiptPath, { force: true });
		const recovered = await reconcileExternalCompletion({
			receiptPath: f.receiptPath,
			sourceCheckpointPath: f.sourceCheckpointPath,
			successorCheckpointPath: f.successorCheckpointPath,
			tasksFilePath: f.tasksFilePath,
			projectPath: f.project,
		});
		strictEqual(recovered.status, "recorded");
	});

	it("completes a crash-after-intent replay after exact owner validation", async () => {
		const f = fixture();
		await reconcileExternalCompletion(
			inputFor(f, { __testFault: "after_intent" }),
		).catch(() => {});
		const recovered = await reconcileExternalCompletion(inputFor(f));
		strictEqual(recovered.status, "recorded");
		strictEqual(recovered.result, "external_completion_recorded");
		strictEqual(
			JSON.parse(readFileSync(f.successorCheckpointPath, "utf8"))
				.externalCompletion.reconciliationId,
			recovered.reconciliationId,
		);
	});

	it("returns recovery-required after successor durability if ledger persistence fails", async () => {
		const f = fixture();
		const interrupted = await reconcileExternalCompletion(
			inputFor(f, { __testFault: "ledger_failure" }),
		);
		strictEqual(interrupted.status, "recovery-required");
		strictEqual(interrupted.reasonCode, "completion_record_persistence_failed");
		strictEqual(existsSync(f.successorCheckpointPath), true);
		strictEqual(
			existsSync(`${f.sourceCheckpointPath}.reconciliation-intent.json`),
			true,
		);
		const recovered = await reconcileExternalCompletion(inputFor(f));
		strictEqual(recovered.status, "recorded");
	});

	it("refuses replay when the canonical ledger entry mismatches the intent", async () => {
		const f = fixture();
		await reconcileExternalCompletion(
			inputFor(f, { __testFault: "after_successor" }),
		).catch(() => {});
		const intent = JSON.parse(
			readFileSync(
				`${f.sourceCheckpointPath}.reconciliation-intent.json`,
				"utf8",
			),
		);
		await recordExternalCompletionToStore(
			{ ...intent.ledger.fields, taskId: "2.2" },
			f.root,
		);
		const refused = await reconcileExternalCompletion(inputFor(f));
		strictEqual(refused.status, "refused");
		strictEqual(refused.result, "external_completion_refused");
		strictEqual(refused.reasonCode, "ledger_reconciliation_mismatch");
		strictEqual(existsSync(f.successorCheckpointPath), true);
	});

	it("refuses a redirect-intent replay before any ledger or successor mutation", async () => {
		const f = fixture();
		await reconcileExternalCompletion(
			inputFor(f, { __testFault: "after_intent" }),
		).catch(() => {});
		const intentPath = `${f.sourceCheckpointPath}.reconciliation-intent.json`;
		const intent = JSON.parse(readFileSync(intentPath, "utf8"));
		const redirect = join(f.root, "redirected-intent-ledger-root");
		intent.immutable.runStorePath = redirect;
		intent.ledger.runStorePath = redirect;
		writeFileSync(intentPath, JSON.stringify(intent, null, 2));
		const sourceBefore = readFileSync(f.sourceCheckpointPath, "utf8");
		const refused = await reconcileExternalCompletion(inputFor(f));
		strictEqual(refused.status, "refused");
		strictEqual(refused.reasonCode, "reconciliation_intent_mismatch");
		strictEqual(readFileSync(f.sourceCheckpointPath, "utf8"), sourceBefore);
		strictEqual(existsSync(f.successorCheckpointPath), false);
		strictEqual((await readLedgerFromStore(f.root)).length, 0);
		strictEqual((await readLedgerFromStore(redirect)).length, 0);
	});

	it("records the ledger under the source-associated store when successor paths differ", async () => {
		const f = fixture();
		const successorDir = join(f.root, "successor-store");
		mkdirSync(successorDir);
		const successorCheckpointPath = join(
			successorDir,
			"successor.checkpoint.json",
		);
		f.receipt.nextRunOptions = {
			...f.receipt.nextRunOptions,
			checkpointPath: successorCheckpointPath,
		};
		writeFileSync(f.receiptPath, JSON.stringify(f.receipt));
		const result = await reconcileExternalCompletion(
			inputFor(f, { successorCheckpointPath }),
		);
		strictEqual(result.status, "recorded");
		strictEqual(
			(await readLedgerFromStore(f.root)).some(
				(entry) => entry.reconciliationId === result.reconciliationId,
			),
			true,
		);
		strictEqual((await readLedgerFromStore(successorDir)).length, 0);
	});

	it("refuses an integrated commit containing an unrelated task path before mutation", async () => {
		const f = fixture();
		writeFileSync(
			join(f.project, "src", "unrelated.mjs"),
			"export const unrelated = true;\n",
		);
		git(f.project, "add", "src/unrelated.mjs");
		git(f.project, "commit", "-qm", "unrelated integrated path");
		f.receipt.integratedCommit = git(f.project, "rev-parse", "HEAD");
		f.receipt.changedPaths = ["src/changed.mjs", "src/unrelated.mjs"];
		f.receipt.requiredPaths = ["src/changed.mjs", "src/unrelated.mjs"];
		writeFileSync(f.receiptPath, JSON.stringify(f.receipt));
		const sourceBefore = readFileSync(f.sourceCheckpointPath, "utf8");
		const refused = await reconcileExternalCompletion(inputFor(f));
		strictEqual(refused.status, "refused");
		strictEqual(refused.reasonCode, "path_scope_mismatch");
		strictEqual(readFileSync(f.sourceCheckpointPath, "utf8"), sourceBefore);
		strictEqual(existsSync(f.successorCheckpointPath), false);
		strictEqual((await readLedgerFromStore(f.root)).length, 0);
	});

	it("refuses a receipt ledger redirect without touching canonical or redirect stores", async () => {
		const f = fixture();
		const redirect = join(f.root, "redirected-ledger-root");
		f.receipt.runStorePath = redirect;
		writeFileSync(f.receiptPath, JSON.stringify(f.receipt));
		const sourceBefore = readFileSync(f.sourceCheckpointPath, "utf8");
		const refused = await reconcileExternalCompletion(inputFor(f));
		strictEqual(refused.status, "refused");
		strictEqual(refused.reasonCode, "receipt_contract_mismatch");
		strictEqual(readFileSync(f.sourceCheckpointPath, "utf8"), sourceBefore);
		strictEqual(existsSync(f.successorCheckpointPath), false);
		strictEqual((await readLedgerFromStore(f.root)).length, 0);
		strictEqual((await readLedgerFromStore(redirect)).length, 0);
	});

	it("does not follow receipt path swaps to symlink, FIFO, or oversize files", async () => {
		const f = fixture();
		const sourceBefore = readFileSync(f.sourceCheckpointPath, "utf8");
		const fifo = join(f.root, "receipt.fifo");
		execFileSync("mkfifo", [fifo]);
		const fifoResult = await Promise.race([
			reconcileExternalCompletion(inputFor(f, { receiptPath: fifo })),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("FIFO receipt read blocked")), 500),
			),
		]);
		strictEqual(fifoResult.reasonCode, "receipt_not_regular");

		const symlink = join(f.root, "receipt.symlink");
		symlinkSync(f.receiptPath, symlink);
		const symlinkResult = await reconcileExternalCompletion(
			inputFor(f, { receiptPath: symlink }),
		);
		strictEqual(symlinkResult.reasonCode, "receipt_not_regular");

		const oversize = join(f.root, "receipt.oversize");
		writeFileSync(oversize, "x".repeat(1024 * 1024 + 1));
		chmodSync(oversize, 0o600);
		const oversizeResult = await reconcileExternalCompletion(
			inputFor(f, { receiptPath: oversize }),
		);
		strictEqual(oversizeResult.reasonCode, "receipt_too_large");
		strictEqual(readFileSync(f.sourceCheckpointPath, "utf8"), sourceBefore);
		strictEqual(existsSync(f.successorCheckpointPath), false);
		strictEqual((await readLedgerFromStore(f.root)).length, 0);
	});

	it("refuses a merge commit before path extraction or durable mutation", async () => {
		const f = fixture();
		const sourceBefore = readFileSync(f.sourceCheckpointPath, "utf8");
		const baseBranch = git(f.project, "rev-parse", "--abbrev-ref", "HEAD");
		const baseCommit = git(f.project, "rev-parse", "HEAD^");
		git(f.project, "checkout", "-qb", "merge-side", baseCommit);
		mkdirSync(join(f.project, "src"), { recursive: true });
		writeFileSync(
			join(f.project, "src", "merge-side.mjs"),
			"export const side = true;\n",
		);
		git(f.project, "add", "src/merge-side.mjs");
		git(f.project, "commit", "-qm", "merge side");
		git(f.project, "checkout", "-q", baseBranch);
		git(f.project, "merge", "--no-ff", "merge-side", "-m", "merge side branch");
		const mergeCommit = git(f.project, "rev-parse", "HEAD");
		f.receipt.integratedCommit = mergeCommit;
		writeFileSync(f.receiptPath, JSON.stringify(f.receipt));
		chmodSync(f.receiptPath, 0o600);
		const result = await reconcileExternalCompletion(inputFor(f));
		strictEqual(result.status, "refused");
		strictEqual(result.reasonCode, "integrated_commit_merge_unsupported");
		strictEqual(existsSync(f.successorCheckpointPath), false);
		strictEqual((await readLedgerFromStore(f.root)).length, 0);
		strictEqual(readFileSync(f.sourceCheckpointPath, "utf8"), sourceBefore);
	});

	it("refuses a mismatched replay without changing the source or successor", async () => {
		const f = fixture();
		const sourceBefore = readFileSync(f.sourceCheckpointPath, "utf8");
		const first = await reconcileExternalCompletion(inputFor(f));
		const successorBefore = readFileSync(f.successorCheckpointPath, "utf8");
		const second = await reconcileExternalCompletion(
			inputFor(f, { requiredPaths: ["src/other.mjs"] }),
		);
		strictEqual(first.status, "recorded");
		strictEqual(second.status, "refused");
		strictEqual(second.reasonCode, "receipt_contract_mismatch");
		strictEqual(readFileSync(f.sourceCheckpointPath, "utf8"), sourceBefore);
		strictEqual(
			readFileSync(f.successorCheckpointPath, "utf8"),
			successorBefore,
		);
	});

	it("reuses pure integration validators for ancestry, exact paths, and overlap", () => {
		const f = fixture();
		const commit = f.receipt.integratedCommit;
		strictEqual(validateIntegratedCommitAncestry(f.project, commit).ok, true);
		strictEqual(
			validateIntegratedCommitPaths(f.project, commit, ["src/changed.mjs"]).ok,
			true,
		);
		strictEqual(
			validateNoTrackedPathOverlap(f.project, ["src/changed.mjs"]).ok,
			true,
		);
		deepStrictEqual(validateExactPathSet(["b", "a", "a"], ["a", "b"]).ok, true);
	});
});

describe("dirty overlay integration identity", () => {
	// A worker seeded from an overlay returns a patch whose preimage is the
	// overlay bytes, not committed HEAD. The gate must apply it against the
	// still-dirty host worktree and stamp the receipt that authorized it.
	it("applies a patch over an overlay-dirty worktree and stamps the receipt", () => {
		const data = fixture();
		const target = join(data.project, "src", "changed.mjs");
		const overlay = "export const done = true;\nexport const overlay = 1;\n";
		const applied = "export const done = true;\nexport const overlay = 2;\n";

		writeFileSync(target, overlay);
		const receipt = captureDirtyOverlay(data.project, ["src/changed.mjs"]);
		// Stage the overlay bytes so `git diff` yields an overlay -> result patch,
		// then restore the worktree to exactly what the receipt captured.
		git(data.project, "add", "src/changed.mjs");
		writeFileSync(target, applied);
		const diff = `${git(data.project, "diff", "--no-color")}\n`;
		git(data.project, "reset", "-q");
		writeFileSync(target, overlay);

		const result = integrationGate(diff, data.project, {
			requiredPaths: ["src/changed.mjs"],
			dirtyOverlayReceiptHash: receipt.receiptHash,
		});
		strictEqual(result.success, true);
		strictEqual(result.dirtyOverlayReceiptHash, receipt.receiptHash);
		strictEqual(readFileSync(target, "utf8"), applied);
	});

	it("stamps the receipt on a refused integration and omits it when unused", () => {
		const data = fixture();
		const refused = integrationGate("", data.project, {
			requiredPaths: ["src/changed.mjs"],
			dirtyOverlayReceiptHash: "b".repeat(64),
		});
		strictEqual(refused.success, false);
		strictEqual(refused.message, "empty_required_diff");
		strictEqual(refused.dirtyOverlayReceiptHash, "b".repeat(64));

		const plain = integrationGate("", data.project, {
			requiredPaths: ["src/changed.mjs"],
		});
		strictEqual(Object.hasOwn(plain, "dirtyOverlayReceiptHash"), false);
	});
});
