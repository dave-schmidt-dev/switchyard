// Best-effort in-container process cleanup after a host-side execFileSync
// timeout. `docker exec` does not forward host signals into the container's
// PID namespace — killing the host-side exec client (SIGTERM on ETIMEDOUT)
// leaves whatever it spawned inside the container running unsupervised.
// Empirically verified: a process started via `docker exec` kept executing
// for several seconds after its host-side client was killed on timeout.

import { execFileSync } from "node:child_process";
import { validateIdentifier } from "./shell-safety.mjs";

/**
 * Kill every process inside a container except PID 1 (the container's own
 * `sleep infinity` keep-alive process — see lifecycle/index.mjs). `kill -1`
 * targets "every process the caller may signal, except PID 1 and the caller
 * itself" (POSIX kill(2)), so this reaches an orphaned provider CLI without
 * needing `pkill`/`ps` to be installed in the agent image. TERM first, then
 * KILL after a short grace period, so a process gets a chance to flush
 * before being forced. Best-effort: swallows all errors, since this runs
 * from an adapter's timeout catch block and must never itself throw or
 * block returning the (already-failed) execution result.
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
				"kill -TERM -1 2>/dev/null; sleep 1; kill -KILL -1 2>/dev/null",
			],
			{ timeout: 5000, stdio: "pipe" },
		);
	} catch {
		// Best-effort — the container may already be gone, or the shell may
		// not exist; either way there's nothing left to clean up.
	}
}
