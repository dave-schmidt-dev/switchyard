// @test-phase: other
// A keyless bridge exit whose provider was stopped by a signal or interrupt
// carries a typed provider signature, `provider_killed` or (only when a
// deadline drove the kill) `provider_deadline_exceeded`, instead of
// `unrecognized`. Fixture lines reproduce the bridge's fixed termination line.
import { strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readRun } from "../src/switchyard/run-store/index.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { defaultExecuteProvider } from "../src/switchyard/simple/provider-invocation.mjs";
import { classifyProviderOutput } from "../src/switchyard/simple/provider-signature.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = tempDir("switchyard-bridge-kill-");

const BRIDGE_SOURCE = readFileSync(
	fileURLToPath(
		new URL("../ops/simple-provider-keyless-bridge.mjs", import.meta.url),
	),
	"utf8",
);
const HEARTBEAT = "switchyard: keyless provider still running\n";
const PROXY_END = 'SWITCHYARD_PROXY_END_V1 {"requests":1}\n';
const bridgeLine = ({
	code = "none",
	signal = "none",
	error = "none",
	interrupt = "none",
}) =>
	`simple-provider-keyless-bridge: provider terminated before a verified completion (code ${code}, signal ${signal}, error ${error}, interrupt ${interrupt})\n`;
const bridgeStderr = (fields) =>
	`${HEARTBEAT}${HEARTBEAT}${PROXY_END}${bridgeLine(fields)}`;
const classify = (stderr, extra = {}) =>
	classifyProviderOutput({
		stderr,
		exitCode: 76,
		keylessBridge: true,
		...extra,
	}).providerSignature;

test("the bridge still prints the termination line and interrupts this classifier reads", () => {
	strictEqual(
		BRIDGE_SOURCE.includes(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: pins the bridge's template source text
			'`provider terminated before a verified completion (code ${Number.isSafeInteger(status.code) ? status.code : "none"}, signal ${statusToken(status.signal)}, error ${statusToken(status.error?.code)}, interrupt ${interrupted ?? "none"})`',
		),
		true,
	);
	const interrupts = [
		...BRIDGE_SOURCE.matchAll(/interrupt\("([^"]+)"\)/gu),
	].map((match) => match[1]);
	strictEqual(
		[...new Set(interrupts)].sort().join(","),
		"SIGINT,SIGTERM,duration-limit",
	);
	strictEqual(BRIDGE_SOURCE.includes("process.exitCode = 76;"), true);
});

test("each signal and interrupt shape maps to its closed signature", () => {
	const cases = [
		[{ signal: "SIGKILL" }, "provider_killed"],
		[{ signal: "SIGTERM" }, "provider_killed"],
		[{ signal: "SIGSEGV" }, "provider_killed"],
		[{ signal: "unknown" }, "provider_killed"],
		[{ code: 143, signal: "SIGTERM" }, "provider_killed"],
		[{ interrupt: "SIGTERM" }, "provider_killed"],
		[{ signal: "SIGTERM", interrupt: "SIGTERM" }, "provider_killed"],
		// The caller's SIGINT is a kill, never an approval denial.
		[{ interrupt: "SIGINT" }, "provider_killed"],
		[{ signal: "SIGTERM", interrupt: "SIGINT" }, "provider_killed"],
		[{ interrupt: "duration-limit" }, "provider_deadline_exceeded"],
		[
			{ signal: "SIGTERM", interrupt: "duration-limit" },
			"provider_deadline_exceeded",
		],
		[
			{ signal: "SIGKILL", interrupt: "duration-limit" },
			"provider_deadline_exceeded",
		],
		// A spawn error is not a kill.
		[{ error: "ENOENT" }, "unrecognized"],
		[{ error: "unknown" }, "unrecognized"],
		[{ code: 1 }, "unrecognized"],
	];
	for (const [fields, expected] of cases)
		strictEqual(
			classify(bridgeStderr(fields)),
			expected,
			JSON.stringify(fields),
		);
	// The server-start interrupt prints the same line with no status fields.
	strictEqual(
		classify(bridgeLine({ interrupt: "duration-limit" })),
		"provider_deadline_exceeded",
	);
	strictEqual(
		classify(bridgeLine({ interrupt: "SIGTERM" })),
		"provider_killed",
	);
});

test("a runner deadline drives the kill only when the runner timed the attempt out", () => {
	for (const fields of [
		{ interrupt: "SIGTERM" },
		{ signal: "SIGKILL" },
		{ signal: "SIGTERM", interrupt: "SIGTERM" },
	]) {
		strictEqual(
			classify(bridgeStderr(fields), { timedOut: true }),
			"provider_deadline_exceeded",
			JSON.stringify(fields),
		);
		strictEqual(
			classify(bridgeStderr(fields), { timedOut: false }),
			"provider_killed",
			JSON.stringify(fields),
		);
	}
	// A timed-out spawn error is still not a kill.
	strictEqual(
		classify(bridgeStderr({ error: "ENOENT" }), { timedOut: true }),
		"unrecognized",
	);
});

