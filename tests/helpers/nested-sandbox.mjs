import { spawnSync } from "node:child_process";

/**
 * Skip reason for tests that run the real check engine, or false when they can
 * run. The engine starts `sandbox-exec`, and macOS refuses to apply a profile
 * from inside a sandbox (exit 71), so these tests cannot run as a Switchyard
 * dispatch check. The host pre-push suite still runs them.
 */
export const nestedSandboxSkip = (() => {
	const probe = spawnSync(
		"/usr/bin/sandbox-exec",
		["-p", "(version 1)(allow default)", "/usr/bin/true"],
		{ stdio: "ignore" },
	);
	return probe.status === 0
		? false
		: "already inside a Seatbelt sandbox; sandbox-exec cannot nest (runs in the host suite)";
})();
