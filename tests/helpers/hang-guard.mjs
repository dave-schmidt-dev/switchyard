/**
 * Upper bound for a spawned child, or a whole test, that should finish in
 * seconds.
 *
 * A hang guard only catches hangs and must never decide a healthy run. On
 * 2026-10-18 this host's process launches stalled for 6 to 10 s at load
 * averages from 6 to 25, and 10 s and 20 s guards killed healthy children in
 * three suites. Use this instead of a tighter literal.
 */
export const HANG_GUARD_MS = 60_000;
