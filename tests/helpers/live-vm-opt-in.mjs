/**
 * Live-VM tests clone and boot a real Parallels guest. Owner decision O9
 * (2026-10-18) makes them opt-in: run them at milestones and before VM-lane
 * releases with `SWITCHYARD_LIVE_VM_TESTS=1`, never on every validate.
 */
const LIVE_VM_OPT_IN_ENV = "SWITCHYARD_LIVE_VM_TESTS";

export const LIVE_VM_OPT_OUT_REASON = `live VM tests are opt-in: set ${LIVE_VM_OPT_IN_ENV}=1`;

/** Returns the skip reason, or null when the caller opted in. */
export function liveVmOptOutReason(env = process.env) {
	return env[LIVE_VM_OPT_IN_ENV] === "1" ? null : LIVE_VM_OPT_OUT_REASON;
}
