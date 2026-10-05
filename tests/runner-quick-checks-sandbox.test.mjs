import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { cwd } from "node:process";
import { afterEach, describe, it } from "node:test";
import {
	quickCheckSandboxProfile,
	runQuickChecks,
} from "../src/switchyard/runner/checks.mjs";

const TEST_DIR = join(cwd(), ".switchyard-quick-check-test-sandbox");
function runFixtureGit(projectPath, args) {
	const result = spawnSync("git", args, { cwd: projectPath, encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}
afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});
describe("Task 51 quick-check regression", () => {
	it("confines provider-edited checks to the candidate and runtime", async () => {
		const project = join(TEST_DIR, "task-check-sandbox");
		mkdirSync(project, { recursive: true });
		const outside = join(TEST_DIR, "outside-marker");
		writeFileSync(outside, "host-only");
		const listener = createServer();
		await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
		const port = listener.address().port;
		try {
			writeFileSync(
				join(project, "package.json"),
				JSON.stringify({ scripts: { lint: "node --test check.mjs" } }),
			);
			writeFileSync(
				join(project, "check.mjs"),
				`import { readFileSync, writeFileSync } from "node:fs";\nimport { connect } from "node:net";\nconst outside = ${JSON.stringify(outside)};\ntry { readFileSync(outside); throw new Error("host path readable"); } catch (error) { if (!["EPERM", "EACCES"].includes(error.code)) throw error; }\ntry { writeFileSync(outside, "modified"); throw new Error("host path writable"); } catch (error) { if (!["EPERM", "EACCES"].includes(error.code)) throw error; }\nawait new Promise((resolve, reject) => { const socket = connect({ host: "127.0.0.1", port: ${port} }); socket.on("connect", () => { socket.destroy(); reject(new Error("network reachable")); }); socket.on("error", (error) => ["EPERM", "EACCES"].includes(error.code) ? resolve() : reject(error)); });\n`,
			);
			writeFileSync(join(project, "a.mjs"), "export const a = 1;\n");
			runFixtureGit(project, ["init", "-q"]);
			runFixtureGit(project, ["add", "."]);
			runFixtureGit(project, [
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				"commit",
				"-qm",
				"base",
			]);
			const baseTree = runFixtureGit(project, ["rev-parse", "HEAD^{tree}"]);
			writeFileSync(join(project, "a.mjs"), "export const a = 2;\n");
			const diff = runFixtureGit(project, ["diff", "--", "a.mjs"]);
			writeFileSync(join(project, "a.mjs"), "export const a = 1;\n");
			const receipt = runQuickChecks({
				projectPath: project,
				taskId: "sandbox",
				attempt: 1,
				baseTree,
				diff,
				checks: [["npm", "run", "lint"]],
				allowedPaths: ["a.mjs"],
			});
			strictEqual(receipt.status, "passed");
			strictEqual(receipt.cleanup.status, "complete");
			strictEqual(readFileSync(outside, "utf8"), "host-only");
			ok(
				!quickCheckSandboxProfile(project, TEST_DIR).includes(
					"network-outbound",
				),
			);
		} finally {
			listener.close();
		}
	});
	it("keeps failed lint incomplete and retains an exact failed receipt", () => {
		const project = join(TEST_DIR, "task-51");
		mkdirSync(project, { recursive: true });
		writeFileSync(
			join(project, "package.json"),
			JSON.stringify({
				private: true,
				scripts: { lint: "node --check broken.mjs" },
			}),
		);
		writeFileSync(join(project, "broken.mjs"), "export const answer = 1;\n");
		runFixtureGit(project, ["init", "-q"]);
		runFixtureGit(project, ["add", "."]);
		runFixtureGit(project, [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-qm",
			"base",
		]);
		const base = runFixtureGit(project, ["rev-parse", "HEAD^{tree}"]);
		writeFileSync(join(project, "broken.mjs"), "export const = ;\n");
		const diff = runFixtureGit(project, ["diff", "--", "broken.mjs"]);
		writeFileSync(join(project, "broken.mjs"), "export const answer = 1;\n");
		const receipt = runQuickChecks({
			projectPath: project,
			taskId: "51",
			attempt: 1,
			baseTree: base,
			diff,
			checks: [["npm", "run", "lint"]],
		});
		strictEqual(receipt.status, "failed");
		strictEqual(receipt.checks[0].exitCode, 1);
		strictEqual(receipt.cleanup.status, "complete");
		strictEqual(receipt.baseTree, base);
		ok(receipt.candidateTree);
		ok(!JSON.stringify(receipt).includes("export const ="));
	});
});
