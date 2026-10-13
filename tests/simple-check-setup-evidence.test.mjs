import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sanitizeFailureDetails } from "../src/switchyard/adapter/exec-error.mjs";
import { resolveFailure } from "../src/switchyard/diagnostics/failure-registry.mjs";
import { readRun } from "../src/switchyard/run-store/index.mjs";
import { createSimpleCheckSessions } from "../src/switchyard/simple/check-session.mjs";
import { npmCiFailureDetails } from "../src/switchyard/simple/check-setup-evidence.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { nestedSandboxSkip } from "./helpers/nested-sandbox.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const sandboxSkip =
	process.platform !== "darwin" ||
	!existsSync("/usr/bin/sandbox-exec") ||
	!existsSync("/opt/homebrew/bin/npm")
		? "requires macOS sandbox-exec and Homebrew npm"
		: nestedSandboxSkip;

function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

function commit(project) {
	git(project, ["init", "-q"]);
	git(project, ["add", "."]);
	git(project, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"base",
	]);
}

function session(project, options = {}) {
	return createSimpleCheckSessions({
		taskRoot: tempDir("switchyard-setup-evidence-task-"),
		projectPath: project,
		baseRevision: git(project, ["rev-parse", "HEAD"]),
		baseTree: git(project, ["rev-parse", "HEAD^{tree}"]),
		files: ["a.txt"],
		commands: [],
		taskId: "setup-evidence",
		deadlineMs: Date.now() + 180_000,
		...options,
	});
}

// An npm project whose lockfile names a package no cold cache can supply, so
// the sandboxed offline `npm ci` setup always fails.
function writeUnresolvableNpmProject(project) {
	writeFileSync(
		join(project, "package.json"),
		JSON.stringify({
			name: "fixture",
			version: "1.0.0",
			dependencies: { "fixture-tool": "1.0.0" },
		}),
	);
	writeFileSync(
		join(project, "package-lock.json"),
		JSON.stringify({
			name: "fixture",
			version: "1.0.0",
			lockfileVersion: 3,
			packages: {
				"": {
					name: "fixture",
					version: "1.0.0",
					dependencies: { "fixture-tool": "1.0.0" },
				},
				"node_modules/fixture-tool": {
					version: "1.0.0",
					resolved:
						"https://registry.npmjs.org/fixture-tool/-/fixture-tool-1.0.0.tgz",
					integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
				},
			},
		}),
	);
}

describe("path dependency drift refusal", { skip: sandboxSkip }, () => {
	it("names path_dependency_changed once an accepted dependency is swapped", async () => {
		const root = tempDir("switchyard-setup-evidence-drift-");
		const project = join(root, "project");
		const sibling = join(root, "sibling");
		mkdirSync(project);
		mkdirSync(sibling);
		writeFileSync(
			join(project, "pyproject.toml"),
			'[tool.uv.sources]\nsibling = { path = "../sibling", editable = true }\n',
		);
		commit(project);
		const checks = session(project);
		try {
			await checks.prepare();
			strictEqual((await checks.run({ command: "true" })).code, 0);
			renameSync(sibling, `${sibling}-moved`);
			symlinkSync(tempDir("switchyard-setup-evidence-outside-"), sibling);
			await rejects(checks.run({ command: "true" }), {
				code: "check_dependencies_unverified",
				dependencyCheck: "path_dependency_changed",
			});
		} finally {
			checks.remove();
		}
	});
});

