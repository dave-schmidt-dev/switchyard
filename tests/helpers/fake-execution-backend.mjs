// Lightweight stand-in for ParallelsExecutionBackend used by adapter
// isXAuthenticated() tests. Adapters call `executionBackend.execGuest(...)`
// only two shapes: a `<cmd> --version` liveness probe, and a
// `sh -c "[ -f PATH ] && [ ... -ge N ]"` credential-presence/byte-threshold
// check (see e.g. src/switchyard/adapter/claude.mjs). This fake interprets
// exactly those two shapes against an in-memory file map rather than
// spinning up a real guest, and lets a `respond` override handle
// provider-specific extra commands (e.g. cursor's `status --format json`).

export const FAKE_PROVIDER_USER = "switchyard";

function evalCredentialCheckScript(script, files, providerUser) {
	const prefix = `/Users/${providerUser}/`;
	const paths = [...script.matchAll(/-f (\S+) \]/g)].map((m) => m[1]);
	const thresholds = [...script.matchAll(/-ge (\d+) \]/g)].map((m) =>
		Number(m[1]),
	);
	if (paths.length === 0 || paths.length !== thresholds.length) {
		throw new Error(`unrecognized credential-check script: ${script}`);
	}
	for (let i = 0; i < paths.length; i++) {
		const abs = paths[i];
		if (!abs.startsWith(prefix)) {
			throw new Error(`unexpected path outside provider home: ${abs}`);
		}
		const relative = abs.slice(prefix.length);
		const content = files[relative];
		if (content == null) {
			throw new Error(`no such file: ${relative}`);
		}
		if (Buffer.byteLength(content) < thresholds[i]) {
			throw new Error(`file too small: ${relative}`);
		}
	}
	return Buffer.from("");
}

/**
 * @param {object} [options]
 * @param {string} [options.providerUser]
 * @param {string} [options.version] `--version` stdout; omit/null to make the
 *   binary appear absent (execGuest throws).
 * @param {Record<string, string>} [options.files] Credential files, keyed by
 *   path relative to `/Users/<providerUser>/`. Mutate this object between
 *   assertions in the same test to simulate a changing guest filesystem.
 * @param {(command: string, args: string[], options: object) => (Buffer|string)} [options.respond]
 *   Fallback handler for any command/args shape not covered by the built-in
 *   `--version`/credential-check handling (e.g. cursor's `status` subcommand).
 */
export function createFakeExecutionBackend({
	providerUser = FAKE_PROVIDER_USER,
	version = null,
	files = {},
	respond,
} = {}) {
	return {
		providerUser,
		execGuest(_workspaceId, command, args = [], _execOptions = {}) {
			if (command === "sh" && args[0] === "-c") {
				return evalCredentialCheckScript(args[1], files, providerUser);
			}
			if (args[0] === "--version") {
				if (version == null) {
					throw new Error("command not found");
				}
				return Buffer.from(version);
			}
			if (respond) {
				return respond(command, args, _execOptions);
			}
			throw new Error(
				`fake execGuest: unhandled invocation ${command} ${args.join(" ")}`,
			);
		},
	};
}
