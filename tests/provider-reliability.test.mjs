import { deepStrictEqual, strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
	classifyProviderStreams,
	providerDiagnosticCodeForKind,
} from "../src/switchyard/adapter/exec-error.mjs";
import { sanitizeFailureMetadata } from "../src/switchyard/adapter/exec-error-sanitize.mjs";
import { executeProviderInvocation } from "../src/switchyard/adapter/provider-lifecycle-invocation.mjs";
import {
	createProviderReliabilityDiagnostic,
	isProviderReliabilityDiagnostic,
} from "../src/switchyard/diagnostics/provider-reliability.mjs";
import { SIMPLE_TARGET_ADAPTERS } from "../src/switchyard/simple/args.mjs";
import {
	parseOpenCodeGoBridgeDiagnosticEvidence,
	providerCodeForOpenCodeGoBridgeEvidence,
} from "../src/switchyard/simple/provider-invocation.mjs";

describe("provider reliability record", () => {
	it("keeps one closed, content-free record across all direct provider CLIs", () => {
		const providers = [
			["claude", "claude"],
			["codex", "codex"],
			["agy", "agy"],
			["cursor", "cursor-agent"],
			["copilot", "copilot"],
			["opencode", "opencode"],
			["vibe", "vibe"],
		];
		for (const [provider, binary] of providers) {
			const evidence = classifyProviderStreams({
				stderr: "Authentication required\n",
				code: 1,
				provider,
				command: `/approved/bin/${binary}`,
			});
			strictEqual(
				providerDiagnosticCodeForKind(evidence.diagnosticKind),
				"auth_expired",
				`${provider} should use its own approved binary pair`,
			);
		}
		const agyTargets = SIMPLE_TARGET_ADAPTERS.filter(
			(adapter) => adapter.harness === "agy",
		).map((adapter) => adapter.targetId);
		deepStrictEqual(agyTargets, ["antigravity", "antigravity-claude"]);
		for (const targetId of agyTargets) {
			strictEqual(
				SIMPLE_TARGET_ADAPTERS.find((adapter) => adapter.targetId === targetId)
					?.harness,
				"agy",
			);
			const evidence = classifyProviderStreams({
				stderr: "Authentication required",
				code: 1,
				provider: "agy",
				command: "/approved/bin/agy",
			});
			strictEqual(
				providerDiagnosticCodeForKind(evidence.diagnosticKind),
				"auth_expired",
			);
		}
	});

	it("does not promote generic exits or wrapper output into provider faults", () => {
		const generic = classifyProviderStreams({
			stderr: "provider exited with an unspecified failure",
			code: 1,
			provider: "vibe",
			command: "/approved/bin/vibe",
		});
		strictEqual(providerDiagnosticCodeForKind(generic.diagnosticKind), null);
		const wrapper = classifyProviderStreams({
			stderr: "Authentication required",
			code: 1,
			provider: "vibe",
			command: "/approved/bin/bws-secret-exec",
		});
		strictEqual(providerDiagnosticCodeForKind(wrapper.diagnosticKind), null);
	});

	it("attributes quota only from an exact OpenCode Go bridge status receipt", () => {
		const quota = parseOpenCodeGoBridgeDiagnosticEvidence(
			"SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=2 upstream_status=429 proxy_rejections=0\n",
		);
		strictEqual(
			providerCodeForOpenCodeGoBridgeEvidence(quota),
			"quota_exhausted",
		);
		for (const line of [
			"SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=0 upstream_status=429 proxy_rejections=0",
			"SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=2 upstream_status=503 proxy_rejections=0",
			"SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=2 upstream_status=429 proxy_rejections=1",
			"proxy rejected request with status 429",
		]) {
			strictEqual(
				providerCodeForOpenCodeGoBridgeEvidence(
					parseOpenCodeGoBridgeDiagnosticEvidence(line),
				),
				null,
			);
		}
	});

	it("persists only bounded scalar evidence and ignores hostile fields", () => {
		const diagnostic = createProviderReliabilityDiagnostic({
			causeCode: "provider_exit_nonzero",
			phase: "provider",
			exitCode: 1,
			baselineStatus: "not_requested",
			providerOutput: "HOSTILE_PRIVATE_OUTPUT",
			prompt: "HOSTILE_PROMPT",
			path: "/private/path",
		});
		strictEqual(diagnostic.causeCategory, "unknown");
		strictEqual(diagnostic.causeCode, "provider_exit_nonzero");
		strictEqual(diagnostic.exitCode, 1);
		strictEqual(isProviderReliabilityDiagnostic(diagnostic), true);
		deepStrictEqual(
			Object.keys(diagnostic).sort(),
			[
				"baselineStatus",
				"cancelled",
				"causeCategory",
				"causeCode",
				"checkIdentity",
				"checkIndex",
				"diffRejectionCategory",
				"diffRejectionCount",
				"exitCode",
				"phase",
				"repairCount",
				"repairStatus",
				"signal",
				"timedOut",
				"version",
			].sort(),
		);
		const persisted = sanitizeFailureMetadata({
			result: "execution_failed",
			errorKind: "execution_failed",
			failurePhase: "provider_execution",
			providerReliability: diagnostic,
			message: "HOSTILE_PRIVATE_OUTPUT",
		});
		strictEqual(
			persisted.providerReliability.causeCode,
			"provider_exit_nonzero",
		);
		strictEqual(
			JSON.stringify(persisted).includes("HOSTILE_PRIVATE_OUTPUT"),
			false,
		);
		strictEqual(
			isProviderReliabilityDiagnostic({ ...diagnostic, extra: "no" }),
			false,
		);
	});

	it("attaches the same closed diagnostic through the shared VM invocation wrapper", async () => {
		const spawnFn = () => {
			const child = new EventEmitter();
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.stdin = { end() {}, write: () => true };
			child.pid = 43210;
			child.kill = () => true;
			queueMicrotask(() => {
				child.stderr.emit("data", Buffer.from("Authentication required\n"));
				child.emit("exit", 1, null);
				child.emit("close", 1, null);
			});
			return child;
		};
		const result = await executeProviderInvocation("claude", [], {
			provider: "claude",
			timeoutMs: 10_000,
			spawnFn,
			cleanup: async () => ({ cleanupFailed: false, postcondition: true }),
		});
		strictEqual(result.success, false);
		strictEqual(result.providerReliability.causeCode, "auth_expired");
		strictEqual(result.providerReliability.causeCategory, "provider");
		strictEqual(
			isProviderReliabilityDiagnostic(result.providerReliability),
			true,
		);
	});
});
