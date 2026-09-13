import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	checkpointRemediation,
	classifyProviderStreams,
	providerDiagnosticCodeForKind,
} from "../src/switchyard/adapter/exec-error.mjs";

const providers = [
	["claude", "claude"],
	["codex", "codex"],
	["agy", "agy"],
	["cursor", "cursor"],
	["cursor", "cursor-agent"],
	["copilot", "copilot"],
	["opencode", "opencode"],
	["vibe", "vibe"],
];

const corpus = [
	["Authentication required", "auth_required"],
	["Not logged in", "auth_required"],
	["Session expired", "auth_required"],
	[
		"Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
		"auth_required",
	],
	["Usage limit reached", "usage_exhausted"],
	["Quota exhausted", "usage_exhausted"],
	["Rate limit exceeded", "usage_exhausted"],
	["Model unavailable", "model_unsupported"],
	["Unsupported model", "model_unsupported"],
	["Model not found", "model_unsupported"],
	["Permission denied", "permission_denied"],
	["EACCES", "permission_denied"],
	["Network unreachable", "network_unreachable"],
	["Connection refused", "network_unreachable"],
	["Connection error", "network_unreachable"],
	["ENOTFOUND", "network_unreachable"],
];

function classify(stdout, stderr = "", options = {}) {
	return classifyProviderStreams({
		stdout,
		stderr,
		code: 1,
		provider: "claude",
		command: "/usr/bin/claude",
		...options,
	});
}

