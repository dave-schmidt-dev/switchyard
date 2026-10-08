import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
	isPersistentFailureDetails,
	isPersistentFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";
import { getRunRoot, readRun } from "../src/switchyard/run-store/index.mjs";
import { PROVIDER_EVIDENCE_TAIL_BYTES } from "../src/switchyard/simple/check-environment.mjs";
import {
	appendFailureRecord,
	readFailureRecords,
} from "../src/switchyard/simple/failure-log.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { defaultExecuteProvider } from "../src/switchyard/simple/provider-invocation.mjs";
import {
	classifyProviderOutput,
	PROVIDER_SIGNATURES,
	writeProviderStderrArtifact,
} from "../src/switchyard/simple/provider-signature.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const suite = tempDir("switchyard-evidence-");
process.env.SWITCHYARD_RUN_STORE_ROOT = suite;

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

const REDACTED_SHAPE = "[REDACTED]";
const PLANTED_CREDENTIALS = Object.freeze({
	sk: "sk-live-ABCDEFGHIJKLMNOPQRSTUVWX",
	ghp: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
	githubPat: "github_pat_0123456789abcdef0123456789",
	bws: "bws_0123456789abcdefghijklmnopqrstuv",
	awsAccessKey: "AKIA0000000000000000",
	awsSessionKey: "ASIA1111111111111111",
	bearer: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
	jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.dGhpcy1pc24tdHJ1ZQ",
	basic: "Authorization: Basic YTpi",
	pair: "token=abcdefghijklmnop",
	password: "password=synthetic-passphrase",
	secret: "secret=synthetic-secret",
	clientSecret: "client_secret=synthetic-client-secret",
	awsSecretAccessKey: "aws_secret_access_key=synthetic-aws-secret",
});
const ORDINARY_PROVIDER_FAULT =
	"unexpected provider fault: widget assembly failed";
const UNRECOGNIZED_STDERR = "unexpected provider refusal";

function assertNoPlantedCredentials(text, label) {
	for (const value of Object.values(PLANTED_CREDENTIALS)) {
		strictEqual(
			text.includes(value),
			false,
			`${label} retains a planted credential shape`,
		);
	}
}

function plantedProviderStderr() {
	return `${ORDINARY_PROVIDER_FAULT}\n${Object.values(PLANTED_CREDENTIALS).join("\n")}\n`;
}

function spawnUnrecognizedExit76(stderrText) {
	const script = `process.stderr.write(${JSON.stringify(stderrText)}); process.exitCode = 76;`;
	return spawn(process.execPath, ["-e", script]);
}

function artifactRefusal(runId) {
	return writeProviderStderrArtifact({ runId, stderr: UNRECOGNIZED_STDERR });
}

