// Execution backend seam for disposable workspaces.

function abstractMethod(name) {
	throw new Error(
		`ExecutionBackend.${name}() must be implemented by a backend`,
	);
}

/**
 * Reject anything that is not a complete command vector. Every backend runs
 * this before building a transport, so a caller that forgets to pass `argv`
 * fails at the seam instead of producing a prefix that runs nothing.
 * @param {unknown} argv
 * @returns {string[]}
 */
export function normalizeExecArgv(argv) {
	if (!Array.isArray(argv) || argv.length === 0) {
		throw new TypeError("execArgv requires a non-empty argv command vector");
	}
	if (argv.some((entry) => typeof entry !== "string")) {
		throw new TypeError("execArgv command vector entries must be strings");
	}
	return [...argv];
}

/**
 * Contract implemented by every workspace execution substrate.
 *
 * `execArgv` takes the *complete* command vector and returns the transport
 * command and the full argument list to run it. It does not return a bare
 * prefix for callers to append to: `prlctl exec` joins its argument vector
 * into one string that the guest re-parses as shell source, so a transport
 * that never sees the provider argv cannot quote it, and any argument
 * carrying a space or newline — which is every prompt — is silently
 * word-split into different commands. Passing the whole vector through the
 * seam is what lets a backend quote it exactly once.
 *
 * The backend also owns `cwd`: honoring it is not optional transport
 * behavior. `prlctl exec` carries no working-directory field and lands in a
 * different launchd domain than the Aqua domain in which a provider must run,
 * so a VM backend must enforce both the directory and execution domain itself.
 * @public
 */
export class ExecutionBackend {
	preflight(...args) {
		return abstractMethod("preflight", args);
	}

	create(...args) {
		return abstractMethod("create", args);
	}

	execArgv(workspaceId, { cwd = "/project", argv } = {}) {
		return abstractMethod("execArgv", [workspaceId, { cwd, argv }]);
	}

	pushTar(...args) {
		return abstractMethod("pushTar", args);
	}

	pullTar(...args) {
		return abstractMethod("pullTar", args);
	}

	destroy(...args) {
		return abstractMethod("destroy", args);
	}

	listManaged(...args) {
		return abstractMethod("listManaged", args);
	}

	inspectProcess(...args) {
		return abstractMethod("inspectProcess", args);
	}

	/**
	 * Run one command in the workspace and return its captured output, throwing
	 * on a non-zero exit. Every provider adapter's authentication predicate calls
	 * this (14 call sites) inside a `try {} catch { return false }`, so a backend
	 * that omits it does not fail as a missing method — it silently reports every
	 * provider as unauthenticated. Declaring it here makes that a seam error.
	 */
	execGuest(...args) {
		return abstractMethod("execGuest", args);
	}

	/**
	 * Absolute home directory of the provider user inside the workspace.
	 * Credential-presence predicates build their paths from this rather than
	 * interpolating `/Users/<user>` themselves: that prefix is a macOS fact, and
	 * an adapter that hardcodes it silently reports every provider as
	 * unauthenticated on any substrate that puts homes elsewhere.
	 */
	guestHomePath(...args) {
		return abstractMethod("guestHomePath", args);
	}
}
