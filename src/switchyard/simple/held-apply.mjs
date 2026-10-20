/**
 * `routing-run apply`: integrate the patch a held simple run verified.
 *
 * The apply runs under the project lock as its own short run record, so lock
 * recovery sees a live holder. Under the lock it re-reads the held run, loads
 * only the patch whose digest that record names, and re-runs the integration
 * gate against the current HEAD: peer history must leave every declared path
 * alone and change no manifest, the declared files must still match what was
 * verified, the acceptance checks re-run when HEAD moved, and the gate's own
 * scope, manifest and `git apply --check` refusals apply before any write.
 * Before the gate may write, the held record is claimed as `applying`, so an
 * apply that dies or cannot record its outcome blocks every later apply
 * instead of letting one write the same patch twice. Every refusal is one
 * closed reason and leaves the project tree untouched, except
 * `held_apply_state_unknown`, which says so.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { sanitizeFailureMetadata } from "../adapter/exec-error.mjs";
import { integrationGate, validateDiff } from "../integrate/index.mjs";
import {
	acquireProjectLock,
	releaseProjectLockIfOwnedBy,
} from "../run-store/project-locks.mjs";
import { initializeRun, readRun } from "../run-store/run-records.mjs";
import { updateRunWithRetry } from "../run-store/run-updates.mjs";
import { git, MAX_CAPTURE_BYTES, requireGit } from "./args.mjs";
import { headAdvanceSafe } from "./head-advance.mjs";
import { heldIntegrationOf, readHeldIntegration } from "./held-integration.mjs";
import { runHeldRechecks } from "./held-recheck.mjs";
import { declaredPathsAreClean, fileFingerprint } from "./overlay.mjs";

export const HELD_APPLY_REFUSALS = Object.freeze([
	"held_run_not_found",
	"held_receipt_invalid",
	"held_receipt_consumed",
	"held_receipt_stale",
	"held_recheck_failed",
	"held_patch_conflict",
	"held_scope_refused",
	"held_apply_failed",
	"held_apply_state_unknown",
	"project_lock_held",
	"run_store_write_failed",
]);
// Refusals that happen before the held record is known to be ours to annotate.
const UNRECORDED_REFUSALS = new Set([
	"held_run_not_found",
	"held_receipt_invalid",
	"held_receipt_consumed",
	"project_lock_held",
	"run_store_write_failed",
]);

function sameProject(recorded, projectPath) {
	try {
		return realpathSync(recorded) === projectPath;
	} catch {
		return false;
	}
}

// The record must be the requested run's own: a record copied into another
// run's directory would otherwise name that other run's patch.
function heldFor(record, runId, projectPath) {
	const held = heldIntegrationOf(record);
	return held &&
		record.runId === runId &&
		sameProject(record.projectPath, projectPath)
		? held
		: null;
}

// `git apply --check` refusals: nothing was written. Any other apply failure
// may have come from the mutating `git apply` and is reported as unknown.
const FORWARD_CHECK_KINDS = new Set(["conflict", "corrupt_patch"]);

function outputsAt(root, paths) {
	return paths.map((path) => {
		try {
			const stats = lstatSync(resolve(root, path));
			const bytes = stats.isFile()
				? readFileSync(resolve(root, path))
				: Buffer.alloc(0);
			return {
				path,
				size: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				mode: stats.mode & 0o777,
			};
		} catch {
			return { path, size: 0, sha256: null, mode: 0 };
		}
	});
}

/** Why the held receipt no longer describes this tree, or null. */
function staleDetail(receipt, head, projectPath) {
	const { verifiedHead } = receipt;
	if (head !== verifiedHead) {
		if (
			git(projectPath, ["merge-base", "--is-ancestor", verifiedHead, head])
				.status !== 0
		)
			return "head_not_descendant";
		if (
			!headAdvanceSafe({
				projectPath,
				base: verifiedHead,
				head,
				paths: [...receipt.scopeFiles, ...receipt.readOnlyInputs],
			})
		)
			return "declared_path_committed";
		// Renames and copies are never detected, so a renamed or copied
		// executable shows as `create mode 100755` and refuses.
		const peerDiff = requireGit(
			projectPath,
			["diff", "--no-renames", "--binary", "--full-index", verifiedHead, head],
			"project_revision_unavailable",
			{ maxBuffer: MAX_CAPTURE_BYTES },
		);
		if (peerDiff.trim()) {
			const peer = validateDiff(peerDiff, projectPath);
			if (!peer.safe || peer.requiresReview) return "peer_history_unsafe";
		}
	}
	if (!declaredPathsAreClean(projectPath, receipt.scopeFiles))
		return "declared_path_dirty";
	if (
		fileFingerprint(projectPath, receipt.files) !== receipt.declaredFingerprint
	)
		return "declared_path_changed";
	return null;
}

function gateRefusal(gate) {
	if (gate?.message !== "Diff apply failed") return "held_scope_refused";
	return FORWARD_CHECK_KINDS.has(gate.reasonKind)
		? "held_patch_conflict"
		: "held_apply_state_unknown";
}

