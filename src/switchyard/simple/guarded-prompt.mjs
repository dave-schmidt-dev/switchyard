/**
 * Builds the guarded prompt handed to the simple provider.
 *
 * The prompt states the writable file scope, optional read-only input paths,
 * and the process guardrails. When acceptance checks are declared, they are
 * appended verbatim so the provider can write code that satisfies them,
 * including formatting, import order, lint rules and types.
 *
 * @param {object} options
 * @param {string} options.promptText Raw prompt text read from the prompt file.
 * @param {string[]} options.files Writable file paths the provider may change.
 * @param {string[]} [options.readOnlyInputs] Read-only input paths the provider must not modify.
 * @param {string[]} [options.checks] Acceptance check commands that run after the provider finishes.
 * @returns {string} The guarded prompt.
 */
export function buildGuardedPrompt({
	promptText,
	files,
	readOnlyInputs = [],
	checks = [],
}) {
	const readOnlyNotice = readOnlyInputs.length
		? ` Read-only input paths (do not modify): ${readOnlyInputs.join(", ")}.`
		: "";
	const scopeSentence = `${promptText}\n\nWork only in the current disposable checkout. Change only these writable files: ${files.join(", ")}.${readOnlyNotice} Do not delegate, plan recursively, commit, push, access credentials, or change any other path.`;
	if (!checks.length) return scopeSentence;
	const checkLines = checks.map((command) => `- \`${command}\``).join("\n");
	return `${scopeSentence}\n\nAfter you finish, these acceptance checks run against your candidate in an independent trusted checkout and must all pass. Write code that satisfies them, including formatting, import order, lint rules and types:\n${checkLines}`;
}
