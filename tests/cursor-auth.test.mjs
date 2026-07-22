import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	captureDiff,
	executeCursor,
	isCursorAuthenticated,
} from "../src/switchyard/adapter/cursor.mjs";

function hasDocker() {
	try {
		execSync("docker --version", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const dockerAvailable = hasDocker();

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

describe("isCursorAuthenticated credential-validity check (real container)", () => {
	// TASKS.md Task 24: unlike claude/codex/agy, `cursor-agent status`'s exit
	// code does NOT distinguish logged-in from logged-out (confirmed live:
	// exit 0 either way), so the check reads `cursor-agent status --format
	// json`'s structured `isAuthenticated` boolean instead (live-verified
	// against a real completed OAuth session: `{"status":"authenticated",
	// "isAuthenticated":true,...}`). The stub is base64-encoded (this
	// project's established pattern for payloads that must cross a
	// `docker exec ... sh -c '...'` boundary, per the cursor wrapper
	// quote-nesting bug found earlier — see HISTORY.md) so the JSON's own
	// quotes never have to be hand-balanced across shell layers.
	function installStatusStub(containerName, statusJson) {
		const script = [
			"#!/bin/sh",
			'if [ "$1" = --version ]; then echo cursor-agent 1.0.0; exit 0; fi',
			`if [ "$1" = status ]; then echo '${statusJson}'; exit 0; fi`,
		].join("\n");
		const encoded = Buffer.from(script, "utf8").toString("base64");
		execSync(
			`docker exec ${containerName} sh -c 'echo ${encoded} | base64 -d > /usr/local/bin/cursor-agent && chmod +x /usr/local/bin/cursor-agent'`,
			{ stdio: "pipe" },
		);
	}

	it("returns false when `status --format json` reports isAuthenticated:false, even though the binary responds", {
		skip: !dockerAvailable,
	}, () => {
		const containerName = `switchyard-cursor-authcheck-${Date.now()}`;

		execSync(
			`docker run -d --name ${containerName} --entrypoint sh alpine -c "sleep 60"`,
			{ stdio: "pipe" },
		);
		try {
			installStatusStub(containerName, '{"isAuthenticated":false}');
			strictEqual(
				isCursorAuthenticated(containerName),
				false,
				"isAuthenticated:false must not read as authenticated",
			);
		} finally {
			execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
		}
	});

	it("returns false when the binary doesn't respond to --version at all", {
		skip: !dockerAvailable,
	}, () => {
		const containerName = `switchyard-cursor-authcheck-noliveness-${Date.now()}`;

		execSync(
			`docker run -d --name ${containerName} --entrypoint sh alpine -c "sleep 60"`,
			{ stdio: "pipe" },
		);
		try {
			strictEqual(
				isCursorAuthenticated(containerName),
				false,
				"a missing binary must not read as authenticated",
			);
		} finally {
			execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
		}
	});

	it("returns false when status output is empty, malformed, or missing the field (fails CLOSED, not open)", {
		skip: !dockerAvailable,
	}, () => {
		// The class of bug caught in review: an earlier text-matching version
		// of this check (`!/not logged in/i.test(statusResult)`) defaulted to
		// "authenticated" for any of these shapes. The JSON-boolean check must
		// default to false instead.
		const containerName = `switchyard-cursor-authcheck-malformed-${Date.now()}`;

		execSync(
			`docker run -d --name ${containerName} --entrypoint sh alpine -c "sleep 60"`,
			{ stdio: "pipe" },
		);
		try {
			for (const badJson of [
				"",
				"{}",
				"not json at all",
				'{"status":"error"}',
			]) {
				installStatusStub(containerName, badJson);
				strictEqual(
					isCursorAuthenticated(containerName),
					false,
					`status output ${JSON.stringify(badJson)} must not read as authenticated`,
				);
			}
		} finally {
			execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
		}
	});

	it("returns true when `status --format json` reports isAuthenticated:true (positive control)", {
		skip: !dockerAvailable,
	}, () => {
		// Proves the negative cases above aren't vacuous, and matches the real
		// shape live-verified against a completed OAuth session:
		// {"status":"authenticated","isAuthenticated":true,"hasAccessToken":true,...}
		const containerName = `switchyard-cursor-authcheck-positive-${Date.now()}`;

		execSync(
			`docker run -d --name ${containerName} --entrypoint sh alpine -c "sleep 60"`,
			{ stdio: "pipe" },
		);
		try {
			installStatusStub(
				containerName,
				'{"status":"authenticated","isAuthenticated":true,"hasAccessToken":true,"hasRefreshToken":true}',
			);
			strictEqual(
				isCursorAuthenticated(containerName),
				true,
				"isAuthenticated:true should read as authenticated",
			);
		} finally {
			execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
		}
	});
});
