// Shared provider prompt guardrails. These instructions are advisory: the
// integration gate remains authoritative and rejects any undeclared files.

export const PROVIDER_PROMPT_GUARDRAIL = [
	"Switchyard execution constraint: do not install or update dependencies, and do not modify package manifests or lockfiles unless the task explicitly declares that exact file in Files.",
	"A project-declared lifecycle hook may have prepared dependencies; you may run its ordinary verification command, but never use npm, npx, pnpm, yarn, bun, or another package manager to install or update packages.",
	"Keep edits limited to the task's declared Files allowlist; undeclared artifacts are rejected by the integration gate.",
].join("\n");

/**
 * Add the provider-side package-artifact guardrail without changing the task
 * prompt itself. The integration gate remains the enforcement boundary.
 * @param {unknown} prompt
 * @returns {unknown}
 */
export function addProviderPromptGuardrail(prompt) {
	if (typeof prompt !== "string") return prompt;
	return `${prompt}\n\n${PROVIDER_PROMPT_GUARDRAIL}`;
}