describe("durable provider stream diagnostics", () => {
	it("builds a closed checkpoint remedy with changed dimensions and a fresh path", () => {
		const remedy = checkpointRemediation("checkpoint_queue_identity_mismatch", {
			dimensions: ["queueIdentity"],
		});
		ok(remedy.includes("queue identity mismatch"));
		ok(remedy.includes("changed: queueIdentity"));
		ok(remedy.includes("create a fresh checkpoint explicitly"));
		ok(remedy.includes("switchyard-fresh.checkpoint.json"));
	});

	it("classifies every exact string variant, with optional Error and case folding", () => {
		for (const [line, code] of corpus) {
			for (const variant of [line, `Error: ${line}`, line.toLowerCase()]) {
				const result = classify(variant);
				strictEqual(result.diagnosticKind, code, variant);
				strictEqual(result.diagnosticCode, undefined, variant);
			}
		}
	});

	it("refuses to classify two recognized artifacts that disagree", () => {
		const same = classify(
			"Error: Session expired\nSESSION EXPIRED\n",
			"session expired\n",
		);
		strictEqual(same.diagnosticKind, "auth_required");

		for (const [stdout, stderr] of [
			["Session expired\n", "Permission denied\n"],
			["Session expired\nQuota exhausted\n", ""],
		]) {
			const result = classify(stdout, stderr);
			strictEqual(result.diagnosticKind, undefined);
			ok(result.stdoutDigest.startsWith("sha256:"));
			ok(result.stderrDigest.startsWith("sha256:"));
		}
	});

	it("reads a recognized artifact through the provider's own transport noise", () => {
		for (const [stdout, stderr] of [
			["Session expired\nextra provider text\n", ""],
			["", "extra provider text\nSession expired\n"],
		]) {
			const result = classify(stdout, stderr);
			strictEqual(result.diagnosticKind, "auth_required");
		}
	});

	it("names a rotated-out refresh token as an auth artifact, not a bare nonzero exit", () => {
		// The shape codex actually emitted in the guest on 2026-09-12: its own
		// timestamped logger lines and websocket 401s around two terminal
		// re-login lines. Only the terminal lines are an approved artifact.
		const stderr = [
			"2026-09-13T02:52:59.385044Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed",
			"2026-09-13T02:52:59.395795Z ERROR codex_login::auth::manager: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
			"2026-09-13T02:53:00.340379Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized",
			"ERROR: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
			"",
		].join("\n");
		const result = classifyProviderStreams({
			stdout: "",
			stderr,
			code: 1,
			provider: "codex",
			command: "/Users/switchyard/.local/bin/codex",
		});
		strictEqual(result.diagnosticKind, "auth_required");
		strictEqual(
			providerDiagnosticCodeForKind(result.diagnosticKind),
			"auth_expired",
		);
		ok(!Object.hasOwn(result, "stderr"));
		strictEqual(result.stderrBytes, Buffer.byteLength(stderr));
	});

	it("keeps stdout and stderr separate while authorizing agreeing streams", () => {
		const result = classify(
			Buffer.from("Authentication required\n"),
			"Error: Authentication required\n",
		);
		strictEqual(result.diagnosticKind, "auth_required");
		strictEqual(
			result.stdoutBytes,
			Buffer.byteLength("Authentication required\n"),
		);
		strictEqual(
			result.stderrBytes,
			Buffer.byteLength("Error: Authentication required\n"),
		);
		ok(!Object.hasOwn(result, "stdout"));
		ok(!Object.hasOwn(result, "stderr"));
	});

	it("does not let a pre-mapped code masquerade as parsed stream evidence", () => {
		const result = classifyProviderStreams({
			stdout: "provider output that is not an approved line\n",
			stderr: "",
			code: 1,
			provider: "claude",
			command: "/usr/bin/claude",
			diagnosticKind: "auth_required",
		});
		strictEqual(result.diagnosticCode, undefined);
	});

	it("accepts each approved provider-command binding", () => {
		for (const [provider, binary] of providers) {
			const result = classifyProviderStreams({
				stdout: "Error: Not logged in\n",
				code: 1,
				provider,
				command: `/usr/local/bin/${binary}`,
			});
			strictEqual(
				result.diagnosticKind,
				"auth_required",
				`${provider}/${binary}`,
			);
			strictEqual(result.diagnosticCode, undefined, `${provider}/${binary}`);
		}
	});

	it("rejects a provider, binary, or command binding that does not agree", () => {
		for (const overrides of [
			{ provider: "codex", command: "/usr/bin/claude" },
			{ provider: "claude", command: "/usr/bin/unknown" },
			{ provider: "claude", command: "/usr/bin/claude-wrapper" },
			{ provider: "unknown", command: "/usr/bin/claude" },
		]) {
			const result = classifyProviderStreams(
				"Session expired\n",
				"",
				overrides,
			);
			strictEqual(result.diagnosticKind, undefined);
			strictEqual(result.diagnosticCode, undefined);
		}
	});

	it("requires exit 2 and an exact approved-binary first usage line", () => {
		deepStrictEqual(
			classifyProviderStreams({
				stdout: "Usage: codex --model MODEL\noptions follow\n",
				code: 2,
				provider: "codex",
				command: "/usr/bin/codex",
			}).diagnosticKind,
			"cli_usage_error",
		);
		for (const overrides of [
			{ code: 1 },
			{ provider: "claude", command: "/usr/bin/codex" },
			{ provider: "codex", command: "/usr/bin/unknown" },
			{
				stdout: "usage: codex\n",
				provider: "codex",
				command: "/usr/bin/codex",
			},
			{
				stdout: "prefix\nUsage: codex\n",
				provider: "codex",
				command: "/usr/bin/codex",
			},
		]) {
			const result = classifyProviderStreams({
				stdout: "Usage: codex\n",
				code: 2,
				provider: "codex",
				command: "/usr/bin/codex",
				...overrides,
			});
			strictEqual(result.diagnosticKind, undefined);
			strictEqual(result.diagnosticCode, undefined);
		}
	});

	it("represents empty, mixed, and unmatched streams by digest/count only", () => {
		for (const result of [
			classifyProviderStreams({}),
			classify(
				"Session expired\nTOKEN=do-not-persist\n",
				"Permission denied\n",
			),
			classify("provider preamble\nno approved artifact here\n"),
		]) {
			strictEqual(Object.hasOwn(result, "diagnosticKind"), false);
			strictEqual(Object.hasOwn(result, "diagnosticCode"), false);
			strictEqual(Object.hasOwn(result, "TOKEN"), false);
			ok(Number.isSafeInteger(result.stdoutBytes));
			ok(Number.isSafeInteger(result.stderrBytes));
		}
	});
});
