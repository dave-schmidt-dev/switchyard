// @test-phase: serial
import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseQuickChecks } from "../src/switchyard/runner/check-contract.mjs";
import { runQuickChecks } from "../src/switchyard/runner/checks.mjs";
import { nestedSandboxSkip } from "./helpers/nested-sandbox.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const TEST_DIR = tempDir("switchyard-quick-checks-cleanup-");
function runFixtureGit(projectPath, args) {
	const result = spawnSync("git", args, { cwd: projectPath, encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}
afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});
/**
 * A failed receipt plus the tail of every npm debug log under `root`: setup
 * logs to `root` itself and the sandboxed check to `root/.npm/_logs`. npm
 * exits with a system error's errno, so a bare exit code such as 255 (EPERM)
 * cannot name the failing operation; the log can, and `afterEach` deletes it.
 */
function receiptEvidence(receipt, root) {
	const logs = [];
	for (const dir of [root, join(root, ".npm", "_logs")]) {
		let names;
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names.filter((entry) => entry.endsWith(".log")).sort())
			logs.push(
				`--- ${name}`,
				...readFileSync(join(dir, name), "utf8").split("\n").slice(-40),
			);
	}
	return [JSON.stringify(receipt), ...logs].join("\n");
}
describe("Task 51 quick-check regression", {
	skip: nestedSandboxSkip,
}, () => {
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
		const quickChecks = parseQuickChecks(
			`- **Quick checks:** npm run probe
- **Quick check setup:** npm ci --ignore-scripts --offline`,
			"53",
		);
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
		strictEqual(
			receipt.status,
			"passed",
			receipt.status === "passed" ? undefined : receiptEvidence(receipt, root),
		);
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
