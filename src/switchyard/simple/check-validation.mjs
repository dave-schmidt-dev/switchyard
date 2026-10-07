import { isAbsolute, join, resolve, sep } from "node:path";
import { xcodebuildActions } from "../runner/checks-sandbox.mjs";
import { SimpleUsageError } from "./args.mjs";
import { commandWords } from "./check-execution.mjs";

const SHELL_KEYWORDS = new Set([
	"if",
	"then",
	"else",
	"elif",
	"while",
	"until",
	"do",
	"!",
]);
const DENIED_WORDS = new Set(["simctl", "codesign", "security"]);
const DENIED_SEQUENCES = [["xcrun", "simctl"]];
const OUT_OF_CLONE_ROOTS = [
	"/Users",
	"/private/var/folders",
	"/var/folders",
	"/tmp",
];
// SwiftPM's own manifest sandbox cannot nest inside the check sandbox and its
// default scratch and cache dirs sit outside the clone, so `swift build` must
// carry these flags.
const SWIFT_BUILD_HINT =
	"swift build --build-system native --disable-sandbox --scratch-path .sy/b --cache-path .sy/c";
const ABSOLUTE_SYSTEM_TOOLS = new Set([
	"/usr/bin/git",
	"/usr/bin/python3",
	"/usr/bin/make",
	"/usr/bin/swiftc",
	"/usr/bin/xcrun",
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

function toolName(word) {
	const separator = word.lastIndexOf("/");
	return separator === -1 ? word : word.slice(separator + 1);
}

function commandSegments(command) {
	const segments = [];
	let words = [];
	let word = "";
	let quote = null;
	const endWord = () => {
		if (word) words.push(word);
		word = "";
	};
	const endSegment = () => {
		endWord();
		if (words.length > 0) segments.push(words);
		words = [];
	};
	for (const char of command) {
		if (quote) {
			if (char === quote) quote = null;
			else word += char;
		} else if (char === "'" || char === '"') {
			quote = char;
		} else if (/\s/u.test(char)) {
			endWord();
		} else if (/[;&|(){}]/u.test(char)) {
			endSegment();
		} else {
			word += char;
		}
	}
	endSegment();
	return segments;
}

function invocationWords(segment) {
	const words = [];
	for (const token of segment) {
		if (words.length === 0) {
			if (
				ASSIGNMENT.test(token) ||
				SHELL_KEYWORDS.has(token) ||
				token.startsWith(">") ||
				token.startsWith("<")
			)
				continue;
		}
		words.push(token);
	}
	return words;
}

// SwiftPM accepts both `--flag value` and `--flag=value`.
function hasFlag(words, flag, value) {
	return words.some((word, index) => {
		if (word === flag) return value === undefined || words[index + 1] === value;
		return (
			word.startsWith(`${flag}=`) &&
			(value === undefined || word === `${flag}=${value}`)
		);
	});
}

function plainSwiftBuild(words) {
	return (
		words.length > 1 &&
		toolName(words[0]) === "swift" &&
		words[1] === "build" &&
		!(
			hasFlag(words, "--build-system", "native") &&
			hasFlag(words, "--disable-sandbox") &&
			hasFlag(words, "--scratch-path") &&
			hasFlag(words, "--cache-path")
		)
	);
}

// xcodebuild's test action boots simulators. Actions are read with the same
// parser that gates the sandbox's xcodebuild grants, so a flag value such as
// `-scheme test` is not an action; an unreadable invocation is refused when
// any word is `test`.
function xcodebuildTest(words) {
	if (toolName(words[0] ?? "") !== "xcodebuild") return false;
	const actions = xcodebuildActions(["xcodebuild", ...words.slice(1)]);
	return actions
		? actions.includes("test")
		: words.slice(1).some((word) => word === "test");
}

function insideDependency(projectPath, path) {
	return [".venv", "node_modules"].some((name) => {
		const root = join(projectPath, name);
		return path === root || path.startsWith(`${root}${sep}`);
	});
}

function underOutOfCloneRoot(path) {
	return OUT_OF_CLONE_ROOTS.some(
		(root) => path === root || path.startsWith(`${root}${sep}`),
	);
}

// A usage error that keeps its code: the CLI reports it as invalid_invocation
// with the message (naming the path or tool) and the exact preflight code.
function refused(code, message) {
	return Object.assign(new SimpleUsageError(message), { code });
}

/** Reject checks that cannot run inside the disposable checker clone. */
export function validateCheckCommand(command, projectPath) {
	if (commandWords(command) === null)
		throw new SimpleUsageError(
			`--check uses unsupported shell grammar ($(...), backticks, unbalanced quote or $/backslash in command position): ${command.slice(0, 80)}`,
		);
	const segments = commandSegments(command);
	for (const segment of segments) {
		for (const word of segment) {
			if (!isAbsolute(word)) continue;
			if (insideDependency(projectPath, resolve(word))) continue;
			if (underOutOfCloneRoot(word) || underOutOfCloneRoot(resolve(word)))
				throw refused(
					"check_out_of_clone_exec",
					`--check must not execute a host path outside the clone: ${word}`,
				);
		}
	}
	for (const segment of segments) {
		const words = invocationWords(segment);
		const head = toolName(words[0] ?? "");
		if (DENIED_WORDS.has(head))
			throw refused(
				"check_tool_denied",
				`--check uses a denied host tool: ${head}`,
			);
		if (plainSwiftBuild(words))
			throw refused(
				"check_tool_denied",
				`--check must run swift build as: ${SWIFT_BUILD_HINT}`,
			);
		if (xcodebuildTest(words))
			throw refused(
				"check_tool_denied",
				"--check uses a denied host tool: xcodebuild test",
			);
		for (const [tool, subcommand] of DENIED_SEQUENCES) {
			if (
				head === tool &&
				words.slice(1).some((word) => toolName(word) === subcommand)
			)
				throw refused(
					"check_tool_denied",
					`--check uses a denied host tool: ${tool} ${subcommand}`,
				);
		}
	}
	for (const segment of segments) {
		for (const word of segment) {
			if (ABSOLUTE_SYSTEM_TOOLS.has(word)) {
				const name = toolName(word);
				throw refused(
					"check_tool_denied",
					`--check must use the bare tool name (${name}) instead of ${word}`,
				);
			}
		}
	}
}
