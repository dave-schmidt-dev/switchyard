import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	describeExecError,
	isPersistentFailureMetadata,
	PERSISTED_ERROR_KINDS,
	reauthHintFor,
	sanitizeFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";
import { AGENT_CONTAINER_NAME } from "../src/switchyard/container/index.mjs";

// Build a thrown-error stand-in shaped like the object execFileSync attaches on
// a non-zero exit: a generic `.message` wrapper plus the captured `.stdout` /
// `.stderr`. No Docker and no live/expired token — the whole point of the
// classifier is that it operates on the captured streams, so it is unit-testable
// from a synthetic error (the incident it fixes was a cross-session investigation
// precisely because that information was being discarded).
function fakeExecError({ message, stdout = "", stderr = "", code } = {}) {
	const err = new Error(message ?? "Command failed: docker exec -i …");
	if (stdout) err.stdout = stdout;
	if (stderr) err.stderr = stderr;
	if (code !== undefined) err.code = code;
	return err;
}

// The exact string Claude Code printed to STDOUT (not stderr) with exit 1 in the
// real incident — the reason the presence-only pre-flight check passed and the
// failure only surfaced at dispatch time.
const CLAUDE_AUTH_EXPIRED_STDOUT =
	"Failed to authenticate: OAuth session expired and could not be refreshed";

describe("describeExecError — auth-expiry classification", () => {
	it("classifies an expired Claude OAuth session and attaches an actionable re-auth hint", () => {
		const described = describeExecError(
			fakeExecError({ stdout: CLAUDE_AUTH_EXPIRED_STDOUT, code: 1 }),
			{ provider: "claude" },
		);

		strictEqual(described.errorKind, "auth_expired");
		// The reason must carry the recovery command a human can actually run —
		// matching README's documented re-auth step verbatim — not the opaque
		// "Command failed: docker exec …" wrapper the ledger recorded before.
		match(described.error, /docker exec -it/);
		match(described.error, /claude auth login/);
		ok(described.error.includes(AGENT_CONTAINER_NAME));
		// The provider's own words survive alongside the hint, as evidence.
		ok(described.error.includes("OAuth session expired"));
		ok(!described.error.includes("Command failed"));
	});

	it("detects the auth signature on stderr as well as stdout", () => {
		const described = describeExecError(
			fakeExecError({ stderr: "Error: not authenticated", code: 1 }),
			{ provider: "codex" },
		);
		strictEqual(described.errorKind, "auth_expired");
		match(described.error, /codex login --device-auth/);
	});

	it("classifies auth expiry even without a provider, but adds no guessed hint", () => {
		const described = describeExecError(
			fakeExecError({ stdout: CLAUDE_AUTH_EXPIRED_STDOUT, code: 1 }),
			{},
		);
		strictEqual(described.errorKind, "auth_expired");
		// No provider → no re-auth command invented; just the raw provider output.
		strictEqual(described.error, CLAUDE_AUTH_EXPIRED_STDOUT);
	});
});

describe("describeExecError — general diagnosability", () => {
	it("surfaces the provider's real output for a NON-auth failure instead of Node's wrapper", () => {
		const described = describeExecError(
			fakeExecError({
				message: "Command failed: docker exec -i … claude --print",
				stdout: "Error: model 'claude-nonexistent' is not available",
				code: 1,
			}),
			{ provider: "claude" },
		);
		strictEqual(described.errorKind, null);
		ok(described.error.includes("model 'claude-nonexistent' is not available"));
		ok(!described.error.includes("Command failed"));
	});

	it("falls back to error.message only when the provider printed nothing", () => {
		const described = describeExecError(
			fakeExecError({ message: "Command failed: docker exec -i …", code: 1 }),
			{ provider: "claude" },
		);
		strictEqual(described.errorKind, null);
		strictEqual(described.error, "Command failed: docker exec -i …");
	});

	it("preserves stdout verbatim in the output field", () => {
		const described = describeExecError(
			fakeExecError({ stdout: "partial work here", stderr: "warn", code: 1 }),
			{ provider: "agy" },
		);
		strictEqual(described.output, "partial work here");
	});

	it("truncates a runaway provider dump so it cannot bloat the ledger line", () => {
		const huge = "x".repeat(5000);
		const described = describeExecError(
			fakeExecError({ stdout: huge, code: 1 }),
		);
		ok(described.error.length < huge.length);
		match(described.error, /truncated/);
	});
});

describe("reauthHintFor", () => {
	it("returns a TTY-attached docker login command for each known provider", () => {
		for (const [provider, needle] of [
			["claude", "claude auth login"],
			["codex", "codex login --device-auth"],
			["cursor", "cursor-agent login"],
			["copilot", "copilot auth login"],
			["opencode", "opencode auth login"],
			["agy", "agy --print hi"],
		]) {
			const hint = reauthHintFor(provider);
			ok(hint.includes(`docker exec -it ${AGENT_CONTAINER_NAME}`));
			ok(hint.includes(needle), `${provider} hint should include ${needle}`);
		}
	});

	it("returns null for an unknown provider rather than inventing a command", () => {
		strictEqual(reauthHintFor("nope"), null);
	});
});

describe("sanitizeFailureMetadata — persistence boundary", () => {
	it("maps an untrusted provider classification to static metadata and an opaque artifact ref", () => {
		const metadata = sanitizeFailureMetadata({
			taskId: "1.1",
			result: "execution_failed",
			errorKind: "provider_private_reason",
			partialDiffPath: "/Users/dave/project/.partial-diffs/1.1.diff",
		});

		strictEqual(metadata.errorKind, "execution_failed");
		strictEqual(metadata.reasonCode, "execution_failed");
		strictEqual(
			metadata.reason,
			"Provider execution failed before a reviewed integration.",
		);
		match(metadata.artifactRef, /^artifact:[a-f0-9]{24}$/);
		ok(!metadata.reason.includes("/Users/dave"));
		ok(isPersistentFailureMetadata(metadata));
	});

	it("retains the closed auth-expired enum without persisting the adapter's raw hint", () => {
		const metadata = sanitizeFailureMetadata({
			taskId: "1.2",
			result: "execution_failed",
			errorKind: "auth_expired",
		});

		deepStrictEqual(metadata, {
			errorKind: "auth_expired",
			reasonCode: "auth_expired",
			reason:
				"Provider authentication expired; interactive re-authentication is required.",
		});
		ok(PERSISTED_ERROR_KINDS.includes(metadata.errorKind));
	});

	it("does not create failure metadata for successful results", () => {
		strictEqual(sanitizeFailureMetadata({ result: "success" }), null);
		strictEqual(sanitizeFailureMetadata({ result: "success_no_diff" }), null);
	});

	it("rejects durable metadata carrying raw provider fields", () => {
		ok(
			!isPersistentFailureMetadata({
				errorKind: "execution_failed",
				reasonCode: "execution_failed",
				reason: "Provider execution failed before a reviewed integration.",
				output: "SECRET_CANARY_provider_output",
			}),
		);
	});
});
