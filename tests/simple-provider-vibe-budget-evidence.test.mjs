import { strict as assert } from "node:assert";
import { test } from "node:test";
import { providerCodeForVibeBudgetEvidence } from "../src/switchyard/simple/provider-invocation.mjs";

// Captured from a real 402 while the Mistral API allowance was exhausted.
const REAL_402 = `SWITCHYARD_PROXY_REQUEST_V1 {"sequence":3,"outcome":"upstream_http_error","httpStatus":402,"upstreamStatus":402}
Error: API error from mistral (model: zai-glm-5-3): LLM backend error [mistral]
  status: 402 Payment Required
  reason: Payment Required
  provider_message: API budget exhausted.
  body_excerpt: {"object":"error","message":"API budget exhausted.","type":"billing_api_budget_exhausted","param":null,"code":"2303","raw_status_code":402}
`;

test("Vibe 402 budget-exhausted block maps to quota_exhausted", () => {
	assert.equal(providerCodeForVibeBudgetEvidence(REAL_402), "quota_exhausted");
	assert.equal(
		providerCodeForVibeBudgetEvidence(
			REAL_402.replace("billing_api_budget", "billing_vibe_budget"),
		),
		"quota_exhausted",
	);
});

test("Vibe 401, 403 and 404 blocks map to auth_expired and model_unavailable", () => {
	const withStatus = (statusLine) =>
		REAL_402.replace("402 Payment Required", statusLine).replace(
			/"type":"billing_api_budget_exhausted"/u,
			'"type":"other"',
		);
	assert.equal(
		providerCodeForVibeBudgetEvidence(withStatus("401 Unauthorized")),
		"auth_expired",
	);
	assert.equal(
		providerCodeForVibeBudgetEvidence(withStatus("403 Forbidden")),
		"auth_expired",
	);
	assert.equal(
		providerCodeForVibeBudgetEvidence(withStatus("404 Not Found")),
		"model_unavailable",
	);
});

test("other Vibe failures and lookalike text are not budget evidence", () => {
	const cases = [
		undefined,
		"",
		"Error: API error from mistral\n  status: 429 Too Many Requests\n",
		REAL_402.replace("402 Payment Required", "500 Internal Server Error"),
		REAL_402.replace(
			/"type":"billing_api_budget_exhausted"/u,
			'"type":"other"',
		),
		// A model quoting the phrase is not Vibe's own error block.
		'the model said status: 402 Payment Required "type":"billing_api_budget_exhausted"',
		"x".repeat(1_000_001),
	];
	for (const value of cases)
		assert.equal(providerCodeForVibeBudgetEvidence(value), null);
});
