import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const QUALIFICATION_FIXTURE_VERSION = "summary-v1";
export const QUALIFICATION_FILES = Object.freeze([
	"src/summary.mjs",
	"tests/summary.test.mjs",
]);
const ACCEPTANCE_FILE = "tests/acceptance.test.mjs";
export const ACCEPTANCE_CHECKS = Object.freeze([
	Object.freeze(["node", "--test", "tests/summary.test.mjs"]),
	Object.freeze(["node", "--test", "tests/acceptance.test.mjs"]),
]);
const BASELINE_OUTPUTS = Object.freeze({
	"src/summary.mjs": [
		"export function summarize(values) {",
		"\tvoid values;",
		"\treturn { count: 0, total: 0, average: null };",
		"}",
		"",
	].join("\n"),
	"tests/summary.test.mjs": [
		'import assert from "node:assert/strict";',
		'import { test } from "node:test";',
		'import { summarize } from "../src/summary.mjs";',
		"",
		'test("placeholder behavior will be replaced", () => {',
		"\tassert.deepEqual(summarize([1]), { count: -1, total: -1, average: -1 });",
		"});",
		"",
	].join("\n"),
});
const ACCEPTANCE_SOURCE = [
	'import assert from "node:assert/strict";',
	'import { test } from "node:test";',
	'import { summarize } from "../src/summary.mjs";',
	"",
	'test("qualification acceptance: finite values", () => {',
	"\tassert.deepEqual(summarize([2, 4, 6]), { count: 3, total: 12, average: 4 });",
	"});",
	"",
	'test("qualification acceptance: empty values", () => {',
	"\tassert.deepEqual(summarize([]), { count: 0, total: 0, average: null });",
	"});",
	"",
	'test("qualification acceptance: invalid values are excluded", () => {',
	'\tassert.deepEqual(summarize([2, Number.POSITIVE_INFINITY, "3", -1]), { count: 2, total: 1, average: 0.5 });',
	"});",
	"",
	'test("qualification acceptance: non-array input is rejected", () => {',
	"\tassert.throws(() => summarize(null), TypeError);",
	"});",
	"",
].join("\n");
const PROMPT = [
	"Implement the series summary in src/summary.mjs and replace the placeholder tests in tests/summary.test.mjs.",
	"Edit both files with your normal file tools. Keep the independent acceptance file and every other path untouched.",
	"Return count and total for finite numeric array values, and average as total/count or null for an empty accepted series.",
	"Reject non-array input with TypeError. Ignore strings, NaN, and infinities.",
	"The independent acceptance check covers normal, empty, filtered, and invalid-input cases.",
	"Do not add files or change any path other than the two declared files.",
].join("\n");
function sha(value) {
	return createHash("sha256").update(value).digest("hex");
}
export function fixtureDigest() {
	return (
		"sha256:" +
		sha(
			JSON.stringify({
				version: QUALIFICATION_FIXTURE_VERSION,
				baseline: BASELINE_OUTPUTS,
				acceptance: ACCEPTANCE_SOURCE,
				prompt: PROMPT,
				allowed: QUALIFICATION_FILES,
				checks: ACCEPTANCE_CHECKS,
			}),
		)
	);
}
export function qualificationPrompt() {
	return PROMPT;
}
export function createQualificationFixture(parentRoot) {
	const parent = realpathSync(parentRoot);
	const projectPath = join(parent, "fixture-project");
	mkdirSync(join(projectPath, "src"), { recursive: true, mode: 0o700 });
	mkdirSync(join(projectPath, "tests"), { recursive: true, mode: 0o700 });
	for (const [path, text] of Object.entries(BASELINE_OUTPUTS)) {
		writeFileSync(join(projectPath, path), text, { mode: 0o600, flag: "wx" });
	}
	writeFileSync(join(projectPath, ACCEPTANCE_FILE), ACCEPTANCE_SOURCE, {
		mode: 0o600,
		flag: "wx",
	});
	const git = (args) => {
		const result = spawnSync("git", ["-C", projectPath, ...args], {
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 16_384,
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (result.status !== 0) throw new Error("fixture_git_setup_failed");
		return result.stdout;
	};
	git(["init", "--quiet"]);
	git(["config", "user.name", "Switchyard Qualification"]);
	git(["config", "user.email", "qualification@localhost"]);
	git(["add", ...QUALIFICATION_FILES, ACCEPTANCE_FILE]);
	git(["commit", "--quiet", "-m", "qualification fixture baseline"]);
	// The VM queue run keeps its run store under <project>/.logs; exclude it
	// locally so the changed-path scope check sees only the provider's edits.
	appendFileSync(join(projectPath, ".git", "info", "exclude"), ".logs/\n");
	const verificationProjectPath = join(parent, "verification-base");
	const clone = spawnSync(
		"git",
		[
			"clone",
			"--quiet",
			"--no-local",
			"--no-hardlinks",
			"--",
			projectPath,
			verificationProjectPath,
		],
		{
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 16_384,
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	if (clone.status !== 0) throw new Error("fixture_git_setup_failed");
	return {
		projectPath,
		verificationProjectPath,
		baseCommit: git(["rev-parse", "HEAD"]).trim(),
		baseTree: git(["rev-parse", "HEAD^{tree}"]).trim(),
		promptPath: join(parent, "task.prompt"),
		taskPath: join(parent, "TASKS.md"),
		checkpointPath: join(parent, "checkpoint.json"),
		acceptancePath: join(projectPath, ACCEPTANCE_FILE),
		acceptanceSha256: `sha256:${sha(ACCEPTANCE_SOURCE)}`,
	};
}
