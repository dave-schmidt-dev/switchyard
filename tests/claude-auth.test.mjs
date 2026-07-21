import { ok, strictEqual } from "node:assert";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	authenticateClaude,
	buildAuthContainerScript,
	captureDiff,
	executeClaude,
	isClaudeAuthenticated,
} from "../src/switchyard/adapter/claude.mjs";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function hasDocker() {
	try {
		execSync("docker --version", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const dockerAvailable = hasDocker();

describe("claude auth isolation", () => {
	it("does not copy host auth file into container", () => {
		const adapterPath = join(PROJECT_ROOT, "src/switchyard/adapter/claude.mjs");
		const source = readFileSync(adapterPath, "utf8");

		strictEqual(
			source.includes("docker cp"),
			false,
			"host cred copy is forbidden",
		);
		ok(
			source.includes("bws-run"),
			"BWS-based auth injection should be present",
		);
	});

	it("never fetches the secret host-side or embeds it in argv", () => {
		const adapterPath = join(PROJECT_ROOT, "src/switchyard/adapter/claude.mjs");
		const source = readFileSync(adapterPath, "utf8");

		strictEqual(
			/bws-get/.test(source),
			false,
			"bws-get prints secrets to stdout host-side — must not be used by adapter code",
		);
		strictEqual(
			/-e CLAUDE_CREDENTIALS=/.test(source),
			false,
			"secret must not be assigned inline on the docker exec command line (visible via ps)",
		);
	});
});

describe("claude adapter shell injection guard", () => {
	it("rejects workingContainerName with shell metacharacters", () => {
		const result = executeClaude("do something", "bad container; rm -rf /", {});
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("rejects model name with shell metacharacters", () => {
		const result = executeClaude("do something", "valid-container", {
			model: "opus; echo INJECTED",
		});
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("accepts a valid container name", () => {
		const result = executeClaude("do something", "switchyard-work-1", {
			model: "claude-sonnet-5",
		});
		ok(
			!result.error?.includes("unsafe characters"),
			"valid identifier should not be rejected by validation",
		);
	});

	it("captureDiff rejects unsafe container names", () => {
		const diff = captureDiff("bad container; rm -rf /");
		strictEqual(diff, null, "captureDiff should return null for unsafe names");
	});

	it("does not execute shell metacharacters embedded in the prompt on the host", () => {
		// Same class of bug fixed in the Codex adapter: the prompt must never be
		// shell-interpolated. Delivered over stdin, so a single quote in a task
		// description can't break out into host shell syntax.
		const markerDir = mkdtempSync(
			join(tmpdir(), "switchyard-prompt-injection-"),
		);
		const markerPath = join(markerDir, "marker");
		const evilPrompt = `wrap up'; touch ${markerPath}; echo '`;

		try {
			const result = executeClaude(
				evilPrompt,
				"switchyard-nonexistent-container",
				{},
			);
			strictEqual(result.success, false, "nonexistent container should fail");
			strictEqual(
				existsSync(markerPath),
				false,
				"prompt content must never be interpreted as host shell syntax",
			);
		} finally {
			rmSync(markerDir, { recursive: true, force: true });
		}
	});
});

describe("authenticateClaude() secretName injection guard", () => {
	it("rejects a malformed secretName before it ever reaches a shell", () => {
		// authenticateClaude interpolates secretName directly into a
		// `zsh -c "... docker exec -e ${secretName} ..."` string, so a
		// malformed value must be rejected by validateEnvName before
		// execFileSync is ever called — not just after. Proven here the
		// same way the prompt-injection regressions above are proven: if
		// the guard didn't fire first, this secretName would run `touch`
		// on the host.
		const markerDir = mkdtempSync(
			join(tmpdir(), "switchyard-authname-injection-"),
		);
		const markerPath = join(markerDir, "marker");
		const evilSecretName = `BAD; touch ${markerPath}; echo x`;

		try {
			const result = authenticateClaude(evilSecretName);
			strictEqual(result, false, "malformed secretName must be rejected");
			strictEqual(
				existsSync(markerPath),
				false,
				"a malformed secretName must never reach a shell invocation",
			);
		} finally {
			rmSync(markerDir, { recursive: true, force: true });
		}
	});

	it("rejects secretName values that aren't UPPERCASE_SNAKE_CASE", () => {
		strictEqual(authenticateClaude("lowercase_name"), false);
		strictEqual(authenticateClaude(""), false);
		strictEqual(authenticateClaude(null), false);
	});
});

describe("claude auth container script (real container)", () => {
	it("persists the forwarded secret's actual content to the login step, not an empty file", {
		skip: !dockerAvailable,
	}, () => {
		// Regression: an earlier version's container script did `cat >
		// /tmp/claude_creds.json` — reading from stdin — while the secret
		// arrives as a forwarded env var (`docker exec -e NAME`, no stdin
		// involved). That version exited 0 while `claude login` received an
		// EMPTY file, silently discarding the credential. The real script
		// always `rm -f`s the temp file afterward (even on login failure),
		// so this verifies the persisted content via a fake `claude` stub
		// that copies what it was actually handed before that cleanup runs.
		const containerName = `switchyard-claude-authscript-${Date.now()}`;
		const secretName = "CLAUDE_CREDENTIALS_TEST";
		const secretValue = '{"fake":"claude-cred-value"}';

		execSync(
			`docker run -d --name ${containerName} --entrypoint sh alpine -c "sleep 60"`,
			{ stdio: "pipe" },
		);
		try {
			execSync(
				`docker exec ${containerName} sh -c 'printf "#!/bin/sh\ncp \\"\\$3\\" /tmp/captured-for-test.json\necho ok\n" > /usr/local/bin/claude && chmod +x /usr/local/bin/claude'`,
				{ stdio: "pipe" },
			);

			const containerScript = buildAuthContainerScript(secretName);
			execFileSync(
				"zsh",
				[
					"-i",
					"-c",
					`docker exec -e ${secretName} ${containerName} sh -c '${containerScript}'`,
				],
				{
					stdio: "pipe",
					env: { ...process.env, [secretName]: secretValue },
				},
			);

			const captured = execSync(
				`docker exec ${containerName} cat /tmp/captured-for-test.json`,
				{ encoding: "utf8" },
			);
			strictEqual(captured.trim(), secretValue);
		} finally {
			execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
		}
	});

	it("propagates a failed `claude login` as a non-zero script exit, not a masked success", {
		skip: !dockerAvailable,
	}, () => {
		// Regression: the script's trailing `rm -f /tmp/claude_creds.json` used
		// to run as an unconditional `;`-continuation after the login chain —
		// so the temp-file cleanup's own exit code (almost always 0) became the
		// whole script's exit status, masking a real `claude login` failure as
		// success. authenticateClaude() would then report `true` for a failed
		// login. The fixed script captures the login chain's exit status before
		// cleanup and re-exits with it. This uses a fake `claude` stub that
		// always fails, and asserts the container script itself now fails.
		const containerName = `switchyard-claude-authfail-${Date.now()}`;
		const secretName = "CLAUDE_CREDENTIALS_TEST_FAIL";
		const secretValue = '{"fake":"claude-cred-value"}';

		execSync(
			`docker run -d --name ${containerName} --entrypoint sh alpine -c "sleep 60"`,
			{ stdio: "pipe" },
		);
		try {
			execSync(
				`docker exec ${containerName} sh -c 'printf "#!/bin/sh\necho login failed >&2\nexit 1\n" > /usr/local/bin/claude && chmod +x /usr/local/bin/claude'`,
				{ stdio: "pipe" },
			);

			const containerScript = buildAuthContainerScript(secretName);
			let threw = false;
			try {
				execFileSync(
					"zsh",
					[
						"-i",
						"-c",
						`docker exec -e ${secretName} ${containerName} sh -c '${containerScript}'`,
					],
					{
						stdio: "pipe",
						env: { ...process.env, [secretName]: secretValue },
					},
				);
			} catch {
				threw = true;
			}
			ok(
				threw,
				"container script must exit non-zero when `claude login` fails, not be masked by the trailing cleanup's own success",
			);

			// The cleanup must still have run despite the failure.
			let credsFileExists = true;
			try {
				execSync(
					`docker exec ${containerName} test -f /tmp/claude_creds.json`,
					{ stdio: "pipe" },
				);
			} catch {
				credsFileExists = false;
			}
			strictEqual(
				credsFileExists,
				false,
				"temp credentials file must be cleaned up even when login fails",
			);
		} finally {
			execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
		}
	});
});

describe("buildAuthContainerScript base64 boundary-crossing (real container)", () => {
	it("delivers a script with a bare single quote and a live $(...) to the container untouched", {
		skip: !dockerAvailable,
	}, () => {
		// Proves the actual bug class this mechanism eliminates. Pre-fix,
		// buildAuthContainerScript's raw return value was interpolated directly
		// into `sh -c '${containerScript}'` inside the outer `zsh -c "..."`
		// invocation — so a future edit introducing a bare single quote or a
		// `$(...)` into the real script text would have broken out of that
		// single-quoted region (or been evaluated too early). Now
		// buildAuthContainerScript base64-encodes the whole real script and
		// returns only `echo <b64> | base64 -d | sh` — the base64 alphabet has
		// no shell metacharacters, so nothing but that fixed, quote-free
		// wrapper ever crosses the boundary. This replicates that exact
		// wrapping formula against a deliberately hazardous payload to prove
		// it survives, rather than merely asserting it.
		const containerName = `switchyard-claude-boundary-${Date.now()}`;
		const hazardousRealScript = `printf '%s' "it's a $(echo substituted) value" > /tmp/boundary-result`;
		const scriptB64 = Buffer.from(hazardousRealScript, "utf8").toString(
			"base64",
		);
		const wrapped = `echo ${scriptB64} | base64 -d | sh`;

		execSync(
			`docker run -d --name ${containerName} --entrypoint sh alpine -c "sleep 60"`,
			{ stdio: "pipe" },
		);
		try {
			execFileSync(
				"zsh",
				["-i", "-c", `docker exec ${containerName} sh -c '${wrapped}'`],
				{ stdio: "pipe" },
			);

			const result = execSync(
				`docker exec ${containerName} cat /tmp/boundary-result`,
				{ encoding: "utf8" },
			);
			strictEqual(
				result,
				"it's a substituted value",
				"the hazardous script must run exactly as normal shell semantics dictate, with nothing corrupted by the boundary crossing",
			);
		} finally {
			execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
		}
	});

	it("never lets an embedded single quote escape onto the host shell", () => {
		// Same hazard, from the other direction: a bare `'` positioned exactly
		// where it would have prematurely closed the old naive
		// `sh -c '${containerScript}'` embedding, leaking the fragment after it
		// to whatever shell parses that level — the host's own zsh. Wrapping
		// the payload as base64 before it ever reaches a shell means this
		// string is never interpolated raw into any shell command at all, so
		// the host-side marker must never appear regardless of container
		// state (this container is never even created).
		const markerDir = mkdtempSync(
			join(tmpdir(), "switchyard-claude-boundary-quote-"),
		);
		const markerPath = join(markerDir, "marker");
		const hazardousRealScript = `echo start'; touch ${markerPath}; echo end '`;
		const scriptB64 = Buffer.from(hazardousRealScript, "utf8").toString(
			"base64",
		);
		const wrapped = `echo ${scriptB64} | base64 -d | sh`;

		try {
			try {
				execFileSync(
					"zsh",
					[
						"-i",
						"-c",
						`docker exec switchyard-nonexistent-boundary-container sh -c '${wrapped}'`,
					],
					{ stdio: "pipe" },
				);
			} catch {
				// Expected: the container doesn't exist, so docker exec fails.
				// The only thing under test is whether the host ever ran `touch`.
			}
			strictEqual(
				existsSync(markerPath),
				false,
				"the embedded single quote must never break out of the outer single-quoted region onto the host",
			);
		} finally {
			rmSync(markerDir, { recursive: true, force: true });
		}
	});
});

describe("isClaudeAuthenticated credential-validity check (real container)", () => {
	it("returns false when the credential is withheld/corrupt even though the binary responds", {
		skip: !dockerAvailable,
	}, () => {
		// TASKS.md Task 15 "done when": with the CLI installed and answering
		// `--version` (liveness passes), a withheld or trivial credential must
		// make isClaudeAuthenticated() return false — the exact false-positive
		// the old liveness-only check produced. Claude's operative credential
		// is Claude Code's own store (/root/.claude/.credentials.json), NOT the
		// /tmp/claude_creds.json that authenticateClaude writes then deletes.
		const containerName = `switchyard-claude-authcheck-${Date.now()}`;
		const credPath = "/root/.claude/.credentials.json";

		execSync(
			`docker run -d --name ${containerName} --entrypoint sh alpine -c "sleep 60"`,
			{ stdio: "pipe" },
		);
		try {
			// Stub that satisfies the `--version` liveness check (output
			// contains "Claude") but is not actually authenticated.
			execSync(
				`docker exec ${containerName} sh -c 'printf "#!/bin/sh\necho Claude Code stub\n" > /usr/local/bin/claude && chmod +x /usr/local/bin/claude'`,
				{ stdio: "pipe" },
			);

			// Credential withheld entirely.
			strictEqual(
				isClaudeAuthenticated(containerName),
				false,
				"withheld credential must not read as authenticated",
			);

			// Credential present but empty (the empty-file bug shape).
			execSync(
				`docker exec ${containerName} sh -c 'mkdir -p /root/.claude && : > ${credPath}'`,
				{ stdio: "pipe" },
			);
			strictEqual(
				isClaudeAuthenticated(containerName),
				false,
				"empty credential file must not read as authenticated",
			);

			// Credential present but a trivial JSON stub.
			execSync(
				`docker exec ${containerName} sh -c 'printf "%s" "{}" > ${credPath}'`,
				{ stdio: "pipe" },
			);
			strictEqual(
				isClaudeAuthenticated(containerName),
				false,
				"trivial {} stub must not read as authenticated",
			);

			// Positive control: a non-trivial credential reads as authenticated,
			// proving the check isn't vacuously false and the negative cases
			// above are meaningfully distinguished (pre-fix liveness-only logic
			// returned true for all four states).
			execSync(
				`docker exec ${containerName} sh -c 'printf "%s" "{\\"accessToken\\":\\"fake-oauth-token-value-1234567890\\"}" > ${credPath}'`,
				{ stdio: "pipe" },
			);
			strictEqual(
				isClaudeAuthenticated(containerName),
				true,
				"a non-trivial persisted credential must read as authenticated",
			);
		} finally {
			execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
		}
	});
});
