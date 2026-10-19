// @test-phase: other
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readEvents, readRun } from "../src/switchyard/run-store/index.mjs";
import {
	dryRunAcceptanceChecks,
	existsInCheckout,
} from "../src/switchyard/simple/check-dry-run.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { git, repoFixture } from "./helpers/check-dry-run-repo.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const suite = tempDir("switchyard-check-dry-run-new-file-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suite, "runs");

const NEW_SCRIPT = "tests/new-test.sh";
const missing = { success: false, code: 127, writerLifecycle: "stopped" };
const passed = { success: true, code: 0, writerLifecycle: "stopped" };

/** Dry run whose checks report exit 127, as a missing script does, unless `outcome` says otherwise. */
function dryRun(checks, extra = {}, outcome = () => missing) {
	const ran = [];
	return {
		ran,
		done: dryRunAcceptanceChecks({
			checks,
			runCheck: async ({ command }) => {
				ran.push(command);
				return outcome(command);
			},
			deadlineMs: 10_000_000,
			now: () => 0,
			...extra,
		}),
	};
}

const absentAtBase = () => false;

// -- dryRunAcceptanceChecks (injected runCheck) --------------------------------

test("a declared script absent from the base tree is red at baseline, not an environment failure", async () => {
	// The later check fails plainly; the run must reach it after the exempted one.
	const run = dryRun(
		[`bash ${NEW_SCRIPT}`, "later-check"],
		{ declaredPaths: ["a.txt", NEW_SCRIPT], pathExistsAtBase: absentAtBase },
		(command) =>
			command === "later-check" ? { ...missing, code: 1 } : missing,
	);
	const result = await run.done;
	strictEqual(result.status, "passed");
	deepStrictEqual(result.redAtBaseline, [1, 2]);
	deepStrictEqual(run.ran, [`bash ${NEW_SCRIPT}`, "later-check"]);
});

test("each way of running a declared new script is recognized", async () => {
	for (const command of [
		`bash ${NEW_SCRIPT}`,
		`sh ${NEW_SCRIPT}`,
		`zsh ${NEW_SCRIPT}`,
		`bash ./${NEW_SCRIPT}`,
		`bash ${NEW_SCRIPT} --verbose one two`,
		`./${NEW_SCRIPT}`,
		NEW_SCRIPT,
		"node tests/new-test.sh",
		"python3 tests/new-test.sh",
		".venv/bin/python tests/new-test.sh",
		"./.venv/bin/python3 tests/new-test.sh",
	]) {
		const result = await dryRun([command], {
			declaredPaths: [NEW_SCRIPT],
			pathExistsAtBase: absentAtBase,
		}).done;
		strictEqual(result.status, "passed", command);
		deepStrictEqual(result.redAtBaseline, [1], command);
	}
});

test("an undeclared absent script still stops with tool_missing", async () => {
	const run = dryRun(
		["true", `bash ${NEW_SCRIPT}`, "never-reached"],
		{
			declaredPaths: ["a.txt", "tests/other.sh"],
			pathExistsAtBase: absentAtBase,
		},
		(command) => (command === "true" ? passed : missing),
	);
	const result = await run.done;
	strictEqual(result.status, "environment_failed");
	strictEqual(result.signature, "tool_missing");
	strictEqual(result.checkIndex, 2);
	deepStrictEqual(run.ran, ["true", `bash ${NEW_SCRIPT}`]);
});

test("without declared paths the dry run behaves as before", async () => {
	const result = await dryRun([`bash ${NEW_SCRIPT}`], {
		pathExistsAtBase: absentAtBase,
	}).done;
	strictEqual(result.status, "environment_failed");
	strictEqual(result.signature, "tool_missing");
	// Declared paths alone, with no way to know absence, exempt nothing.
	const unknown = await dryRun([`bash ${NEW_SCRIPT}`], {
		declaredPaths: [NEW_SCRIPT],
	}).done;
	strictEqual(unknown.status, "environment_failed");
	strictEqual(unknown.signature, "tool_missing");
});

test("a declared script that exists in the base tree and fails tool_missing still stops", async () => {
	const result = await dryRun([`bash ${NEW_SCRIPT}`], {
		declaredPaths: [NEW_SCRIPT],
		pathExistsAtBase: (path) => path === NEW_SCRIPT,
	}).done;
	strictEqual(result.status, "environment_failed");
	strictEqual(result.signature, "tool_missing");
	strictEqual(result.checkIndex, 1);
});

test("only tool_missing is exempted for a declared absent script", async () => {
	const declared = {
		declaredPaths: [NEW_SCRIPT],
		pathExistsAtBase: absentAtBase,
	};
	for (const [signature, outcome] of [
		["exec_denied", { ...missing, code: 126 }],
		[
			"sandbox_denial",
			{
				...missing,
				code: 1,
				stderr: "Sandbox: sh(4) deny(1) file-write-create /x",
			},
		],
	]) {
		const result = await dryRun([`bash ${NEW_SCRIPT}`], declared, () => outcome)
			.done;
		strictEqual(result.status, "environment_failed", signature);
		strictEqual(result.signature, signature);
	}
	// A plain failure of the same command is red at baseline either way.
	const plain = await dryRun([`bash ${NEW_SCRIPT}`], declared, () => ({
		...missing,
		code: 1,
	})).done;
	deepStrictEqual(plain.redAtBaseline, [1]);
});

test("commands that do not plainly run a declared relative script keep the stop", async () => {
	for (const command of [
		// Shell syntax: what actually ran is not the script word.
		`bash ${NEW_SCRIPT} && true`,
		`true; bash ${NEW_SCRIPT}`,
		`sh -c "bash ${NEW_SCRIPT}"`,
		`bash '${NEW_SCRIPT}'`,
		`bash $(echo ${NEW_SCRIPT})`,
		`bash ${NEW_SCRIPT} | cat`,
		`bash ${NEW_SCRIPT} > out.txt`,
		`test ! -e ${NEW_SCRIPT} || bash ${NEW_SCRIPT}`,
		// A flag, not a script, follows the interpreter.
		`bash -x ${NEW_SCRIPT}`,
		`node --test ${NEW_SCRIPT}`,
		// Not a repo-relative path inside the tree.
		`bash /abs/${NEW_SCRIPT}`,
		`bash ../${NEW_SCRIPT}`,
		`bash tests/../${NEW_SCRIPT}`,
		`/abs/${NEW_SCRIPT}`,
		// A bare word is a PATH lookup, not the declared file.
		"new-test.sh",
		"bash",
		"bash ",
		"",
		// An unlisted program does not make its argument the script.
		`env bash ${NEW_SCRIPT}`,
		`timeout 5 bash ${NEW_SCRIPT}`,
		`npm run ${NEW_SCRIPT}`,
		// A leading assignment is environment, not the script, and can hide the
		// interpreter (PATH=...) so the shell itself exits 127.
		"PATH=tests/nonexistent-bin bash tests/existing.sh",
		`PATH=tests/nonexistent-bin ./${NEW_SCRIPT}`,
		`FOO=tests/new-test.sh bash ${NEW_SCRIPT}`,
	]) {
		const result = await dryRun([command], {
			declaredPaths: [
				NEW_SCRIPT,
				"new-test.sh",
				"tests/../tests/new-test.sh",
				"PATH=tests/nonexistent-bin",
				"FOO=tests/new-test.sh",
			],
			pathExistsAtBase: absentAtBase,
		}).done;
		strictEqual(result.status, "environment_failed", JSON.stringify(command));
		strictEqual(result.signature, "tool_missing", JSON.stringify(command));
	}
});

// -- existsInCheckout ---------------------------------------------------------

test("existsInCheckout reports only a definite absence as absent", () => {
	const root = tempDir("switchyard-check-dry-run-new-file-root-");
	mkdirSync(join(root, "tests"));
	writeFileSync(join(root, "tests", "present.sh"), "exit 0\n");
	symlinkSync("nowhere", join(root, "tests", "dangling.sh"));
	const exists = existsInCheckout(root);
	strictEqual(exists("tests/present.sh"), true);
	strictEqual(exists("tests"), true);
	strictEqual(exists("tests/dangling.sh"), true);
	strictEqual(exists(NEW_SCRIPT), false);
	strictEqual(exists("nodir/new-test.sh"), false);
	strictEqual(exists("tests/present.sh/under-a-file.sh"), false);
});

// -- runSimpleTask with the real sandboxed check session ------------------------

const sandboxed = existsSync("/usr/bin/sandbox-exec");

const newScriptProvider = async ({ worktreePath }) => {
	mkdirSync(join(worktreePath, "tests"), { recursive: true });
	writeFileSync(join(worktreePath, NEW_SCRIPT), "exit 0\n");
	return { success: true, writerLifecycle: "stopped" };
};

async function runTask(repo, options, provider = newScriptProvider) {
	let providerCalls = 0;
	const result = await runSimpleTask(
		{
			...repo,
			capability: "standard",
			files: ["a.txt", NEW_SCRIPT],
			allowManifests: [NEW_SCRIPT],
			checks: [`bash ${NEW_SCRIPT}`],
			deadlineMs: Date.now() + 180_000,
			...options,
		},
		{
			tmpdir: repo.root,
			route: () => ({ provider: "Codex (Spark)", reason: "priority_fill" }),
			resolveTargetIdentity: () => ({
				targetId: "codex",
				harnessKey: "codex",
				ambiguous: false,
			}),
			getInvocationDescriptor: () => ({
				target_id: "codex",
				selector: "gpt-5.3-codex-spark",
				invocation_args: [],
			}),
			assertFundedRoute: () => {},
			executeProvider: async (context) => {
				providerCalls += 1;
				return provider(context);
			},
		},
	);
	return { result, providerCalls };
}

test("a task whose check runs a script the task creates reaches the provider and must still pass", {
	skip: !sandboxed,
}, async () => {
	const repo = repoFixture();
	const { result, providerCalls } = await runTask(repo);
	strictEqual(providerCalls, 1);
	strictEqual(result.status, "succeeded");
	strictEqual(result.checks[0].status, "passed");
	const finished = (await readEvents(result.runId)).find(
		(event) => event.milestone === "dry_run_check_finished",
	);
	strictEqual(finished.checkStatus, "failed", "the dry run ran the check");
	// Acceptance is unchanged: the script was absent for the dry run, but a
	// provider that creates it broken still fails the check afterwards.
	const broken = await runTask(repoFixture(), {}, async (context) => {
		await newScriptProvider(context);
		writeFileSync(join(context.worktreePath, NEW_SCRIPT), "exit 1\n");
		return { success: true, writerLifecycle: "stopped" };
	});
	ok(broken.providerCalls >= 1, "the provider still started");
	strictEqual(broken.result.status, "failed");
	strictEqual(broken.result.failureReason, "check_failed");
});

test("an undeclared missing script or a present broken one stops before the provider", {
	skip: !sandboxed,
}, async () => {
	const repo = repoFixture();
	const undeclared = await runTask(repo, {
		files: ["a.txt"],
		allowManifests: [],
	});
	strictEqual(undeclared.providerCalls, 0);
	strictEqual(undeclared.result.failureReason, "check_environment_failed");
	strictEqual(
		(await readRun(undeclared.result.runId)).failureDetails
			.checkEnvironmentSignature,
		"tool_missing",
	);

	const present = repoFixture();
	mkdirSync(join(present.projectPath, "tests"));
	writeFileSync(join(present.projectPath, NEW_SCRIPT), "exit 127\n");
	git(present.projectPath, ["add", "."]);
	git(present.projectPath, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"script",
	]);
	const broken = await runTask(present);
	strictEqual(broken.providerCalls, 0);
	strictEqual(broken.result.failureReason, "check_environment_failed");
	strictEqual(
		(await readRun(broken.result.runId)).failureDetails
			.checkEnvironmentSignature,
		"tool_missing",
	);
});
