/**
 * Recognize an acceptance check that runs a test runner, and build the same
 * command with a machine-readable reporter attached.
 *
 * Only a plain argv qualifies: words of path-safe characters, no quoting,
 * expansion, redirection, separator, or leading environment assignment, so
 * nothing can hide what actually runs. Each runner admits a closed flag
 * allowlist; any other flag keeps the check strict, because it could truncate
 * the run (`-x`, `--maxfail`), depend on state (`--lf`, `--sw`,
 * `--test-rerun-failures`), fail for a reason other than a test (coverage
 * thresholds), or collide with the attached reporter.
 */

import { basename } from "node:path";

// Same grammar as the dry run's plain command, without `%`/`,` widening.
const PLAIN_ARGV = /^[A-Za-z0-9._/@:+=,\- ]+$/u;
const PYTHON = /^python(?:3(?:\.\d+)?)?$/u;
const WORD = /^[A-Za-z0-9_]+$/u;

const PYTEST_FLAGS = new Set([
	"-q",
	"-qq",
	"-v",
	"-vv",
	"-s",
	"-l",
	"--quiet",
	"--verbose",
	"--no-header",
	"--no-summary",
	"--disable-warnings",
	"--strict-markers",
]);
const PYTEST_VALUE_FLAGS = {
	"--tb": /^(?:auto|long|short|line|native|no)$/u,
	"--color": /^(?:yes|no|auto)$/u,
	"--import-mode": /^(?:prepend|append|importlib)$/u,
	"--durations": /^\d{1,4}$/u,
	"--ignore": null,
	"--deselect": null,
};
// Flags whose value is the next word.
const PYTEST_SPLIT_FLAGS = {
	"-p": /^no:cacheprovider$/u,
	"-k": WORD,
	"-m": WORD,
	"-n": /^(?:\d{1,3}|auto)$/u,
};
const NODE_FLAGS = new Set([
	"--test",
	"--test-only",
	"--test-force-exit",
	"--experimental-test-module-mocks",
	"--experimental-strip-types",
	"--no-warnings",
	"--enable-source-maps",
]);
const NODE_VALUE_FLAGS = {
	"--test-concurrency": /^\d{1,3}$/u,
	"--test-timeout": /^\d{1,9}$/u,
	"--test-shard": /^\d{1,3}\/\d{1,3}$/u,
	"--test-isolation": /^(?:process|none)$/u,
	"--experimental-test-isolation": /^(?:process|none)$/u,
	"--test-name-pattern": WORD,
	"--test-skip-pattern": WORD,
};

/** A repo-relative path or pytest node id: no absolute path, `..`, or empty segment. */
function relativeTarget(word) {
	if (word.startsWith("-") || word.startsWith("/")) return false;
	const path = word.split("::")[0];
	return path
		.split("/")
		.every((segment, index, all) =>
			segment === "" ? index === all.length - 1 && index > 0 : segment !== "..",
		);
}

function valueFlagAllowed(word, table) {
	const separator = word.indexOf("=");
	if (separator === -1) return false;
	const name = word.slice(0, separator);
	if (!Object.hasOwn(table, name)) return false;
	const value = word.slice(separator + 1);
	const pattern = table[name];
	return (
		value !== "" && (pattern ? pattern.test(value) : relativeTarget(value))
	);
}

function pytestArgumentsAllowed(args) {
	for (let index = 0; index < args.length; index += 1) {
		const word = args[index];
		if (Object.hasOwn(PYTEST_SPLIT_FLAGS, word)) {
			const value = args[index + 1];
			if (value === undefined || !PYTEST_SPLIT_FLAGS[word].test(value))
				return false;
			index += 1;
		} else if (
			!(
				PYTEST_FLAGS.has(word) ||
				/^-r[A-Za-z]{1,8}$/u.test(word) ||
				valueFlagAllowed(word, PYTEST_VALUE_FLAGS) ||
				relativeTarget(word)
			)
		)
			return false;
	}
	return true;
}

function nodeArgumentsAllowed(args) {
	return (
		args.includes("--test") &&
		args.every(
			(word) =>
				NODE_FLAGS.has(word) ||
				valueFlagAllowed(word, NODE_VALUE_FLAGS) ||
				relativeTarget(word),
		)
	);
}

// Single-quoted shell word; the runtime path may contain spaces.
const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

/**
 * Classify a check command as a test-runner check.
 *
 * @param {string} command
 * @returns {{runner: "pytest"|"node"|"swift", eligible: boolean,
 *   reason: string|null, words: string[]}|null} Null when the command is not
 *   a recognized test runner; `eligible` false with a closed `reason`
 *   (`unsupported_runner`, `unsupported_arguments`) when it is one but must
 *   stay strict.
 */
export function testRunnerOf(command) {
	if (typeof command !== "string" || !PLAIN_ARGV.test(command)) return null;
	const words = command.trim().split(/ +/u);
	const head = basename(words[0] ?? "");
	if (words[0].includes("=")) return null;
	if (head === "pytest" || head === "py.test")
		return {
			runner: "pytest",
			words,
			...verdict(pytestArgumentsAllowed(words.slice(1))),
		};
	if (PYTHON.test(head) && words[1] === "-m" && words[2] === "pytest")
		return {
			runner: "pytest",
			words,
			...verdict(pytestArgumentsAllowed(words.slice(3))),
		};
	if (head === "node" && words.includes("--test"))
		return {
			runner: "node",
			words,
			...verdict(nodeArgumentsAllowed(words.slice(1))),
		};
	if (head === "swift" && words[1] === "test")
		return {
			runner: "swift",
			words,
			eligible: false,
			reason: "unsupported_runner",
		};
	return null;
}

function verdict(allowed) {
	return allowed
		? { eligible: true, reason: null }
		: { eligible: false, reason: "unsupported_arguments" };
}

/**
 * The shell command that runs an eligible check with its reporter attached.
 * The original argv is unchanged apart from the added reporter flags, which
 * never change whether the run passes: pytest gains a junit file (xunit1 keeps
 * each case's `file`) and `--maxfail=0`, so a configured `-x` cannot truncate
 * a red run; node keeps its spec output on stdout and adds the JSON-lines
 * reporter.
 *
 * @param {{runner: string, words: string[]}} plan From `testRunnerOf`.
 * @param {{reportPath: string, reporterPath?: string}} paths
 * @returns {string}
 */
export function reportingCommand(plan, { reportPath, reporterPath }) {
	const [head, ...rest] = plan.words;
	if (plan.runner === "pytest")
		return [
			...plan.words,
			shellQuote(`--junitxml=${reportPath}`),
			"-o",
			"junit_family=xunit1",
			"--maxfail=0",
		].join(" ");
	if (plan.runner === "node")
		return [
			head,
			"--test-reporter=spec",
			"--test-reporter-destination=stdout",
			shellQuote(`--test-reporter=${reporterPath}`),
			shellQuote(`--test-reporter-destination=${reportPath}`),
			...rest,
		].join(" ");
	throw new Error("unsupported_runner");
}
