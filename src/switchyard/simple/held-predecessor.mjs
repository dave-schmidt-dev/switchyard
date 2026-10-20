/** Durable accepted-output projection for an applied held run. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { assertOverlayPathSafe } from "../lifecycle/overlay-paths.mjs";
import { parsePredecessorReceipt } from "../lifecycle/overlay-receipts.mjs";
import { MAX_CAPTURE_BYTES, requireGit, SECRET_PATHS } from "./args.mjs";
import { heldIntegrationOf, readHeldIntegration } from "./held-integration.mjs";
import { simpleQuarantinePath } from "./worktree-cleanup.mjs";

/** Identity shared by a held receipt and its exact apply attempt. */
export function heldApplyBinding(integration, receipt) {
	return {
		runId: receipt.runId,
		taskId: receipt.taskId,
		attemptId: receipt.attemptId,
		receiptPath: integration.receiptPath,
		receiptSha256: integration.receiptSha256,
		patchSha256: integration.patchSha256,
	};
}

function pathAbsent(path) {
	try {
		lstatSync(path);
		return false;
	} catch (error) {
		return error?.code === "ENOENT";
	}
}

/** Require recorded checker-stop/removal and affirmative absence, never an IO guess. */
export function heldApplyCleanupComplete(record) {
	if (record.cleanupState !== "complete") return false;
	const worktree = record.worktree;
	if (worktree === null) return true;
	try {
		return (
			worktree?.state === "removed" &&
			worktree.writerStopped === true &&
			typeof worktree.path === "string" &&
			typeof worktree.nonce === "string" &&
			pathAbsent(worktree.path) &&
			pathAbsent(simpleQuarantinePath(worktree.nonce))
		);
	} catch {
		return false;
	}
}

/** Refuse unless both held and apply records durably accept the exact outputs. */
export async function appliedHeldPredecessor(record, projectPath, readRun) {
	const invalid = () =>
		Object.assign(new Error("applied held predecessor is unverified"), {
			code: "predecessor_receipt_unverified",
		});
	try {
		const integration = heldIntegrationOf(record);
		if (integration?.state !== "applied" || record.cleanupState !== "complete")
			throw invalid();
		const { receipt } = readHeldIntegration(record, projectPath, record.runId);
		const applied = await readRun(integration.applyRunId);
		const summary = applied?.terminalSummary;
		if (
			applied?.runId !== integration.applyRunId ||
			applied.state !== "succeeded" ||
			applied.cleanupState !== "complete" ||
			applied.initialHostFingerprint !== "simple-apply" ||
			applied.tasksFilePath !== integration.receiptPath ||
			applied.orderedTaskIds?.length !== 1 ||
			applied.orderedTaskIds[0] !== receipt.taskId ||
			record.orderedTaskIds?.length !== 1 ||
			record.orderedTaskIds[0] !== receipt.taskId ||
			realpathSync(applied.projectPath) !== projectPath ||
			summary?.status !== "held_applied" ||
			summary.heldRunId !== record.runId ||
			summary.appliedHead !== integration.appliedHead ||
			summary.baseRevision !== integration.appliedHead ||
			JSON.stringify(summary.heldBinding) !==
				JSON.stringify(heldApplyBinding(integration, receipt)) ||
			JSON.stringify(summary.outputs) !==
				JSON.stringify(receipt.expectedOutputs) ||
			JSON.stringify(summary.changedFiles) !==
				JSON.stringify(receipt.changedFiles)
		)
			throw invalid();
		if (
			requireGit(
				projectPath,
				["rev-parse", "HEAD"],
				"project_revision_unavailable",
			).trim() !== summary.baseRevision
		)
			throw invalid();
		if (!heldApplyCleanupComplete(applied)) throw invalid();
		// Validate the projection and every path before any live output read.
		const projection = parsePredecessorReceipt(
			{
				runId: record.runId,
				baseRevision: summary.baseRevision,
				outputs: summary.outputs,
			},
			{ projectPath },
		);
		if (
			JSON.stringify(projection.outputs) !== JSON.stringify(summary.outputs) ||
			new Set(projection.outputs.map((output) => output.path)).size !==
				projection.outputs.length
		)
			throw invalid();
		for (const output of projection.outputs) {
			if (output.size > MAX_CAPTURE_BYTES) throw invalid();
			assertOverlayPathSafe(projectPath, output.path, {
				enforceTarPathLimit: false,
				secretPaths: SECRET_PATHS,
			});
		}
		// Caller receipt, durable outputs and the live project must all agree.
		for (const output of projection.outputs) {
			const path = resolve(projectPath, output.path);
			const stat = lstatSync(path);
			if (
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.nlink !== 1 ||
				stat.size !== output.size ||
				(stat.mode & 0o777) !== output.mode ||
				createHash("sha256").update(readFileSync(path)).digest("hex") !==
					output.sha256
			)
				throw invalid();
		}
		return projection;
	} catch {
		throw invalid();
	}
}
