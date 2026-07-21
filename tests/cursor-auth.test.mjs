import { ok, strictEqual } from "node:assert";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	buildAuthContainerScript,
	captureDiff,
	executeCursor,
} from "../src/switchyard/adapter/cursor.mjs";

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

describe("cursor auth isolation", () => {
	it("does not copy a host OAuth session/config into the container", () => {
		const adapterPath = join(PROJECT_ROOT, "src/switchyard/adapter/cursor.mjs");
		const source = readFileSync(adapterPath, "utf8");

		strictEqual(
			source.includes("docker cp"),
			false,
			"host cred/session copy is forbidden",
		);
		strictEqual(
			source.includes("cli-config.json"),
			false,
			"must not replicate the interactive OAuth session file — CURSOR_API_KEY is the sanctioned headless mechanism",
		);
		ok(
			source.includes("bws-run"),
			"BWS-based auth injection should be present",
		);
	});

	it("never fetches the secret host-side or embeds it in argv", () => {
		const adapterPath = join(PROJECT_ROOT, "src/switchyard/adapter/cursor.mjs");
		const source = readFileSync(adapterPath, "utf8");

		strictEqual(
			/bws-get/.test(source),
			false,
			"bws-get prints secrets to stdout host-side — must not be used by adapter code",
		);
		strictEqual(
			/-e CURSOR_API_KEY=/.test(source),
			false,
			"secret must not be assigned inline on the docker exec command line (visible via ps)",
		);
	});
});

describe("cursor adapter shell injection guard", () => {
	it("rejects workingContainerName with shell metacharacters", () => {
		const result = executeCursor("do something", "bad container; rm -rf /", {});
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("rejects model name with shell metacharacters", () => {
		const result = executeCursor("do something", "valid-container", {
			model: "composer-2.5; echo INJECTED",
		});
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("accepts a valid container name and model", () => {
		const result = executeCursor("do something", "switchyard-work-1", {
			model: "composer-2.5",
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
		// cursor-agent cannot read stdin — the prompt is delivered as the final
		// execFileSync argv element, never through a shell. This guards against
		// a future refactor accidentally reintroducing shell interpolation, the
		// exact bug class already found and fixed in the claude/codex adapters.
		const markerDir = mkdtempSync(
			join(tmpdir(), "switchyard-prompt-injection-"),
		);
		const markerPath = join(markerDir, "marker");
		const evilPrompt = `wrap up'; touch ${markerPath}; echo '`;

		try {
			const result = executeCursor(
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

describe("cursor auth container script (real container)", () => {
	it("persists the forwarded API key and writes a working wrapper binary", {
		skip: !dockerAvailable,
	}, () => {
		// This is the test that caught a real bug during development: the
		// wrapper script's own body contains shell-special characters
		// ($, ", (), @) that broke the *outer* shell's quoting when
		// naively embedded, causing the outer zsh to command-substitute
		// $(cat ...) against the HOST filesystem instead of writing it
		// literally into the container. Fixed by base64-encoding the
		// wrapper payload so no shell-special byte ever crosses a shell
		// boundary. This test exercises the real script end-to-end.
		const containerName = `switchyard-cursor-authscript-${Date.now()}`;
		const secretName = "CURSOR_API_KEY_TEST";
		const secretValue = "sk-fake-cursor-key-abc123";

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

			const apiKey = execSync(
				`docker exec ${containerName} cat /root/.cursor-agent-env/api_key`,
				{ encoding: "utf8" },
			);
			strictEqual(apiKey.trim(), secretValue);

			const wrapper = execSync(
				`docker exec ${containerName} cat /usr/local/bin/cursor-agent-authed`,
				{ encoding: "utf8" },
			);
			ok(wrapper.startsWith("#!/bin/sh"), "wrapper must be a valid script");
			ok(
				wrapper.includes('export CURSOR_API_KEY="$(cat'),
				"wrapper must export CURSOR_API_KEY from the persisted file",
			);

			const perms = execSync(
				`docker exec ${containerName} stat -c "%a" /usr/local/bin/cursor-agent-authed`,
				{ encoding: "utf8" },
			);
			strictEqual(perms.trim(), "755");
		} finally {
			execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
		}
	});
});
