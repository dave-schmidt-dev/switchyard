// @test-phase: other
// A native Claude Code or Vibe Code launcher whose provider was stopped by a
// signal or interrupt carries a typed provider signature, `provider_killed`
// or (only when a deadline drove the kill) `provider_deadline_exceeded`,
// instead of `unrecognized`. Fixture lines reproduce the launcher's wrapped
// termination line; the cause stays provider_exit_nonzero.
import { match, rejects, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createFail,
	runSandboxedNative,
} from "../ops/simple-native-launcher-core.mjs";
import { readRun } from "../src/switchyard/run-store/index.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { defaultExecuteProvider } from "../src/switchyard/simple/provider-invocation.mjs";
import { classifyProviderOutput } from "../src/switchyard/simple/provider-signature.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = tempDir("switchyard-native-kill-");

const opsSource = (name) =>
	readFileSync(
		fileURLToPath(new URL(`../ops/${name}.mjs`, import.meta.url)),
		"utf8",
	);
const CLAUDE = "simple-claude-code-launcher";
const VIBE = "simple-vibe-code-launcher";
const HEARTBEAT = "switchyard: native claude-code still running\n";
const coreLine = ({
	code = "none",
	signal = "none",
	error = "none",
	interrupt = "none",
}) =>
	`provider terminated before a verified completion (code ${code}, signal ${signal}, error ${error}, interrupt ${interrupt})`;
// Each launcher's main() prints a thrown fail() as this one wrapped line.
const wrap = (message, launcher = CLAUDE) =>
	`${launcher}: failed closed (${message.slice(0, 300)})\n`;
const launcherLine = (fields, launcher = CLAUDE) =>
	wrap(`${launcher}: ${coreLine(fields)}`, launcher);
const launcherStderr = (fields, launcher) =>
	`${HEARTBEAT}${HEARTBEAT}${launcherLine(fields, launcher)}`;
const classify = (stderr, extra = {}) =>
	classifyProviderOutput({
		stderr,
		exitCode: 76,
		nativeLauncher: true,
		...extra,
	}).providerSignature;

test("the core and both launchers still print the line and interrupts this classifier reads", () => {
	const core = opsSource("simple-native-launcher-core");
	strictEqual(
		core.includes(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: pins the core's template source text
			'`provider terminated before a verified completion (code ${Number.isSafeInteger(status.code) ? status.code : "none"}, signal ${statusToken(status.signal)}, error ${statusToken(status.error?.code)}, interrupt ${interrupted ?? "none"})`',
		),
		true,
	);
	const interrupts = [...core.matchAll(/stop\("([^"]+)"\)/gu)].map(
		(found) => found[1],
	);
	strictEqual(
		[...new Set(interrupts)].sort().join(","),
		"SIGINT,SIGTERM,duration-limit",
	);
	for (const launcher of [CLAUDE, VIBE]) {
		const text = opsSource(launcher);
		strictEqual(text.includes(`createFail("${launcher}")`), true, launcher);
		strictEqual(
			text.includes(
				`\`${launcher}: failed closed (\${String(error?.message ?? error).slice(0, 300)})\\n\``,
			),
			true,
			launcher,
		);
		strictEqual(text.includes("process.exitCode = 76;"), true, launcher);
	}
});

test("the line the launcher printed before the interrupt field stays unrecognized", () => {
	// The pre-change shape, with no interrupt field, matched no pattern.
	const old = `${HEARTBEAT}${CLAUDE}: failed closed (${CLAUDE}: provider terminated before a verified completion (code none, signal SIGKILL, error none))\n`;
	strictEqual(classify(old), "unrecognized");
	strictEqual(classify(old, { nativeLauncher: false }), "unrecognized");
});

