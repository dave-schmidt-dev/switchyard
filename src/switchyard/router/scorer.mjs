// Scorer module - capacity scoring for provider selection
// Reuses review-plugin's scoring logic: 0.9·pace + 0.1·jitter
// Seedable PRNG for deterministic behavior

/**
 * FNV-1a 32-bit string hash → uint32.
 */
function hashString(str) {
	let h = 0x811c9dc5;
	for (const ch of str) {
		h ^= ch.charCodeAt(0);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/**
 * Order-independent avalanche mix of two uint32 → uint32.
 */
function mix(a, b) {
	let h = (a ^ b) >>> 0;
	h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
	h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
	return (h ^ (h >>> 16)) >>> 0;
}

/**
 * mulberry32 PRNG. Returns a function yielding floats in [0, 1).
 */
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Deterministic jitter in [0, 1) for (seed, key). Independent of iteration
 * order — derived purely from the inputs.
 *
 * @param {number} seed uint32 seed.
 * @param {string} key Candidate key (`provider:model`).
 * @returns {number}
 */
export function jitter(seed, key) {
	return mulberry32(mix(seed >>> 0, hashString(key)))();
}

/**
 * Resolve the routing seed. Precedence: explicit finite `seed`, else a
 * hash of `runId`, else a fixed default.
 *
 * @param {{seed?: number, runId?: string}} opts
 * @returns {{seed: number}}
 */
export function resolveSeed({ seed, runId }) {
	if (typeof seed === "number" && Number.isFinite(seed)) {
		return { seed: seed >>> 0 };
	}
	if (typeof runId === "string" && runId.length > 0) {
		return { seed: hashString(runId) };
	}
	return { seed: 0 };
}

/**
 * Compute normalized pace and score for a provider.
 * Score = 0.9 * normPace + 0.1 * jitter
 *
 * @param {number} pace The raw pace value (pace_delta from snapshot)
 * @param {number} seed The routing seed
 * @param {string} key Candidate key for jitter
 * @param {number[]} allPaces All pace values for normalization
 * @returns {{normPace: number, jitter: number, score: number}}
 */
export function computeScore(pace, seed, key, allPaces) {
	const lo = Math.min(...allPaces);
	const hi = Math.max(...allPaces);
	const span = hi - lo;
	const normPace = span === 0 ? 1.0 : (pace - lo) / span;
	const jitterVal = jitter(seed, key);
	const score = 0.9 * normPace + 0.1 * jitterVal;
	return { normPace, jitter: jitterVal, score };
}
