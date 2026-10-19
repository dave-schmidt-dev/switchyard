/**
 * Fake `{ now, sleep }` clock for deadline loops that take the
 * `util/clock.mjs` seam. `sleep` advances the clock at once and resolves on a
 * microtask, so a loop's deadline is reached by the clock, never by host
 * load. `sleeps` records every requested pause.
 */
export function fakeClock(startMs = 0) {
	let nowMs = startMs;
	const sleeps = [];
	return {
		now: () => nowMs,
		sleep: async (ms) => {
			sleeps.push(ms);
			nowMs += ms;
		},
		sleeps,
	};
}
