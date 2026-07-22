import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	captureDiff,
	executeCursor,
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
const testRoot = mkdtempSync(join(tmpdir(), "switchyard-cursor-adapter-"));
const containerName = `switchyard-cursor-adapter-${Date.now()}`;

describe("cursor adapter container execution", () => {
	before(() => {
		if (!dockerAvailable) return;

		writeFileSync(join(testRoot, "test.txt"), "base\n", "utf8");
		execSync("git init", { cwd: testRoot, stdio: "pipe" });
		execSync('git config user.email "test@test.com"', {
			cwd: testRoot,
			stdio: "pipe",
		});
		execSync('git config user.name "Test"', { cwd: testRoot, stdio: "pipe" });
		execSync("git add test.txt", { cwd: testRoot, stdio: "pipe" });
		execSync('git commit -m "base"', { cwd: testRoot, stdio: "pipe" });

		execSync(
			`docker run -d --name ${containerName} --entrypoint sh -v ${testRoot}:/project -w /project alpine/git -c "sleep infinity"`,
			{ stdio: "pipe" },
		);

		// executeCursor invokes cursor-agent directly (TASKS.md Task 24: auth is
		// now a real in-container OAuth login, not a generated wrapper binary
		// that exports an injected API key). cursor-agent can't read stdin, so
		// this stub doesn't try to drain any.
		execSync(
			`docker exec ${containerName} sh -c 'printf "#!/bin/sh\necho updated >> test.txt\necho cursor-agent\n" > /usr/local/bin/cursor-agent && chmod +x /usr/local/bin/cursor-agent'`,
			{ stdio: "pipe" },
		);
	});

	after(() => {
		if (dockerAvailable) {
			try {
				execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
			} catch {
				// ignore cleanup errors
			}
		}
		rmSync(testRoot, { recursive: true, force: true });
	});

	it("executes cursor-agent inside working container and captures diff", {
		skip: !dockerAvailable,
	}, () => {
		const result = executeCursor("apply a small change", containerName, {
			model: "composer-2.5",
		});
		strictEqual(result.success, true, result.error);

		const diff = captureDiff(containerName);
		ok(typeof diff === "string" && diff.includes("updated"));
		ok(diff.includes("diff --git"));
	});
});
