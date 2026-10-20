/** Retry only a lost annotation for a durably proven non-mutating refusal. */
import { realpathSync } from "node:fs";
import { requireGit } from "./args.mjs";
import { heldIntegrationOf, readHeldIntegration } from "./held-integration.mjs";
import {
	heldApplyBinding,
	heldApplyCleanupComplete,
} from "./held-predecessor.mjs";
import { declaredPathsAreClean, fileFingerprint } from "./overlay.mjs";
import { writerQuiescent } from "./routing-recovery.mjs";

/** Called only under a new apply-run project lock. Never applies project bytes. */
export async function reconcileHeldUnderLock(
	{ projectPath, runId, applyRunId, deadlineMs, signal, now },
	deps,
) {
	const { read, updateRun, refusal, progress } = deps;
	const timeRefusal = () =>
		signal?.aborted
			? refusal("held_apply_failed", { detail: "cancelled" })
			: !Number.isFinite(deadlineMs) || now() >= deadlineMs
				? refusal("held_apply_failed", { detail: "deadline_expired" })
				: null;
	const expired = timeRefusal();
	if (expired) return expired;
	const record = await read(runId);
	const held = heldIntegrationOf(record);
	if (
		!held ||
		record.runId !== runId ||
		realpathSync(record.projectPath) !== projectPath
	)
		return refusal("held_receipt_invalid");
	if (held.state === "applied") return refusal("held_receipt_consumed");
	if (held.state !== "applying")
		return refusal("held_apply_state_unknown", { detail: "not_applying" });
	const { receipt } = readHeldIntegration(record, projectPath, runId);
	const earlier = await read(held.applyRunId).catch(() => null);
	const summary = earlier?.terminalSummary;
	if (
		!earlier ||
		earlier.runId !== held.applyRunId ||
		earlier.state !== "failed" ||
		earlier.cleanupState !== "complete" ||
		realpathSync(earlier.projectPath) !== projectPath ||
		earlier.initialHostFingerprint !== "simple-apply" ||
		earlier.tasksFilePath !== held.receiptPath ||
		record.orderedTaskIds?.length !== 1 ||
		record.orderedTaskIds[0] !== receipt.taskId ||
		earlier.orderedTaskIds?.length !== 1 ||
		earlier.orderedTaskIds[0] !== record.orderedTaskIds?.[0] ||
		!Number.isSafeInteger(earlier.workerPid) ||
		earlier.workerPid <= 0 ||
		typeof earlier.workerNonce !== "string" ||
		!earlier.workerNonce ||
		summary?.status !== "held_apply_refused" ||
		summary.heldRunId !== runId ||
		!["held_patch_conflict", "held_scope_refused"].includes(summary.reason) ||
		JSON.stringify(summary.heldBinding) !==
			JSON.stringify(heldApplyBinding(held, receipt)) ||
		!writerQuiescent(earlier, deps)
	)
		return refusal("held_apply_state_unknown", {
			detail: "reconciliation_proof_unavailable",
		});
	if (!heldApplyCleanupComplete(earlier))
		return refusal("held_apply_state_unknown", {
			detail: "checker_cleanup_unconfirmed",
		});
	progress({ phase: "reconcile" });
	const head = requireGit(
		projectPath,
		["rev-parse", "HEAD"],
		"project_revision_unavailable",
	).trim();
	if (
		receipt.dirtyOverlay ||
		head !== receipt.verifiedHead ||
		!declaredPathsAreClean(projectPath, [
			...receipt.scopeFiles,
			...receipt.readOnlyInputs,
		]) ||
		fileFingerprint(projectPath, receipt.files) !== receipt.declaredFingerprint
	)
		return refusal("held_receipt_stale", { detail: "original_state_changed" });
	const late = timeRefusal();
	if (late) return late;
	const at = new Date(now()).toISOString();
	try {
		await updateRun(runId, {
			terminalSummary: {
				...record.terminalSummary,
				integration: {
					...held,
					state: "held",
					reconciliation: {
						earlierApplyRunId: held.applyRunId,
						reason: summary.reason,
						reconciledBy: applyRunId,
						at,
					},
				},
			},
		});
	} catch {
		return refusal("run_store_write_failed", {
			detail: "reconciliation_unrecorded",
		});
	}
	return {
		ok: true,
		state: "held",
		runId,
		reconciledAt: at,
		earlierApplyRunId: held.applyRunId,
	};
}
