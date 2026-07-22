import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	captureDiff,
	executeCodex,
	isCodexAuthenticated,
} from "../src/switchyard/adapter/codex.mjs";

function hasDocker() {
	try {
		execSync("docker --version", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const dockerAvailable = hasDocker();

describe("codex adapter shell injection guard", () => {
	it("rejects workingContainerName with shell metacharacters", () => {
		const result = executeCodex("do something", "bad container; rm -rf /", {});
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("rejects model name with shell metacharacters", () => {
		const result = executeCodex("do something", "valid-container", {
			model: "gpt-4; echo INJECTED",
		});
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("accepts a valid container name", () => {
		// Should not throw on validation — will fail at Docker exec (not available),
		// but the failure comes from Docker, not from input validation.
		const result = executeCodex("do something", "switchyard-work-1", {
			model: "gpt-4o",
		});
		// Either Docker is unavailable (success:false with docker error) or succeeds.
		// Key: no "unsafe characters" error.
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
		// Regression test: an earlier version shell-interpolated the prompt into
		// a single-quoted `sh -c '...'` block without escaping single quotes.
		// A prompt containing an unescaped `'` would close that quoted region
		// early and let the remainder of the prompt run as literal shell syntax
		// in the *host* shell that invoked the whole docker command — a host
		// RCE via task text, not merely a captured-diff bug. The current
		// implementation delivers the prompt over stdin (never shell-parsed),
		// so this must be a no-op regardless of the container's existence.
		const markerDir = mkdtempSync(
			join(tmpdir(), "switchyard-prompt-injection-"),
		);
		const markerPath = join(markerDir, "marker");
		const evilPrompt = `wrap up'; touch ${markerPath}; echo '`;

		try {
			const result = executeCodex(
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

describe("codex adapter invocation shape (real container)", () => {
	it("invokes the `codex exec` subcommand, not the bare interactive binary", {
		skip: !dockerAvailable,
	}, () => {
		// Regression: an earlier version called bare `codex` (no `exec`
		// subcommand). Per the CLI's own --help: "If no subcommand is
		// specified, options will be forwarded to the interactive CLI" —
		// so a real dispatch would launch the interactive TUI instead of
		// running non-interactively. The fake stub below fails loudly if
		// `exec` isn't argv[1], which a stub that merely ignores its argv
		// (as the adapter test's stub does) would never have caught.
		const containerName = `switchyard-codex-shape-${Date.now()}`;
		execSync(
			`docker run -d --name ${containerName} --entrypoint sh alpine -c "sleep 60"`,
			{ stdio: "pipe" },
		);
		try {
			execSync(`docker exec ${containerName} mkdir -p /project`, {
				stdio: "pipe",
			});
			execSync(
				`docker exec ${containerName} sh -c 'printf "#!/bin/sh\nif [ \\"\\$1\\" != exec ]; then echo MISSING_EXEC_SUBCOMMAND >&2; exit 1; fi\ncat >/dev/null\necho ok\n" > /usr/local/bin/codex && chmod +x /usr/local/bin/codex'`,
				{ stdio: "pipe" },
			);

			const result = executeCodex("do something", containerName, {});
			strictEqual(result.success, true, result.error);
			ok(
				!result.output.includes("MISSING_EXEC_SUBCOMMAND"),
				`codex was invoked without its exec subcommand: ${result.output}`,
			);
		} finally {
			execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
		}
	});
});

describe("isCodexAuthenticated credential-validity check (real container)", () => {
	it("returns false when the credential is withheld/corrupt even though the binary responds", {
		skip: !dockerAvailable,
	}, () => {
		// TASKS.md Task 15 "done when": with the CLI installed and answering
		// `--version` (liveness passes), a withheld or trivial auth.json must
		// make isCodexAuthenticated() return false — the false-positive the old
		// liveness-only check produced. `codex login` persists
		// /root/.codex/auth.json directly (TASKS.md Task 24), so that is the
		// checked path.
		const containerName = `switchyard-codex-authcheck-${Date.now()}`;
		const credPath = "/root/.codex/auth.json";

		execSync(
			`docker run -d --name ${containerName} --entrypoint sh alpine -c "sleep 60"`,
			{ stdio: "pipe" },
		);
		try {
			// Stub that satisfies the `--version` liveness check (output
			// contains "codex") but is not actually authenticated.
			execSync(
				`docker exec ${containerName} sh -c 'printf "#!/bin/sh\necho codex-cli 1.0.0\n" > /usr/local/bin/codex && chmod +x /usr/local/bin/codex'`,
				{ stdio: "pipe" },
			);

			// Credential withheld entirely.
			strictEqual(
				isCodexAuthenticated(containerName),
				false,
				"withheld credential must not read as authenticated",
			);

			// Credential present but empty (the empty-file bug shape).
			execSync(
				`docker exec ${containerName} sh -c 'mkdir -p /root/.codex && : > ${credPath}'`,
				{ stdio: "pipe" },
			);
			strictEqual(
				isCodexAuthenticated(containerName),
				false,
				"empty credential file must not read as authenticated",
			);

			// Credential present but a trivial JSON stub.
			execSync(
				`docker exec ${containerName} sh -c 'printf "%s" "{}" > ${credPath}'`,
				{ stdio: "pipe" },
			);
			strictEqual(
				isCodexAuthenticated(containerName),
				false,
				"trivial {} stub must not read as authenticated",
			);

			// Positive control: a non-trivial credential reads as authenticated
			// (pre-fix liveness-only logic returned true for all four states).
			execSync(
				`docker exec ${containerName} sh -c 'printf "%s" "{\\"OPENAI_API_KEY\\":\\"fake-codex-token-1234567890\\"}" > ${credPath}'`,
				{ stdio: "pipe" },
			);
			strictEqual(
				isCodexAuthenticated(containerName),
				true,
				"a non-trivial persisted credential must read as authenticated",
			);
		} finally {
			execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
		}
	});
});
