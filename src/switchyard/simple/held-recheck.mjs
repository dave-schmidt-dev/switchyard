/**
 * Acceptance rechecks for a held patch whose verified HEAD has since moved.
 *
 * The same rule as the simple integrate step: when peer commits advanced HEAD,
 * the patch must pass the same acceptance checks at the new HEAD before any
 * host mutation. The checker runs in a disposable root the apply run owns and
 * records, so an interrupted apply leaves a claim recovery can find.
 */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	statSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { getRunRoot } from "../run-store/run-records.mjs";
import { updateRunWithRetry } from "../run-store/run-updates.mjs";
import { requireGit } from "./args.mjs";
import { createSimpleCheckSessions } from "./check-session.mjs";
import { allocateSimpleRoot, OWNER_MARKER } from "./simple-root.mjs";
import { cleanupSimpleWorktree } from "./worktree-cleanup.mjs";

function writeOwnerMarker(root, runId, nonce) {
	const fd = openSync(join(root, OWNER_MARKER), "wx", 0o600);
	try {
		writeSync(fd, `${JSON.stringify({ runId, nonce })}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const dirFd = openSync(root, "r");
	try {
		fsyncSync(dirFd);
	} finally {
		closeSync(dirFd);
	}
}

/**
 * Run every held acceptance check against `head` with `patch` applied in a
 * sandboxed checker. Resolves `{ ok: true }` or `{ ok: false, detail,
 * checkIndex? }`; it never touches the project tree.
 */
export async function runHeldRechecks(
	{
		applyRunId,
		projectPath,
		head,
		patch,
		receipt,
		deadlineMs,
		now = Date.now,
		signal,
		onProgress = () => {},
	},
	deps = {},
) {
	const updateRun = deps.updateRunWithRetry ?? updateRunWithRetry;
	const { canonicalParent, candidateChild, candidatePath } =
		allocateSimpleRoot(deps);
	const claim = { canonicalParent, candidateChild, path: candidatePath };
	await updateRun(applyRunId, {
		worktree: { ...claim, state: "allocating", reason: null, retainedAt: null },
	});
	mkdirSync(candidatePath, { mode: 0o700 });
	const rootStat = statSync(candidatePath, { bigint: true });
	const nonce = randomUUID();
	writeOwnerMarker(candidatePath, applyRunId, nonce);
	const identity = {
		device: rootStat.dev.toString(),
		inode: rootStat.ino.toString(),
		nonce,
	};
	await updateRun(applyRunId, {
		worktree: {
			...claim,
			state: "active",
			reason: null,
			retainedAt: null,
			...identity,
		},
	});
	let session = null;
	let writerStopped = true;
	try {
		session = createSimpleCheckSessions({
			taskRoot: candidatePath,
			projectPath,
			baseRevision: head,
			baseTree: requireGit(
				projectPath,
				["rev-parse", `${head}^{tree}`],
				"project_revision_unavailable",
			).trim(),
			dirtyOverlayReceipt: null,
			files: receipt.scopeFiles,
			allowManifests: receipt.allowManifests,
			allowExecutables: receipt.allowExecutables,
			commands: receipt.checks,
			taskId: receipt.taskId,
			deadlineMs,
			cachePath: deps.checkCachePath,
			evidenceDir: join(getRunRoot(applyRunId), "check-evidence"),
			now,
			signal,
			onProgress: () => onProgress({ processPhase: "held_recheck_preparing" }),
		});
		await session.prepare(patch, 1);
		for (let index = 0; index < receipt.checks.length; index += 1) {
			const result = await session.run({
				command: receipt.checks[index],
				onProgress: () =>
					onProgress({
						processPhase: "held_recheck_running",
						checkIndex: index + 1,
					}),
			});
			if (!result?.success)
				return { ok: false, detail: "check_failed", checkIndex: index + 1 };
		}
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			detail:
				error?.code === "deadline_expired"
					? "deadline_expired"
					: "check_setup_failed",
		};
	} finally {
		try {
			session?.remove();
		} catch {
			writerStopped = false;
		}
		let outcome;
		try {
			outcome = await (deps.cleanupSimpleWorktree ?? cleanupSimpleWorktree)(
				applyRunId,
				{ ...claim, ...identity },
				{ writerStopped },
			);
		} catch {
			outcome = { removed: false, path: candidatePath };
		}
		const path = outcome.path ?? candidatePath;
		await updateRun(applyRunId, {
			worktree: {
				canonicalParent: dirname(path),
				candidateChild: basename(path),
				path,
				state: outcome.removed ? "removed" : "retained",
				reason: outcome.removed
					? null
					: (outcome.reason ?? "worktree_cleanup_failed"),
				retainedAt: outcome.removed ? null : new Date(now()).toISOString(),
				writerStopped,
				...identity,
			},
		}).catch(() => {});
	}
}
