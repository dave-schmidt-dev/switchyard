import { strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { integrationGate } from "../src/switchyard/integrate/index.mjs";
import { captureDirtyOverlay } from "../src/switchyard/lifecycle/index.mjs";
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
