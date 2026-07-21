import { ok, strictEqual } from "node:assert";
import { execFileSync, execSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	authenticateAgy,
	buildAuthContainerScript,
	captureDiff,
	executeAgy,
	isAgyAuthenticated,
} from "../src/switchyard/adapter/agy.mjs";

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

describe("agy auth isolation", () => {
	it("does not copy host auth file into container", () => {
		const adapterPath = join(PROJECT_ROOT, "src/switchyard/adapter/agy.mjs");
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
		const adapterPath = join(PROJECT_ROOT, "src/switchyard/adapter/agy.mjs");
		const source = readFileSync(adapterPath, "utf8");

		strictEqual(
			/bws-get/.test(source),
			false,
			"bws-get prints secrets to stdout host-side — must not be used by adapter code",
		);
		strictEqual(
			/-e GEMINI_CREDENTIALS=/.test(source),
			false,
			"secret must not be assigned inline on the docker exec command line (visible via ps)",
		);
	});
});

describe("agy adapter shell injection guard", () => {
	it("rejects workingContainerName with shell metacharacters", () => {
		const result = executeAgy("do something", "bad container; rm -rf /", {});
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("rejects model name with shell metacharacters", () => {
		const result = executeAgy("do something", "valid-container", {
			model: "Gemini 3.6 Flash; echo INJECTED",
		});
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("accepts a valid container name and a display-name model with spaces/parens", () => {
		const result = executeAgy("do something", "switchyard-work-1", {
			model: "Gemini 3.6 Flash (High)",
		});
		ok(
			!result.error?.includes("unsafe characters"),
			"valid identifier/model should not be rejected by validation",
		);
	});

	it("captureDiff rejects unsafe container names", () => {
		const diff = captureDiff("bad container; rm -rf /");
		strictEqual(diff, null, "captureDiff should return null for unsafe names");
	});

	it("does not execute shell metacharacters embedded in the prompt on the host", () => {
		// agy's prompt is delivered as a single execFileSync argv element (a
		// --print flag value), never through a shell — this guards against a
		// future refactor accidentally reintroducing shell interpolation, the
		// exact bug class already found and fixed in the claude/codex adapters.
		const markerDir = mkdtempSync(
			join(tmpdir(), "switchyard-prompt-injection-"),
		);
		const markerPath = join(markerDir, "marker");
		const evilPrompt = `wrap up'; touch ${markerPath}; echo '`;

		try {
			const result = executeAgy(
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

describe("authenticateAgy() secretName injection guard", () => {
	it("rejects a malformed secretName before it ever reaches a shell", () => {
		// authenticateAgy interpolates secretName directly into a
		// `zsh -c "... docker exec -e ${secretName} ..."` string, so a
		// malformed value must be rejected by validateEnvName before
		// execFileSync is ever called — not just after.
		const markerDir = mkdtempSync(
			join(tmpdir(), "switchyard-authname-injection-"),
		);
		const markerPath = join(markerDir, "marker");
		const evilSecretName = `BAD; touch ${markerPath}; echo x`;

		try {
			const result = authenticateAgy(evilSecretName);
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
		strictEqual(authenticateAgy("lowercase_name"), false);
		strictEqual(authenticateAgy(""), false);
		strictEqual(authenticateAgy(null), false);
	});
});

describe("authenticateAgy() ground truth (fake shell/docker — touches no real container)", () => {
	// Installs fake `zsh` and `docker` executables at the front of PATH so
	// authenticateAgy() never reaches a real shell, real BWS, or a real
	// container — both calls it makes (`execFileSync("zsh", ...)` and
	// hasNonTrivialCredential's `execFileSync("docker", ...)`) resolve
	// through PATH with no `env` override on either call, so this genuinely
	// intercepts the exact binaries the production code spawns rather than
	// mocking at the JS layer (named ESM imports from node:child_process
	// don't observe mock.method() reassignment on the shared module object —
	// verified empirically before choosing this approach). Fake zsh always
	// exits 0, standing in for the exact failure mode a61aafc fixed: `bws
	// run` has been observed to report success for a wrapped `docker exec
	// ...` command even when the script demonstrably failed inside the
	// container. Fake docker's exit code is the caller's to control,
	// standing in for hasNonTrivialCredential's own credential-presence
	// check succeeding or failing. AGENT_CONTAINER_NAME is never touched —
	// there is no real container at all in this scenario.
	function withFakeAuthShell(dockerExitCode, fn) {
		const fakeBinDir = mkdtempSync(join(tmpdir(), "switchyard-fake-auth-bin-"));
		writeFileSync(join(fakeBinDir, "zsh"), "#!/bin/sh\nexit 0\n");
		writeFileSync(
			join(fakeBinDir, "docker"),
			`#!/bin/sh\nexit ${dockerExitCode}\n`,
		);
		chmodSync(join(fakeBinDir, "zsh"), 0o755);
		chmodSync(join(fakeBinDir, "docker"), 0o755);

		const originalPath = process.env.PATH;
		process.env.PATH = `${fakeBinDir}:${originalPath}`;
		try {
			return fn();
		} finally {
			process.env.PATH = originalPath;
			rmSync(fakeBinDir, { recursive: true, force: true });
		}
	}

	it("returns false when the wrapped command reports success but no credential is actually persisted (regression: a61aafc, previously trusted the wrapper's exit code)", () => {
		// Pre-fix authenticateAgy() did `execFileSync(...); return true;`
		// inside the try block — trusting the wrapped command's exit code
		// directly. Faking zsh to always exit 0 reproduces that "reported
		// success" shape; faking docker to exit non-zero makes
		// hasNonTrivialCredential's own credential-presence check fail,
		// standing in for "no credential was actually persisted". Against
		// the pre-fix code this returns true; against the fix it must return
		// false because the real return value now comes from
		// hasNonTrivialCredential() unconditionally, never from the wrapped
		// command's own exit code.
		const result = withFakeAuthShell(1, () =>
			authenticateAgy("GEMINI_CREDENTIALS_FAKE_TEST"),
		);
		strictEqual(
			result,
			false,
			"authenticateAgy() must not trust the wrapped command's exit code alone",
		);
	});

	it("returns true when the wrapped command succeeds and the credential check also passes (positive control)", () => {
		// Proves the negative case above isn't vacuous: with the identical
		// fake-zsh-always-succeeds setup, a passing credential check still
		// yields true, so the false result above is specifically caused by
		// the credential check failing, not by some general breakage of the
		// fake-shell harness.
		const result = withFakeAuthShell(0, () =>
			authenticateAgy("GEMINI_CREDENTIALS_FAKE_TEST"),
		);
		strictEqual(result, true);
	});
});

describe("agy auth container script (real container)", () => {
	it("persists the forwarded secret's actual content into the credentials file, not an empty file", {
		skip: !dockerAvailable,
	}, () => {
		const containerName = `switchyard-agy-authscript-${Date.now()}`;
		const secretName = "GEMINI_CREDENTIALS_TEST";
		const secretValue = '{"fake":"agy-cred-value"}';

		execSync(
			`docker run -d --name ${containerName} --entrypoint sh alpine -c "sleep 60"`,
			{ stdio: "pipe" },
		);
		try {
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

			const content = execSync(
				`docker exec ${containerName} cat /root/.gemini/gemini-credentials.json`,
				{ encoding: "utf8" },
			);
			strictEqual(content.trim(), secretValue);
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
		const containerName = `switchyard-agy-boundary-${Date.now()}`;
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
			join(tmpdir(), "switchyard-agy-boundary-quote-"),
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

describe("isAgyAuthenticated credential-validity check (real container)", () => {
	it("returns false when the credential is withheld/corrupt even though the binary responds", {
		skip: !dockerAvailable,
	}, () => {
		// TASKS.md Task 15 "done when": with the CLI installed and answering
		// `--version` (liveness passes — agy has no vendor keyword, so any
		// non-empty output counts), a withheld or trivial credentials file must
		// make isAgyAuthenticated() return false. Agy persists
		// /root/.gemini/gemini-credentials.json directly (the CLI still uses the
		// pre-rename `.gemini` namespace), so that is the checked path.
		const containerName = `switchyard-agy-authcheck-${Date.now()}`;
		const credPath = "/root/.gemini/gemini-credentials.json";

		execSync(
			`docker run -d --name ${containerName} --entrypoint sh alpine -c "sleep 60"`,
			{ stdio: "pipe" },
		);
		try {
			// Stub that satisfies the `--version` liveness check (non-empty
			// output) but is not actually authenticated.
			execSync(
				`docker exec ${containerName} sh -c 'printf "#!/bin/sh\necho agy 1.0.0\n" > /usr/local/bin/agy && chmod +x /usr/local/bin/agy'`,
				{ stdio: "pipe" },
			);

			// Credential withheld entirely.
			strictEqual(
				isAgyAuthenticated(containerName),
				false,
				"withheld credential must not read as authenticated",
			);

			// Credential present but empty (the empty-file bug shape).
			execSync(
				`docker exec ${containerName} sh -c 'mkdir -p /root/.gemini && : > ${credPath}'`,
				{ stdio: "pipe" },
			);
			strictEqual(
				isAgyAuthenticated(containerName),
				false,
				"empty credential file must not read as authenticated",
			);

			// Credential present but a trivial JSON stub.
			execSync(
				`docker exec ${containerName} sh -c 'printf "%s" "{}" > ${credPath}'`,
				{ stdio: "pipe" },
			);
			strictEqual(
				isAgyAuthenticated(containerName),
				false,
				"trivial {} stub must not read as authenticated",
			);

			// Positive control: a non-trivial credential reads as authenticated
			// (pre-fix liveness-only logic returned true for all four states).
			execSync(
				`docker exec ${containerName} sh -c 'printf "%s" "{\\"refresh_token\\":\\"fake-gemini-token-1234567890\\"}" > ${credPath}'`,
				{ stdio: "pipe" },
			);
			strictEqual(
				isAgyAuthenticated(containerName),
				true,
				"a non-trivial persisted credential must read as authenticated",
			);
		} finally {
			execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
		}
	});
});
