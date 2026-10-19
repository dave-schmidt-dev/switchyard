// @test-phase: other
import { strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { classifyProviderStreams } from "../src/switchyard/adapter/exec-error.mjs";
import { resolveFailure } from "../src/switchyard/diagnostics/failure-registry.mjs";
import { SIMPLE_TARGET_ADAPTERS } from "../src/switchyard/simple/args.mjs";
import {
	classifyExecutionFailure,
	defaultExecuteProvider,
} from "../src/switchyard/simple/provider-invocation.mjs";
import { createSimpleProviderReliabilityDiagnostic } from "../src/switchyard/simple/reliability.mjs";

// FAIL-6 (2026-10-18 stability audit, owner decision O5): a codex HTTP 401 is
// an auth cause. Before this, the bare 401 reached the record as
// `provider_exit_nonzero`, so it took the transient-exit health and retry path
// instead of asking for a re-login.

// Measured: the line codex's own logger emitted in the guest on 2026-09-12
// (see tests/exec-error.test.mjs). Here it stands alone, without the
// refresh-token re-login line that used to rescue the classification.
const CODEX_WEBSOCKET_401 =
	"2026-09-13T02:53:00.340379Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized";
// Not field-measured: the audit's refuter probed this shape, and codex 0.163.0
// carries its `unexpected status ` format string. Kept because it is the same
// HTTP 401 from codex's non-websocket path.
const CODEX_UNEXPECTED_STATUS_401 =
	"ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header";

const DESCRIPTORS = Object.freeze({
	codex: Object.freeze({
		target_id: "codex",
		selector: "gpt-5.3-codex-spark",
		invocation_args: [],
	}),
	claude: Object.freeze({
		target_id: "claude-code",
		selector: SIMPLE_TARGET_ADAPTERS.find(
			(item) => item.targetId === "claude-code",
		).selectors[0],
		invocation_args: ["--effort", "high"],
	}),
});

function fakeChild({ stderr = "", code = 1 }) {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = { end() {} };
	child.kill = () => true;
	queueMicrotask(() => {
		if (stderr) child.stderr.emit("data", Buffer.from(stderr));
		child.emit("close", code, null);
	});
	return child;
}

async function causeFor(harness, stderr) {
	const result = await defaultExecuteProvider({
		targetId: DESCRIPTORS[harness].target_id,
		harness,
		descriptor: DESCRIPTORS[harness],
		capability: "standard",
		prompt: "Apply the change.",
		worktreePath: process.cwd(),
		timeoutMs: 30_000,
		spawnFn: () => fakeChild({ stderr, code: 1 }),
	});
	strictEqual(result.success, false);
	const failureReason = classifyExecutionFailure(result);
	const reliability = createSimpleProviderReliabilityDiagnostic({
		failureReason,
		failurePhase: "execute",
		providerResult: result,
	});
	const resolved = resolveFailure({
		reason: failureReason,
		phase: "execute",
		providerResult: result,
	});
	return { result, failureReason, reliability, resolved };
}

for (const [label, stderr] of [
	["the measured websocket 401", `${CODEX_WEBSOCKET_401}\n`],
	["the unexpected-status 401", `${CODEX_UNEXPECTED_STATUS_401}\n`],
	[
		"a 401 among codex's own transport noise",
		[
			"2026-09-13T02:52:59.385044Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed",
			CODEX_WEBSOCKET_401,
			"",
		].join("\n"),
	],
]) {
	test(`a codex run that exits 1 on ${label} is auth_expired, not provider_exit_nonzero`, async () => {
		const { result, failureReason, reliability, resolved } = await causeFor(
			"codex",
			stderr,
		);
		strictEqual(result.diagnosticCode, "auth_expired");
		strictEqual(result.diagnosticOrigin, "adapter");
		strictEqual(result.providerSignature, "auth_failed");
		// The process outcome stays the plain exit; the adapter diagnostic names
		// the cause, exactly as for the other auth forms.
		strictEqual(failureReason, "provider_exit_nonzero");
		strictEqual(reliability.causeCode, "auth_expired");
		strictEqual(reliability.causeCategory, "provider");
		strictEqual(resolved.causeCode, "auth_expired");
	});
}

test("the same 401 line from another harness stays unclassified", async () => {
	const { result, reliability } = await causeFor(
		"claude",
		`${CODEX_WEBSOCKET_401}\n`,
	);
	strictEqual(result.diagnosticCode, undefined);
	strictEqual(reliability.causeCode, "provider_exit_nonzero");
});

test("401 text inside a longer codex line is not an auth artifact", async () => {
	for (const line of [
		`note: the fixture expects failed to connect to websocket: HTTP error: 401 Unauthorized`,
		`${CODEX_WEBSOCKET_401} (retrying)`,
		"src/api.test.ts: expected unexpected status 401 Unauthorized to be handled",
	]) {
		const { result, reliability } = await causeFor("codex", `${line}\n`);
		strictEqual(result.diagnosticCode, undefined, line);
		strictEqual(reliability.causeCode, "provider_exit_nonzero", line);
	}
});

test("a codex 401 beside a different recognized kind still refuses to classify", () => {
	const result = classifyProviderStreams({
		stderr: `${CODEX_WEBSOCKET_401}\nUsage limit reached\n`,
		code: 1,
		provider: "codex",
		command: "/opt/homebrew/bin/codex",
	});
	strictEqual(result.diagnosticKind, undefined);
});