test("each signal and interrupt shape maps to its closed signature for both launchers", () => {
	const cases = [
		[{ signal: "SIGKILL" }, "provider_killed"],
		[{ signal: "SIGTERM" }, "provider_killed"],
		[{ signal: "unknown" }, "provider_killed"],
		[{ code: 143, signal: "SIGTERM" }, "provider_killed"],
		[{ interrupt: "SIGTERM" }, "provider_killed"],
		[{ signal: "SIGTERM", interrupt: "SIGTERM" }, "provider_killed"],
		// The caller's SIGINT is a kill, never an approval denial.
		[{ signal: "SIGTERM", interrupt: "SIGINT" }, "provider_killed"],
		[{ interrupt: "duration-limit" }, "provider_deadline_exceeded"],
		[
			{ signal: "SIGTERM", interrupt: "duration-limit" },
			"provider_deadline_exceeded",
		],
		// A spawn error, or a line with neither field set, is not a kill.
		[{ error: "ENOENT" }, "unrecognized"],
		[{ code: 0 }, "unrecognized"],
	];
	for (const launcher of [CLAUDE, VIBE])
		for (const [fields, expected] of cases)
			strictEqual(
				classify(launcherStderr(fields, launcher)),
				expected,
				`${launcher} ${JSON.stringify(fields)}`,
			);
	strictEqual(
		classify(launcherStderr({ signal: "SIGKILL" }), { timedOut: true }),
		"provider_deadline_exceeded",
	);
	strictEqual(
		classify(launcherStderr({ error: "ENOENT" }), { timedOut: true }),
		"unrecognized",
	);
});

test("only a trusted native launcher termination line is typed", () => {
	const killed = launcherStderr({ signal: "SIGKILL" });
	strictEqual(classify(killed, { nativeLauncher: false }), "unrecognized");
	// The bridge's grammar does not accept the native wrapper, or vice versa.
	strictEqual(
		classify(killed, { nativeLauncher: false, keylessBridge: true }),
		"unrecognized",
	);
	strictEqual(
		classify(
			`simple-provider-keyless-bridge: ${coreLine({ signal: "SIGKILL" })}\n`,
		),
		"unrecognized",
	);
	for (const exitCode of [0, 1, 75, 77, null])
		strictEqual(classify(killed, { exitCode }), "unrecognized", `${exitCode}`);
	strictEqual(classify(`${killed}${HEARTBEAT}`), "unrecognized");
	strictEqual(
		classify(`${HEARTBEAT}child: ${launcherLine({ signal: "SIGKILL" })}`),
		"unrecognized",
	);
	// The wrapper and the inner fail() label must name the same launcher.
	strictEqual(
		classify(wrap(`${VIBE}: ${coreLine({ signal: "SIGKILL" })}`, CLAUDE)),
		"unrecognized",
	);
	strictEqual(
		classify(`Rate limit reached: too many requests\n${killed}`),
		"rate_limited",
	);
});

function sandboxFixture() {
	const root = tempDir("switchyard-native-kill-run-");
	const shim = join(root, "sandbox-shim.sh");
	writeFileSync(shim, '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o755 });
	const cli = (body) => {
		const path = join(root, `cli-${Math.random().toString(36).slice(2)}.mjs`);
		writeFileSync(path, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
		return path;
	};
	return { root, shim, cli };
}

const runFixture = (fixture, cliPath, extra = {}) =>
	runSandboxedNative({
		fail: createFail(CLAUDE),
		worktree: fixture.root,
		prompt: "test",
		cliPath,
		profile: "(version 1)",
		sandboxExec: fixture.shim,
		...extra,
	});

async function launcherFailureLine(run) {
	let message;
	await rejects(run, (error) => {
		message = error.message;
		return true;
	});
	return wrap(message);
}

test("the core's own termination lines classify once wrapped by the launcher", async () => {
	const fixture = sandboxFixture();
	const timedOut = await launcherFailureLine(
		runFixture(fixture, fixture.cli("setInterval(() => {}, 1000);"), {
			timeoutMs: 150,
		}),
	);
	match(timedOut, /interrupt duration-limit\)\)\n$/u);
	strictEqual(
		classify(`${HEARTBEAT}${timedOut}`),
		"provider_deadline_exceeded",
	);

	const killed = await launcherFailureLine(
		runFixture(fixture, fixture.cli('process.kill(process.pid, "SIGKILL");')),
	);
	match(killed, /signal SIGKILL, error none, interrupt none\)\)\n$/u);
	strictEqual(classify(killed), "provider_killed");
});