test("provider stderr artifact is a redacted, bounded, owner-only tail", {
	skip: typeof process.getuid === "function" && process.getuid() === 0,
}, () => {
	const filler = "x".repeat(PROVIDER_EVIDENCE_TAIL_BYTES - 12);
	const stderr =
		`${filler}\n${PLANTED_CREDENTIALS.sk}${"y".repeat(64)}\n` +
		`${ORDINARY_PROVIDER_FAULT}\n${PLANTED_CREDENTIALS.ghp}\n` +
		`${PLANTED_CREDENTIALS.bws}\n${PLANTED_CREDENTIALS.bearer}\n` +
		`${PLANTED_CREDENTIALS.pair}\n`;
	const runId = "ev-write";
	const artifactPath = writeProviderStderrArtifact({ runId, stderr });
	ok(artifactPath, "artifact path returned");
	const runRoot = getRunRoot(runId);
	const artifactDir = join(runRoot, "artifacts");
	strictEqual(artifactPath.startsWith(artifactDir), true);
	strictEqual(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.log$/u.test(
			basename(artifactPath),
		),
		true,
		"artifact name is an unpredictable token",
	);
	strictEqual(statSync(artifactDir).mode & 0o777, 0o700);
	strictEqual(statSync(artifactPath).mode & 0o777, 0o600);
	const bytes = readFileSync(artifactPath);
	ok(
		bytes.length <= PROVIDER_EVIDENCE_TAIL_BYTES,
		"artifact respects the 4 KiB cap",
	);
	const text = bytes.toString("utf8");
	ok(text.includes(ORDINARY_PROVIDER_FAULT), "ordinary stderr is retained");
	ok(text.includes(REDACTED_SHAPE), "credential shapes are replaced");
	assertNoPlantedCredentials(text, "artifact");
	strictEqual(
		text.includes(PLANTED_CREDENTIALS.sk.slice(18)),
		false,
		"truncation never exposes a token suffix",
	);
	const boundaryCredential = PLANTED_CREDENTIALS.githubPat;
	const boundarySuffix = "s".repeat(
		PROVIDER_EVIDENCE_TAIL_BYTES + 10 - Buffer.byteLength(boundaryCredential),
	);
	const boundaryPath = writeProviderStderrArtifact({
		runId: "ev-redaction-boundary",
		stderr: `${"p".repeat(20)}\n${boundaryCredential}${boundarySuffix}`,
	});
	ok(boundaryPath, "boundary artifact path returned");
	const boundaryBytes = readFileSync(boundaryPath);
	ok(
		boundaryBytes.length <= PROVIDER_EVIDENCE_TAIL_BYTES,
		"boundary artifact respects the 4 KiB cap",
	);
	const boundaryText = boundaryBytes.toString("utf8");
	strictEqual(
		boundaryText.includes(boundaryCredential.slice(10)),
		false,
		"full-stream redaction removes a PAT suffix crossing the artifact tail",
	);
	ok(boundaryText.includes(REDACTED_SHAPE), "boundary canary is replaced");
	const second = writeProviderStderrArtifact({
		runId,
		stderr: ORDINARY_PROVIDER_FAULT,
	});
	strictEqual(
		second === artifactPath,
		false,
		"artifact names are unpredictable",
	);
});

test("provider stderr artifact refuses missing runId, broad modes and symlinks", () => {
	strictEqual(writeProviderStderrArtifact(), null);
	strictEqual(
		writeProviderStderrArtifact({ stderr: UNRECOGNIZED_STDERR }),
		null,
	);
	strictEqual(
		writeProviderStderrArtifact({
			runId: "../escape",
			stderr: UNRECOGNIZED_STDERR,
		}),
		null,
	);

	const broadRoot = getRunRoot("ev-broad-root");
	mkdirSync(broadRoot, { recursive: true, mode: 0o700 });
	chmodSync(broadRoot, 0o755);
	strictEqual(artifactRefusal("ev-broad-root"), null);
	strictEqual(
		statSync(broadRoot).mode & 0o777,
		0o755,
		"run root mode is never forced",
	);

	const broadArtifacts = join(getRunRoot("ev-broad-artifacts"), "artifacts");
	mkdirSync(broadArtifacts, { recursive: true, mode: 0o700 });
	chmodSync(broadArtifacts, 0o755);
	strictEqual(artifactRefusal("ev-broad-artifacts"), null);
	strictEqual(
		statSync(broadArtifacts).mode & 0o777,
		0o755,
		"artifact directory mode is never forced",
	);

	const symlinkRunRoot = getRunRoot("ev-symlink-run");
	mkdirSync(symlinkRunRoot, { recursive: true, mode: 0o700 });
	const outside = tempDir("switchyard-evidence-outside-");
	symlinkSync(outside, join(symlinkRunRoot, "artifacts"));
	strictEqual(artifactRefusal("ev-symlink-run"), null);
	deepStrictEqual(readdirSync(outside), [], "symlink target stays empty");

	const bypassDir = tempDir("switchyard-evidence-bypass-");
	const bypassPath = writeProviderStderrArtifact({
		runId: "ev-bypass",
		stderr: UNRECOGNIZED_STDERR,
		artifactDir: bypassDir,
	});
	ok(bypassPath, "runId-derived artifact is still written");
	deepStrictEqual(readdirSync(bypassDir), [], "caller directory is ignored");
});

