// INV-2 gate test: code returns to Mac only through explicit reviewed gate
// Tests: agent output reaches host files ONLY via the reviewed apply, and
// the gate's own validation — not just git's — rejects unsafe diffs.

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { INTEGRATION_REFUSAL_KINDS } from "../src/switchyard/adapter/exec-error.mjs";
import {
	dequoteGitPath,
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

describe("integration refusal kinds", () => {
	// Every refusal below reaches `dispatch` stdout, `status`, `result`,
	// `run.json`, `events.jsonl`, and the checkpoint as a single static
	// `integration_failed`. Run eab7d23c (2026-08-25) was rejected for omitting
	// `AllowManifests: true` and diagnosing it required reading this file's
	// source. Each site now names its own cause through a closed enum, so the
	// operator surface distinguishes them without carrying provider text.
	beforeEach(() => {
		projectPath = initRepo();
		commitFile(projectPath, "test.txt", "original content\n");
	});

	afterEach(() => {
		rmSync(projectPath, { recursive: true, force: true });
	});

	it("names a distinct kind at every refusal site", () => {
		const kinds = new Map();

		kinds.set("empty diff", validateDiff("   \n  ", projectPath).reasonKind);

		kinds.set(
			"path escape",
			validateDiff(
				`diff --git a/../../../etc/switchyard-poc b/../../../etc/switchyard-poc
new file mode 100644
index 0000000..abcdef1
--- /dev/null
+++ b/../../../etc/switchyard-poc
@@ -0,0 +1 @@
+pwned
`,
				projectPath,
			).reasonKind,
		);

		kinds.set(
			"git internals",
			validateDiff(
				`diff --git a/.git/hooks/post-checkout b/.git/hooks/post-checkout
new file mode 100755
index 0000000..abcdef1
--- /dev/null
+++ b/.git/hooks/post-checkout
@@ -0,0 +1,2 @@
+#!/bin/sh
+echo pwned
`,
				projectPath,
			).reasonKind,
		);

		kinds.set(
			"credential path",
			validateDiff(
				buildStagedDiff(projectPath, (dir) => {
					writeFileSync(join(dir, ".env"), "TOKEN=abc\n", "utf8");
				}),
				projectPath,
			).reasonKind,
		);
		// Each fixture must leave the tree clean, or the next `buildStagedDiff`
		// re-stages it and an earlier rule claims the later diff.
		execSync("git rm --cached -q .env", { cwd: projectPath, stdio: "pipe" });
		rmSync(join(projectPath, ".env"), { force: true });

		kinds.set(
			"symlink",
			validateDiff(
				buildStagedDiff(projectPath, (dir) => {
					execSync("ln -s /etc/passwd evil-link", { cwd: dir });
				}),
				projectPath,
			).reasonKind,
		);
		execSync("git rm --cached -q evil-link", {
			cwd: projectPath,
			stdio: "pipe",
		});
		rmSync(join(projectPath, "evil-link"), { force: true });

		kinds.set(
			"executable",
			validateDiff(
				buildStagedDiff(projectPath, (dir) => {
					writeFileSync(
						join(dir, "evil.sh"),
						"#!/bin/sh\necho pwned\n",
						"utf8",
					);
					execSync("chmod +x evil.sh", { cwd: dir });
				}),
				projectPath,
			).reasonKind,
		);

		for (const [site, kind] of kinds) {
			ok(
				INTEGRATION_REFUSAL_KINDS.includes(kind),
				`${site} produced ${JSON.stringify(kind)}, which is not a closed-enum member`,
			);
		}
		strictEqual(
			new Set(kinds.values()).size,
			kinds.size,
			`each site must name its own cause, got ${JSON.stringify([...kinds])}`,
		);
	});

	it("names the manifest refusal through the gate, not just the validator", () => {
		commitFile(projectPath, "package.json", '{"name":"x","scripts":{}}\n');
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(
				join(dir, "package.json"),
				'{"name":"x","scripts":{"postinstall":"curl evil"}}\n',
				"utf8",
			);
		});

		const result = integrationGate(diff, projectPath);
		strictEqual(result.success, false);
		strictEqual(result.reasonKind, "manifest_review_required");
		ok(INTEGRATION_REFUSAL_KINDS.includes(result.reasonKind));
	});

	it("carries the refusal kind out of the gate for a structural refusal", () => {
		const result = integrationGate("", projectPath);
		strictEqual(result.success, false);
		strictEqual(result.reasonKind, "empty_diff");
	});

	it("keeps every refusal kind free of paths, diff hunks, and provider text", () => {
		// The `reason` field still interpolates a path for the operator's live
		// console, which is why the persisted channel is `reasonKind` and not
		// `reason`. The enum member is what crosses the persistence boundary.
		for (const kind of INTEGRATION_REFUSAL_KINDS) {
			ok(/^[a-z][a-z0-9_]*$/.test(kind), `${kind} must be a bare enum member`);
			ok(!kind.includes("/"), `${kind} must carry no path separator`);
		}
	});

	it("every closed rejection belongs to the closed code vocabulary", () => {
		const closedCodes = new Set([
			"empty_required_diff",
			"required_paths_missing",
			"undeclared_paths_touched",
			"no_op_diff",
			...INTEGRATION_REFUSAL_KINDS,
		]);
		strictEqual(closedCodes.size, 15);
		for (const code of closedCodes) {
			ok(/^[a-z][a-z0-9_]*$/.test(code), `${code} must be a bare identifier`);
			ok(!code.includes("/"), `${code} must carry no path separator`);
		}
	});

	it("maps allowlisted file-allowlist rejections to closed codes", () => {
		const closedCodes = new Set([
			"empty_required_diff",
			"required_paths_missing",
			"undeclared_paths_touched",
			"no_op_diff",
		]);

		const emptyRequired = integrationGate("", projectPath, {
			requiredPaths: ["test.txt"],
		});
		strictEqual(emptyRequired.success, false);
		ok(closedCodes.has(emptyRequired.message));

		commitFile(projectPath, "src/a.mjs", "original\n");
		commitFile(projectPath, "src/b.mjs", "original\n");
		const requiredPathsMissing = buildDiff(projectPath, (dir) => {
			writeFileSync(join(dir, "src", "a.mjs"), "modified\n", "utf8");
		});
		execSync("git checkout -- src/a.mjs", {
			cwd: projectPath,
			stdio: "pipe",
		});
		const requiredPathsMissingResult = integrationGate(
			requiredPathsMissing,
			projectPath,
			{
				requiredPaths: ["src/a.mjs", "src/b.mjs"],
			},
		);
		strictEqual(requiredPathsMissingResult.success, false);
		ok(closedCodes.has(requiredPathsMissingResult.message));

		const undeclaredPathsTouched = buildDiff(projectPath, (dir) => {
			writeFileSync(join(dir, "src", "a.mjs"), "modified\n", "utf8");
			writeFileSync(join(dir, "src", "b.mjs"), "also modified\n", "utf8");
		});
		const undeclaredPathsTouchedResult = integrationGate(
			undeclaredPathsTouched,
			projectPath,
			{ requiredPaths: ["src/a.mjs"] },
		);
		strictEqual(undeclaredPathsTouchedResult.success, false);
		ok(closedCodes.has(undeclaredPathsTouchedResult.message));

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
		commitFile(projectPath, "target.txt", "a\nb\nc\n");
		const noOpResult = integrationGate(noopDiff, projectPath);
		strictEqual(noOpResult.success, false);
		ok(closedCodes.has(noOpResult.message));
	});
});