/**
 * Apply one held run's verified patch to `projectPath` (canonical). Resolves
 * one JSON-safe result: `{ ok: true, state: "applied", ... }` or
 * `{ ok: false, state: "refused", reason, ... }` with `reason` from
 * HELD_APPLY_REFUSALS.
 */
export async function applyHeldIntegration(
	{ projectPath, runId, deadlineMs, signal },
	deps = {},
) {
	const now = deps.now ?? Date.now;
	const read = deps.readRun ?? readRun;
	const updateRun = deps.updateRunWithRetry ?? updateRunWithRetry;
	const progress = deps.onProgress ?? (() => {});
	const refusal = (reason, extra = {}) => ({
		ok: false,
		state: "refused",
		runId,
		reason,
		...extra,
	});
	const consumed = (integration) =>
		refusal("held_receipt_consumed", {
			appliedAt: integration.appliedAt,
			appliedHead: integration.appliedHead,
			applyRunId: integration.applyRunId,
		});

	let record;
	try {
		record = await read(runId);
	} catch {
		return refusal("held_run_not_found");
	}
	const held = heldFor(record, runId, projectPath);
	if (!held)
		return refusal("held_receipt_invalid", { detail: "not_a_held_run" });
	if (held.state === "applied") return consumed(held);

	const applyRunId = deps.applyRunId ?? `simple-apply-${randomUUID()}`;
	try {
		await (deps.initializeRun ?? initializeRun)({
			runId: applyRunId,
			tasksFilePath: held.receiptPath,
			projectPath,
			orderedTaskIds: [record.orderedTaskIds?.[0] ?? runId],
			initialHostFingerprint: "simple-apply",
			workerPid: process.pid,
			workerNonce: randomUUID(),
		});
		await updateRun(applyRunId, {
			state: "running",
			startedAt: new Date(now()).toISOString(),
		});
	} catch {
		return refusal("run_store_write_failed");
	}
	const finish = async (result) => {
		const finishedAt = new Date(now()).toISOString();
		// As in the simple run's own cleanup: a lock this apply took but could
		// not confirm released, or a retained checker, is a cleanup failure, so
		// recovery never reads the leftover as a clean terminal run.
		const cleanupResult =
			result.lockReleased === false
				? "project_lock_release_unconfirmed"
				: result.checker === "retained"
					? "worktree_cleanup_failed"
					: null;
		const cleanup = cleanupResult
			? {
					cleanupState: "failed",
					cleanupFailure: {
						...sanitizeFailureMetadata({
							result: cleanupResult,
							errorKind: "cleanup_failed",
							failurePhase: "cleanup",
						}),
						result: cleanupResult,
					},
				}
			: { cleanupState: "complete" };
		try {
			await updateRun(
				applyRunId,
				result.ok
					? {
							state: "succeeded",
							...cleanup,
							finishedAt,
							terminalSummary: {
								status: "held_applied",
								heldRunId: runId,
								appliedHead: result.appliedHead,
								changedFiles: result.changedFiles,
							},
						}
					: {
							state: "failed",
							...cleanup,
							finishedAt,
							lastFailure: sanitizeFailureMetadata({
								result: result.reason,
								errorKind: "validation_failed",
								failurePhase: "integrate",
							}),
							terminalSummary: {
								status: "held_apply_refused",
								heldRunId: runId,
								reason: result.reason,
							},
						},
			);
		} catch {
			result.applyRecord = "unconfirmed";
		}
		return { ...result, applyRunId };
	};

	progress({ phase: "lock" });
	try {
		await (deps.acquireProjectLock ?? acquireProjectLock)(
			projectPath,
			applyRunId,
		);
	} catch (error) {
		return finish(
			refusal("project_lock_held", {
				...(typeof error?.holderRunId === "string"
					? { holderRunId: error.holderRunId }
					: {}),
			}),
		);
	}

	const state = { mutationStarted: false, record: null, claimed: null };
	let result;
	try {
		result = await applyUnderLock(
			{ projectPath, runId, applyRunId, deadlineMs, signal, now },
			{ ...deps, read, updateRun, progress, refusal, consumed },
			state,
		);
	} catch (error) {
		result = refusal(
			error?.code === "held_receipt_invalid"
				? "held_receipt_invalid"
				: state.mutationStarted
					? "held_apply_state_unknown"
					: "held_apply_failed",
			typeof error?.detail === "string" ? { detail: error.detail } : {},
		);
	}
	// Annotate the held record while the lock still excludes other appliers.
	// An unknown outcome keeps the `applying` claim; any other refusal after
	// the claim proves the tree untouched and returns the receipt to `held`.
	if (!result.ok && !UNRECORDED_REFUSALS.has(result.reason) && state.record) {
		const integration =
			result.reason === "held_apply_state_unknown" && state.claimed
				? state.claimed
				: heldIntegrationOf(state.record);
		try {
			await updateRun(runId, {
				terminalSummary: {
					...state.record.terminalSummary,
					integration: {
						...integration,
						lastApplyRefusal: {
							reason: result.reason,
							...(result.detail ? { detail: result.detail } : {}),
							at: new Date(now()).toISOString(),
							applyRunId,
						},
					},
				},
			});
		} catch {
			if (state.claimed) result.heldRecord = "unconfirmed";
		}
	}
	let released = false;
	try {
		released =
			(await (deps.releaseProjectLock ?? releaseProjectLockIfOwnedBy)(
				projectPath,
				applyRunId,
			)) === true;
	} catch {}
	result.lockReleased = released;
	return finish(result);
}