test("provider evidence refuses a symlinked runs ancestor", () => {
	const state = tempDir("switchyard-evidence-ancestor-");
	const outside = tempDir("switchyard-evidence-target-");
	symlinkSync(outside, join(state, "runs"));
	const previous = process.env.SWITCHYARD_RUN_STORE_ROOT;
	process.env.SWITCHYARD_RUN_STORE_ROOT = state;
	try {
		strictEqual(artifactRefusal("ev-ancestor"), null);
		deepStrictEqual(readdirSync(outside), []);
	} finally {
		process.env.SWITCHYARD_RUN_STORE_ROOT = previous;
	}
});

test("provider stderr artifact write failure leaves the outcome unchanged", () => {
	const runId = "ev-readonly";
	const artifactDir = join(getRunRoot(runId), "artifacts");
	mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
	chmodSync(artifactDir, 0o500);
	try {
		strictEqual(artifactRefusal(runId), null);
		deepStrictEqual(readdirSync(artifactDir), [], "no partial artifact");
	} finally {
		chmodSync(artifactDir, 0o700);
	}
});

test("spawned exit 76 with unrecognized stderr is suppressed without a run", async () => {
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
		timeoutMs: 10_000,
		spawnFn: () => spawnUnrecognizedExit76(plantedProviderStderr()),
	});
	strictEqual(result.success, false);
	strictEqual(result.code, 76);
	strictEqual(result.providerSignature, "unrecognized");
	strictEqual(result.output, "");
	strictEqual(result.stderr, "");
	strictEqual("outputPath" in result, false);
	strictEqual(JSON.stringify(result).includes(ORDINARY_PROVIDER_FAULT), false);
	assertNoPlantedCredentials(JSON.stringify(result), "result");
});

test("unrecognized failed provider persists only a sanitized artifact path", async () => {
	const runId = "ev-e2e";
	const repo = repoFixture();
	const stderrText = plantedProviderStderr();
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
			runId,
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
					spawnFn: () => spawnUnrecognizedExit76(stderrText),
				}),
			runCheck: async () => ({ success: true, writerLifecycle: "stopped" }),
		},
	);

	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "provider_exit_nonzero");
	const details = result.failureDetails;
	ok(details, "terminal result carries failure details");
	strictEqual(details.providerSignature, "unrecognized");
	strictEqual(typeof details.outputPath, "string");
	const runRoot = getRunRoot(runId);
	const artifactDir = join(runRoot, "artifacts");
	strictEqual(details.outputPath.startsWith(artifactDir), true);
	strictEqual(statSync(details.outputPath).mode & 0o777, 0o600);
	const artifactText = readFileSync(details.outputPath, "utf8");
	ok(artifactText.includes(ORDINARY_PROVIDER_FAULT));
	assertNoPlantedCredentials(artifactText, "artifact");

	const runRecord = await readRun(runId);
	strictEqual(runRecord.failureDetails.outputPath, details.outputPath);
	strictEqual(
		JSON.stringify(runRecord).includes(ORDINARY_PROVIDER_FAULT),
		false,
	);
	assertNoPlantedCredentials(JSON.stringify(runRecord), "run record");
	strictEqual(JSON.stringify(result).includes(ORDINARY_PROVIDER_FAULT), false);
	assertNoPlantedCredentials(JSON.stringify(result), "result");

	for (const filePath of allFilesUnder(runRoot)) {
		const content = readFileSync(filePath, "utf8");
		assertNoPlantedCredentials(content, filePath);
		if (/\.jsonl?$/u.test(filePath)) {
			strictEqual(
				content.includes(ORDINARY_PROVIDER_FAULT),
				false,
				`raw stderr leaked into ${filePath}`,
			);
		}
	}
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
