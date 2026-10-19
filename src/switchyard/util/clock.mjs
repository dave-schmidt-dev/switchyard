/**
 * Clock seam for deadline loops.
 *
 * A loop that polls until a deadline takes a `{ now, sleep }` clock and
 * defaults to this one, so a test can drive the deadline with a fake clock
 * instead of waiting real time on a host whose load decides the outcome.
 * Timestamps compared with operating-system values (process start times, file
 * mtimes) stay on `Date.now()`; only the deadline arithmetic and the pause
 * between polls go through the clock.
 *
 * @typedef {object} Clock
 * @property {() => number} now Milliseconds since the epoch.
 * @property {(ms: number) => Promise<void>} sleep Resolves after `ms`.
 */

/** @type {Readonly<Clock>} */
export const systemClock = Object.freeze({
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
