/** Live stall reporting for the engine's post-terminal finalization. */
import { performance } from "node:perf_hooks";

const TICK_MS = 5_000;
const WAIT_REPORT_MS = 60_000;
const BLOCKED_REPORT_MS = 10_000;

/**
 * Report a stalled finalization step instead of waiting silently.
 *
 * The 2026-10-15 hermes attempt sat 11.4 hours between its terminal milestone
 * and its failure disposition with no output at all. An awaited step that
 * stays in flight is reported every `waitReportMs`. A synchronous call that
 * blocks the event loop cannot be reported while it blocks, so the first
 * check after it returns measures the lost time and names the step that was
 * in flight. Nothing here times out or abandons a step.
 *
 * @param {object} options
 * @param {(line: string) => void} options.warn - Writes one warning line.
 * @param {() => number} [options.clock] - Monotonic milliseconds.
 * @param {number} [options.tickMs] - Check interval.
 * @param {number} [options.waitReportMs] - Report period for a waiting step.
 * @param {number} [options.blockedReportMs] - Smallest reported loop block.
 * @param {{setInterval: Function, clearInterval: Function}} [options.timers]
 * @returns {{step: (name: string) => void, stop: () => object|null}} `stop`
 *   returns the longest stall as `{ step, kind, durationMs }`, or null.
 */
export function createFinalizationWatch({
	warn,
	clock = () => performance.now(),
	tickMs = TICK_MS,
	waitReportMs = WAIT_REPORT_MS,
	blockedReportMs = BLOCKED_REPORT_MS,
	timers = { setInterval, clearInterval },
}) {
	let step = null;
	let stepStartedAt = clock();
	let lastWaitReportAt = stepStartedAt;
	let lastTickAt = stepStartedAt;
	let longest = null;
	const report = (line) => {
		try {
			warn(`dispatch: simple finalization ${line}`);
		} catch {}
	};
	const record = (kind, durationMs) => {
		if (longest === null || durationMs > longest.durationMs)
			longest = { step, kind, durationMs: Math.round(durationMs) };
	};
	const check = (scheduled) => {
		const observed = clock();
		const blockedMs = observed - lastTickAt - tickMs;
		if (scheduled || blockedMs >= blockedReportMs) lastTickAt = observed;
		if (step === null) return;
		if (blockedMs >= blockedReportMs) {
			report(`step=${step} event_loop_blocked_ms=${Math.round(blockedMs)}`);
			record("event_loop_blocked", blockedMs);
			lastWaitReportAt = observed;
			return;
		}
		const waitedMs = observed - stepStartedAt;
		if (
			waitedMs >= waitReportMs &&
			observed - lastWaitReportAt >= waitReportMs
		) {
			lastWaitReportAt = observed;
			report(`step=${step} waiting_ms=${Math.round(waitedMs)}`);
			record("waiting", waitedMs);
		}
	};
	const handle = timers.setInterval(() => check(true), tickMs);
	handle?.unref?.();
	return {
		step(name) {
			// A block that ended just before this call belongs to the prior step.
			check(false);
			step = name;
			stepStartedAt = clock();
			lastWaitReportAt = stepStartedAt;
		},
		stop() {
			check(false);
			timers.clearInterval(handle);
			step = null;
			return longest;
		},
	};
}
