import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	classifyProviderDiagnostic,
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

describe("describeExecError — provider-scoped quota classification", () => {
	it("classifies the verified Agy phrase with a dynamic suffix", () => {
		const described = describeExecError(
			fakeExecError({
				stdout: "Individual quota reached; retry after the reset window",
				code: 1,
			}),
			{ provider: "agy" },
		);

		strictEqual(described.errorKind, "quota_exhausted");
		ok(described.error.includes("Individual quota reached"));
	});

	it("classifies Cursor only when both verified usage markers are present", () => {
		const described = describeExecError(
			fakeExecError({
				stderr: "Request denied: out-of-usage; your limit is unavailable",
				code: 1,
			}),
			{ provider: "cursor" },
		);

		strictEqual(described.errorKind, "quota_exhausted");
	});

	it("rejects near misses, generic rate limits, and provider cross-talk", () => {
		const cases = [
			{ provider: "agy", output: "Quota reached", label: "Agy near miss" },
			{
				provider: "cursor",
				output: "out of usage",
				label: "Cursor missing limit marker",
			},
			{
				provider: "cursor",
				output: "your limit is unavailable",
				label: "Cursor missing usage marker",
			},
			{
				provider: "unknown",
				output: "Individual quota reached",
				label: "unknown provider",
			},
			{
				provider: "agy",
				output: "HTTP 429 rate limit exceeded",
				label: "generic rate limit",
			},
		];

		for (const { provider, output, label } of cases) {
			const described = describeExecError(
				fakeExecError({ stdout: output, code: 1 }),
				{ provider },
			);
			strictEqual(described.errorKind, null, label);
		}
	});

	it("keeps auth precedence and leaves transport failures unclassified", () => {
		const auth = describeExecError(
			fakeExecError({
				stdout: "Authentication failed: individual quota reached",
				code: 1,
			}),
			{ provider: "agy" },
		);
		strictEqual(auth.errorKind, "auth_expired");

		const transport = describeExecError(
			fakeExecError({
				message: "spawnSync docker ETIMEDOUT",
				code: "ETIMEDOUT",
			}),
			{ provider: "agy" },
		);
		strictEqual(transport.errorKind, null);
	});

	it("persists quota as static metadata without provider text", () => {
		const metadata = sanitizeFailureMetadata({
			taskId: "5.4",
			result: "execution_failed",
			errorKind: "quota_exhausted",
		});

		deepStrictEqual(metadata, {
			errorKind: "quota_exhausted",
			reasonCode: "quota_exhausted",
			reason:
				"Provider quota is exhausted; the target is unavailable for this attempt.",
		});
		ok(isPersistentFailureMetadata(metadata));
	});
});

