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

		// executeCursor calls the post-auth wrapper binary (cursor-agent-authed),
		// not cursor-agent directly — install the fake stub under that name,
		// same as authenticateCursor would in a real deployment. cursor-agent
		// can't read stdin, so this stub doesn't try to drain any.
		execSync(
			`docker exec ${containerName} sh -c 'printf "#!/bin/sh\necho updated >> test.txt\necho cursor-agent\n" > /usr/local/bin/cursor-agent-authed && chmod +x /usr/local/bin/cursor-agent-authed'`,
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

	it("executes cursor-agent-authed inside working container and captures diff", {
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
