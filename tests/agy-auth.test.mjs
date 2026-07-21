import { ok, strictEqual } from "node:assert";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
