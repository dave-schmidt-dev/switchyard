import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	isPersistentFailureDetails,
	isPersistentFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";
import { getRunRoot, readRun } from "../src/switchyard/run-store/index.mjs";
import {
	appendFailureRecord,
	readFailureRecords,
} from "../src/switchyard/simple/failure-log.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { defaultExecuteProvider } from "../src/switchyard/simple/provider-invocation.mjs";
import {
	classifyProviderOutput,
	PROVIDER_SIGNATURES,
} from "../src/switchyard/simple/provider-signature.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const suite = tempDir("switchyard-provider-evidence-suite-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suite, "runs");

function git(path, args) {
	return execFileSync("git", args, {
		cwd: path,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		},
	}).trim();
}

function commit(path) {
	git(path, ["add", "."]);
	git(path, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"fixture",
	]);
}

function repoFixture() {
	const root = tempDir("switchyard-provider-evidence-repo-");
	const projectPath = join(root, "project");
	mkdirSync(projectPath);
	writeFileSync(join(projectPath, "a.txt"), "base\n");
	git(projectPath, ["init", "-q"]);
	commit(projectPath);
	const promptPath = join(root, "prompt");
	writeFileSync(promptPath, "Modify a.txt\n");
	return { root, projectPath, promptPath };
}

function allFilesUnder(dir) {
	const results = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...allFilesUnder(full));
		} else {
			results.push(full);
		}
	}
	return results;
}

test("classifyProviderOutput correctly classifies one fixture per enum value", () => {
	const fixtures = [
		{
			signature: "approval_denied",
			input: {
				stderr: "Tool approval denied by user",
				exitCode: 1,
			},
		},
		{
			signature: "auth_failed",
			input: {
				stderr: "401 Unauthorized: token expired",
				exitCode: 1,
			},
		},
		{
			signature: "rate_limited",
			input: {
				stderr: "Rate limit reached: too many requests (status: 429)",
				exitCode: 1,
			},
		},
		{
			signature: "network_error",
			input: {
				stderr: "Network error: connection refused ECONNREFUSED",
				exitCode: 1,
			},
		},
		{
			signature: "model_unavailable",
			input: {
				stderr: "Model unavailable: model not found",
				exitCode: 1,
			},
		},
		{
			signature: "tool_error",
			input: {
				stderr: "Tool execution failed: command exited with code 1",
				exitCode: 1,
			},
		},
		{
			signature: "context_overflow",
			input: {
				stderr: "Maximum context length exceeded: prompt too long",
				exitCode: 1,
			},
		},
		{
			signature: "unrecognized",
			input: {
				stderr: "Something completely unexpected occurred on line 123",
				exitCode: 1,
			},
		},
	];

	// Verify that all 8 enum values are represented
	deepStrictEqual(
		fixtures.map((f) => f.signature).sort(),
		[...PROVIDER_SIGNATURES].sort(),
	);

	for (const fixture of fixtures) {
		const result = classifyProviderOutput(fixture.input);
		strictEqual(
			result.providerSignature,
			fixture.signature,
			`expected ${fixture.signature}`,
		);
		strictEqual(
			result.stderrBytes,
			Buffer.byteLength(fixture.input.stderr, "utf8"),
		);
		strictEqual(result.stdoutBytes, 0);
	}
});

test("classifyProviderOutput supports signals and exit codes", () => {
	strictEqual(
		classifyProviderOutput({ signal: "SIGINT" }).providerSignature,
		"approval_denied",
	);
	strictEqual(
		classifyProviderOutput({ exitCode: 130 }).providerSignature,
		"approval_denied",
	);
	strictEqual(
		classifyProviderOutput({ exitCode: 401 }).providerSignature,
		"auth_failed",
	);
	strictEqual(
		classifyProviderOutput({ exitCode: 429 }).providerSignature,
		"rate_limited",
	);
	strictEqual(
		classifyProviderOutput({ exitCode: 404 }).providerSignature,
		"model_unavailable",
	);
	strictEqual(
		classifyProviderOutput({ exitCode: 503 }).providerSignature,
		"network_error",
	);
});

