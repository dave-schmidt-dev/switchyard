import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { captureDiff, executeAgy } from "../src/switchyard/adapter/agy.mjs";

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
const testRoot = mkdtempSync(join(tmpdir(), "switchyard-agy-adapter-"));
const containerName = `switchyard-agy-adapter-${Date.now()}`;

describe("agy adapter container execution", () => {
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

		// agy's prompt arrives as a --print flag value, not stdin (unlike
		// claude/codex) — the stub doesn't drain stdin since none is sent.
		execSync(
			`docker exec ${containerName} sh -c 'printf "#!/bin/sh\necho updated >> test.txt\necho agy\n" > /usr/local/bin/agy && chmod +x /usr/local/bin/agy'`,
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

	it("executes agy inside working container and captures diff", {
		skip: !dockerAvailable,
	}, () => {
		const result = executeAgy("apply a small change", containerName, {
			model: "Gemini 3.6 Flash (Medium)",
		});
		strictEqual(result.success, true, result.error);

		const diff = captureDiff(containerName);
		ok(typeof diff === "string" && diff.includes("updated"));
		ok(diff.includes("diff --git"));
	});
});

describe("agy adapter host-side timeout", () => {
	it("keeps the host-side kill timeout longer than agy's own --print-timeout flag", () => {
		// Regression: the host-side execFileSync timeout was 300000ms (5min)
		// while executeAgy passes `--print-timeout 9m` (540000ms) to the CLI
		// itself. A valid run between 5 and 9 minutes was force-killed by the
		// host before agy's own timeout could fire — the host timeout is
		// meant as a backstop for a hung process, not the primary limit.
		const adapterPath = join(PROJECT_ROOT, "src/switchyard/adapter/agy.mjs");
		const source = readFileSync(adapterPath, "utf8");

		const printTimeoutMatch = source.match(
			/--print-timeout["'\s,]+["'](\d+)m["']/,
		);
		ok(
			printTimeoutMatch,
			"expected to find the --print-timeout CLI flag value",
		);
		const printTimeoutMs = Number(printTimeoutMatch[1]) * 60 * 1000;

		const hostTimeoutMatch = source.match(/timeout:\s*(\d+)/);
		ok(hostTimeoutMatch, "expected to find the host-side execFileSync timeout");
		const hostTimeoutMs = Number(hostTimeoutMatch[1]);

		ok(
			hostTimeoutMs > printTimeoutMs,
			`host timeout (${hostTimeoutMs}ms) must exceed agy's own --print-timeout (${printTimeoutMs}ms)`,
		);
	});
});
