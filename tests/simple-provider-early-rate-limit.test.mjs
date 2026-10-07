import { ok, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { resolveFailure } from "../src/switchyard/diagnostics/failure-registry.mjs";
import {
	classifyExecutionFailure,
	defaultExecuteProvider,
} from "../src/switchyard/simple/provider-invocation.mjs";
import {
	createRateLimitMatcher,
	RATE_LIMIT_TAIL_BYTES,
} from "../src/switchyard/simple/provider-signature.mjs";
import { createSimpleProviderReliabilityDiagnostic } from "../src/switchyard/simple/reliability.mjs";

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

test("a stderr rate-limit report stops the provider early and resolves quota_exhausted", async () => {
	const children = [];
	try {
		const startedAt = Date.now();
		const result = await defaultExecuteProvider(
			providerContext({
				spawnFn: nodeProvider(
					'process.stderr.write("429 Too Many Requests: rate limit exceeded\\n");\nsetTimeout(() => process.exit(0), 30_000);\n',
					children,
				),
			}),
		);
		const elapsedMs = Date.now() - startedAt;
		ok(elapsedMs < 2_000, `provider stopped after ${elapsedMs}ms`);

		strictEqual(result.success, false);
		strictEqual(result.rateLimited, true);
		strictEqual(result.terminationReason, "rate_limited");
		strictEqual(result.diagnosticCode, "quota_exhausted");
		strictEqual(result.diagnosticOrigin, "adapter");
		strictEqual(result.diagnosticEvidenceAvailable, true);
		strictEqual(result.providerSignature, "rate_limited");

		const failureReason = classifyExecutionFailure(result);
		const reliability = createSimpleProviderReliabilityDiagnostic({
			failureReason,
			failurePhase: "execute",
			providerResult: result,
		});
		strictEqual(reliability.causeCode, "quota_exhausted");
		strictEqual(reliability.causeCategory, "provider");
		strictEqual(reliability.phase, "provider");

		const resolved = resolveFailure({
			reason: failureReason,
			phase: "execute",
			providerResult: result,
		});
		strictEqual(resolved.causeCode, "quota_exhausted");
		strictEqual(resolved.causeCategory, "provider");
		strictEqual(resolved.providerCaused, true);
	} finally {
		releaseChildren(children);
	}
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
