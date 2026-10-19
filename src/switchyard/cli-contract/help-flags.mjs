// Read the flags a provider CLI says it accepts, and the flags an argv uses.
//
// Only option-definition lines count: a help line whose first non-blank
// character is `-` (`  -m, --model <MODEL>`, `      --auto   ...`). Flags named
// in prose ("requires --continue") are deliberately ignored, so a flag that was
// removed but is still mentioned in another option's description reads as
// absent, which is the drift this contract exists to catch.

const FLAG_TOKEN = /^(--?[A-Za-z0-9][A-Za-z0-9_-]*)(?:[=[].*)?$/u;
const NEGATABLE = /^--\[no-\]([A-Za-z0-9][A-Za-z0-9_-]*)/u;
// Definition lines are shallowly indented; a deeply indented line that starts
// with `-` is a wrapped description naming other flags (claude does this).
const MAX_DEFINITION_INDENT = 12;
// Value placeholders that may sit between flag aliases on a definition line:
// <MODEL>, [PROMPT], {a,b}, MODEL, <key=value>...
const PLACEHOLDER =
	/^(?:<[^>]*>|\[[^\]]*\]|\{[^}]*\}|[A-Z][A-Z0-9_]*)(?:\.\.\.)?,?$/u;

/** The set of flags declared on option-definition lines of `--help` output. */
export function parseHelpFlags(text) {
	const flags = new Set();
	for (const raw of String(text ?? "").split(/\r?\n/u)) {
		const line = raw.replace(/\t/gu, " ");
		const indent = /^ */u.exec(line)[0].length;
		if (line[indent] !== "-" || indent > MAX_DEFINITION_INDENT) continue;
		// Aliases and their placeholders come before the description, which
		// starts after the first run of two or more spaces.
		const head = line.trim().split(/\s{2,}/u)[0];
		for (const piece of head.split(/[\s,|]+/u)) {
			if (piece === "") continue;
			const negatable = NEGATABLE.exec(piece);
			if (negatable) {
				flags.add(`--${negatable[1]}`);
				flags.add(`--no-${negatable[1]}`);
				continue;
			}
			const match = FLAG_TOKEN.exec(piece);
			if (match) {
				flags.add(match[1]);
				continue;
			}
			if (!PLACEHOLDER.test(piece)) break;
		}
	}
	return flags;
}

/**
 * The flags one provider argv passes, in order and without duplicates. Values
 * and positionals are skipped: a flag never contains whitespace and always
 * starts with `-`; a lone `-` (stdin) or `--` is not a flag.
 */
export function argvFlags(argv) {
	const flags = [];
	for (const token of argv) {
		if (
			typeof token !== "string" ||
			!token.startsWith("-") ||
			token === "-" ||
			token === "--" ||
			/\s/u.test(token)
		)
			continue;
		const flag = token.split("=", 1)[0];
		if (!flags.includes(flag)) flags.push(flag);
	}
	return flags;
}

/**
 * The version token in `--version` text, or null. Same rule as
 * `extract_cli_version` in ops/macos-vm: the first word that starts with a
 * digit, with trailing punctuation dropped. One leading `v` is accepted and
 * dropped when a digit follows, so `opencode v2.0.32` reads as `2.0.32`.
 */
export function extractCliVersion(text) {
	for (const word of String(text ?? "").split(/\s+/u)) {
		const trimmed = word
			.replace(/[^0-9A-Za-z]+$/u, "")
			.replace(/^[vV](?=[0-9])/u, "");
		if (/^[0-9][0-9A-Za-z.+_-]*$/u.test(trimmed)) return trimmed;
	}
	return null;
}
