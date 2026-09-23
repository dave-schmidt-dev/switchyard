import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { execFileSync, execSync } from "node:child_process";
import {
	chmodSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";

import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { captureDiff as captureAgyDiff } from "../src/switchyard/adapter/agy.mjs";
import { captureDiff as captureClaudeDiff } from "../src/switchyard/adapter/claude.mjs";
import { captureDiff as captureCodexDiff } from "../src/switchyard/adapter/codex.mjs";
import { captureDiff as captureCopilotDiff } from "../src/switchyard/adapter/copilot.mjs";
import { captureDiff as captureCursorDiff } from "../src/switchyard/adapter/cursor.mjs";
import { captureDiff as captureOpencodeDiff } from "../src/switchyard/adapter/opencode.mjs";
import { integrationGate } from "../src/switchyard/integrate/index.mjs";
import {
	captureDirtyOverlay,
	readDirtyOverlayReceipt,
	seedProjectWithBackend,
	validateDirtyOverlayReceipt,
	writeDirtyOverlayReceipt,
} from "../src/switchyard/lifecycle/index.mjs";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const captures = [
	["agy", captureAgyDiff],
	["claude", captureClaudeDiff],
	["codex", captureCodexDiff],
	["copilot", captureCopilotDiff],
	["cursor", captureCursorDiff],
	["opencode", captureOpencodeDiff],
];
const TASK_BASE = {
	ref: "refs/switchyard/task-base/patch-bytes/1.1",
	tree: "2".repeat(40),
};

// getWorkspaceExecution (provider-lifecycle.mjs) now requires an
// executionBackend with no default -- the removed DEFAULT_EXECUTION_BACKEND
// used to fill this in. installFakeDocker() below still shims a `docker`
// binary onto PATH, so this fixture only needs to route through that:
// command "docker" with the same argv tail the case-statement stub matches
// against.
const parallelsArgumentBuilder = new ParallelsExecutionBackend({
	aquaUid: 501,
});
const dockerExecutionBackend = {
	execArgv(workspaceId, options = {}) {
		const { cwd = "/project", argv } = options;
		parallelsArgumentBuilder.execArgv(workspaceId, options);
		return {
			command: "docker",
			args: ["exec", "-i", "-w", cwd, workspaceId, ...argv],
		};
	},
};

let tempRoot;
let originalPath;

afterEach(() => {
	if (originalPath !== undefined) {
		process.env.PATH = originalPath;
		originalPath = undefined;
	}
	if (tempRoot) {
		rmSync(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
});

function installFakeDocker(patch) {
	tempRoot = tempDir("switchyard-patch-bytes-");
	const patchPath = join(tempRoot, "patch.diff");
	writeFileSync(patchPath, patch, "utf8");
	const dockerPath = join(tempRoot, "docker");
	writeFileSync(
		dockerPath,
		`#!/bin/sh
case " $* " in
  *" git rev-parse --verify "*) printf '%s' ${JSON.stringify(TASK_BASE.tree)} ;;
  *" git diff --cached ${TASK_BASE.tree} ") cat ${JSON.stringify(patchPath)} ;;
  *) exit 0 ;;
esac
`,
		{ encoding: "utf8", mode: 0o755 },
	);
	originalPath = process.env.PATH;
	process.env.PATH = `${tempRoot}:${originalPath}`;
}

function buildProject() {
	const project = tempDir("switchyard-patch-gate-");
	writeFileSync(join(project, "test.txt"), "before\n", "utf8");
	execSync("git init -q", { cwd: project, stdio: "pipe" });
	execSync('git config user.email "test@test.com"', {
		cwd: project,
		stdio: "pipe",
	});
	execSync('git config user.name "Test"', { cwd: project, stdio: "pipe" });
	execSync("git add test.txt", { cwd: project, stdio: "pipe" });
	execSync('git commit -q -m "base"', { cwd: project, stdio: "pipe" });
	writeFileSync(join(project, "test.txt"), "after\n", "utf8");
	const diff = execFileSync("git", ["diff", "--no-color"], {
		cwd: project,
		encoding: "utf8",
	});
	writeFileSync(join(project, "test.txt"), "before\n", "utf8");
	return { project, diff };
}

describe("adapter patch-byte preservation", () => {
	for (const trailingNewlines of [1, 2]) {
		it(`preserves ${trailingNewlines} trailing newline(s) through capture and integration`, () => {
			const { project, diff } = buildProject();
			const body = diff.replace(/\n+$/u, "");
			const expected = `${body}${"\n".repeat(trailingNewlines)}`;
			installFakeDocker(expected);

			for (const [name, capture] of captures) {
				const cleanupContext = {
					runId: "patch-bytes",
					taskId: "1.1",
					attemptId: "attempt-1",
					descriptorIdentity: `descriptor-${name}`,
					workspaceId: "fake-container",
					processStartIdentity: null,
					operation: "helper",
				};
				strictEqual(
					capture("fake-container", {
						executionBackend: dockerExecutionBackend,
						taskBase: TASK_BASE,
						cleanupContext,
					}),
					expected,
					`${name} capture must preserve terminal patch bytes`,
				);
			}

			const result = integrationGate(expected, project);
			strictEqual(result.success, true, result.message);
			strictEqual(readFileSync(join(project, "test.txt"), "utf8"), "after\n");
			rmSync(project, { recursive: true, force: true });
		});
	}
});

describe("tracked dirty overlay receipts", () => {
	it("binds tracked bytes and rejects traversal, untracked, and drifted input", () => {
		const { project } = buildProject();
		const receipt = captureDirtyOverlay(project, ["test.txt"]);
		strictEqual(receipt.paths.length, 1);
		strictEqual(validateDirtyOverlayReceipt(project, receipt).ok, true);
		// The receipt lives outside the project: an in-project receipt is itself
		// an untracked stray, and the scope check has no exemption for one.
		const receiptPath = join(
			tempDir("switchyard-patch-receipt-"),
			"queue.checkpoint.json.dirty-overlay.json",
		);
		writeDirtyOverlayReceipt(receiptPath, receipt);
		deepStrictEqual(readDirtyOverlayReceipt(receiptPath), receipt);
		strictEqual(statSync(receiptPath).mode & 0o777, 0o600);

		writeFileSync(join(project, "test.txt"), "drifted\n", "utf8");
		strictEqual(
			validateDirtyOverlayReceipt(project, receipt).reason,
			"dirty_overlay_file_drift",
		);
		writeFileSync(join(project, "extra.txt"), "untracked\n", "utf8");
		throws(
			() => captureDirtyOverlay(project, ["test.txt"]),
			/out-of-scope|untracked/,
		);
		throws(() => captureDirtyOverlay(project, ["../test.txt"]), /outside/);
	});

	it("refuses an untracked receipt-shaped stray inside the project", () => {
		// A receipt name carries no exemption. Naming the stray after the receipt
		// suffix once bypassed the scope check entirely, which let any untracked
		// file reach a capture by renaming itself.
		const { project } = buildProject();
		writeFileSync(join(project, "test.txt"), "after\n", "utf8");
		writeFileSync(
			join(project, "leak.dirty-overlay.json"),
			'{"leak":true}\n',
			"utf8",
		);
		throws(
			() => captureDirtyOverlay(project, ["test.txt"]),
			/leak\.dirty-overlay\.json/,
		);
	});

	// INVARIANTS names eight rejection classes for declared overlay input.
	// Traversal, untracked and out-of-scope are covered above; the remaining
	// four are enumerated here so no class ships without a fixture.
	it("rejects ignored, symlinked, secret-shaped, and duplicate declarations", () => {
		const { project } = buildProject();
		const commit = (message) => {
			execSync("git add -A", { cwd: project, stdio: "pipe" });
			execSync(`git commit -q -m ${message}`, { cwd: project, stdio: "pipe" });
		};
		writeFileSync(join(project, ".gitignore"), "ignored.txt\n", "utf8");
		writeFileSync(join(project, "ignored.txt"), "ignored\n", "utf8");
		symlinkSync("test.txt", join(project, "link.txt"));
		execSync("git add -f .gitignore ignored.txt link.txt", {
			cwd: project,
			stdio: "pipe",
		});
		commit("overlay-rejection-fixture");

		throws(() => captureDirtyOverlay(project, ["ignored.txt"]), /ignored path/);
		throws(() => captureDirtyOverlay(project, ["link.txt"]), /symlink path/);
		throws(() => captureDirtyOverlay(project, [".env"]), /secret-shaped/);
		throws(
			() => captureDirtyOverlay(project, ["test.txt", "./test.txt"]),
			/duplicate paths/,
		);
		throws(() => captureDirtyOverlay(project, []), /at least one/);
	});

	it("refuses a tampered receipt and a post-capture source-head change", () => {
		const { project } = buildProject();
		const receipt = captureDirtyOverlay(project, ["test.txt"]);
		strictEqual(
			validateDirtyOverlayReceipt(project, {
				...receipt,
				sourceHead: "0".repeat(40),
			}).reason,
			"dirty_overlay_receipt_changed",
		);
		strictEqual(
			validateDirtyOverlayReceipt(project, receipt, ["other.txt"]).reason,
			"dirty_overlay_scope_mismatch",
		);
		writeFileSync(join(project, "second.txt"), "second\n", "utf8");
		execSync("git add second.txt", { cwd: project, stdio: "pipe" });
		execSync('git commit -q -m "second"', { cwd: project, stdio: "pipe" });
		strictEqual(
			validateDirtyOverlayReceipt(project, receipt).reason,
			"dirty_overlay_source_head_drift",
		);
		strictEqual(
			validateDirtyOverlayReceipt(project, {
				...receipt,
				paths: [{ ...receipt.paths[0], mode: -1 }],
			}).reason,
			"dirty_overlay_receipt_invalid",
		);
		strictEqual(
			validateDirtyOverlayReceipt(project, {
				...receipt,
				paths: [{ ...receipt.paths[0], mode: 0o1000 }],
			}).reason,
			"dirty_overlay_receipt_invalid",
		);
		strictEqual(
			validateDirtyOverlayReceipt(project, {
				...receipt,
				paths: [{ ...receipt.paths[0], mode: "755" }],
			}).reason,
			"dirty_overlay_receipt_invalid",
		);
	});

	it("round-trips numeric modes 0o755, 0o600, and 0o644 through capture and validation", () => {
		const { project } = buildProject();
		try {
			const files = [
				{ name: "exec.txt", mode: 0o755, content: "executable content\n" },
				{ name: "owner.txt", mode: 0o600, content: "private content\n" },
				{ name: "readable.txt", mode: 0o644, content: "readable content\n" },
			];
			for (const file of files) {
				const target = join(project, file.name);
				writeFileSync(target, file.content, "utf8");
				chmodSync(target, file.mode);
				execSync(`git add ${file.name}`, { cwd: project, stdio: "pipe" });
			}
			execSync('git commit -q -m "modes fixture"', {
				cwd: project,
				stdio: "pipe",
			});

			for (const file of files) {
				const target = join(project, file.name);
				writeFileSync(target, `dirty ${file.content}`, "utf8");
				chmodSync(target, file.mode);

				const receipt = captureDirtyOverlay(project, [file.name]);
				strictEqual(receipt.paths.length, 1);
				strictEqual(receipt.paths[0].mode, file.mode);

				const validation = validateDirtyOverlayReceipt(project, receipt);
				strictEqual(
					validation.ok,
					true,
					`mode 0o${file.mode.toString(8)} failed validation: ${validation.reason}`,
				);
				strictEqual(validation.receiptHash, receipt.receiptHash);

				const receiptPath = join(
					tempDir("switchyard-mode-receipt-"),
					"queue.checkpoint.json.dirty-overlay.json",
				);
				writeDirtyOverlayReceipt(receiptPath, receipt);
				deepStrictEqual(readDirtyOverlayReceipt(receiptPath), receipt);
				writeFileSync(target, file.content, "utf8");
			}

			for (const file of files) {
				writeFileSync(
					join(project, file.name),
					`dirty ${file.content}`,
					"utf8",
				);
			}
			const allPaths = files.map((f) => f.name);
			const multiReceipt = captureDirtyOverlay(project, allPaths);
			strictEqual(multiReceipt.paths.length, 3);
			deepStrictEqual(
				multiReceipt.paths.map((p) => p.mode),
				files.map((f) => f.mode),
			);
			const multiValidation = validateDirtyOverlayReceipt(
				project,
				multiReceipt,
			);
			strictEqual(
				multiValidation.ok,
				true,
				`multi-path validation failed: ${multiValidation.reason}`,
			);
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	});

	it("applies an integration patch over an executable dirty-overlay with non-manifest filename", () => {
		const project = tempDir("switchyard-executable-integration-");
		try {
			execSync("git init -q", { cwd: project, stdio: "pipe" });
			execSync('git config user.email "test@test.com"', {
				cwd: project,
				stdio: "pipe",
			});
			execSync('git config user.name "Test"', { cwd: project, stdio: "pipe" });

			const target = join(project, "payload.txt");
			writeFileSync(target, "initial executable payload\n", "utf8");
			chmodSync(target, 0o755);
			execSync("git add payload.txt", { cwd: project, stdio: "pipe" });
			execSync('git commit -q -m "initial payload"', {
				cwd: project,
				stdio: "pipe",
			});

			const overlayContent = "overlay executable payload\n";
			writeFileSync(target, overlayContent, "utf8");
			chmodSync(target, 0o755);

			const receipt = captureDirtyOverlay(project, ["payload.txt"]);
			strictEqual(receipt.paths[0].mode, 0o755);
			strictEqual(validateDirtyOverlayReceipt(project, receipt).ok, true);

			// Stage overlay so git diff produces overlay -> applied patch
			execSync("git add payload.txt", { cwd: project, stdio: "pipe" });
			const appliedContent = "applied executable payload\n";
			writeFileSync(target, appliedContent, "utf8");
			chmodSync(target, 0o755);
			const diff = `${execFileSync("git", ["diff", "--no-color"], {
				cwd: project,
				encoding: "utf8",
			})}\n`;

			// Restore worktree to exact overlay state
			execSync("git reset -q", { cwd: project, stdio: "pipe" });
			writeFileSync(target, overlayContent, "utf8");
			chmodSync(target, 0o755);

			const result = integrationGate(diff, project, {
				requiredPaths: ["payload.txt"],
				dirtyOverlayReceiptHash: receipt.receiptHash,
			});

			strictEqual(result.success, true, result.message);
			strictEqual(result.dirtyOverlayReceiptHash, receipt.receiptHash);
			strictEqual(readFileSync(target, "utf8"), appliedContent);
			strictEqual(statSync(target).mode & 0o777, 0o755);
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	});

	it("allows an executable declared file under dirty-overlay to reach integration in simple dispatch", async () => {
		const project = tempDir("switchyard-executable-simple-");
		const promptDir = tempDir("switchyard-prompt-");
		try {
			const scriptPath = join(project, "payload.txt");
			writeFileSync(scriptPath, "#!/bin/sh\necho base\n", {
				encoding: "utf8",
				mode: 0o755,
			});
			chmodSync(scriptPath, 0o755);
			execSync("git init -q", { cwd: project, stdio: "pipe" });
			execSync('git config user.email "test@test.com"', {
				cwd: project,
				stdio: "pipe",
			});
			execSync('git config user.name "Test"', { cwd: project, stdio: "pipe" });
			execSync("git add payload.txt", { cwd: project, stdio: "pipe" });
			execSync('git commit -q -m "base"', { cwd: project, stdio: "pipe" });

			// Make payload.txt dirty with executable mode 0o755
			writeFileSync(scriptPath, "#!/bin/sh\necho dirty-overlay\n", {
				encoding: "utf8",
				mode: 0o755,
			});
			chmodSync(scriptPath, 0o755);

			const promptPath = join(promptDir, "prompt.txt");
			writeFileSync(promptPath, "Update payload.txt\n", "utf8");

			const events = [];
			const result = await runSimpleTask(
				{
					promptPath,
					projectPath: project,
					capability: "standard",
					files: ["payload.txt"],
					checks: ["test -x payload.txt"],
					deadlineMs: Date.now() + 60_000,
					dirtyOverlay: true,
				},
				{
					now: () => Date.now(),
					taskId: "executable-dirty-overlay-task",
					attemptId: "attempt-1",
					onStatus: (event) => events.push(event),
					initializeRun: async () => ({ runId: "test-run" }),
					updateRunWithRetry: async () => {},
					acquireProjectLock: async () => {},
					releaseProjectLock: async () => true,
					route: () => ({
						provider: "Codex (Spark)",
						reason: "priority_fill",
					}),
					resolveTargetIdentity: () => ({
						targetId: "codex",
						harnessKey: "codex",
						ambiguous: false,
					}),
					getInvocationDescriptor: () => ({
						target_id: "codex",
						selector: "gpt-5.3-codex-spark",
						invocation_args: [],
					}),
					assertFundedRoute: () => {},
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(
							join(worktreePath, "payload.txt"),
							"#!/bin/sh\necho updated\n",
							{ encoding: "utf8", mode: 0o755 },
						);
						chmodSync(join(worktreePath, "payload.txt"), 0o755);
						return { success: true, code: 0, writerLifecycle: "stopped" };
					},
					runCheck: async () => ({ success: true }),
				},
			);

			strictEqual(result.status, "succeeded");
			ok(
				events.some(
					(e) =>
						e.phase === "integrate" && e.milestone === "integration_started",
				),
				"executable dirty overlay must reach integration_started milestone",
			);
			ok(
				events.some(
					(e) =>
						e.phase === "integrate" && e.milestone === "integration_completed",
				),
				"executable dirty overlay must complete integration",
			);
			strictEqual(
				readFileSync(scriptPath, "utf8"),
				"#!/bin/sh\necho updated\n",
			);
			strictEqual(statSync(scriptPath).mode & 0o777, 0o755);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(promptDir, { recursive: true, force: true });
		}
	});

	it("seeds overlay bytes once and refuses to seed a drifted receipt", () => {
		const { project } = buildProject();
		writeFileSync(join(project, "test.txt"), "overlay\n", "utf8");
		const receipt = captureDirtyOverlay(project, ["test.txt"]);
		const pushes = [];
		const backend = {
			pushTar: (_workspaceId, tar, destination) => {
				pushes.push({ destination, tar });
				return { bytes: tar.length };
			},
			execGuest: () => ({ status: 0 }),
		};

		seedProjectWithBackend(backend, "overlay-workspace", project, {
			dirtyOverlayReceipt: receipt,
		});
		strictEqual(pushes.length, 2);
		// The overlay tar carries the receipt's exact bytes; the base archive
		// carries committed HEAD, which does not contain them.
		ok(pushes[1].tar.includes("overlay\n"));
		ok(!pushes[0].tar.includes("overlay\n"));

		writeFileSync(join(project, "test.txt"), "drifted-after-capture\n", "utf8");
		throws(
			() =>
				seedProjectWithBackend(backend, "overlay-workspace", project, {
					dirtyOverlayReceipt: receipt,
				}),
			/rejected before seed: dirty_overlay_file_drift/,
		);
		// The base archive still went out; no overlay bytes followed it.
		strictEqual(pushes.length, 3);
	});
});