test("failed provider run with sk-test-123 in stderr writes run record and failure-log entry without leaking secret", async () => {
	const repo = repoFixture();
	const secretText = "sk-test-123: authentication failed\n";
	const expectedStderrBytes = Buffer.byteLength(secretText, "utf8");

	const result = await runSimpleTask(
		{
			projectPath: repo.projectPath,
			promptPath: repo.promptPath,
			capability: "standard",
			files: ["a.txt"],
			checks: ["test -f a.txt"],
			deadlineMs: Date.now() + 180_000,
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
			executeProvider: (context) =>
				defaultExecuteProvider({
					...context,
					spawnFn: () => {
						const child = new EventEmitter();
						child.stdout = new EventEmitter();
						child.stderr = new EventEmitter();
						child.stdin = { end() {} };
						queueMicrotask(() => {
							child.stderr.emit("data", Buffer.from(secretText));
							child.emit("close", 1, null);
						});
						return child;
					},
				}),
			runCheck: async () => ({ success: true, writerLifecycle: "stopped" }),
		},
	);

	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "provider_exit_nonzero");

	const runRecord = await readRun(result.runId);
	ok(runRecord, "run record exists");
	const details = runRecord.failureDetails;
	ok(details, "run.json carries failureDetails");
	strictEqual(details.failureReason, "provider_exit_nonzero");
	strictEqual(details.providerSignature, "auth_failed");
	strictEqual(details.stderrBytes, expectedStderrBytes);
	strictEqual(details.stdoutBytes, 0);

	// Ensure detail fields do NOT leak into lastFailure
	strictEqual("providerSignature" in runRecord.lastFailure, false);
	strictEqual("stderrBytes" in runRecord.lastFailure, false);
	strictEqual("stdoutBytes" in runRecord.lastFailure, false);
	ok(isPersistentFailureDetails(details));
	ok(isPersistentFailureMetadata(runRecord.lastFailure));

	// Write and check failure-log record
	const stateRoot = tempDir("switchyard-provider-evidence-log-");
	const logged = appendFailureRecord(
		{
			recordType: "attempt",
			targetId: "codex",
			reason: result.failureReason,
			causeCode: "provider_exit_nonzero",
			phase: "execute",
			failurePhase: result.failurePhase,
			errorKind: result.errorKind,
			...details,
		},
		{ stateRoot },
	);

	strictEqual(logged.failureReason, "provider_exit_nonzero");
	strictEqual(logged.providerSignature, "auth_failed");
	strictEqual(logged.stderrBytes, expectedStderrBytes);
	strictEqual(logged.stdoutBytes, 0);

	const logRecords = readFailureRecords({ stateRoot });
	strictEqual(logRecords.length, 1);
	deepStrictEqual(logRecords[0], logged);

	// Assert run record and failure log contain NO secrets
	strictEqual(JSON.stringify(runRecord).includes("sk-test-123"), false);
	strictEqual(JSON.stringify(logged).includes("sk-test-123"), false);
	strictEqual(JSON.stringify(logRecords[0]).includes("sk-test-123"), false);

	// Assert NO file under fixture run root contains provider output text
	const runRoot = getRunRoot(result.runId);
	ok(existsSync(runRoot), "run root exists");
	const runFiles = allFilesUnder(runRoot);
	ok(runFiles.length > 0, "run root has persisted files");

	for (const filePath of runFiles) {
		const content = readFileSync(filePath, "utf8");
		strictEqual(
			content.includes("sk-test-123"),
			false,
			`secret found in ${filePath}`,
		);
		strictEqual(
			content.includes("authentication failed"),
			false,
			`provider output text found in ${filePath}`,
		);
	}
});

test("defaultExecuteProvider suppresses provider output and attaches signature on failure", async () => {
	const secretText = "sk-test-123: rate limit exceeded (status: 429)\n";
	const expectedStderrBytes = Buffer.byteLength(secretText, "utf8");
	const repo = repoFixture();

	const result = await defaultExecuteProvider({
		targetId: "codex",
		harness: "codex",
		descriptor: {
			target_id: "codex",
			selector: "gpt-5.3-codex-spark",
			invocation_args: [],
		},
		capability: "standard",
		prompt: "test",
		worktreePath: repo.projectPath,
		timeoutMs: 5_000,
		spawnFn: () => {
			const child = new EventEmitter();
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.stdin = { end() {} };
			queueMicrotask(() => {
				child.stderr.emit("data", Buffer.from(secretText));
				child.emit("close", 1, null);
			});
			return child;
		},
	});

	strictEqual(result.success, false);
	strictEqual(result.providerSignature, "rate_limited");
	strictEqual(result.stderrBytes, expectedStderrBytes);
	strictEqual(result.stdoutBytes, 0);
	strictEqual(result.stderr, "");
	strictEqual(result.output, "");
	strictEqual(JSON.stringify(result).includes("sk-test-123"), false);
	strictEqual(JSON.stringify(result).includes("rate limit"), false);
});

test("resolveFailure never writes provider detail fields onto Object.prototype", async () => {
	const { resolveFailure } = await import(
		"../src/switchyard/diagnostics/failure-registry.mjs"
	);
	resolveFailure({
		reason: "provider_exit_nonzero",
		phase: "execute",
		providerResult: {
			providerSignature: "auth_failed",
			stderrBytes: 12,
			stdoutBytes: 0,
		},
	});
	await new Promise((resolve) => setImmediate(resolve));
	for (const key of ["providerSignature", "stderrBytes", "stdoutBytes"]) {
		strictEqual(Object.hasOwn(Object.prototype, key), false, key);
		strictEqual({}[key], undefined, key);
	}
});