test("only a trusted bridge termination line is typed", () => {
	const killed = bridgeStderr({ signal: "SIGKILL" });
	// Another harness printing the same text stays unrecognized.
	strictEqual(classify(killed, { keylessBridge: false }), "unrecognized");
	// The bridge always exits 76 after its termination line.
	for (const exitCode of [0, 1, 75, 77, null])
		strictEqual(classify(killed, { exitCode }), "unrecognized", `${exitCode}`);
	// The line must be the last one the bridge wrote.
	strictEqual(classify(`${killed}${HEARTBEAT}`), "unrecognized");
	// A framed child line is never the bridge's own.
	strictEqual(
		classify(`child: ${bridgeLine({ signal: "SIGKILL" })}`),
		"unrecognized",
	);
	strictEqual(
		classify(bridgeStderr({ signal: "SIGKILL", interrupt: "timeout" })),
		"unrecognized",
	);
	strictEqual(classify(bridgeStderr({ signal: "sigkill" })), "unrecognized");
	// A recognized provider pattern keeps its classification.
	strictEqual(
		classify(`Rate limit reached: too many requests\n${killed}`),
		"rate_limited",
	);
});

function fakeChild() {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = { end() {} };
	child.kill = () => true;
	return child;
}

function exitingChild(stderr, code = 76) {
	const child = fakeChild();
	queueMicrotask(() => {
		child.stderr.emit("data", Buffer.from(stderr));
		child.emit("close", code, null);
	});
	return child;
}

const OPENCODE_GO = {
	targetId: "opencode-go",
	harness: "opencode",
	descriptor: {
		target_id: "opencode-go",
		selector: "opencode-go/deepseek-v4.1-flash",
		invocation_args: ["--variant", "max"],
	},
	capability: "standard",
	prompt: "test",
	timeoutMs: 5_000,
};

test("a killed opencode-go bridge attempt carries provider_killed and writes no stderr artifact", async () => {
	const worktreePath = tempDir("switchyard-bridge-kill-worktree-");
	const result = await defaultExecuteProvider({
		...OPENCODE_GO,
		worktreePath,
		runId: "simple-bridge-kill-unit",
		spawnFn: () => exitingChild(bridgeStderr({ signal: "SIGKILL" })),
	});
	strictEqual(result.success, false);
	strictEqual(result.code, 76);
	strictEqual(result.providerSignature, "provider_killed");
	strictEqual(result.outputPath, undefined);
	strictEqual(result.stderr, "");

	const codex = await defaultExecuteProvider({
		...OPENCODE_GO,
		targetId: "codex",
		harness: "codex",
		descriptor: {
			target_id: "codex",
			selector: "gpt-5.3-codex-spark",
			invocation_args: [],
		},
		worktreePath,
		spawnFn: () => exitingChild(bridgeStderr({ signal: "SIGKILL" })),
	});
	strictEqual(codex.providerSignature, "unrecognized");
});

test("a vibe bridge attempt killed by its own duration limit carries provider_deadline_exceeded", async () => {
	const result = await defaultExecuteProvider({
		...OPENCODE_GO,
		targetId: "vibe",
		harness: "vibe",
		descriptor: {
			target_id: "vibe",
			selector: "glm-5-3",
			invocation_args: [],
		},
		worktreePath: tempDir("switchyard-bridge-kill-worktree-"),
		spawnFn: () =>
			exitingChild(
				bridgeStderr({ signal: "SIGTERM", interrupt: "duration-limit" }),
			),
	});
	strictEqual(result.providerSignature, "provider_deadline_exceeded");
	// The runner did not time the attempt out; only the signature is typed.
	strictEqual(result.timedOut, false);
});

test("a bridge stopped at the runner's deadline carries provider_deadline_exceeded", async (t) => {
	const start = 1_700_000_000_000;
	mock.timers.enable({ apis: ["Date"], now: start });
	t.after(() => mock.timers.reset());
	const child = fakeChild();
	const pending = defaultExecuteProvider({
		...OPENCODE_GO,
		worktreePath: "/tmp/switchyard-bridge-kill-deadline",
		timeoutMs: 30 * 60 * 1000,
		deadlineMs: start + 60_000,
		spawnFn: () => child,
	});
	mock.timers.setTime(start + 60_000);
	child.stderr.emit(
		"data",
		Buffer.from(bridgeStderr({ interrupt: "SIGTERM" })),
	);
	child.emit("close", 76, null);
	const result = await pending;
	strictEqual(result.timedOut, true);
	strictEqual(result.providerSignature, "provider_deadline_exceeded");
});

function git(path, args) {
	return execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
}

test("the simple failure record of a killed bridge attempt names provider_killed", async () => {
	const root = tempDir("switchyard-bridge-kill-repo-");
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
	writeFileSync(promptPath, "Change a.txt\n");
	const result = await runSimpleTask(
		{
			projectPath,
			promptPath,
			capability: "standard",
			files: ["a.txt"],
			checks: ["test -f a.txt"],
			deadlineMs: Date.now() + 120_000,
		},
		{
			tmpdir: root,
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
					...OPENCODE_GO,
					spawnFn: () =>
						exitingChild(
							bridgeStderr({ signal: "SIGTERM", interrupt: "SIGTERM" }),
						),
				}),
			runCheck: async () => ({ success: true, writerLifecycle: "stopped" }),
		},
	);
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "provider_exit_nonzero");
	const run = await readRun(result.runId);
	strictEqual(run.failureDetails.providerSignature, "provider_killed");
	strictEqual(run.lastFailure.providerReliability.exitCode, 76);
	strictEqual(run.failureDetails.outputPath, undefined);
});