describe("exact allowlist enforcement", () => {
	let projectDir;
	beforeEach(() => {
		projectDir = initRepo();
		commitFile(projectDir, "src/a.txt", "alpha\n");
		commitFile(projectDir, "src/b.txt", "beta\n");
		commitFile(projectDir, "src/c.txt", "gamma\n");
	});
	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("succeeds when only a subset of declared allowedPaths is changed", () => {
		const diff = buildDiff(projectDir, (dir) => {
			writeFileSync(join(dir, "src", "a.txt"), "alpha modified\n", "utf8");
		});
		execSync("git checkout -- src/a.txt", { cwd: projectDir, stdio: "pipe" });

		const result = integrationGate(diff, projectDir, {
			allowedPaths: ["src/a.txt", "src/b.txt", "src/c.txt"],
		});
		strictEqual(result.success, true, result.message);
		strictEqual(
			readFileSync(join(projectDir, "src", "a.txt"), "utf8"),
			"alpha modified\n",
		);
	});

	it("fails when an undeclared addition is touched", () => {
		const diff = buildStagedDiff(projectDir, (dir) => {
			writeFileSync(join(dir, "src", "a.txt"), "alpha modified\n", "utf8");
			writeFileSync(join(dir, "src", "new.txt"), "new file\n", "utf8");
		});
		execSync("git checkout -- src/a.txt", { cwd: projectDir, stdio: "pipe" });
		rmSync(join(projectDir, "src", "new.txt"), { force: true });
		execSync("git reset -q", { cwd: projectDir, stdio: "pipe" });

		const result = integrationGate(diff, projectDir, {
			allowedPaths: ["src/a.txt", "src/b.txt"],
		});
		strictEqual(result.success, false);
		strictEqual(result.message, "undeclared_paths_touched");
		deepStrictEqual(result.extraPaths, ["src/new.txt"]);
	});

	it("fails when an undeclared deletion is touched", () => {
		const diff = buildStagedDiff(projectDir, (dir) => {
			writeFileSync(join(dir, "src", "a.txt"), "alpha modified\n", "utf8");
			rmSync(join(dir, "src", "c.txt"), { force: true });
		});
		execSync("git checkout -- src/a.txt", { cwd: projectDir, stdio: "pipe" });
		execSync("git checkout HEAD -- src/c.txt", {
			cwd: projectDir,
			stdio: "pipe",
		});
		execSync("git reset -q", { cwd: projectDir, stdio: "pipe" });

		const result = integrationGate(diff, projectDir, {
			allowedPaths: ["src/a.txt", "src/b.txt"],
		});
		strictEqual(result.success, false);
		strictEqual(result.message, "undeclared_paths_touched");
		deepStrictEqual(result.extraPaths, ["src/c.txt"]);
	});

	it("fails when an undeclared rename endpoint is touched", () => {
		const diff = buildStagedDiff(projectDir, (dir) => {
			execSync("git mv src/b.txt src/renamed.txt", {
				cwd: dir,
				stdio: "pipe",
			});
		});
		execSync("git reset --hard HEAD -q", { cwd: projectDir, stdio: "pipe" });

		const result = integrationGate(diff, projectDir, {
			allowedPaths: ["src/a.txt", "src/b.txt"],
		});
		strictEqual(result.success, false);
		strictEqual(result.message, "undeclared_paths_touched");
		deepStrictEqual(result.extraPaths, ["src/renamed.txt"]);
	});

	it("succeeds when both rename endpoints are declared in allowedPaths", () => {
		const diff = buildStagedDiff(projectDir, (dir) => {
			execSync("git mv src/b.txt src/renamed.txt", {
				cwd: dir,
				stdio: "pipe",
			});
		});
		execSync("git reset --hard HEAD -q", { cwd: projectDir, stdio: "pipe" });

		const result = integrationGate(diff, projectDir, {
			allowedPaths: ["src/a.txt", "src/b.txt", "src/renamed.txt"],
		});
		strictEqual(result.success, true, result.message);
	});

	it("rejects ambiguous combined rename spellings in allowedPaths", () => {
		const diff = buildDiff(projectDir, (dir) => {
			writeFileSync(join(dir, "src", "a.txt"), "alpha modified\n", "utf8");
		});
		execSync("git checkout -- src/a.txt", { cwd: projectDir, stdio: "pipe" });

		const result = integrationGate(diff, projectDir, {
			allowedPaths: ["src/a.txt => src/b.txt"],
		});
		strictEqual(result.success, false);
		strictEqual(result.reasonKind, "ambiguous_combined_rename_spelling");
	});

	it("refuses an undeclared path containing => when allowedPaths is enforced", () => {
		commitFile(projectDir, "src/a.mjs", "original\n");
		const diff = buildStagedDiff(projectDir, (dir) => {
			writeFileSync(join(dir, "src", "a.mjs"), "modified\n", "utf8");
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(
				join(dir, "tests", "x=>y.test.mjs"),
				"test content\n",
				"utf8",
			);
		});
		execSync("git checkout -- src/a.mjs", {
			cwd: projectDir,
			stdio: "pipe",
		});
		rmSync(join(projectDir, "tests", "x=>y.test.mjs"), { force: true });
		execSync("git reset -q", { cwd: projectDir, stdio: "pipe" });

		const result = integrationGate(diff, projectDir, {
			allowedPaths: ["src/a.mjs"],
		});
		strictEqual(result.success, false);
		strictEqual(result.message, "undeclared_paths_touched");
		deepStrictEqual(result.extraPaths, ["tests/x=>y.test.mjs"]);
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