// Measured 2026-08-13: a working container rejected a model the standing
// container dispatches fine. Every such dispatch was booked as a generic
// execution_failed whose static ledger reason ("Provider execution failed
// before a reviewed integration") is indistinguishable from a model that
// actually ran and failed — so it had to be re-diagnosed by hand. This class
// now has its own bounded kind, which is the only way the real cause can cross
// the persistence boundary: the provider's own text never does.
//
// The kind earns its place because of HOW agy fails here. It fetches its model
// catalog live and falls back to the list compiled into the binary when that
// fetch does not succeed, with no error of any sort — so a fetch failure
// arrives disguised as an unknown model. (Verified 2026-08-14: the 1.1.12
// binary in `switchyard-agent:latest` carries `gemini-3.6` literals and zero
// `gemini-3.7`, so a container listing 3.7 has demonstrably fetched.) The
// original diagnosis blamed provisioning; that was disproved the same day —
// see the comment in adapter/exec-error.mjs — which is why nothing here
// asserts a cause beyond the CLI's own refusal.
//
// The constant below is the verbatim stderr of a live 2026-08-14 probe against
// the standing container (agy 1.1.13, `--model <nonexistent>`), with the probe's
// throwaway model id swapped for a real one — so this asserts the classifier
// against the CLI's actual wording, not a transcription of it.
//
// Note the real message is multi-line and prefixes the phrase with an "invalid
// model selection (--model … --effort …)" clause. Matching a fragment in the
// middle of it is deliberate: the surrounding clause carries the model id and
// the CLI's full catalog, neither of which may be persisted.
describe("describeExecError — provider-scoped unresolvable-model classification", () => {
	const AGY_UNKNOWN_MODEL_STDERR = [
		'Error: invalid model selection (--model "gemini-3.7-flash-medium" --effort ""): model gemini-3.7-flash-medium is not recognized as a known model or custom model in settings',
		"Available models:",
		"  Gemini 3.6 Flash (High)",
	].join("\n");

	it("classifies the verified Agy phrase and keeps the provider's own words in the transient reason", () => {
		const described = describeExecError(
			fakeExecError({ stderr: AGY_UNKNOWN_MODEL_STDERR, code: 1 }),
			{ provider: "agy" },
		);

		strictEqual(described.errorKind, "model_unavailable");
		ok(described.error.includes("is not recognized as a known model"));
	});

	it("rejects near misses and provider cross-talk", () => {
		const cases = [
			{
				provider: "agy",
				output: "Error: model 'x' is not recognized",
				label: "truncated phrase",
			},
			{
				provider: "agy",
				output: "Error: unknown model 'x'",
				label: "different wording",
			},
			{
				provider: "claude",
				output: AGY_UNKNOWN_MODEL_STDERR,
				label: "another provider's CLI",
			},
			{
				provider: undefined,
				output: AGY_UNKNOWN_MODEL_STDERR,
				label: "no provider",
			},
		];

		for (const { provider, output, label } of cases) {
			const described = describeExecError(
				fakeExecError({ stdout: output, code: 1 }),
				{ provider },
			);
			strictEqual(described.errorKind, null, label);
		}
	});

	it("ranks below auth and quota, which explain a failure this one would only guess at", () => {
		const auth = describeExecError(
			fakeExecError({
				stdout: `Failed to authenticate. ${AGY_UNKNOWN_MODEL_STDERR}`,
				code: 1,
			}),
			{ provider: "agy" },
		);
		strictEqual(auth.errorKind, "auth_expired");

		const quota = describeExecError(
			fakeExecError({
				stdout: `Individual quota reached. ${AGY_UNKNOWN_MODEL_STDERR}`,
				code: 1,
			}),
			{ provider: "agy" },
		);
		strictEqual(quota.errorKind, "quota_exhausted");
	});

	it("persists as static metadata naming the catalog, not the model", () => {
		const metadata = sanitizeFailureMetadata({
			taskId: "1.1",
			result: "execution_failed",
			errorKind: "model_unavailable",
		});

		deepStrictEqual(metadata, {
			errorKind: "model_unavailable",
			reasonCode: "model_unavailable",
			reason:
				"The provider CLI did not resolve the dispatched model; its resolvable catalog is stale or incomplete for this attempt.",
		});
		ok(isPersistentFailureMetadata(metadata));
		// No model name, no provider text: the kind is the whole signal. And no
		// claim about WHY the catalog was short -- the classifier cannot see that,
		// and the first attempt at this string guessed wrong ("the working
		// container's provider state is incomplete", disproved 2026-08-14).
		ok(!metadata.reason.includes("gemini"));
		ok(!metadata.reason.includes("container"));
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
			["copilot", "copilot login"],
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
	it("retains only allowlisted structured execution diagnostics", () => {
		const metadata = sanitizeFailureMetadata({
			result: "execution_failed",
			errorKind: "execution_failed",
			diagnosticCode: "cli_usage_error",
			exitCode: 2,
			signal: "SECRET_CANARY_signal",
			failurePhase: "provider_execution",
		});

		deepStrictEqual(metadata, {
			errorKind: "execution_failed",
			reasonCode: "execution_failed",
			reason: "Provider execution failed before a reviewed integration.",
			diagnosticCode: "cli_usage_error",
			exitCode: 2,
			failurePhase: "provider_execution",
		});
		ok(isPersistentFailureMetadata(metadata));
		strictEqual(JSON.stringify(metadata).includes("SECRET_CANARY"), false);
	});

	it("classifies provider text without returning the text", () => {
		const code = classifyProviderDiagnostic({
			text: "SECRET_CANARY_x: unexpected argument --bad",
			exitCode: 2,
		});
		strictEqual(code, "cli_usage_error");
		strictEqual(code.includes("SECRET_CANARY"), false);
	});

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
