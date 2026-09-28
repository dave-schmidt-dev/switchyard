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
	validateExactPathSet,
	validateIntegratedCommitAncestry,
	validateIntegratedCommitPaths,
	validateNoTrackedPathOverlap,
} from "../src/switchyard/integrate/index.mjs";
import { readLedgerFromStore } from "../src/switchyard/ledger/index.mjs";
import { reconcileExternalCompletion } from "../src/switchyard/runner/index.mjs";
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
		"### Task 1.1: External\n- **Status:** pending\n- **Type:** implementation\n- **Executor:** switchyard\n- **Files:** src/changed.mjs\n- **Quick checks:** none\n";
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
