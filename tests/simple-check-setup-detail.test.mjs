import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, isAbsolute, join } from "node:path";
import { test } from "node:test";
import {
	isPersistentFailureDetails,
	isPersistentFailureMetadata,
	sanitizeFailureDetails,
	sanitizeFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";
import { resolveFailure } from "../src/switchyard/diagnostics/failure-registry.mjs";
import { readRun } from "../src/switchyard/run-store/index.mjs";
import { dryRunAcceptanceChecks } from "../src/switchyard/simple/check-dry-run.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const suite = tempDir("switchyard-check-setup-detail-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suite, "runs");
// The host git config location is not guaranteed readable in every runner.
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const sandboxProbe =
	process.platform === "darwin" && existsSync(SANDBOX_EXEC)
		? spawnSync(
				SANDBOX_EXEC,
				["-p", "(version 1)(allow default)", "/usr/bin/true"],
				{ timeout: 10_000 },
			)
		: null;
const sandboxSkip =
	sandboxProbe?.status === 0 ? false : "requires a usable macOS sandbox-exec";

const SETUP_ERROR_MESSAGE_CANARY = "fixture-spawn-message-canary";

function git(path, args) {
	return execFileSync("git", args, {
		cwd: path,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		},
	}).trim();
}

function repoFixture() {
	const root = tempDir("switchyard-check-setup-detail-repo-");
	const projectPath = join(root, "project");
	mkdirSync(projectPath);
	writeFileSync(join(projectPath, "a.txt"), "base\n");
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
	writeFileSync(promptPath, "Change a.txt");
	return { root, projectPath, promptPath };
}

function taskDependencies(repo, onProvider) {
	return {
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
		executeProvider: async () => {
			onProvider?.();
			return { success: true, writerLifecycle: "stopped" };
		},
	};
}

// The first git spawn inside the check session's own root is the checker
// clone. Throwing there simulates a spawn error the prepare step cannot wrap.
async function runSetupFailure({
	code,
	syscall = "spawnSync git",
	path = "/usr/bin/git",
}) {
	const repo = repoFixture();
	const cp = createRequire(import.meta.url)("node:child_process");
	const original = cp.spawnSync;
	let providerCalls = 0;
	cp.spawnSync = (command, args, options) => {
		if (
			command === "git" &&
			typeof options?.cwd === "string" &&
			options.cwd.includes("/checker-")
		) {
			throw Object.assign(new Error(SETUP_ERROR_MESSAGE_CANARY), {
				code,
				syscall,
				path,
			});
		}
		return original(command, args, options);
	};
	syncBuiltinESMExports();
	try {
		const result = await runSimpleTask(
			{
				...repo,
				capability: "standard",
				files: ["a.txt"],
				checks: ["test -f a.txt"],
				deadlineMs: Date.now() + 180_000,
			},
			taskDependencies(repo, () => {
				providerCalls += 1;
			}),
		);
		return { result, run: await readRun(result.runId), providerCalls };
	} finally {
		cp.spawnSync = original;
		syncBuiltinESMExports();
	}
}

test("a prepare step that throws ENOENT records the step, code, syscall and executable", async () => {
	const { result, run, providerCalls } = await runSetupFailure({
		code: "ENOENT",
	});
	strictEqual(providerCalls, 0);
	strictEqual(result.status, "failed");
	strictEqual(result.failurePhase, "prepare");
	strictEqual(result.failureReason, "ENOENT");
	strictEqual(result.providerReliability.causeCode, "check_setup_failed");
	const details = run.failureDetails;
	ok(details, "run.json carries failureDetails");
	strictEqual(details.checkSetupStep, "clone_checkout");
	strictEqual(details.checkSetupErrorCode, "ENOENT");
	strictEqual(details.checkSetupSyscall, "spawnSync");
	strictEqual(details.checkSetupExecutable, "git");
	ok(
		!JSON.stringify(details).includes(SETUP_ERROR_MESSAGE_CANARY),
		"failureDetails never carries the thrown message",
	);
	ok(isPersistentFailureDetails(details));
	strictEqual("checkSetupStep" in run.lastFailure, false);
	strictEqual("checkSetupErrorCode" in run.lastFailure, false);
	strictEqual("checkSetupExecutable" in run.lastFailure, false);
	ok(isPersistentFailureMetadata(run.lastFailure));
});

