import { createHash } from "node:crypto";
import { PERSISTED_SIGNALS } from "../adapter/exec-error-kinds.mjs";
import { classifyFailedCheck } from "./check-environment.mjs";
import { aggregateWriterLifecycle } from "./recovery.mjs";

/** Longest a single pre-provider check may run, however much deadline remains. */
export const DRY_RUN_CHECK_CAP_MS = 120_000;

const SETTLED_LIFECYCLES = new Set(["stopped", "never_started"]);

// Same identity as baseline.mjs: sha256 hex of the command text.
const checkIdentityOf = (command) =>
	createHash("sha256").update(command).digest("hex");

/**
 * Run the acceptance checks once against the base tree, before any provider
 * starts, to catch a check that cannot run here at all.
 *
 * Only a classified environment failure (see `classifyFailedCheck`) stops the
 * attempt. A check that fails for any other reason, or times out, is expected
 * on an unmodified tree and the run proceeds. This is not a baseline run: it
 * does not require a clean tree and never decides acceptance.
 *
 * Statuses: `passed` (all ran), `environment_failed` (first classified check,
 * with `checkIndex`, `checkIdentity`, `signature`, `outputPath`, `exitCode`,
 * `signal`, and — when the caller resolved them — `checkExecutable` and
 * `hostExecutable`), `cancelled`, `deadline_expired` (stopped early; the
 * engine's own deadline fences fail the run in their phase), `unconfirmed` (a
 * check left its process group unsettled; the caller's session removal rejects
 * it).
 *
 * @param {object} options
 * @param {string[]} options.checks Acceptance check commands, in order.
 * @param {Function} options.runCheck Session `runCheck` (writes check evidence on failure).
 * @param {Function} [options.resolveCheckExecutables] Resolves a check command
 *   to its sandbox and host executables; null/omitted skips the comparison.
 * @param {number} options.deadlineMs Absolute deadline, ms since epoch.
 * @param {Function} [options.now]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.capMs] Per-check cap; tests inject a smaller one.
 * @param {Function} [options.onProgress] Called with `{event, checkIndex,
 *   checkIdentity, checkStatus?}`; `*_progress` events are heartbeats.
 * @returns {Promise<object>}
 */
export async function dryRunAcceptanceChecks({
	checks = [],
	runCheck,
	resolveCheckExecutables = null,
	deadlineMs,
	now = Date.now,
	signal = null,
	onProgress = null,
	capMs = DRY_RUN_CHECK_CAP_MS,
}) {
	const cap =
		Number.isFinite(capMs) && capMs > 0 ? capMs : DRY_RUN_CHECK_CAP_MS;
	let writerLifecycle = "never_started";
	const finish = (status, extra = {}) => ({
		status,
		writerLifecycle,
		...extra,
	});
	for (const [position, command] of checks.entries()) {
		if (signal?.aborted) return finish("cancelled");
		const remaining = deadlineMs - now();
		if (remaining <= 0) return finish("deadline_expired");
		const checkIndex = position + 1;
		const checkIdentity = checkIdentityOf(command);
		const emit = (event, extra = {}) =>
			onProgress?.({ event, checkIndex, checkIdentity, ...extra });
		emit("dry_run_check_started");
		let result;
		try {
			result = await runCheck({
				command,
				timeoutMs: Math.min(remaining, cap),
				signal,
				onProgress: () => emit("dry_run_check_progress"),
			});
		} catch (error) {
			if (signal?.aborted || error?.code === "cancelled")
				return finish("cancelled");
			if (error?.code === "deadline_expired") return finish("deadline_expired");
			throw error;
		}
		writerLifecycle = aggregateWriterLifecycle(
			writerLifecycle,
			result?.writerLifecycle,
		);
		emit("dry_run_check_finished", {
			checkStatus: result?.success ? "passed" : "failed",
		});
		if (signal?.aborted) return finish("cancelled");
		if (!SETTLED_LIFECYCLES.has(result?.writerLifecycle))
			return finish("unconfirmed");
		const signature = classifyFailedCheck(result, { preProvider: true });
		if (signature) {
			// Task 2.8: when the failing check's command resolves differently in
			// the check sandbox and on the host, both paths travel with the
			// classification. Resolution can never change the gate result.
			let executableDetails = null;
			if (typeof resolveCheckExecutables === "function") {
				try {
					executableDetails = await resolveCheckExecutables(command);
				} catch {
					executableDetails = null;
				}
			}
			return finish("environment_failed", {
				checkIndex,
				checkIdentity,
				signature,
				outputPath:
					typeof result.outputPath === "string" ? result.outputPath : null,
				exitCode:
					Number.isSafeInteger(result.code) &&
					result.code >= 0 &&
					result.code <= 255
						? result.code
						: null,
				signal: PERSISTED_SIGNALS.has(result.signal) ? result.signal : null,
				...(executableDetails?.checkExecutable
					? { checkExecutable: executableDetails.checkExecutable }
					: {}),
				...(executableDetails?.hostExecutable
					? { hostExecutable: executableDetails.hostExecutable }
					: {}),
			});
		}
	}
	return finish("passed");
}
