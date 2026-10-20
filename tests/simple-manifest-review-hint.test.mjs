// @test-phase: other
// A `manifest_review_required` refusal names the `--allow-manifest` flag that
// resolves it, in the result's `hint` and one stderr line, while every machine
// code stays unchanged.
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import { parseSimpleArgs } from "../src/switchyard/simple/args.mjs";
import { manifestReviewHint } from "../src/switchyard/simple/declared-diff.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import { fixture as routingFixture } from "./helpers/simple-routing-fixture.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const suite = tempDir("switchyard-manifest-review-hint-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suite, "runs");

function git(path, args) {
	return execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
}

function fixture() {
	const root = tempDir("switchyard-manifest-review-hint-repo-");
	const projectPath = join(root, "project");
	mkdirSync(projectPath);
	writeFileSync(join(projectPath, "a.txt"), "base\n");
	writeFileSync(join(projectPath, "package.json"), "{}\n");
	git(projectPath, ["init", "-q"]);
	git(projectPath, ["add", "."]);
	git(projectPath, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"fixture",
	]);
	const promptPath = join(root, "prompt");
	writeFileSync(promptPath, "Change package.json");
	return { root, projectPath, promptPath };
}

async function refuseManifest(manifest) {
	const repo = fixture();
	const warnings = [];
	let executions = 0;
	const result = await runSimpleTask(
		{
			...repo,
			capability: "standard",
			files: ["a.txt", manifest],
			checks: ["test -f a.txt"],
			deadlineMs: Date.now() + 120_000,
		},
		{
			tmpdir: repo.root,
			onRoutingWarning: (line) => warnings.push(line),
			executeProvider: async () => {
				executions += 1;
				return { success: true, writerLifecycle: "stopped" };
			},
		},
	);
	strictEqual(executions, 0);
	return { result, warnings };
}

test("an unreviewed declared manifest names --allow-manifest in the hint and on stderr", async () => {
	const { result, warnings } = await refuseManifest("package.json");
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "manifest_review_required");
	strictEqual(result.failurePhase, "input_validation");
	strictEqual(result.errorKind, "validation_failed");
	strictEqual(result.diffRejection.rule, "manifest_review_required");
	deepStrictEqual(result.diffRejection.paths, ["package.json"]);
	strictEqual(
		result.hint,
		"review the change to package.json, then rerun with --allow-manifest=package.json to allow it",
	);
	deepStrictEqual(
		warnings.filter((line) => line.includes("manifest review")),
		[`dispatch: manifest review required: ${result.hint}`],
	);
});

test("the hint names a manifest path past the persisted bound exactly", async () => {
	const manifest = `${"d/".repeat(103)}package.json`;
	const { result } = await refuseManifest(manifest);
	strictEqual(result.failureReason, "manifest_review_required");
	strictEqual(result.diffRejection.paths[0].length, 200);
	ok(result.hint.includes(` --allow-manifest=${manifest} `));
});

test("the hint names exact paths, shell-quoted, and counts the ones it cannot name", () => {
	strictEqual(
		manifestReviewHint(["Makefile", "pkg dir/package.json", "it's/go.mod"]),
		"review the change to Makefile, pkg dir/package.json, it's/go.mod, then rerun with --allow-manifest=Makefile --allow-manifest='pkg dir/package.json' --allow-manifest='it'\\''s/go.mod' to allow it",
	);
	// Past the persisted 200-character bound, the flag still names the path.
	const long = `${"d/".repeat(103)}go.mod`;
	strictEqual(long.length, 212);
	ok(manifestReviewHint([long]).includes(`--allow-manifest=${long} `));
	// A control character is never printed; that path is only counted.
	strictEqual(
		manifestReviewHint([
			"a.sh",
			"b\u001b[2Jc.sh",
			"c.sh",
			"d.sh",
			"e.sh",
			"f.sh",
			"g.sh",
		]),
		"review the change to a.sh, c.sh, d.sh, e.sh, f.sh and 2 more, then rerun with --allow-manifest=a.sh --allow-manifest=c.sh --allow-manifest=d.sh --allow-manifest=e.sh --allow-manifest=f.sh to allow it",
	);
	ok(!manifestReviewHint(["package.json"]).includes("more"));
	strictEqual(
		manifestReviewHint(["\u202e.sh"]),
		"review the 1 changed manifest, then rerun with --allow-manifest=<path> for each one to allow it",
	);
	strictEqual(
		manifestReviewHint(["\u202e.sh", "b\u0007.sh"]),
		"review the 2 changed manifests, then rerun with --allow-manifest=<path> for each one to allow it",
	);
});

test("the suggested flag parses back to the exact declared path", () => {
	const repo = fixture();
	for (const path of ["-task.sh", "pkg dir/package.json"]) {
		mkdirSync(join(repo.projectPath, dirname(path)), { recursive: true });
		writeFileSync(join(repo.projectPath, path), "x\n");
		const flag = manifestReviewHint([path]).match(
			/--allow-manifest=('(?:[^']|'\\'')*'|\S+)/u,
		)[1];
		const value = flag.startsWith("'")
			? flag.slice(1, -1).replaceAll("'\\''", "'")
			: flag;
		const parsed = parseSimpleArgs([
			repo.promptPath,
			"--project",
			repo.projectPath,
			"--capability",
			"standard",
			`--file=${path}`,
			`--allow-manifest=${value}`,
			"--check",
			"true",
			"--timeout",
			"30",
		]);
		deepStrictEqual(parsed.allowManifests, [path]);
	}
});

test("the routing answer the CLI prints keeps the engine hint", async () => {
	const hint = manifestReviewHint(["package.json"]);
	const f = routingFixture({
		"antigravity-claude": {
			status: "failed",
			result: {
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "input_rejected",
					phase: "input_validation",
				}),
				failureReason: "manifest_review_required",
				failurePhase: "input_validation",
				errorKind: "validation_failed",
				hint,
			},
		},
	});
	const routing = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(routing.direction, "stop");
	strictEqual(routing.result.failureReason, "manifest_review_required");
	strictEqual(routing.result.hint, hint);
});
