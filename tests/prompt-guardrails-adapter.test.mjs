import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	addProviderPromptGuardrail,
	PROVIDER_PROMPT_GUARDRAIL,
} from "../src/switchyard/adapter/prompt-guardrails.mjs";

describe("provider prompt guardrails", () => {
	it("keeps the task prompt intact and adds package side-effect constraints", () => {
		const prompt = "Implement the requested change.\nFiles: src/example.mjs";
		const guarded = addProviderPromptGuardrail(prompt);
		strictEqual(guarded.startsWith(prompt), true);
		strictEqual(guarded.endsWith(PROVIDER_PROMPT_GUARDRAIL), true);
		strictEqual(guarded.includes("npm"), true);
		strictEqual(guarded.includes("npx"), true);
		strictEqual(guarded.includes("pnpm"), true);
		strictEqual(guarded.includes("yarn"), true);
		strictEqual(guarded.includes("lockfiles"), true);
		strictEqual(guarded.includes("seedable"), true);
		strictEqual(guarded.includes("force-add"), true);
		strictEqual(guarded.includes("Git-ignored"), true);
	});

	it("leaves non-string prompts unchanged for the adapter boundary", () => {
		strictEqual(addProviderPromptGuardrail(null), null);
		strictEqual(addProviderPromptGuardrail(undefined), undefined);
	});
});
