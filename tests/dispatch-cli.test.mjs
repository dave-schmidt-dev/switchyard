// Dispatch CLI argument-parsing test. Covers the validation the thin runQueue
// wrapper does before it ever touches Docker: required args, a real tasks file,
// a project that is an actual git repo (seedProject needs a committed HEAD),
// and numeric/flag coercion. No Docker required — parseDispatchArgs is pure
// validation, so the whole surface is exercised deterministically.

import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseDispatchArgs } from "../src/switchyard/dispatch/index.mjs";

let dir;
let tasksFile;
let projectDir;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "switchyard-dispatch-cli-"));
	tasksFile = join(dir, "tasks.md");
	writeFileSync(tasksFile, "## Phase 1\n", "utf8");
	projectDir = join(dir, "project");
	mkdirSync(join(projectDir, ".git"), { recursive: true });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("parseDispatchArgs", () => {
	it("parses a valid invocation with defaults", () => {
		const opts = parseDispatchArgs([tasksFile, "--project", projectDir]);
		strictEqual(opts.help, false);
		strictEqual(opts.tasksFilePath, tasksFile);
		strictEqual(opts.projectPath, projectDir);
		strictEqual(opts.maxTasks, Number.POSITIVE_INFINITY);
		strictEqual(opts.stopOnFailure, true);
		strictEqual(opts.checkpointPath, undefined);
	});

	it("returns help:true for --help without requiring other args", () => {
		deepStrictEqual(parseDispatchArgs(["--help"]), { help: true });
	});

	it("honors --max-tasks, --checkpoint, and --no-stop-on-failure", () => {
		const checkpoint = join(dir, "cp.json");
		const opts = parseDispatchArgs([
			tasksFile,
			"--project",
			projectDir,
			"--max-tasks",
			"3",
			"--checkpoint",
			checkpoint,
			"--no-stop-on-failure",
		]);
		strictEqual(opts.maxTasks, 3);
		strictEqual(opts.checkpointPath, checkpoint);
		strictEqual(opts.stopOnFailure, false);
	});

	it("throws when the tasks positional is missing", () => {
		throws(
			() => parseDispatchArgs(["--project", projectDir]),
			/missing <tasks\.md>/,
		);
	});

	it("throws when --project is missing", () => {
		throws(
			() => parseDispatchArgs([tasksFile]),
			/--project <path> is required/,
		);
	});

	it("throws when the tasks file does not exist", () => {
		throws(
			() => parseDispatchArgs([join(dir, "nope.md"), "--project", projectDir]),
			/tasks file not found/,
		);
	});

	it("throws when --project is not a git repository", () => {
		const bare = join(dir, "not-a-repo");
		mkdirSync(bare, { recursive: true });
		throws(
			() => parseDispatchArgs([tasksFile, "--project", bare]),
			/not a git repository/,
		);
	});

	it("throws when --max-tasks is not a positive integer", () => {
		for (const bad of ["0", "-1", "abc"]) {
			// Equals form
			throws(
				() =>
					parseDispatchArgs([
						tasksFile,
						"--project",
						projectDir,
						`--max-tasks=${bad}`,
					]),
				/(--max-tasks must be a positive integer|Option '--max-tasks' argument is ambiguous)/,
			);
			// Space form
			throws(
				() =>
					parseDispatchArgs([
						tasksFile,
						"--project",
						projectDir,
						"--max-tasks",
						bad,
					]),
				/(--max-tasks must be a positive integer|Option '--max-tasks' argument is ambiguous)/,
			);
		}
	});
});