describe("npm ci setup failure evidence", () => {
	const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

	it("keeps a redacted tail and names a recognised environment signature", () => {
		const evidenceDir = join(tempDir("switchyard-setup-evidence-"), "evidence");
		const details = npmCiFailureDetails(
			{
				success: false,
				code: 1,
				output: `npm error auth ${token}\n`,
				stderr: "node: OpenSSL configuration error: Operation not permitted\n",
			},
			evidenceDir,
		);
		strictEqual(details.dependencyCheck, "npm_ci_failed");
		strictEqual(details.outputPath, join(evidenceDir, "setup-0.log"));
		strictEqual(details.checkEnvironmentSignature, "sandbox_denial");
		const text = readFileSync(details.outputPath, "utf8");
		ok(text.includes("OpenSSL configuration error"), "diagnostic tail kept");
		ok(!text.includes(token), "credential-shaped token redacted");
		strictEqual(statSync(details.outputPath).mode & 0o777, 0o600);
		ok(
			!JSON.stringify(details).includes("OpenSSL"),
			"the details carry a path and a signature, never output bytes",
		);
	});

	it("keeps the tail but no signature for a plain npm ci failure", () => {
		const evidenceDir = join(tempDir("switchyard-setup-evidence-"), "evidence");
		const details = npmCiFailureDetails(
			{
				success: false,
				code: 1,
				output: "npm error code ENOTCACHED\n",
				stderr: "",
			},
			evidenceDir,
		);
		deepStrictEqual(Object.keys(details).sort(), [
			"dependencyCheck",
			"outputPath",
		]);
		ok(readFileSync(details.outputPath, "utf8").includes("ENOTCACHED"));
	});

	it("never lets missing or failing evidence storage change the refusal", () => {
		const failing = { success: false, code: 127, output: "", stderr: "" };
		deepStrictEqual(npmCiFailureDetails(failing, null), {
			dependencyCheck: "npm_ci_failed",
			checkEnvironmentSignature: "tool_missing",
		});
		const blocker = join(tempDir("switchyard-setup-evidence-"), "file");
		writeFileSync(blocker, "not a directory\n");
		deepStrictEqual(npmCiFailureDetails(failing, join(blocker, "evidence")), {
			dependencyCheck: "npm_ci_failed",
			checkEnvironmentSignature: "tool_missing",
		});
	});

	it("classifies neither a timeout nor a process that succeeded", () => {
		const evidenceDir = join(tempDir("switchyard-setup-evidence-"), "evidence");
		const output = "Operation not permitted\n";
		const timedOut = npmCiFailureDetails(
			{ success: false, code: null, timedOut: true, output, stderr: "" },
			evidenceDir,
		);
		ok(!("checkEnvironmentSignature" in timedOut), "a hang is not proof");
		ok(existsSync(timedOut.outputPath), "the timed-out tail is still kept");
		const other = join(tempDir("switchyard-setup-evidence-"), "evidence");
		deepStrictEqual(
			npmCiFailureDetails(
				{ success: true, code: 0, output, stderr: "" },
				other,
			),
			{ dependencyCheck: "npm_ci_failed" },
		);
		strictEqual(existsSync(other), false, "no failure output to keep");
	});

	it("records setup evidence in a real sandboxed npm ci refusal", {
		skip: sandboxSkip,
	}, async () => {
		const root = tempDir("switchyard-setup-evidence-npm-");
		const project = join(root, "project");
		const cache = join(root, "cold-cache");
		const evidenceDir = join(root, "evidence");
		mkdirSync(project);
		mkdirSync(cache);
		writeFileSync(join(project, "a.txt"), "base\n");
		writeUnresolvableNpmProject(project);
		commit(project);
		const checks = session(project, {
			commands: ["node --version"],
			cachePath: cache,
			evidenceDir,
		});
		try {
			await rejects(checks.prepare(), (error) => {
				strictEqual(error.code, "check_dependencies_unverified");
				strictEqual(error.dependencyCheck, "npm_ci_failed");
				strictEqual(error.checkSetupStep, "provision_dependencies");
				strictEqual(error.outputPath, join(evidenceDir, "setup-0.log"));
				ok(existsSync(error.outputPath), "evidence file written");
				ok(!error.message.includes(evidenceDir), "message carries no path");
				return true;
			});
		} finally {
			checks.remove();
		}
	});
});

describe("npm ci setup refusal in run.json", () => {
	it("persists the evidence path, step and cause through a simple task", {
		skip: sandboxSkip,
	}, async () => {
		const root = tempDir("switchyard-setup-evidence-run-");
		process.env.SWITCHYARD_RUN_STORE_ROOT = join(root, "runs");
		const project = join(root, "project");
		const cache = join(root, "cold-cache");
		mkdirSync(project);
		mkdirSync(cache);
		writeFileSync(join(project, "a.txt"), "base\n");
		writeUnresolvableNpmProject(project);
		commit(project);
		const promptPath = join(root, "prompt");
		writeFileSync(promptPath, "Change a.txt");
		let providerCalls = 0;
		const result = await runSimpleTask(
			{
				projectPath: project,
				promptPath,
				capability: "standard",
				files: ["a.txt"],
				checks: ["node --version"],
				deadlineMs: Date.now() + 180_000,
			},
			{
				tmpdir: root,
				checkCachePath: cache,
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
				executeProvider: async () => {
					providerCalls += 1;
					return { success: true, writerLifecycle: "stopped" };
				},
			},
		);
		strictEqual(providerCalls, 0);
		strictEqual(result.status, "failed");
		strictEqual(result.failureReason, "check_dependencies_unverified");
		const details = (await readRun(result.runId)).failureDetails;
		strictEqual(details.dependencyCheck, "npm_ci_failed");
		strictEqual(details.checkSetupStep, "provision_dependencies");
		ok(details.outputPath.endsWith("/check-evidence/setup-0.log"));
		ok(existsSync(details.outputPath), "evidence file written");
	});
});

describe("setup refusal record", () => {
	it("persists the step, evidence path and signature on a dependency refusal", () => {
		const detailFields = resolveFailure({
			reason: "check_dependencies_unverified",
			phase: "prepare",
		}).detailFields;
		const raw = {
			failureReason: "check_dependencies_unverified",
			dependencyCheck: "npm_ci_failed",
			checkSetupStep: "provision_dependencies",
			outputPath: "/tmp/evidence/setup-0.log",
			checkEnvironmentSignature: "sandbox_denial",
			checkSetupErrorCode: "EACCES",
		};
		const selected = Object.fromEntries(
			detailFields.filter((field) => field in raw).map((f) => [f, raw[f]]),
		);
		deepStrictEqual(sanitizeFailureDetails(selected), selected);
		ok(!("checkSetupErrorCode" in selected), "other setup fields stay out");
	});
});
