/**
 * The doctor subset that runs at `simple` start: qualification expiry,
 * repair holds and, for a caller-supplied routing run, its stranded pending
 * attempt. File reads only, bounded by a deadline, and silent unless a check
 * positively finds a problem; anything unreadable is left to the full
 * `switchyard-dispatch doctor`.
 */

import {
	checkQualificationExpiry,
	checkRepairHolds,
	checkStrandedPending,
	STATUS,
} from "./checks.mjs";
import {
	readQualificationSlots,
	readRepairHolds,
	readStrandedPending,
} from "./state.mjs";

const QUICK_DEADLINE_MS = 2_000;

/**
 * One stderr line naming each non-OK quick check, or null when all pass.
 * Never throws.
 * @param {{projectPath: string, routingRunId?: string|null,
 *   routingRunIdSource?: string, now?: () => number, readers?: object,
 *   deadlineMs?: number}} options
 *   A generated routing ID is a fresh run, so its pending scan is skipped.
 * @returns {Promise<string|null>}
 */
export async function quickDoctorLine({
	projectPath,
	routingRunId = null,
	routingRunIdSource = "generated",
	now = Date.now,
	readers = {},
	deadlineMs = QUICK_DEADLINE_MS,
}) {
	try {
		const read = {
			qualification: readQualificationSlots,
			holds: readRepairHolds,
			pending: readStrandedPending,
			...readers,
		};
		const scoped = routingRunIdSource !== "generated" && routingRunId;
		let timer;
		const answers = await Promise.race([
			Promise.all([
				read.qualification(),
				read.holds(),
				scoped
					? read.pending({ project: projectPath, routingRunId })
					: { pending: [] },
			]),
			new Promise((done) => {
				timer = setTimeout(() => done(null), deadlineMs);
				timer.unref?.();
			}),
		]).finally(() => clearTimeout(timer));
		if (!answers) return null;
		const [qualification, holds, pending] = answers;
		const nowMs = now();
		const found = [
			qualification?.error
				? null
				: checkQualificationExpiry(qualification, nowMs),
			holds?.error ? null : checkRepairHolds(holds),
			pending?.error ? null : checkStrandedPending(pending),
		].filter((check) => check && check.status !== STATUS.OK);
		if (found.length === 0) return null;
		return `switchyard doctor: ${found
			.map((check) => `${check.status} ${check.id}: ${check.summary}`)
			.join("; ")}; run "switchyard-dispatch doctor" for fixes`;
	} catch {
		return null;
	}
}