async function applyUnderLock(input, deps, state) {
	const { projectPath, runId, applyRunId, now } = input;
	const { read, updateRun, progress, refusal, consumed } = deps;
	// Re-read under the lock: a concurrent apply that won it first has
	// already marked the receipt applied.
	const record = await read(runId);
	const held = heldFor(record, runId, projectPath);
	if (!held)
		return refusal("held_receipt_invalid", { detail: "not_a_held_run" });
	if (held.state === "applied") return consumed(held);
	// A claim left by an earlier apply that ended without an outcome: that
	// apply may have written the patch, so only the owner can resolve it.
	if (held.state === "applying")
		return refusal("held_apply_state_unknown", {
			detail: "interrupted_apply",
			earlierApplyRunId: held.applyRunId,
		});
	const { receipt, patch, differentialBaselines } = readHeldIntegration(
		record,
		projectPath,
		runId,
	);
	state.record = record;

	progress({ phase: "verify" });
	const head = requireGit(
		projectPath,
		["rev-parse", "HEAD"],
		"project_revision_unavailable",
	).trim();
	const stale = staleDetail(receipt, head, projectPath);
	if (stale)
		return refusal("held_receipt_stale", {
			detail: stale,
			verifiedHead: receipt.verifiedHead,
			head,
		});
	let recheck = "not_needed";
	if (head !== receipt.verifiedHead && receipt.checks.length > 0) {
		progress({ phase: "recheck" });
		const checked = await (deps.runHeldRechecks ?? runHeldRechecks)(
			{
				applyRunId,
				projectPath,
				head,
				patch,
				receipt,
				differentialBaselines,
				deadlineMs: input.deadlineMs,
				now,
				signal: input.signal,
				onProgress: (details) => progress({ phase: "recheck", ...details }),
			},
			deps,
		);
		if (!checked?.ok)
			return refusal("held_recheck_failed", {
				detail: checked?.detail ?? "check_failed",
				...(checked?.checkIndex ? { checkIndex: checked.checkIndex } : {}),
				...(typeof checked?.differentialReason === "string"
					? { differentialReason: checked.differentialReason }
					: {}),
				...(checked?.checker === "retained" ? { checker: "retained" } : {}),
				head,
			});
		recheck = "passed";
		// The rechecks can take minutes; nothing may have moved under them.
		const after = requireGit(
			projectPath,
			["rev-parse", "HEAD"],
			"project_revision_unavailable",
		).trim();
		const moved = after !== head ? "head_moved_during_recheck" : null;
		const restale = moved ?? staleDetail(receipt, head, projectPath);
		if (restale)
			return refusal("held_receipt_stale", { detail: restale, head: after });
	}

	progress({ phase: "integrate" });
	const claimed = {
		...held,
		state: "applying",
		applyRunId,
		applyingAt: new Date(now()).toISOString(),
	};
	try {
		await updateRun(runId, {
			terminalSummary: { ...record.terminalSummary, integration: claimed },
		});
	} catch {
		return refusal("run_store_write_failed", {
			detail: "apply_claim_unrecorded",
		});
	}
	state.claimed = claimed;
	state.mutationStarted = true;
	const gate = (deps.integrationGate ?? integrationGate)(patch, projectPath, {
		allowedPaths: receipt.scopeFiles,
		allowSensitiveManifests: receipt.allowManifests.length > 0,
		allowExecutables: receipt.allowExecutables,
	});
	if (!gate?.success)
		return refusal(gateRefusal(gate), {
			detail: gate?.reasonKind ?? gate?.message ?? "integration_failed",
			head,
		});
	const appliedAt = new Date(now()).toISOString();
	const outputs = outputsAt(projectPath, receipt.changedFiles);
	let recorded = true;
	try {
		await updateRun(runId, {
			terminalSummary: {
				...record.terminalSummary,
				integration: {
					...held,
					state: "applied",
					appliedAt,
					appliedHead: head,
					applyRunId,
					recheck,
				},
			},
		});
	} catch {
		recorded = false;
	}
	return {
		ok: true,
		state: "applied",
		runId,
		verifiedHead: receipt.verifiedHead,
		appliedHead: head,
		appliedAt,
		recheck,
		changedFiles: receipt.changedFiles,
		outputs,
		outputsMatchHeld:
			JSON.stringify(outputs) === JSON.stringify(receipt.expectedOutputs),
		...(receipt.undeclaredPaths.length > 0
			? { undeclaredPaths: receipt.undeclaredPaths }
			: {}),
		heldRecord: recorded ? "applied" : "unconfirmed",
	};
}
