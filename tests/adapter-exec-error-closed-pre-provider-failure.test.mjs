// @test-phase: other
import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	classifyPreProviderFailure,
	describeExecError,
	isPersistentFailureMetadata,
	PRE_PROVIDER_FAILURE_TRIPLES,
	sanitizeFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";

describe("closed pre-provider failure triples", () => {
	it("enumerates only triples that round-trip through the persistence boundary", () => {
		for (const triple of PRE_PROVIDER_FAILURE_TRIPLES) {
			const failure = sanitizeFailureMetadata({
				result: "launch_failed",
				...triple,
			});
			strictEqual(failure.diagnosticCode, triple.diagnosticCode);
			strictEqual(failure.errorKind, triple.errorKind);
			strictEqual(failure.failurePhase, triple.failurePhase);
			ok(isPersistentFailureMetadata(failure));
		}
	});

	it("classifies fixed categories without retaining lock owners, paths, or messages", () => {
		const dynamic = Object.assign(
			new Error("project lock held by pid 4242 at /private/secret prompt"),
			{ name: "LockError", code: "PROJECT_LOCK_HELD" },
		);
		deepStrictEqual(classifyPreProviderFailure(dynamic), {
			diagnosticCode: "project_lock_held",
			errorKind: "project_lock_failed",
			failurePhase: "project_lock",
		});
		const persisted = JSON.stringify(
			sanitizeFailureMetadata({
				result: "launch_failed",
				...classifyPreProviderFailure(dynamic),
			}),
		);
		ok(!persisted.includes("4242"));
		ok(!persisted.includes("/private/secret"));
		ok(!persisted.includes("prompt"));

		const arbitrary = Object.assign(new Error("/private/canary"), {
			name: "CheckpointIdentityError",
			code: "checkpoint_arbitrary_canary",
		});
		strictEqual(classifyPreProviderFailure(arbitrary), null);
		// Error types retired with the VM and queue lanes no longer classify.
		const retired = Object.assign(new Error("dependency-blocked:9.9"), {
			name: "TaskSelectionError",
			code: "dependency-blocked:9.9",
		});
		strictEqual(classifyPreProviderFailure(retired), null);
	});
});

function fakeExecError({ message, stdout = "", stderr = "", code } = {}) {
	const err = new Error(message ?? "Command failed: docker exec -i …");
	if (stdout) err.stdout = stdout;
	if (stderr) err.stderr = stderr;
	if (code !== undefined) err.code = code;
	return err;
}

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
		match(described.error, /npm run auth/);
		match(described.error, /claude auth login/);
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

	it("classifies a rotated-out codex refresh token, not a bare execution failure", () => {
		// Measured in switchyard-golden-6 on 2026-09-12. Before this phrase was
		// an auth signature, errorKind came back null, the persisted reasonCode
		// was `execution_failed`, and the operator's FAIL line said only
		// "Provider execution failed before a reviewed integration."
		const stderr = [
			"2026-09-13T02:52:59.395795Z ERROR codex_login::auth::manager: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
			"2026-09-13T02:53:00.340379Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized",
			"ERROR: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
			"",
		].join("\n");
		const described = describeExecError(fakeExecError({ stderr, code: 1 }), {
			provider: "codex",
		});
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
