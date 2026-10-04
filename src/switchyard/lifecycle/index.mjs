import { execFileSync } from "node:child_process";
export function seedProjectWithBackend(
	executionBackend,
	workspaceId,
	projectPath,
	{ dirtyOverlayReceipt = null } = {},
) {
	if (!executionBackend || typeof executionBackend.pushTar !== "function") {
		throw new TypeError("execution backend does not support tar transfer");
	}
	if (typeof workspaceId !== "string" || workspaceId.length === 0) {
		throw new TypeError("workspaceId must be a non-empty backend handle");
	}
	const tar = execFileSync("git", ["-C", projectPath, "archive", "HEAD"], {
		maxBuffer: 256 * 1024 * 1024,
	});
	const receipt = executionBackend.pushTar(workspaceId, tar, "/project");
	// Repeat-safe on purpose: execGuest retries a prlctl job misfire, so this
	// script can run a second time against a guest that already ran it to
	// completion. `git init` and `git add` are no-ops on the second pass, but an
	// unguarded `commit --allow-empty` would stack a redundant baseline commit,
	// so the commit is gated on HEAD not already existing. `--allow-empty` stays
	// because an empty project still needs a baseline for HEAD to resolve.
	const script =
		"git init -q && git add -A -f && { git rev-parse --verify -q HEAD >/dev/null || git -c user.name=switchyard -c user.email=switchyard@localhost commit --allow-empty -qm baseline; }";
	if (typeof executionBackend.execGuest === "function") {
		executionBackend.execGuest(workspaceId, "/bin/bash", ["-lc", script], {
			cwd: "/project",
		});
	} else {
		const execution = executionBackend.execArgv(workspaceId, {
			cwd: "/project",
			argv: ["/bin/bash", "-lc", script],
		});
		execFileSync(execution.command, execution.args, { stdio: "pipe" });
	}
	if (dirtyOverlayReceipt) {
		const checked = validateDirtyOverlayReceipt(
			projectPath,
			dirtyOverlayReceipt,
			dirtyOverlayReceipt.paths.map((entry) => entry.path),
		);
		if (
			!checked.ok ||
			checked.receiptHash !== dirtyOverlayReceipt.receiptHash
		) {
			throw new Error(
				`dirty overlay receipt rejected before seed: ${checked.reason}`,
			);
		}
		// pushTar extracts the immutable payload into the guest without a host
		// mount, overwriting exactly the declared paths in the already-seeded
		// tree. It runs after the baseline commit, so the overlay is the guest
		// repository's only uncommitted change when the apply command below
		// folds it into a single commit.
		executionBackend.pushTar(
			workspaceId,
			createOverlayTar(dirtyOverlayReceipt),
			"/project",
		);
		const overlayScript =
			"git add -A -- . && git diff --cached --quiet || git commit -q -m switchyard-dirty-overlay";
		if (typeof executionBackend.execGuest === "function") {
			executionBackend.execGuest(
				workspaceId,
				"/bin/bash",
				["-lc", overlayScript],
				{
					cwd: "/project",
				},
			);
		} else {
			const overlayExecution = executionBackend.execArgv(workspaceId, {
				cwd: "/project",
				argv: ["/bin/bash", "-lc", overlayScript],
			});
			execFileSync(overlayExecution.command, overlayExecution.args, {
				stdio: "pipe",
			});
		}
	}
	return receipt;
}
export * from "./execution-backend.mjs";
export * from "./parallels-execution-backend.mjs";

import "./overlay-paths.mjs";
import "./overlay-receipts.mjs";
import {
	createOverlayTar,
	validateDirtyOverlayReceipt,
} from "./dirty-overlay.mjs";
import "./task-base-probe.mjs";
import "./task-base.mjs";

export {
	captureDirtyOverlay,
	materializeDirtyOverlay,
	validateDirtyOverlayReceipt,
} from "./dirty-overlay.mjs";
export { ignoredPath } from "./overlay-paths.mjs";
export {
	parsePredecessorReceipt,
	readDirtyOverlayReceipt,
	writeDirtyOverlayReceipt,
} from "./overlay-receipts.mjs";
export {
	captureTaskStartTree,
	captureTaskStartTreeAsync,
	releaseTaskStartTree,
	releaseTaskStartTreeAsync,
	validateTaskStartTree,
	validateTaskStartTreeAsync,
} from "./task-base.mjs";
