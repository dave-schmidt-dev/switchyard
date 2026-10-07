/** Upper bound on carried file names listed in the prompt note. */
const MAX_CARRIED_FILE_NAMES = 16;

// Only declared-file names enter the note: never diff text or anything else
// the earlier provider wrote.
function carriedNote(files) {
	if (!files.length) return "";
	const listed = files.slice(0, MAX_CARRIED_FILE_NAMES).join(", ");
	const more =
		files.length > MAX_CARRIED_FILE_NAMES
			? ` and ${files.length - MAX_CARRIED_FILE_NAMES} more`
			: "";
	return `\n\nThis checkout already contains unfinished work carried from an earlier attempt in: ${listed}${more}. That work is incomplete and has not passed the acceptance checks; review it, keep what is correct, and finish the task.`;
}

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
 * @param {string[]} [options.carriedFiles] Declared files already holding unfinished work carried from an earlier attempt (Task 3.11).
 * @param {boolean} [options.reportMode] Whether the run accepts exactly one report output.
 * @returns {string} The guarded prompt.
 */
export function buildGuardedPrompt({
	promptText,
	files,
	readOnlyInputs = [],
	checks = [],
	carriedFiles = [],
	reportMode = false,
}) {
	const readOnlyNotice = readOnlyInputs.length
		? ` Read-only input paths (do not modify): ${readOnlyInputs.join(", ")}.`
		: "";
	const scopeSentence = `${promptText}\n\nWork only in the current disposable checkout. Change only these writable files: ${files.join(", ")}.${readOnlyNotice} Do not delegate, plan recursively, commit, push, access credentials, or change any other path.`;
	const carried = carriedNote(carriedFiles);
	const reportSentence = reportMode
		? `\n\nThis is a report-mode run: produce exactly one output file, the report at ${files[0]}, and change no other path.`
		: "";
	if (!checks.length) return `${scopeSentence}${carried}${reportSentence}`;
	const checkLines = checks.map((command) => `- \`${command}\``).join("\n");
	return `${scopeSentence}${carried}${reportSentence}\n\nAfter you finish, these acceptance checks run against your candidate in an independent trusted checkout and must all pass. Write code that satisfies them, including formatting, import order, lint rules and types:\n${checkLines}`;
}
