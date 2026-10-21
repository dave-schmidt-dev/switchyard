// @test-phase: other
import { strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { defaultExecuteProvider } from "../src/switchyard/simple/provider-invocation.mjs";
import {
	createRateLimitMatcher,
	RATE_LIMIT_TAIL_BYTES,
} from "../src/switchyard/simple/provider-signature.mjs";
import { HANG_GUARD_MS } from "./helpers/hang-guard.mjs";

const CODEX_DESCRIPTOR = Object.freeze({
	target_id: "codex",
	selector: "gpt-5.3-codex-spark",
	invocation_args: [],
});

function providerContext({
	prompt = "Apply the change.",
	timeoutMs = 30_000,
	spawnFn,
}) {
	return {
		targetId: "codex",
		harness: "codex",
		descriptor: CODEX_DESCRIPTOR,
		capability: "standard",
		prompt,
		worktreePath: process.cwd(),
		timeoutMs,
		...(spawnFn ? { spawnFn } : {}),
	};
}

function nodeProvider(script, children = []) {
	return (_command, _args, options) => {
		const child = spawn(process.execPath, ["-e", script], options);
		children.push(child);
		return child;
	};
}

// A sandbox that denies signals to children must not leave a sleeping provider
// holding the test runner open; unref and destroy its pipes after the run.
function releaseChildren(children) {
	for (const child of children) {
		child.on("error", () => {});
		try {
			child.kill("SIGKILL");
		} catch {}
		for (const stream of [child.stdout, child.stderr, child.stdin]) {
			stream?.destroy?.();
		}
		child.unref();
	}
}

function fakeChild({
	stdout = "",
	stderr = "",
	code = 0,
	signal = null,
	onKill = null,
}) {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = { end() {} };
	child.kill = (killSignal) => {
		onKill?.(killSignal);
		return true;
	};
	queueMicrotask(() => {
		if (stdout) child.stdout.emit("data", Buffer.from(stdout));
		if (stderr) child.stderr.emit("data", Buffer.from(stderr));
		child.emit("close", code, signal);
	});
	return child;
}

test("streaming matcher bounds the tail and ignores the echoed prompt", () => {
	strictEqual(RATE_LIMIT_TAIL_BYTES, 8 * 1024);
	const matcher = createRateLimitMatcher();
	strictEqual(matcher.push("stderr", "429 Too Many Requests\n"), true);

	const bounded = createRateLimitMatcher();
	bounded.push("stderr", "rate limit exceeded\n");
	strictEqual(
		bounded.push("stderr", "x".repeat(RATE_LIMIT_TAIL_BYTES + 1_024)),
		false,
	);

	const echoed = createRateLimitMatcher({
		prompt: "note: rate limit handling",
	});
	strictEqual(echoed.push("stdout", "note: "), false);
	strictEqual(echoed.push("stdout", "rate limit handling\n"), false);
	strictEqual(echoed.push("stdout", "all done\n"), false);

	const plain = createRateLimitMatcher();
	strictEqual(plain.push("stdout", "upstream_status=429\n"), true);
});

test("Codex can back off and retry after rate-limit reports without being terminated", async () => {
	const children = [];
	try {
		const result = await defaultExecuteProvider(
			providerContext({
				timeoutMs: HANG_GUARD_MS,
				spawnFn: nodeProvider(
					'process.stderr.write("429 Too Many Requests: retrying after backoff\\n");\nsetTimeout(() => { process.stderr.write("retrying after another rate limit\\n"); setTimeout(() => { process.stdout.write("completed after retries\\n"); }, 40); }, 20);\n',
					children,
				),
			}),
		);
		strictEqual(children.length, 1);
		strictEqual(result.success, true);
		strictEqual(result.rateLimited, false);
		strictEqual(result.terminationReason, "completed");
		strictEqual(result.output, "completed after retries\n");
		strictEqual(result.diagnosticCode, undefined);
	} finally {
		releaseChildren(children);
	}
});

function pendingRateLimitedChild({ onReport = () => {}, onKill }) {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = { end() {} };
	child.kill = (signal) => {
		onKill(signal);
		queueMicrotask(() => child.emit("close", null, signal));
		return true;
	};
	queueMicrotask(() => {
		child.stderr.emit("data", Buffer.from("429 Too Many Requests; retrying\n"));
		onReport();
	});
	return child;
}

test("Codex rate-limit backoff remains bounded by the provider deadline", async () => {
	const signals = [];
	const result = await defaultExecuteProvider(
		providerContext({
			timeoutMs: 40,
			spawnFn: () =>
				pendingRateLimitedChild({ onKill: (s) => signals.push(s) }),
		}),
	);
	strictEqual(result.success, false);
	strictEqual(result.timedOut, true);
	strictEqual(result.rateLimited, false);
	strictEqual(result.terminationReason, "deadline");
	strictEqual(signals[0], "SIGTERM");
});

test("cancellation interrupts Codex rate-limit backoff", async () => {
	const controller = new AbortController();
	const signals = [];
	const context = providerContext({
		spawnFn: () =>
			pendingRateLimitedChild({
				onReport: () => controller.abort("SIGTERM"),
				onKill: (s) => signals.push(s),
			}),
	});
	context.signal = controller.signal;
	const result = await defaultExecuteProvider(context);
	strictEqual(result.success, false);
	strictEqual(result.cancelled, true);
	strictEqual(result.rateLimited, false);
	strictEqual(result.terminationReason, "cancelled");
	strictEqual(signals[0], "SIGTERM");
});

test("stdout rate-limit words in a successful run are unaffected", async () => {
	const result = await defaultExecuteProvider(
		providerContext({
			spawnFn: () =>
				fakeChild({ stdout: "docs: the rate limit section is unchanged\n" }),
		}),
	);
	strictEqual(result.success, true);
	strictEqual(result.output.includes("rate limit"), true);
	strictEqual(result.diagnosticCode, undefined);
});

test("prompt text echoed on stdout never triggers the early stop", async () => {
	const prompt = "Remove the rate limit handling from a.txt\n";
	let killed = false;
	const result = await defaultExecuteProvider(
		providerContext({
			prompt,
			spawnFn: () =>
				fakeChild({
					stdout: prompt,
					onKill: () => {
						killed = true;
					},
				}),
		}),
	);
	strictEqual(result.success, true);
	strictEqual(killed, false);
});

test("a provider with no rate-limit report behaves exactly as before", async () => {
	const children = [];
	try {
		const result = await defaultExecuteProvider(
			providerContext({
				spawnFn: nodeProvider(
					'process.stdout.write("changed a.txt\\n");\nprocess.stderr.write("note: all good\\n");\n',
					children,
				),
			}),
		);
		strictEqual(result.success, true);
		strictEqual(result.output, "changed a.txt\n");
		strictEqual(result.stderr, "note: all good\n");
		strictEqual(result.rateLimited, false);
		strictEqual(result.terminationReason, "completed");
		strictEqual(result.diagnosticCode, undefined);
	} finally {
		releaseChildren(children);
	}
});
