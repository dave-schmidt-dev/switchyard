import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/tempdir.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const VM_OPS = resolve(PKG_ROOT, "ops/macos-vm");
const PROBE = resolve(VM_OPS, "probe-guest-credentials.sh");
const IS_DARWIN = process.platform === "darwin";
const notDarwin = { skip: IS_DARWIN ? false : "macOS-only ops lane" };
const extractShellFunction = (body, name) => {
	const start = body.indexOf(`${name}() {`);
	ok(start !== -1, `no ${name}() in script`);
	const end = body.indexOf("\n}\n", start);
	ok(end !== -1, `unterminated ${name}()`);
	return body.slice(start, end + 3);
};
const scratch = () => tempDir("switchyard-vm-ops-");
const renderGuestScript = (dir) => {
	const rendered = readFileSync(PROBE, "utf8")
		.replace('  prlctl exec "$VM_NAME" /bin/bash -s <<EOF', "  cat <<EOF")
		.replace(/^ {2}require_host_tools$/m, "  true");
	ok(rendered.includes("cat <<EOF"), "probe's prlctl exec call moved");
	// Prose mentions prlctl exec repeatedly; only a command position matters.
	ok(
		!/^\s*prlctl exec\b/m.test(rendered),
		"probe has a second prlctl exec call",
	);
	const harness = join(dir, "render.sh");
	writeFileSync(harness, rendered);
	const run = spawnSync(
		"/bin/bash",
		[harness, "--vm", "probe-vm", "--phase", "baseline"],
		{
			encoding: "utf8",
		},
	);
	strictEqual(run.status, 0, `render failed: ${run.stderr}`);
	return run.stdout;
};
describe("the guest credential probe", () => {
	it(
		"renders a guest script that is syntax-clean under bash",
		notDarwin,
		() => {
			const dir = scratch();
			const guest = join(dir, "guest.sh");
			writeFileSync(guest, renderGuestScript(dir));
			const r = spawnSync("/bin/bash", ["-n", guest], { encoding: "utf8" });
			strictEqual(r.status, 0, `guest script is not valid bash: ${r.stderr}`);
		},
	);

	it(
		"routes every check through the provider's Aqua session",
		notDarwin,
		() => {
			const guest = renderGuestScript(scratch());
			// prlctl exec lands as root in the System domain; the CLIs live in the
			// auto-login account's Aqua session and the two see different Keychains.
			ok(
				/\/bin\/launchctl asuser "\$uid" \/usr\/bin\/sudo -iu "\$provider_user"/.test(
					guest,
				),
				"probe no longer enters the Aqua session the way install_guest_tools does",
			);
			ok(
				/launchctl managername/.test(guest),
				"probe no longer reports which domain it measured",
			);
		},
	);

	it("never asks the Keychain for secret data", () => {
		const body = readFileSync(PROBE, "utf8");
		const dumps = body.match(/security dump-keychain[^\n|]*/g) ?? [];
		ok(dumps.length > 0, "probe no longer enumerates the Keychain");
		for (const call of dumps) {
			ok(!/\s-d\b/.test(call), `dump-keychain must never use -d: ${call}`);
		}
		ok(
			!/security\s+find-generic-password[^\n]*-w/.test(body),
			"probe must not print a password",
		);
	});

	it(
		"scores the measured CLI outputs by output, not exit status",
		notDarwin,
		() => {
			const guest = renderGuestScript(scratch());
			const dir = scratch();
			const harness = join(dir, "classify.sh");
			writeFileSync(
				harness,
				[
					"set -uo pipefail",
					extractShellFunction(guest, "bounded"),
					extractShellFunction(guest, "classify"),
					// awk, not `head -1`: head would close the pipe early and
					// pipefail would surface classify's SIGPIPE as a harness failure.
					"verdict() {",
					'  classify "$@" | awk -F"\\t" \'NR==1 {print $2}\'',
					"}",
				].join("\n"),
			);

			// provider, unauth regex, auth rule, fixture stdout, fixture exit, want.
			// Every fixture is a real output captured from the pinned CLIs on
			// 2026-08-14 in a credential-free container.
			const cases = [
				[
					"claude",
					'"loggedIn": false',
					'"loggedIn": true',
					'{\n  "loggedIn": false\n}',
					1,
					"unauthenticated",
				],
				[
					"claude",
					'"loggedIn": false',
					'"loggedIn": true',
					'{\n  "loggedIn": true\n}',
					0,
					"authenticated",
				],
				[
					"codex",
					"Not logged in",
					"Logged in",
					"Not logged in",
					1,
					"unauthenticated",
				],
				[
					"agy",
					"Please sign in|authentication required",
					"gemini-",
					"Error: Please sign in to view available models.",
					1,
					"unauthenticated",
				],
				// agy words its refusal differently in the VM than in the container.
				// Measured in switchyard-check-2 on 2026-08-14; the container fixture
				// above is the same day. Both must score unauthenticated.
				[
					"agy",
					"Please sign in|authentication required",
					"gemini-",
					"Error: authentication required. Run 'agy' to log in, then retry.",
					1,
					"unauthenticated",
				],
				[
					"agy",
					"Please sign in|authentication required",
					"gemini-",
					"gemini-3.7-flash-medium",
					0,
					"authenticated",
				],
				// The two that exit 0 while logged out.
				[
					"cursor-agent",
					"Not logged in",
					"Logged in|Email|Account",
					"Not logged in",
					0,
					"unauthenticated",
				],
				[
					"opencode",
					"0 credentials",
					"[1-9][0-9]* credentials",
					"0 credentials",
					0,
					"unauthenticated",
				],
				[
					"opencode",
					"0 credentials",
					"[1-9][0-9]* credentials",
					"3 credentials",
					0,
					"authenticated",
				],
				[
					"copilot",
					"No authentication information found",
					"exit0",
					"Error: No authentication information found.",
					1,
					"unauthenticated",
				],
				[
					"copilot",
					"No authentication information found",
					"exit0",
					"ok",
					0,
					"authenticated",
				],
				// A transport failure is neither, and must not be scored as a pass.
				[
					"copilot",
					"No authentication information found",
					"exit0",
					"fetch failed",
					1,
					"indeterminate",
				],
			];

			for (const [provider, unauth, rule, output, status, want] of cases) {
				const fixture = join(dir, "fixture.sh");
				writeFileSync(
					fixture,
					`printf '%s\\n' ${JSON.stringify(output)}\nexit ${status}\n`,
				);
				const r = spawnSync(
					"/bin/bash",
					[
						"-c",
						`. ${JSON.stringify(harness)}; verdict "$@"`,
						"harness",
						provider,
						unauth,
						rule,
						"/bin/sh",
						fixture,
					],
					{ encoding: "utf8" },
				);
				strictEqual(r.status, 0, `classify harness failed: ${r.stderr}`);
				strictEqual(
					r.stdout.trim(),
					want,
					`${provider} with output ${JSON.stringify(output)} exit ${status}`,
				);
			}
		},
	);

	it("bounds a hung provider check without coreutils", notDarwin, () => {
		const guest = renderGuestScript(scratch());
		const dir = scratch();
		const harness = join(dir, "bounded.sh");
		writeFileSync(
			harness,
			`set -uo pipefail\n${extractShellFunction(guest, "bounded")}\n`,
		);
		const started = Date.now();
		const r = spawnSync(
			"/bin/bash",
			["-c", `. ${JSON.stringify(harness)}; bounded 1 /bin/sleep 30`],
			{ encoding: "utf8" },
		);
		const elapsed = Date.now() - started;
		ok(r.status !== 0, "a hung check must not report success");
		ok(elapsed < 10_000, `alarm did not fire: ${elapsed}ms`);
	});

	// Regression, found on the first real guest run (2026-08-14): the probe is
	// itself delivered to `bash -s` on stdin, so a provider that reads stdin --
	// agy does, when it decides to prompt for a login -- swallows the remainder
	// of the script. The baseline run ended silently after agy and never ran
	// cursor-agent, copilot, or opencode. Nothing failed; three rows just
	// disappeared, which is the worst shape a credential probe can fail in.
	it(
		"does not let a provider check eat the rest of the script",
		notDarwin,
		() => {
			const guest = renderGuestScript(scratch());
			const dir = scratch();
			const harness = join(dir, "stdin.sh");
			writeFileSync(
				harness,
				[
					"set -uo pipefail",
					extractShellFunction(guest, "bounded"),
					extractShellFunction(guest, "classify"),
					// /bin/cat is the minimal stand-in for a stdin-reading provider.
					"classify greedy no-such-string exit0 /bin/cat >/dev/null 2>&1",
					'printf "SURVIVED\\n"',
				].join("\n"),
			);
			const r = spawnSync("/bin/bash", ["-s"], {
				encoding: "utf8",
				input: readFileSync(harness, "utf8"),
			});
			strictEqual(
				r.stdout.trim(),
				"SURVIVED",
				"a stdin-reading provider consumed the script tail",
			);
		},
	);
});
