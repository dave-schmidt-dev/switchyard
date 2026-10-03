import { createHash } from "node:crypto";
import { materializeDirtyOverlay } from "../lifecycle/index.mjs";
import { git, MAX_CAPTURE_BYTES, requireGit, SECRET_PATHS } from "./args.mjs";

const BASELINE_STATUS_TIMEOUT_MS = 5_000;
const SAFE_SIGNALS = new Set(["SIGINT", "SIGTERM", "SIGKILL", "SIGABRT"]);

function remainingMs(deadlineMs, now) {
	return Math.max(0, deadlineMs - now());
}

function workingStatus(git, worktreePath, timeoutMs) {
	const result = git(
		worktreePath,
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		{ timeout: Math.max(100, Math.min(BASELINE_STATUS_TIMEOUT_MS, timeoutMs)) },
	);
	return result?.status === 0 && typeof result.stdout === "string"
		? result.stdout
		: null;
}

export async function runSimpleBaselineChecks({
	checks = [],
	taskId,
	worktreePath,
	deadlineMs,
	now = Date.now,
	signal,
	runCheck,
	git,
	onStatus,
}) {
	if (!checks.length) return { status: "not_requested", checks: [] };
	const before = workingStatus(git, worktreePath, remainingMs(deadlineMs, now));
	if (before === null) return { status: "unknown", checks: [] };
	if (before.length > 0)
		return { status: "mutation_detected", checks: [], mutationCount: 1 };
	const results = [];
	for (const [index, command] of checks.entries()) {
		if (signal?.aborted) return { status: "cancelled", checks: results };
		const timeoutMs = remainingMs(deadlineMs, now);
		if (timeoutMs <= 0)
			return { status: "failed", checks: results, timedOut: true };
		const checkIdentity = createHash("sha256").update(command).digest("hex");
		onStatus?.({
			phase: "baseline",
			event: "baseline_check_started",
			taskId,
			checkIndex: index + 1,
			checkIdentity,
			status: "in_progress",
		});
		let result;
		try {
			result = await runCheck({
				command,
				worktreePath,
				timeoutMs,
				signal,
				onProgress: () =>
					onStatus?.({
						phase: "baseline",
						event: "baseline_check_progress",
						taskId,
						checkIndex: index + 1,
						checkIdentity,
						status: "in_progress",
					}),
			});
		} catch {
			return { status: "unknown", checks: results };
		}
		const item = {
			index: index + 1,
			identity: checkIdentity,
			success: result?.success === true,
			exitCode:
				Number.isSafeInteger(result?.code) &&
				result.code >= 0 &&
				result.code <= 255
					? result.code
					: null,
			signal: SAFE_SIGNALS.has(result?.signal) ? result.signal : null,
			timedOut: result?.timedOut === true,
			writerLifecycle: ["stopped", "never_started", "unavailable"].includes(
				result?.writerLifecycle,
			)
				? result.writerLifecycle
				: "unknown",
		};
		results.push(item);
		onStatus?.({
			phase: "baseline",
			event: "baseline_check_finished",
			taskId,
			checkIndex: index + 1,
			checkIdentity,
			checkStatus: item.success ? "passed" : "failed",
			status: item.success ? "passed" : "failed",
		});
		if (signal?.aborted) return { status: "cancelled", checks: results };
		if (
			item.writerLifecycle === "unavailable" ||
			item.writerLifecycle === "unknown"
		)
			return { status: "unknown", checks: results };
		const afterCheck = workingStatus(
			git,
			worktreePath,
			remainingMs(deadlineMs, now),
		);
		if (afterCheck === null) return { status: "unknown", checks: results };
		if (before !== afterCheck) {
			const entries = afterCheck.split("\0").filter(Boolean);
			return {
				status: "mutation_detected",
				checks: results,
				mutationCount: Math.min(4096, Math.max(1, entries.length)),
			};
		}
		if (!item.success) return { status: "failed", checks: results };
	}
	const after = workingStatus(git, worktreePath, remainingMs(deadlineMs, now));
	if (after === null) return { status: "unknown", checks: results };
	if (before !== after) {
		const entries = after.split("\0").filter(Boolean);
		return {
			status: "mutation_detected",
			checks: results,
			mutationCount: Math.min(4096, Math.max(1, entries.length)),
		};
	}
	return { status: "passed", checks: results };
}

/** Replay the captured overlay and establish the exact provider/checker base. */
export function prepareSimpleOverlayBaseline({
	worktreePath,
	dirtyOverlayReceipt,
	baselinePaths,
	deadlineMs,
	now,
}) {
	materializeDirtyOverlay(worktreePath, dirtyOverlayReceipt, {
		maxFileBytes: MAX_CAPTURE_BYTES,
		secretPaths: SECRET_PATHS,
	});
	requireGit(
		worktreePath,
		["add", "-A", "--", ...baselinePaths],
		"dirty_overlay_stage_failed",
		{ timeout: Math.max(1, deadlineMs - now()) },
	);
	const overlayDiff = git(worktreePath, ["diff", "--cached", "--quiet"], {
		timeout: Math.max(1, deadlineMs - now()),
	});
	if (overlayDiff.status === 1) {
		requireGit(
			worktreePath,
			[
				"-c",
				"user.name=switchyard",
				"-c",
				"user.email=switchyard@localhost",
				"commit",
				"-qm",
				"switchyard-dirty-overlay",
			],
			"dirty_overlay_baseline_failed",
			{ timeout: Math.max(1, deadlineMs - now()) },
		);
	} else if (overlayDiff.status !== 0) {
		throw Object.assign(new Error("dirty_overlay_baseline_failed"), {
			code: "dirty_overlay_baseline_failed",
		});
	}
	return requireGit(
		worktreePath,
		["rev-parse", "HEAD"],
		"dirty_overlay_baseline_revision_unavailable",
		{ timeout: Math.max(1, deadlineMs - now()) },
	).trim();
}
