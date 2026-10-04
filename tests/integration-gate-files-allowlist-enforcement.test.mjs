// INV-2 gate test: code returns to Mac only through explicit reviewed gate
// Tests: agent output reaches host files ONLY via the reviewed apply, and
// the gate's own validation — not just git's — rejects unsafe diffs.

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { integrationGate } from "../src/switchyard/integrate/index.mjs";
import {
	buildDiff,
	buildStagedDiff,
	commitFile,
	initRepo,
} from "./helpers/integration-gate-fixtures.mjs";

let projectPath;

// Build a diff by making a change against a real git working tree and
// capturing git's own diff output — every fixture below is a diff git
// itself produced, not hand-written unified-diff text, so the parsing
// assumptions match real dispatches.
beforeEach(() => {
	projectPath = initRepo();
	commitFile(projectPath, "test.txt", "original content\n");
});

afterEach(() => {
	rmSync(projectPath, { recursive: true, force: true });
});

describe("Files allowlist enforcement", () => {
	it("exact declared set passes gate", () => {
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(join(dir, "test.txt"), "modified content\n", "utf8");
		});
		execSync("git checkout -- test.txt", { cwd: projectPath, stdio: "pipe" });

		const result = integrationGate(diff, projectPath, {
			requiredPaths: ["test.txt"],
		});
		strictEqual(result.success, true);
		strictEqual(
			readFileSync(join(projectPath, "test.txt"), "utf8"),
			"modified content\n",
		);
	});

	it("allows a changed subset of declared allowed paths", () => {
		commitFile(projectPath, "src/a.mjs", "original\n");
		commitFile(projectPath, "src/b.mjs", "original\n");
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(join(dir, "src", "a.mjs"), "modified\n", "utf8");
		});
		execSync("git checkout -- src/a.mjs", {
			cwd: projectPath,
			stdio: "pipe",
		});

		const result = integrationGate(diff, projectPath, {
			allowedPaths: ["src/a.mjs", "src/b.mjs"],
		});
		strictEqual(result.success, true);
		strictEqual(
			readFileSync(join(projectPath, "src/a.mjs"), "utf8"),
			"modified\n",
		);
		strictEqual(
			readFileSync(join(projectPath, "src/b.mjs"), "utf8"),
			"original\n",
		);
	});

	it("returns required_paths_missing when a declared path is not touched", () => {
		commitFile(projectPath, "src/a.mjs", "original\n");
		commitFile(projectPath, "src/b.mjs", "original\n");
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(join(dir, "src", "a.mjs"), "modified\n", "utf8");
		});
		execSync("git checkout -- src/a.mjs", {
			cwd: projectPath,
			stdio: "pipe",
		});

		const result = integrationGate(diff, projectPath, {
			requiredPaths: ["src/a.mjs", "src/b.mjs"],
		});
		strictEqual(result.success, false);
		strictEqual(result.message, "required_paths_missing");
		deepStrictEqual(result.missingPaths, ["src/b.mjs"]);
	});

	it("returns undeclared_paths_touched when a touched path is not declared", () => {
		commitFile(projectPath, "src/a.mjs", "original\n");
		commitFile(projectPath, "src/b.mjs", "original\n");
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(join(dir, "src", "a.mjs"), "modified\n", "utf8");
			writeFileSync(join(dir, "src", "b.mjs"), "also modified\n", "utf8");
		});

		const result = integrationGate(diff, projectPath, {
			requiredPaths: ["src/a.mjs"],
		});
		strictEqual(result.success, false);
		strictEqual(result.message, "undeclared_paths_touched");
		ok(result.extraPaths.includes("src/b.mjs"));
	});

	it("returns empty_required_diff when diff is empty and requiredPaths is set", () => {
		const result = integrationGate("", projectPath, {
			requiredPaths: ["test.txt"],
		});
		strictEqual(result.success, false);
		strictEqual(result.message, "empty_required_diff");
	});

	it("rename: Files declaring the destination passes (both rename paths counted for declaration)", () => {
		commitFile(projectPath, "src/old.mjs", "original\n");
		const diff = buildStagedDiff(projectPath, (dir) => {
			execSync("git mv src/old.mjs src/new.mjs", { cwd: dir });
		});
		execSync("git reset -q HEAD -- src/", {
			cwd: projectPath,
			stdio: "pipe",
		});
		execSync("git checkout -q -- src/", {
			cwd: projectPath,
			stdio: "pipe",
		});
		// checkout restores tracked files but leaves the rename destination as
		// an untracked file — remove it so git apply can recreate it cleanly.
		rmSync(join(projectPath, "src", "new.mjs"), { force: true });

		const result = integrationGate(diff, projectPath, {
			requiredPaths: ["src/new.mjs"],
		});
		strictEqual(result.success, true);
	});

	it("rename: Files declaring the destination fails when only the source is declared", () => {
		commitFile(projectPath, "src/old.mjs", "original\n");
		const diff = buildStagedDiff(projectPath, (dir) => {
			execSync("git mv src/old.mjs src/new.mjs", { cwd: dir });
		});
		execSync("git reset -q HEAD -- src/", {
			cwd: projectPath,
			stdio: "pipe",
		});
		execSync("git checkout -q -- src/", {
			cwd: projectPath,
			stdio: "pipe",
		});
		rmSync(join(projectPath, "src", "new.mjs"), { force: true });

		const result = integrationGate(diff, projectPath, {
			requiredPaths: ["src/old.mjs"],
		});
		// The source path is counted via the summary line, but the destination
		// path (src/new.mjs) is also touched and undeclared — blocked.
		strictEqual(result.success, false);
		strictEqual(result.message, "undeclared_paths_touched");
		ok(result.extraPaths.includes("src/new.mjs"));
	});

	it("delete: Files declaring the deleted path passes (deleted path in --numstat)", () => {
		commitFile(projectPath, "src/gone.mjs", "original\n");
		const diff = buildStagedDiff(projectPath, (dir) => {
			execSync("git rm -q src/gone.mjs", { cwd: dir });
		});
		execSync("git reset -q HEAD -- src/", {
			cwd: projectPath,
			stdio: "pipe",
		});
		execSync("git checkout -q -- src/", {
			cwd: projectPath,
			stdio: "pipe",
		});

		const result = integrationGate(diff, projectPath, {
			requiredPaths: ["src/gone.mjs"],
		});
		strictEqual(result.success, true);
	});

	it("sensitive paths still blocked even when in Files allowlist", () => {
		commitFile(projectPath, "config.json", "{}");
		const diff = buildStagedDiff(projectPath, (dir) => {
			writeFileSync(join(dir, ".env"), "SECRET=xyz\n", "utf8");
		});
		const result = integrationGate(diff, projectPath, {
			requiredPaths: [".env"],
		});
		strictEqual(result.success, false);
		ok(result.message.includes("credential"));
	});

	it("manifest paths still require allowSensitiveManifests even when in Files allowlist", () => {
		commitFile(projectPath, "package.json", '{"name":"x"}\n');
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(join(dir, "package.json"), '{"name":"y"}\n', "utf8");
		});
		execSync("git checkout -- package.json", {
			cwd: projectPath,
			stdio: "pipe",
		});

		const result = integrationGate(diff, projectPath, {
			requiredPaths: ["package.json"],
		});
		strictEqual(result.success, false);
		strictEqual(result.requiresReview, true);
	});

	it("rejects undeclared package-lock artifacts while preserving the exact Files allowlist", () => {
		commitFile(projectPath, "package-lock.json", '{"lockfileVersion":3}\n');
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(
				join(dir, "package-lock.json"),
				'{"lockfileVersion":3,"packages":{}}\n',
				"utf8",
			);
			writeFileSync(join(dir, "test.txt"), "declared source change\n", "utf8");
		});
		execSync("git checkout -- package-lock.json", {
			cwd: projectPath,
			stdio: "pipe",
		});
		execSync("git checkout -- test.txt", {
			cwd: projectPath,
			stdio: "pipe",
		});

		const result = integrationGate(diff, projectPath, {
			requiredPaths: ["test.txt"],
		});
		strictEqual(result.success, false);
		strictEqual(result.message, "undeclared_paths_touched");
		ok(result.extraPaths.includes("package-lock.json"));
	});

	it("requires review for a lockfile even without an explicit Files allowlist", () => {
		commitFile(projectPath, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(
				join(dir, "pnpm-lock.yaml"),
				"lockfileVersion: '9.0'\nimporters: {}\n",
				"utf8",
			);
		});
		execSync("git checkout -- pnpm-lock.yaml", {
			cwd: projectPath,
			stdio: "pipe",
		});

		const result = integrationGate(diff, projectPath);
		strictEqual(result.success, false);
		strictEqual(result.requiresReview, true);
		ok(result.sensitivePaths.includes("pnpm-lock.yaml"));
	});

	it("manifest path passes AllowManifests: true plus Files: together", () => {
		commitFile(projectPath, "package.json", '{"name":"x"}\n');
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(join(dir, "package.json"), '{"name":"y"}\n', "utf8");
		});
		execSync("git checkout -- package.json", {
			cwd: projectPath,
			stdio: "pipe",
		});

		const result = integrationGate(diff, projectPath, {
			requiredPaths: ["package.json"],
			allowSensitiveManifests: true,
		});
		strictEqual(result.success, true);
	});

	it("null requiredPaths: legacy behavior preserved", () => {
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(join(dir, "test.txt"), "modified content\n", "utf8");
		});
		execSync("git checkout -- test.txt", { cwd: projectPath, stdio: "pipe" });

		const result = integrationGate(diff, projectPath, {
			requiredPaths: null,
		});
		strictEqual(result.success, true);
	});
});
