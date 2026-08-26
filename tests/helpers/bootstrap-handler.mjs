// Shared harness for asserting against worker-bootstrap's real handlers.
//
// worker-bootstrap.mjs cannot be imported: it is a bare top-level script that
// parses process.argv and calls process.exit on the spot, so importing it
// would kill the test runner. These helpers slice the shipped handler body out
// of the source and execute it, so assertions bind to the code that actually
// runs rather than to a copy of it that can drift.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	CLEANUP_STAGES,
	PERSISTED_SIGNALS,
} from "../../src/switchyard/adapter/exec-error.mjs";

export const BOOTSTRAP_PATH = resolve(
	"src/switchyard/dispatch/worker-bootstrap.mjs",
);
export const BOOTSTRAP_SOURCE = readFileSync(BOOTSTRAP_PATH, "utf8");

/**
 * Slice a brace-balanced arrow-function body out of the bootstrap source,
 * ignoring braces that appear inside string or template literals. Returns the
 * body text between the opening `{` and its matching `}`.
 */
export function extractHandlerBody(source, header) {
	const start = source.indexOf(header);
	if (start < 0) throw new Error(`handler not found: ${header}`);
	let i = source.indexOf("{", start + header.length - 1);
	const bodyStart = i + 1;
	let depth = 0;
	let quote = null;
	for (; i < source.length; i += 1) {
		const ch = source[i];
		if (quote) {
			if (ch === "\\") {
				i += 1;
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(bodyStart, i);
		}
	}
	throw new Error(`unbalanced handler body: ${header}`);
}

export function makeOnStatus() {
	const body = extractHandlerBody(BOOTSTRAP_SOURCE, "onStatus: (event) => {");
	const emitted = [];
	const runStore = {
		createEvent: (_runId, event) => {
			emitted.push(event);
			return Promise.resolve(1);
		},
	};
	const queueWrite = (fn) => fn();
	// The handler closes over two module-level vocabularies imported from
	// adapter/exec-error.mjs. They are injected as parameters rather than
	// restated here, so a change to either set is exercised by these tests
	// instead of being shadowed by a stale copy.
	const factory = new Function(
		"runStore",
		"runId",
		"queueWrite",
		"CLEANUP_STAGES",
		"PERSISTED_SIGNALS",
		`return (event) => {${body}};`,
	);
	return {
		onStatus: factory(
			runStore,
			"test-run",
			queueWrite,
			CLEANUP_STAGES,
			PERSISTED_SIGNALS,
		),
		emitted,
	};
}