test("the terminal result carries the same durable failureDetails as run.json", async () => {
	const { result, run } = await runSetupFailure({ code: "ENOENT" });
	strictEqual(result.status, "failed");
	ok(result.failureDetails, "terminal result carries failureDetails");
	deepStrictEqual(result.failureDetails, run.failureDetails);
	strictEqual(result.failureDetails.checkSetupStep, "clone_checkout");
	ok(isPersistentFailureDetails(result.failureDetails));
	ok(
		!JSON.stringify(result.failureDetails).includes(SETUP_ERROR_MESSAGE_CANARY),
		"terminal failureDetails never carries the thrown message",
	);
});

test("a cancelled provider result persists its resolved cancel source", async () => {
	const repo = repoFixture();
	let providerCalls = 0;
	const result = await runSimpleTask(
		{
			...repo,
			capability: "standard",
			files: ["a.txt"],
			checks: [],
			deadlineMs: Date.now() + 180_000,
		},
		{
			...taskDependencies(repo, () => {
				providerCalls += 1;
			}),
			executeProvider: async () => {
				providerCalls += 1;
				return {
					success: false,
					code: null,
					signal: "SIGTERM",
					timedOut: false,
					cancelled: true,
					cancelSource: "signal_sigterm",
					writerLifecycle: "stopped",
				};
			},
		},
	);
	strictEqual(providerCalls, 1);
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "provider_cancelled");
	strictEqual(result.providerReliability.causeCode, "cancelled");
	const run = await readRun(result.runId);
	strictEqual(run.failureDetails.cancelSource, "signal_sigterm");
	strictEqual(run.failureDetails.cancelled, true);
	deepStrictEqual(result.failureDetails, run.failureDetails);
});

test("a credential-shaped provider cancel source never reaches run.json", async () => {
	const repo = repoFixture();
	const canary = "sk-live-5f2c9d-credential";
	const result = await runSimpleTask(
		{
			...repo,
			capability: "standard",
			files: ["a.txt"],
			checks: [],
			deadlineMs: Date.now() + 180_000,
		},
		{
			...taskDependencies(repo),
			executeProvider: async () => ({
				success: false,
				code: null,
				signal: null,
				timedOut: false,
				cancelled: true,
				cancelSource: canary,
				writerLifecycle: "stopped",
			}),
		},
	);
	strictEqual(result.status, "failed");
	const run = await readRun(result.runId);
	strictEqual(run.failureDetails.cancelSource, "unspecified");
	ok(!JSON.stringify(run.failureDetails).includes(canary));
	deepStrictEqual(result.failureDetails, run.failureDetails);
});

test("a readiness refusal names the second failing command without its argv", {
	skip: sandboxSkip,
}, async () => {
	const repo = repoFixture();
	const argvCanary = "--switchyard-argv-canary";
	let providerCalls = 0;
	const result = await runSimpleTask(
		{
			...repo,
			capability: "standard",
			files: ["a.txt"],
			checks: ["test -f a.txt", `switchyard_missing_check_tool ${argvCanary}`],
			deadlineMs: Date.now() + 180_000,
		},
		taskDependencies(repo, () => {
			providerCalls += 1;
		}),
	);
	strictEqual(providerCalls, 0, "no provider ran before the refusal");
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "check_environment_unavailable");
	strictEqual(result.failurePhase, "prepare");
	strictEqual(result.providerReliability.causeCode, "check_setup_failed");
	const run = await readRun(result.runId);
	const details = run.failureDetails;
	ok(details, "run.json carries failureDetails");
	strictEqual(details.checkSetupStep, "validate_commands");
	strictEqual(details.checkIndex, 2);
	strictEqual(details.checkSetupExecutable, "switchyard_missing_check_tool");
	ok(!JSON.stringify(details).includes(argvCanary));
	deepStrictEqual(result.failureDetails, run.failureDetails);
});

test("a setup error code outside the bound is dropped, not persisted", async () => {
	const { result, run } = await runSetupFailure({ code: "ENOENT/../escape" });
	strictEqual(result.providerReliability.causeCode, "check_setup_failed");
	const details = run.failureDetails;
	ok(details, "run.json carries failureDetails");
	strictEqual("checkSetupErrorCode" in details, false);
	ok(isPersistentFailureDetails(details));
});

test("the details boundary drops out-of-bound setup error codes", () => {
	for (const code of [
		"ENOENT with spaces",
		"ENOENT/../escape",
		"ENOENT;rm",
		"ENOENT!",
		"ENOENT\u0000",
		"e".repeat(65),
	]) {
		strictEqual(
			sanitizeFailureDetails({ checkSetupErrorCode: code }),
			null,
			code,
		);
		strictEqual(
			isPersistentFailureDetails({ checkSetupErrorCode: code }),
			false,
			code,
		);
	}
	strictEqual(
		sanitizeFailureDetails({ checkSetupErrorCode: "ENOENT" })
			.checkSetupErrorCode,
		"ENOENT",
	);
	strictEqual(
		sanitizeFailureDetails({ checkSetupErrorCode: "EAI_AGAIN" })
			.checkSetupErrorCode,
		"EAI_AGAIN",
	);
});

