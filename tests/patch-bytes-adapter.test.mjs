import { strictEqual } from "node:assert";
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { captureDiff as captureAgyDiff } from "../src/switchyard/adapter/agy.mjs";
import { captureDiff as captureClaudeDiff } from "../src/switchyard/adapter/claude.mjs";
import { captureDiff as captureCodexDiff } from "../src/switchyard/adapter/codex.mjs";
import { captureDiff as captureCopilotDiff } from "../src/switchyard/adapter/copilot.mjs";
import { captureDiff as captureCursorDiff } from "../src/switchyard/adapter/cursor.mjs";
import { captureDiff as captureOpencodeDiff } from "../src/switchyard/adapter/opencode.mjs";
import { integrationGate } from "../src/switchyard/integrate/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const captures = [
	["agy", captureAgyDiff],
	["claude", captureClaudeDiff],
	["codex", captureCodexDiff],
	["copilot", captureCopilotDiff],
	["cursor", captureCursorDiff],
	["opencode", captureOpencodeDiff],
];

// getWorkspaceExecution (provider-lifecycle.mjs) now requires an
// executionBackend with no default -- the removed DEFAULT_EXECUTION_BACKEND
// used to fill this in. installFakeDocker() below still shims a `docker`
// binary onto PATH, so this fixture only needs to route through that:
// command "docker" with the same argv tail the case-statement stub matches
// against.
const dockerExecutionBackend = {
	execArgv(workspaceId, { cwd = "/project", argv } = {}) {
		return {
			command: "docker",
			args: ["exec", "-i", "-w", cwd, workspaceId, ...argv],
		};
	},
};

let tempRoot;
let originalPath;

afterEach(() => {
	if (originalPath !== undefined) {
		process.env.PATH = originalPath;
		originalPath = undefined;
	}
	if (tempRoot) {
		rmSync(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
});

function installFakeDocker(patch) {
	tempRoot = tempDir("switchyard-patch-bytes-");
	const patchPath = join(tempRoot, "patch.diff");
	writeFileSync(patchPath, patch, "utf8");
	const dockerPath = join(tempRoot, "docker");
	writeFileSync(
		dockerPath,
		`#!/bin/sh
case " $* " in
  *" git diff --cached HEAD ") cat ${JSON.stringify(patchPath)} ;;
  *) exit 0 ;;
esac
`,
		{ encoding: "utf8", mode: 0o755 },
	);
	originalPath = process.env.PATH;
	process.env.PATH = `${tempRoot}:${originalPath}`;
}

function buildProject() {
	const project = tempDir("switchyard-patch-gate-");
	writeFileSync(join(project, "test.txt"), "before\n", "utf8");
	execSync("git init -q", { cwd: project, stdio: "pipe" });
	execSync('git config user.email "test@test.com"', {
		cwd: project,
		stdio: "pipe",
	});
	execSync('git config user.name "Test"', { cwd: project, stdio: "pipe" });
	execSync("git add test.txt", { cwd: project, stdio: "pipe" });
	execSync('git commit -q -m "base"', { cwd: project, stdio: "pipe" });
	writeFileSync(join(project, "test.txt"), "after\n", "utf8");
	const diff = execFileSync("git", ["diff", "--no-color"], {
		cwd: project,
		encoding: "utf8",
	});
	writeFileSync(join(project, "test.txt"), "before\n", "utf8");
	return { project, diff };
}

describe("adapter patch-byte preservation", () => {
	for (const trailingNewlines of [1, 2]) {
		it(`preserves ${trailingNewlines} trailing newline(s) through capture and integration`, () => {
			const { project, diff } = buildProject();
			const body = diff.replace(/\n+$/u, "");
			const expected = `${body}${"\n".repeat(trailingNewlines)}`;
			installFakeDocker(expected);

			for (const [name, capture] of captures) {
				strictEqual(
					capture("fake-container", {
						executionBackend: dockerExecutionBackend,
					}),
					expected,
					`${name} capture must preserve terminal patch bytes`,
				);
			}

			const result = integrationGate(expected, project);
			strictEqual(result.success, true, result.message);
			strictEqual(readFileSync(join(project, "test.txt"), "utf8"), "after\n");
			rmSync(project, { recursive: true, force: true });
		});
	}
});
