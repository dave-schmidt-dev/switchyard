// D-9: best-effort in-container process cleanup after a host-side execFileSync
// timeout. `docker exec` does not forward host signals into the container's
// PID namespace — killing the host-side exec client (SIGTERM on ETIMEDOUT)
// leaves whatever it spawned inside the container running unsupervised.
// Empirically verified: a process started via `docker exec` kept executing
// for several seconds after its host-side client was killed on timeout.

import { execFile, execFileSync } from "node:child_process";
import { validateIdentifier } from "./shell-safety.mjs";

/**
 * Kill every process inside a container except PID 1 (the container's own
 * `sleep infinity` keep-alive process — see lifecycle/index.mjs). `kill -1`
 * targets "every process the caller may signal, except PID 1 and the caller
 * itself" (POSIX kill(2)), so this reaches an orphaned provider CLI without
 * needing `pkill`/`ps` to be installed in the agent image. TERM first, then
 * KILL after a short grace period, so a process gets a chance to flush
 * before being forced.
 *
 * Also clears a stale `/project/.git/index.lock` left behind if the killed
 * process was itself mid `git add`/`git commit` (a real, empirically
 * confirmed case: a stale lock makes captureDiff's own `git add -A` fail,
 * which its catch-all swallows into a silent `null` — losing the very work
 * this whole timeout path exists to preserve). Safe specifically at this
 * point: every process in the container has just been force-killed above, so
 * nothing can still legitimately hold the lock.
 *
 * Best-effort throughout: swallows all errors, since this runs from an
 * adapter's timeout catch block and must never itself throw or block
 * returning the (already-failed) execution result.
 * @param {string} containerName
 */
export function killOrphanedProcesses(containerName) {
	try {
		validateIdentifier(containerName, "containerName");
	} catch {
		return;
	}
	try {
		execFileSync(
			"docker",
			[
				"exec",
				containerName,
				"sh",
				"-c",
				"kill -TERM -1 2>/dev/null; sleep 1; kill -KILL -1 2>/dev/null; " +
					"rm -f /project/.git/index.lock 2>/dev/null",
			],
			{ timeout: 5000, stdio: "pipe" },
		);
	} catch {
		// Best-effort — the container may already be gone, or the shell may
		// not exist; either way there's nothing left to clean up.
	}
}

/**
 * Non-blocking counterpart for async provider lifecycles. The command is
 * deliberately identical to killOrphanedProcesses so TERM/KILL ordering and
 * stale-index cleanup remain one containment policy.
 * @param {string} containerName
 * @returns {Promise<void>}
 */
export function killOrphanedProcessesAsync(containerName) {
	try {
		validateIdentifier(containerName, "containerName");
	} catch {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		let child;
		try {
			child = execFile(
				"docker",
				[
					"exec",
					containerName,
					"sh",
					"-c",
					"kill -TERM -1 2>/dev/null; sleep 1; kill -KILL -1 2>/dev/null; " +
						"rm -f /project/.git/index.lock 2>/dev/null",
				],
				{ timeout: 5000, stdio: "ignore" },
				finish,
			);
		} catch {
			finish();
			return;
		}
		child?.once?.("error", finish);
		child?.once?.("close", finish);
		setTimeout(finish, 5000).unref?.();
	});
}
