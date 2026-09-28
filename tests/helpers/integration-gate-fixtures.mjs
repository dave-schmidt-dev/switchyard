import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./tempdir.mjs";

function initRepo() {
	const dir = tempDir("switchyard-gate-");
	execSync("git init -q", { cwd: dir, stdio: "pipe" });
	execSync('git config user.email "test@test.com"', {
		cwd: dir,
		stdio: "pipe",
	});
	execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
	return dir;
}

function commitFile(dir, relativePath, content) {
	const fullPath = join(dir, relativePath);
	mkdirSync(join(fullPath, ".."), { recursive: true });
	writeFileSync(fullPath, content, "utf8");
	execSync(`git add ${relativePath}`, { cwd: dir, stdio: "pipe" });
	execSync('git commit -q -m "base"', { cwd: dir, stdio: "pipe" });
}

function buildDiff(dir, mutate) {
	mutate(dir);
	return execSync("git diff --no-color", { cwd: dir, encoding: "utf8" });
}

function buildStagedDiff(dir, mutate) {
	mutate(dir);
	execSync("git add -A", { cwd: dir, stdio: "pipe" });
	return execSync("git diff --cached --no-color", {
		cwd: dir,
		encoding: "utf8",
	});
}

export { buildDiff, buildStagedDiff, commitFile, initRepo };
