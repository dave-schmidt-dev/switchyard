import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { captureDiff, executeCodex } from "../src/switchyard/adapter/codex.mjs";

function hasDocker() {
	try {
		execSync("docker --version", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const dockerAvailable = hasDocker();
const testRoot = mkdtempSync(join(tmpdir(), "switchyard-codex-adapter-"));
const containerName = `switchyard-codex-adapter-${Date.now()}`;

describe("codex adapter container execution", () => {
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

		execSync(
			`docker exec ${containerName} sh -c 'printf "#!/bin/sh\ncat >/dev/null\necho updated >> test.txt\necho codex\n" > /usr/local/bin/codex && chmod +x /usr/local/bin/codex'`,
			{ stdio: "pipe" },
		);
	});

	after(() => {
		if (dockerAvailable) {
			try {
				execSync(`docker rm -f ${containerName}`, { stdio: "pipe" });
			} catch {
				// ignore cleanup errors
			}
		}
		rmSync(testRoot, { recursive: true, force: true });
	});

	it("executes codex inside working container and captures diff", {
		skip: !dockerAvailable,
	}, () => {
		const result = executeCodex("apply a small change", containerName, {
			model: "fake-model",
		});
		strictEqual(result.success, true);

		const diff = captureDiff(containerName);
		ok(typeof diff === "string" && diff.includes("updated"));
		ok(diff.includes("diff --git"));
	});
});
