import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	runQuickChecks,
	runQuickChecksAsync,
} from "../src/switchyard/runner/checks.mjs";
import { parseTaskQueue } from "../src/switchyard/runner/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const TEST_DIR = tempDir("switchyard-quick-checks-cleanup-");
const READY_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 15_000;
function runFixtureGit(projectPath, args) {
	const result = spawnSync("git", args, { cwd: projectPath, encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}
async function waitFor(check, timeoutMs = READY_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (!check() && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 20));
	return check();
}
afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});
describe("Task 51 quick-check regression", () => {
	it("kills escaped check helpers after normal, failed, timed out, and abrupt runs", async () => {
		for (const mode of ["normal", "failed", "timeout", "abrupt"]) {
			const project = join(TEST_DIR, `task-check-child-${mode}`);
			mkdirSync(project, { recursive: true });
			let marker = null;
			let release = null;
			const handshakes = mode === "normal" || mode === "failed";
			const ending = handshakes
				? `await waitForRelease();${mode === "failed" ? "\nprocess.exit(3);" : ""}`
				: "setInterval(() => {}, 1000);";
			const script = `import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), detached: true, stdio: "ignore" });
writeFileSync(join(process.env.HOME, "check-helper.pid"), String(child.pid));
child.unref();
const waitForRelease = async () => {
	const releasePath = join(process.env.HOME, "check-release.flag");
	const deadline = Date.now() + ${READY_TIMEOUT_MS};
	while (!existsSync(releasePath) && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 20));
};
${ending}
`;
			writeFileSync(join(project, "check.mjs"), script);
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
			let pid = null;
			let runnerPid = null;
			try {
				const pending = runQuickChecksAsync({
					projectPath: project,
					taskId: `helper-${mode}`,
					attempt: 1,
					baseTree,
					diff,
					checks: [["node", "--test", "check.mjs"]],
					checkTimeoutMs: mode === "timeout" ? CHECK_TIMEOUT_MS : undefined,
					allowedPaths: ["a.mjs"],
					onRunnerStarted: (value, root) => {
						runnerPid = value;
						marker = join(root, "check-helper.pid");
						release = join(root, "check-release.flag");
					},
				});
				const startedPid = await waitFor(() => {
					if (!marker) return 0;
					try {
						const value = Number(readFileSync(marker, "utf8"));
						return Number.isSafeInteger(value) && value > 0 ? value : 0;
					} catch {
						return 0;
					}
				});
				ok(startedPid > 0, "check helper must start before cleanup");
				pid = startedPid;
				if (release && handshakes) writeFileSync(release, "release");
				if (mode === "abrupt") {
					process.kill(runnerPid, "SIGKILL");
				}
				const receipt = await pending;
				if (mode === "abrupt") strictEqual(receipt, null);
				else {
					strictEqual(receipt?.status, mode === "normal" ? "passed" : "failed");
					strictEqual(receipt.cleanup.status, "complete");
					if (mode === "timeout") strictEqual(receipt.checks[0].timedOut, true);
					if (mode === "failed") ok(receipt.checks[0].exitCode !== 0);
				}
				ok(Number.isSafeInteger(pid) && pid > 0);
				const stopped = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				});
				ok(
					stopped.status === 1 || /^Z/u.test(stopped.stdout.trim()),
					"escaped helper must be gone or reaped",
				);
			} finally {
				if (runnerPid) {
					try {
						process.kill(-runnerPid, "SIGKILL");
					} catch {
						/* already gone */
					}
				}
				if (pid) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						/* already gone */
					}
				}
			}
		}
	});
	it("kills a detached helper before synchronous check cleanup", () => {
		const project = join(TEST_DIR, "task-check-sync-child");
		const root = join(TEST_DIR, "check-root");
		mkdirSync(project, { recursive: true });
		mkdirSync(root, { recursive: true });
		const script = `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), detached: true, stdio: "ignore" });
writeFileSync(join(process.env.HOME, "check-helper.pid"), String(child.pid));
child.unref();
`;
		writeFileSync(join(project, "check.mjs"), script);
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
		let pid = null;
		try {
			const receipt = runQuickChecks({
				projectPath: project,
				taskId: "sync-helper",
				attempt: 1,
				baseTree,
				diff,
				checks: [["node", "--test", "check.mjs"]],
				allowedPaths: ["a.mjs"],
				ownedRoot: root,
			});
			strictEqual(receipt.status, "passed");
			const marker = join(root, "check-helper.pid");
			ok(existsSync(marker));
			pid = Number(readFileSync(marker, "utf8"));
			const stopped = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			ok(
				stopped.status === 1 || /^Z/u.test(stopped.stdout.trim()),
				"detached helper must be gone before receipt returns",
			);
		} finally {
			if (pid) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* already gone */
				}
			}
		}
	});
	it("runs declared offline dependency setup before the check", () => {
		const project = join(TEST_DIR, "task-setup");
		const root = join(TEST_DIR, "task-setup-root");
		const tool = join(project, "fixture-tool");
		const forbidden = join(TEST_DIR, "postinstall-ran");
		mkdirSync(project, { recursive: true });
		mkdirSync(root, { recursive: true });
		mkdirSync(tool, { recursive: true });
		writeFileSync(
			join(project, "package.json"),
			JSON.stringify({
				name: "task-setup-fixture",
				version: "1.0.0",
				private: true,
				devDependencies: { "fixture-tool": "file:./fixture-tool" },
				scripts: { probe: "fixture-tool" },
			}),
		);
		writeFileSync(
			join(tool, "package.json"),
			JSON.stringify({
				name: "fixture-tool",
				version: "1.0.0",
				bin: { "fixture-tool": "bin.mjs" },
				scripts: {
					postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(forbidden)}, 'unsafe')"`,
				},
			}),
		);
		writeFileSync(
			join(tool, "bin.mjs"),
			'#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nimport { join } from "node:path";\nwriteFileSync(join(process.env.HOME, "local-bin-ran"), "yes");\n',
			{ mode: 0o755 },
		);
		writeFileSync(join(project, ".gitignore"), "node_modules/\n");
		const lock = spawnSync(
			"npm",
			[
				"install",
				"--package-lock-only",
				"--ignore-scripts",
				"--offline",
				"--no-audit",
				"--no-fund",
			],
			{ cwd: project, encoding: "utf8" },
		);
		strictEqual(lock.status, 0);
		writeFileSync(join(project, "a.mjs"), "export const answer = 1;\n");
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
		writeFileSync(join(project, "a.mjs"), "export const answer = 2;\n");
		const diff = runFixtureGit(project, ["diff", "--", "a.mjs"]);
		writeFileSync(join(project, "a.mjs"), "export const answer = 1;\n");
		const quickChecks = parseTaskQueue(`### Task 53: Setup
- **Status:** pending
- **Executor:** switchyard
- **Files:** a.mjs
- **Quick checks:** npm run probe
- **Quick check setup:** npm ci --ignore-scripts --offline
`)[0].quickChecks;
		const receipt = runQuickChecks({
			projectPath: project,
			taskId: "53",
			attempt: 1,
			baseTree,
			diff,
			...quickChecks,
			allowedPaths: ["a.mjs"],
			ownedRoot: root,
		});
		strictEqual(receipt.status, "passed", JSON.stringify(receipt));
		strictEqual(receipt.setup.exitCode, 0);
		strictEqual(receipt.checks[0].exitCode, 0);
		strictEqual(readFileSync(join(root, "local-bin-ran"), "utf8"), "yes");
		ok(!existsSync(forbidden), "npm lifecycle scripts must stay disabled");
		const manifestPath = join(project, "package.json");
		const originalManifest = readFileSync(manifestPath, "utf8");
		const editedManifest = JSON.parse(originalManifest);
		editedManifest.scripts.probe = "node --version";
		writeFileSync(manifestPath, JSON.stringify(editedManifest));
		const manifestDiff = runFixtureGit(project, ["diff", "--", "package.json"]);
		writeFileSync(manifestPath, originalManifest);
		const untrusted = runQuickChecks({
			projectPath: project,
			taskId: "53-untrusted",
			attempt: 1,
			baseTree,
			diff: manifestDiff,
			...quickChecks,
			allowedPaths: ["package.json"],
			allowSensitiveManifests: true,
		});
		strictEqual(untrusted.status, "unknown");
		strictEqual(untrusted.failureCode, "setup_unavailable");
	});
});