test("the dry run carries both resolved executables from the session resolver", async () => {
	const seen = [];
	const result = await dryRunAcceptanceChecks({
		checks: ["xcrun definitely-missing-tool-xyz"],
		runCheck: async () => ({
			success: false,
			code: 127,
			writerLifecycle: "stopped",
		}),
		resolveCheckExecutables: async (command) => {
			seen.push(command);
			return {
				checkExecutable: "/checker/runtime/bin/xcrun",
				hostExecutable: "/usr/bin/xcrun",
			};
		},
		deadlineMs: Date.now() + 60_000,
	});
	strictEqual(result.status, "environment_failed");
	strictEqual(result.signature, "tool_missing");
	strictEqual(result.checkExecutable, "/checker/runtime/bin/xcrun");
	strictEqual(result.hostExecutable, "/usr/bin/xcrun");
	deepStrictEqual(seen, ["xcrun definitely-missing-tool-xyz"]);
});

test("a failing executable resolver never changes the dry-run gate", async () => {
	const result = await dryRunAcceptanceChecks({
		checks: ["sh -c 'exit 127'"],
		runCheck: async () => ({
			success: false,
			code: 127,
			writerLifecycle: "stopped",
		}),
		resolveCheckExecutables: async () => {
			throw new Error("resolver failed");
		},
		deadlineMs: Date.now() + 60_000,
	});
	strictEqual(result.status, "environment_failed");
	strictEqual(result.signature, "tool_missing");
	strictEqual("checkExecutable" in result, false);
	strictEqual("hostExecutable" in result, false);
});

test("both executables join the environment-failure details and message", () => {
	const checkExecutable = "/checker/runtime/bin/xcrun";
	const hostExecutable = "/usr/bin/xcrun";
	const resolution = resolveFailure({
		reason: "check_environment_failed",
		phase: "baseline",
		checkExecutable,
		hostExecutable,
	});
	ok(resolution.detailFields.includes("checkExecutable"));
	ok(resolution.detailFields.includes("hostExecutable"));
	const details = sanitizeFailureDetails({
		failureReason: "check_environment_failed",
		checkExecutable,
		hostExecutable,
	});
	strictEqual(details.checkExecutable, checkExecutable);
	strictEqual(details.hostExecutable, hostExecutable);
	ok(isPersistentFailureDetails(details));
	const metadata = sanitizeFailureMetadata({
		result: "execution_failed",
		errorKind: "environment_failure",
		checkExecutable,
		hostExecutable,
	});
	ok(metadata.reason.includes(checkExecutable));
	ok(metadata.reason.includes(hostExecutable));
	ok(metadata.reason.includes("check command resolves to "));
	ok(metadata.reason.includes(" in the check sandbox but "));
	ok(metadata.reason.includes(" on the host."));
	ok(isPersistentFailureMetadata(metadata));
});

test("a dry-run check whose tool resolves differently records both paths", {
	skip: sandboxSkip,
}, async () => {
	const repo = repoFixture();
	let providerCalls = 0;
	const result = await runSimpleTask(
		{
			...repo,
			capability: "standard",
			files: ["a.txt"],
			checks: ["xcrun definitely-missing-tool-xyz"],
			deadlineMs: Date.now() + 180_000,
		},
		taskDependencies(repo, () => {
			providerCalls += 1;
		}),
	);
	strictEqual(providerCalls, 0);
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "check_environment_failed");
	strictEqual(result.failurePhase, "baseline");
	strictEqual(result.providerReliability.causeCode, "check_environment_failed");
	const run = await readRun(result.runId);
	const details = run.failureDetails;
	ok(details, "run.json carries failureDetails");
	strictEqual(details.checkEnvironmentSignature, "tool_missing");
	ok(isAbsolute(details.checkExecutable), details.checkExecutable);
	ok(
		details.checkExecutable.includes("/runtime/bin/"),
		details.checkExecutable,
	);
	ok(isAbsolute(details.hostExecutable), details.hostExecutable);
	strictEqual(basename(details.hostExecutable), "xcrun");
	ok(details.checkExecutable !== details.hostExecutable);
	ok(isPersistentFailureDetails(details));
	ok(run.lastFailure.reason.includes(details.checkExecutable));
	ok(run.lastFailure.reason.includes(details.hostExecutable));
	ok(run.lastFailure.reason.includes("check command resolves to "));
	ok(isPersistentFailureMetadata(run.lastFailure));
});