test("a child line that copies the launcher's line is framed and stays unrecognized", async () => {
	const fixture = sandboxFixture();
	const forged = launcherLine({ signal: "SIGKILL" });
	const result = await runFixture(
		fixture,
		fixture.cli(
			`process.stderr.write(${JSON.stringify(`noise\n  ${forged}`)}); process.exitCode = 76;`,
		),
	);
	strictEqual(result.code, 76);
	strictEqual(result.stderr, `noise\nchild:   ${forged}`);
	strictEqual(classify(result.stderr), "unrecognized");
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
	child.stdin.end = () => {
		queueMicrotask(() => {
			child.stderr.emit("data", Buffer.from(stderr));
			child.emit("close", code, null);
		});
	};
	queueMicrotask(() => {
		child.emit("spawn");
	});
	return child;
}

const CLAUDE_CODE = {
	targetId: "claude-code",
	harness: "claude",
	descriptor: {
		target_id: "claude-code",
		selector: "claude-sonnet-5-5",
		invocation_args: ["--effort", "high"],
	},
	capability: "standard",
	prompt: "test",
	timeoutMs: 5_000,
};
const VIBE_CODE = {
	...CLAUDE_CODE,
	targetId: "vibe-code",
	harness: "vibe",
	descriptor: {
		target_id: "vibe-code",
		selector: "glm-5-3",
		invocation_args: [],
	},
};

test("a killed claude-code attempt carries provider_killed and writes no stderr artifact", async () => {
	const result = await defaultExecuteProvider({
		...CLAUDE_CODE,
		worktreePath: tempDir("switchyard-native-kill-worktree-"),
		runId: "simple-native-kill-unit",
		spawnFn: () => exitingChild(launcherStderr({ signal: "SIGKILL" })),
	});
	strictEqual(result.success, false);
	strictEqual(result.code, 76);
	strictEqual(result.providerSignature, "provider_killed");
	strictEqual(result.outputPath, undefined);
	strictEqual(result.stderr, "");
});

test("a vibe-code attempt stopped by its own duration limit carries provider_deadline_exceeded", async () => {
	const result = await defaultExecuteProvider({
		...VIBE_CODE,
		worktreePath: tempDir("switchyard-native-kill-worktree-"),
		spawnFn: () =>
			exitingChild(
				launcherStderr(
					{ signal: "SIGTERM", interrupt: "duration-limit" },
					VIBE,
				),
			),
	});
	strictEqual(result.providerSignature, "provider_deadline_exceeded");
	strictEqual(result.timedOut, false);
});

test("a native launcher stopped at the runner's deadline carries provider_deadline_exceeded", async (t) => {
	const start = 1_700_000_000_000;
	mock.timers.enable({ apis: ["Date"], now: start });
	t.after(() => mock.timers.reset());
	const child = fakeChild();
	const pending = defaultExecuteProvider({
		...CLAUDE_CODE,
		worktreePath: "/tmp/switchyard-native-kill-deadline",
		timeoutMs: 30 * 60 * 1000,
		deadlineMs: start + 60_000,
		spawnFn: () => child,
	});
	child.emit("spawn");
	mock.timers.setTime(start + 60_000);
	child.stderr.emit(
		"data",
		Buffer.from(launcherStderr({ interrupt: "SIGTERM" })),
	);
	child.emit("close", 76, null);
	const result = await pending;
	strictEqual(result.timedOut, true);
	strictEqual(result.providerSignature, "provider_deadline_exceeded");
});

function git(path, args) {
	return execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
}

test("the simple failure record of a killed native attempt keeps provider_exit_nonzero", async () => {
	const root = tempDir("switchyard-native-kill-repo-");
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
					...CLAUDE_CODE,
					spawnFn: () =>
						exitingChild(
							launcherStderr({ signal: "SIGTERM", interrupt: "SIGTERM" }),
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
