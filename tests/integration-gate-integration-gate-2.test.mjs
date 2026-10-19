// @test-phase: other
// INV-2 gate test: code returns to Mac only through explicit reviewed gate
// Tests: agent output reaches host files ONLY via the reviewed apply, and
// the gate's own validation — not just git's — rejects unsafe diffs.

import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";

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

describe("integration gate", () => {
	it("rejects an empty or whitespace-only diff instead of erroring obscurely", () => {
		for (const empty of ["", "   \n\t \n"]) {
			const result = integrationGate(empty, projectPath);
			strictEqual(result.success, false);
			ok(result.message.toLowerCase().includes("empty"));
		}
	});

	it("rejects a diff that writes into .git internals (e.g. a hook), even though git apply itself accepts it", () => {
		// Regression-shaped gap: `git apply --numstat`/the real `git apply`
		// happily parse and would happily write a path under .git/ (verified
		// directly against the installed git) — nothing about git's own
		// plumbing refuses it. A hook written this way (e.g. .git/hooks/
		// post-checkout) executes automatically on a later git operation,
		// making this an RCE path structurally distinct from — and not
		// caught by — the path-traversal, symlink, or executable-file checks
		// above, since .git/hooks/post-checkout lives inside the project
		// root and isn't itself a symlink.
		const diff = `diff --git a/.git/hooks/post-checkout b/.git/hooks/post-checkout
new file mode 100755
index 0000000..abcdef1
--- /dev/null
+++ b/.git/hooks/post-checkout
@@ -0,0 +1,2 @@
+#!/bin/sh
+echo pwned
`;
		const result = integrationGate(diff, projectPath);
		strictEqual(result.success, false);
		ok(result.message.includes(".git"));
	});

	it("rejects a diff that renames a file into a credential-convention path", () => {
		// A rename lands only the *new* path in `git apply --numstat` output
		// (verified: a clean rename reports just the destination, not
		// "old => new"), so the sensitive-path check must be applied against
		// that reported path — not skipped just because the change is a
		// rename rather than a new-file creation.
		const diff = buildStagedDiff(projectPath, (dir) => {
			execSync("git mv test.txt .env", { cwd: dir });
		});
		const result = integrationGate(diff, projectPath);
		strictEqual(result.success, false);
		ok(result.message.includes("credential"));
	});

	it("detects a no-op diff (hunks net to zero content change) even with unrelated dirty state", () => {
		// Regression: integrationGate reported {success: true} whenever
		// `git apply` exited 0, even when the diff netted to zero real
		// content change — a production incident. The new no-op check
		// compares pre- and post-apply fingerprints scoped to touched paths
		// only, so unrelated dirty state in other files is ignored.
		commitFile(projectPath, "target.txt", "a\nb\nc\n");
		commitFile(projectPath, "other.txt", "original\n");

		// A structurally-valid diff whose hunk changes 'b' to 'b' — a
		// semantic no-op. `git apply --numstat` parses it (passes
		// structural validation), `git apply` exits 0 (context matches),
		// but the file content doesn't change.
		const noopDiff = `${[
			"diff --git a/target.txt b/target.txt",
			"--- a/target.txt",
			"+++ b/target.txt",
			"@@ -1,3 +1,3 @@",
			" a",
			"-b",
			"+b",
			" c",
		].join("\n")}\n`;

		// Unrelated dirty state in a file the diff doesn't touch
		writeFileSync(join(projectPath, "other.txt"), "modified\n", "utf8");

		const result = integrationGate(noopDiff, projectPath);
		strictEqual(result.success, false);
		strictEqual(result.message, "no_op_diff");

		// Verify the genuine empty-diff path is unchanged
		const emptyResult = integrationGate("", projectPath);
		strictEqual(emptyResult.success, false);
		ok(emptyResult.message.toLowerCase().includes("empty"));
	});

	it("accepts a real change to a touched file that was already dirty", () => {
		commitFile(
			projectPath,
			"target.txt",
			"line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\n",
		);
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(
				join(dir, "target.txt"),
				"line 1\nchanged by diff\nline 3\nline 4\nline 5\nline 6\nline 7\n",
				"utf8",
			);
		});
		execSync("git checkout -- target.txt", { cwd: projectPath, stdio: "pipe" });
		writeFileSync(
			join(projectPath, "target.txt"),
			"line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nlocal dirty line\n",
			"utf8",
		);

		const result = integrationGate(diff, projectPath);
		strictEqual(result.success, true, result.message);
		strictEqual(
			readFileSync(join(projectPath, "target.txt"), "utf8"),
			"line 1\nchanged by diff\nline 3\nline 4\nline 5\nline 6\nline 7\nlocal dirty line\n",
		);
	});

	it("does not infer prior application from a matching after-state", () => {
		// A matching after-state cannot prove this operation applied: unrelated
		// edits can produce the same bytes. The forward `git apply --check`
		// fails because the before-state no longer matches, so a re-run fails
		// closed and never re-mutates the host.
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(join(dir, "test.txt"), "modified content\n", "utf8");
		});
		execSync("git checkout -- test.txt", { cwd: projectPath, stdio: "pipe" });

		const first = integrationGate(diff, projectPath);
		strictEqual(first.success, true, first.message);
		strictEqual(
			readFileSync(join(projectPath, "test.txt"), "utf8"),
			"modified content\n",
		);

		const second = integrationGate(diff, projectPath);
		strictEqual(second.success, false, second.message);
		strictEqual(second.alreadyApplied, undefined);
		strictEqual(
			readFileSync(join(projectPath, "test.txt"), "utf8"),
			"modified content\n",
			"re-applying must not mutate the host",
		);
	});

	it("applies sequential task baselines while host HEAD remains unchanged", () => {
		const headBefore = execSync("git rev-parse HEAD", {
			cwd: projectPath,
			encoding: "utf8",
		}).trim();
		const firstDiff = buildDiff(projectPath, (dir) => {
			writeFileSync(join(dir, "test.txt"), "first accepted task\n", "utf8");
		});
		execSync("git checkout -- test.txt", { cwd: projectPath, stdio: "pipe" });
		strictEqual(integrationGate(firstDiff, projectPath).success, true);
		execSync("git add test.txt", { cwd: projectPath, stdio: "pipe" });
		writeFileSync(
			join(projectPath, "test.txt"),
			"second accepted task\n",
			"utf8",
		);
		const secondDiff = execSync("git diff --no-color -- test.txt", {
			cwd: projectPath,
			encoding: "utf8",
		});
		execSync("git reset -q", { cwd: projectPath, stdio: "pipe" });
		writeFileSync(
			join(projectPath, "test.txt"),
			"first accepted task\n",
			"utf8",
		);
		strictEqual(integrationGate(secondDiff, projectPath).success, true);
		strictEqual(
			readFileSync(join(projectPath, "test.txt"), "utf8"),
			"second accepted task\n",
		);
		strictEqual(
			execSync("git rev-parse HEAD", {
				cwd: projectPath,
				encoding: "utf8",
			}).trim(),
			headBefore,
		);
	});

	it("does not infer a new-file application from a matching after-state", () => {
		// New-file shape: a reverse apply of a new-file diff deletes the
		// already-created file, so `--reverse --check` succeeds and the gate
		// reports alreadyApplied without touching the host.
		const diff = buildStagedDiff(projectPath, (dir) => {
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(
				join(dir, "src", "new-module.txt"),
				"created by agent\n",
				"utf8",
			);
		});
		ok(diff.includes("new file"), "fixture must be a new-file diff");
		rmSync(join(projectPath, "src"), { recursive: true, force: true });
		execSync("git reset -q", { cwd: projectPath, stdio: "pipe" });

		const first = integrationGate(diff.trim(), projectPath);
		strictEqual(first.success, true, first.message);
		ok(existsSync(join(projectPath, "src", "new-module.txt")));

		const second = integrationGate(diff.trim(), projectPath);
		strictEqual(second.success, false, second.message);
		strictEqual(second.alreadyApplied, undefined);
		strictEqual(
			readFileSync(join(projectPath, "src", "new-module.txt"), "utf8"),
			"created by agent\n",
		);
	});

	it("does not infer a rename application from a matching after-state", () => {
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

		const first = integrationGate(diff, projectPath);
		strictEqual(first.success, true, first.message);
		ok(existsSync(join(projectPath, "src", "new.mjs")));
		ok(!existsSync(join(projectPath, "src", "old.mjs")));

		const second = integrationGate(diff, projectPath);
		strictEqual(second.success, false, second.message);
		strictEqual(second.alreadyApplied, undefined);
		ok(existsSync(join(projectPath, "src", "new.mjs")));
		ok(!existsSync(join(projectPath, "src", "old.mjs")));
	});
});
