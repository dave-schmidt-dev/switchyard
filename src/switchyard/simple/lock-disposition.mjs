import { projectDisposition } from "../dispatch/disposition.mjs";
import { recoveryCommandFor } from "../dispatch/status-envelope.mjs";
import { RUN_ID_RE } from "../run-store/errors.mjs";
import { readRun } from "../run-store/index.mjs";
import { classifyRunLiveness } from "../run-store/run-liveness.mjs";

/** Read caller-only holder facts; never persist them or mutate the conflicting lock. */
export async function simpleLockDisposition(
	error,
	projectPath,
	dependencies = {},
) {
	const holderRunId =
		typeof error?.holderRunId === "string" &&
		error.holderRunId.length <= 256 &&
		RUN_ID_RE.test(error.holderRunId)
			? error.holderRunId
			: null;
	let holderLiveness = "unknown";
	if (error?.code === "PROJECT_LOCK_HELD" && holderRunId) {
		try {
			const holder = await (dependencies.readRun ?? readRun)(holderRunId);
			if (holder?.runId === holderRunId && holder.projectPath === projectPath) {
				holderLiveness = classifyRunLiveness(holder, {
					now: (dependencies.now ?? Date.now)(),
					probePid: dependencies.probePid,
				});
			}
		} catch {
			// Missing, unreadable, or mismatched durable evidence stays fail-closed.
		}
	}
	const lockConflict = {
		type: "lock_conflict",
		code:
			error?.code === "PROJECT_LOCK_HELD" ? error.code : "PROJECT_LOCK_FAILED",
		holderRunId,
		holderLiveness,
	};
	const disposition = projectDisposition({
		preInitialization: lockConflict,
		recoveryCommand: holderRunId ? recoveryCommandFor(holderRunId) : null,
	});
	return { lockConflict, disposition };
}
