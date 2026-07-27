import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	captureDiff,
	execute as executeCopilot,
	isCopilotAuthenticated,
} from "../src/switchyard/adapter/copilot.mjs";

function hasDocker() {
	try {
		execSync("docker --version", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const dockerAvailable = hasDocker();

describe("copilot adapter shell injection guard", () => {
	it("rejects workingContainerName with shell metacharacters", () => {
		const result = executeCopilot(
			"do something",
			"bad container; rm -rf /",
			{},
		);
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("rejects model name with shell metacharacters", () => {
		const result = executeCopilot("do something", "valid-container", {
			model: "opus; echo INJECTED",
		});
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("accepts a valid container name", () => {
		const result = executeCopilot("do something", "switchyard-work-1", {
			model: "copilot-model-1",
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
		const markerDir = mkdtempSync(
			join(tmpdir(), "switchyard-prompt-injection-"),
		);
		const markerPath = join(markerDir, "marker");
		const evilPrompt = `wrap up'; touch ${markerPath}; echo '`;

		try {
			const result = executeCopilot(
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

describe("isCopilotAuthenticated credential-validity check (real container)", () => {
	it("returns false when the binary is absent even with nontrivial hosts.json and apps.json present", {
		skip: !dockerAvailable,
	}, () => {
		const containerName = `switchyard-copilot-binfail-${Date.now()}`;
		const appsPath = "/root/.config/github-copilot/apps.json";
		const hostsPath = "/root/.config/github-copilot/hosts.json";

		execSync(
			`docker run -d --name ${containerName} --entrypoint sh alpine -c "sleep 60"`,
			{ stdio: "pipe" },
		);
		try {
			execSync(
				`docker exec ${containerName} sh -c 'mkdir -p /root/.config/github-copilot && printf "%s" "{\\"accessToken\\":\\"fake-oauth-token-value-1234567890\\"}" > ${appsPath}'`,
				{ stdio: "pipe" },
			);
			execSync(
				`docker exec ${containerName} sh -c 'printf "%s" "{\\"host\\":\\"github.com\\",\\"accessToken\\":\\"gho_fake-token-value-1234567890\\"}" > ${hostsPath}'`,
				{ stdio: "pipe" },
			);

			strictEqual(
				isCopilotAuthenticated(containerName),
				false,
				"missing binary must not read as authenticated even with nontrivial credentials present",
			);
		} finally {
			execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
		}
	});

	it("returns false when the credential is withheld/corrupt even though the binary responds", {
		skip: !dockerAvailable,
	}, () => {
		const containerName = `switchyard-copilot-authcheck-${Date.now()}`;
		const credPath = "/root/.config/github-copilot/apps.json";

		execSync(
			`docker run -d --name ${containerName} --entrypoint sh alpine -c "sleep 60"`,
			{ stdio: "pipe" },
		);
		try {
			execSync(
				`docker exec ${containerName} sh -c 'printf "#!/bin/sh\necho Copilot stub\n" > /usr/local/bin/copilot && chmod +x /usr/local/bin/copilot'`,
				{ stdio: "pipe" },
			);

			strictEqual(
				isCopilotAuthenticated(containerName),
				false,
				"withheld credential must not read as authenticated",
			);

			execSync(
				`docker exec ${containerName} sh -c 'mkdir -p /root/.config/github-copilot && : > ${credPath}'`,
				{ stdio: "pipe" },
			);
			strictEqual(
				isCopilotAuthenticated(containerName),
				false,
				"empty credential file must not read as authenticated",
			);

			execSync(
				`docker exec ${containerName} sh -c 'printf "%s" "{}" > ${credPath}'`,
				{ stdio: "pipe" },
			);
			strictEqual(
				isCopilotAuthenticated(containerName),
				false,
				"trivial {} stub must not read as authenticated",
			);

			execSync(
				`docker exec ${containerName} sh -c 'printf "%s" "{\\"accessToken\\":\\"fake-oauth-token-value-1234567890\\"}" > ${credPath}'`,
				{ stdio: "pipe" },
			);
			strictEqual(
				isCopilotAuthenticated(containerName),
				true,
				"a non-trivial persisted credential must read as authenticated",
			);
		} finally {
			execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
		}
	});
});
