/**
 * Read and parse the machine-readable report a test-runner check wrote.
 *
 * Both parsers return one entry per test identity, or throw a `report_invalid`
 * error: a report that is malformed, incomplete, ambiguous, or names a file
 * outside the checkout never yields a partial set. Statuses are `passed`,
 * `failed`, `skipped` and `todo`; `abnormal` marks a failure that ended by a
 * timeout, a signal or an unexpected process exit rather than by an assertion.
 * Identity components escape a backslash, `:` and `>`, so two different tests never
 * share an identity through the `::` and ` > ` separators.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** Largest report read back from the checker runtime. */
const MAX_REPORT_BYTES = 32 * 1024 * 1024;
/** Most test entries one report may hold. */
const MAX_TESTS = 100_000;

function invalid(detail) {
	return Object.assign(new Error(`report_invalid: ${detail}`), {
		code: "report_invalid",
	});
}

/**
 * The report's text, or null when it is absent, not one regular file with a
 * single link (a planted symlink or hard link is never followed), or larger
 * than `maxBytes`. It opens without blocking, so a FIFO planted in place of
 * the report cannot hang the host.
 *
 * @param {string} path
 * @param {number} [maxBytes]
 * @returns {string|null}
 */
export function readReportFile(path, maxBytes = MAX_REPORT_BYTES) {
	let fd;
	try {
		fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch {
		return null;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) return null;
		const buffer = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < buffer.length) {
			const read = readSync(fd, buffer, offset, buffer.length - offset, null);
			if (read === 0) break;
			offset += read;
		}
		return offset === stat.size ? buffer.toString("utf8") : null;
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(value) {
	return value.replace(/&([^;&]{1,10});|&/gu, (_match, body) => {
		if (body === undefined) throw invalid("bare ampersand");
		if (Object.hasOwn(ENTITIES, body)) return ENTITIES[body];
		const numeric = /^#(?:x([0-9A-Fa-f]{1,6})|(\d{1,7}))$/u.exec(body);
		if (!numeric) throw invalid("unknown entity");
		const code = numeric[1]
			? Number.parseInt(numeric[1], 16)
			: Number.parseInt(numeric[2], 10);
		if (code > 0x10ffff) throw invalid("entity out of range");
		return String.fromCodePoint(code);
	});
}

const ATTRIBUTE = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/uy;

function parseTag(body) {
	const selfClosing = body.endsWith("/");
	const inner = selfClosing ? body.slice(0, -1) : body;
	const name = /^[A-Za-z_][\w.:-]*/u.exec(inner)?.[0];
	if (!name) throw invalid("tag name");
	const attributes = Object.create(null);
	ATTRIBUTE.lastIndex = name.length;
	let end = name.length;
	for (;;) {
		const match = ATTRIBUTE.exec(inner);
		if (match === null) break;
		if (Object.hasOwn(attributes, match[1]))
			throw invalid("repeated attribute");
		attributes[match[1]] = decodeEntities(match[2] ?? match[3]);
		end = ATTRIBUTE.lastIndex;
	}
	if (inner.slice(end).trim() !== "") throw invalid("attribute syntax");
	return { name, attributes, selfClosing };
}

/**
 * Element tags and non-blank text runs in document order; comments and
 * processing instructions are skipped. Text is yielded raw (`{text}`) and
 * CDATA as `{text, cdata: true}`.
 */
function* xmlTags(xml) {
	let index = 0;
	for (;;) {
		const open = xml.indexOf("<", index);
		const text = xml.slice(index, open === -1 ? xml.length : open);
		if (text.trim() !== "") yield { text };
		if (open === -1) return;
		for (const [start, stop] of [
			["<!--", "-->"],
			["<![CDATA[", "]]>"],
			["<?", "?>"],
		]) {
			if (xml.startsWith(start, open)) {
				const close = xml.indexOf(stop, open + start.length);
				if (close === -1) throw invalid("unterminated section");
				index = close + stop.length;
				if (start === "<![CDATA[") yield { text: "", cdata: true };
				break;
			}
		}
		if (index > open) continue;
		if (xml.startsWith("<!", open)) throw invalid("declaration");
		let cursor = open + 1;
		let quote = null;
		for (; cursor < xml.length; cursor += 1) {
			const char = xml[cursor];
			if (quote) {
				if (char === quote) quote = null;
			} else if (char === '"' || char === "'") quote = char;
			else if (char === "<") throw invalid("nested tag");
			else if (char === ">") break;
		}
		if (cursor >= xml.length) throw invalid("unterminated tag");
		const body = xml.slice(open + 1, cursor);
		index = cursor + 1;
		if (body.startsWith("/")) {
			const name = body.slice(1).trim();
			if (!/^[A-Za-z_][\w.:-]*$/u.test(name)) throw invalid("closing tag");
			yield { name, closing: true };
		} else yield parseTag(body);
	}
}

const COUNT = /^\d{1,7}$/u;

/** One identity component with the separator characters escaped. */
const idPart = (value) => value.replace(/[\\:>]/gu, "\\$&");

function addTest(tests, id, entry) {
	if (tests.has(id)) throw invalid("duplicate test id");
	if (tests.size >= MAX_TESTS) throw invalid("too many tests");
	tests.set(id, entry);
}

/**
 * Parse pytest's junit XML (`-o junit_family=xunit1`). Identity is
 * `<file>::<classname>::<name>`. The document must be one root element with
 * no stray text, and the testcase count must equal the sum of the
 * `testsuite tests=` attributes, so a truncated report is refused. A testcase
 * that is both skipped and failed (a skipped call with a teardown error) is
 * refused rather than given either status.
 *
 * @param {string} xml
 * @returns {Map<string, {status: string, file: string|null, abnormal: boolean}>}
 */
export function parsePytestJunit(xml) {
	if (typeof xml !== "string") throw invalid("not text");
	const tests = new Map();
	const open = [];
	let declared = 0;
	let suites = 0;
	let current = null;
	let rootClosed = false;
	const finish = () => {
		const { attributes } = current;
		if (typeof attributes.name !== "string" || attributes.name === "")
			throw invalid("testcase name");
		if (current.failed && current.skipped) throw invalid("mixed outcome");
		const file = attributes.file ?? null;
		const classname = attributes.classname ?? "";
		const status = current.failed
			? "failed"
			: current.skipped
				? "skipped"
				: "passed";
		addTest(
			tests,
			`${idPart(file ?? "")}::${idPart(classname)}::${idPart(attributes.name)}`,
			{ status, file, abnormal: false },
		);
		current = null;
	};
	for (const tag of xmlTags(xml)) {
		if (rootClosed) throw invalid("content after root");
		if (tag.text !== undefined) {
			if (open.length === 0) throw invalid("text outside root");
			if (!tag.cdata) decodeEntities(tag.text);
			continue;
		}
		if (tag.closing) {
			if (open.pop() !== tag.name) throw invalid("mismatched close");
			if (tag.name === "testcase") finish();
			rootClosed = open.length === 0;
			continue;
		}
		if (
			open.length === 0 &&
			tag.name !== "testsuites" &&
			tag.name !== "testsuite"
		)
			throw invalid("root element");
		if (tag.name === "testsuite") {
			if (current) throw invalid("suite inside testcase");
			if (!COUNT.test(tag.attributes.tests ?? "")) throw invalid("suite count");
			declared += Number(tag.attributes.tests);
			suites += 1;
		} else if (tag.name === "testcase") {
			if (current) throw invalid("nested testcase");
			current = { attributes: tag.attributes, failed: false, skipped: false };
		} else if (tag.name === "failure" || tag.name === "error") {
			if (!current) throw invalid("result outside testcase");
			current.failed = true;
		} else if (tag.name === "skipped") {
			if (!current) throw invalid("result outside testcase");
			current.skipped = true;
		}
		if (tag.selfClosing) {
			if (tag.name === "testcase") finish();
			rootClosed = open.length === 0;
		} else open.push(tag.name);
	}
	if (open.length > 0 || current) throw invalid("unterminated document");
	if (suites === 0 || declared !== tests.size) throw invalid("incomplete");
	return tests;
}

const NODE_STATUSES = new Set(["passed", "failed", "skipped", "todo"]);

/** The checkout-relative form of an absolute test file, or null outside it. */
function checkoutRelative(file, checkoutRoots) {
	for (const root of checkoutRoots) {
		const prefix = root.endsWith("/") ? root : `${root}/`;
		if (file.startsWith(prefix)) {
			const relative = file.slice(prefix.length);
			if (relative && !relative.split("/").includes("..")) return relative;
		}
	}
	return null;
}

/**
 * Parse the JSON-lines report of `nodeTestJsonReporter`. Identity is
 * `<checkout-relative file>::<suite path joined by " > ">`. The closing `end`
 * line must be present and count every entry, so a run that died before the
 * reporter finished is refused.
 *
 * @param {string} text
 * @param {string[]} checkoutRoots Absolute checkout paths, including its realpath.
 * @returns {Map<string, {status: string, file: string|null, abnormal: boolean}>}
 */
export function parseNodeTestReport(text, checkoutRoots) {
	if (typeof text !== "string") throw invalid("not text");
	const lines = text.split("\n");
	if (lines.at(-1) !== "") throw invalid("unterminated line");
	lines.pop();
	const tests = new Map();
	let ended = false;
	for (const line of lines) {
		if (ended) throw invalid("entry after end");
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			throw invalid("json");
		}
		if (entry?.end === true) {
			if (entry.count !== tests.size) throw invalid("count");
			ended = true;
			continue;
		}
		const { path, file, status, abnormal } = entry ?? {};
		if (
			!Array.isArray(path) ||
			path.length === 0 ||
			!path.every((name) => typeof name === "string") ||
			!NODE_STATUSES.has(status) ||
			typeof abnormal !== "boolean" ||
			(file !== null && typeof file !== "string")
		)
			throw invalid("entry shape");
		const relative =
			file === null ? null : checkoutRelative(file, checkoutRoots);
		if (file !== null && relative === null)
			throw invalid("file outside checkout");
		addTest(
			tests,
			`${idPart(relative ?? "")}::${path.map(idPart).join(" > ")}`,
			{ status, file: relative, abnormal },
		);
	}
	if (!ended) throw invalid("incomplete");
	return tests;
}

/**
 * A node:test custom reporter that writes one JSON line per finished test or
 * suite, then `{"end":true,"count":N}`. It rebuilds each test's suite path
 * with the same `test:start` nesting logic as node's own junit reporter, but
 * keeps every node's own result: junit turns a parent test into a
 * `<testsuite>` and drops a failure thrown by the parent itself. A failure is
 * `abnormal` unless node classified it as an ordinary test, hook, subtest or
 * cancelled-by-parent failure from a process that was not killed by a signal
 * and exited 0 or 1: a timeout, an abort (whose type is lost across process
 * isolation), or an unknown shape is abnormal.
 *
 * It is loaded from a `data:` URL as a standalone module, so it must not
 * reference anything outside its own body.
 *
 * @param {AsyncIterable<{type: string, data: object}>} source
 */
export async function* nodeTestJsonReporter(source) {
	const stack = [];
	let count = 0;
	const ordinaryFailures = new Set([
		"testCodeFailure",
		"subtestsFailed",
		"hookFailure",
		"cancelledByParent",
	]);
	const start = (name, nesting) => stack.push({ name, nesting });
	for await (const event of source) {
		const data = event?.data ?? {};
		if (event?.type === "test:start") start(data.name, data.nesting);
		else if (event?.type === "test:pass" || event?.type === "test:fail") {
			// No synthetic "root" parent (unlike junit): it would rename the test.
			const top = stack[stack.length - 1];
			if (!top || top.name !== data.name || top.nesting !== data.nesting)
				start(data.name, data.nesting);
			const path = stack.map((node) => String(node.name));
			if (stack[stack.length - 1].nesting === data.nesting) stack.pop();
			const marked = (value) => value !== undefined && value !== false;
			const error = data.details?.error;
			const exitCode = error?.exitCode;
			const abnormal =
				event.type === "test:fail" &&
				(!ordinaryFailures.has(error?.failureType) ||
					typeof error?.signal === "string" ||
					(Number.isInteger(exitCode) && exitCode !== 0 && exitCode !== 1));
			const status = marked(data.todo)
				? "todo"
				: marked(data.skip)
					? "skipped"
					: event.type === "test:fail"
						? "failed"
						: "passed";
			count += 1;
			yield `${JSON.stringify({
				path,
				file: typeof data.file === "string" ? data.file : null,
				type: data.details?.type === "suite" ? "suite" : "test",
				status,
				abnormal,
			})}\n`;
		}
	}
	yield `${JSON.stringify({ end: true, count })}\n`;
}

/**
 * `--test-reporter` specifier for `nodeTestJsonReporter`: a `data:` URL, so
 * the host never writes a module where check code could redirect the write.
 */
export const NODE_TEST_REPORTER_URL = `data:text/javascript;base64,${Buffer.from(
	`export default ${nodeTestJsonReporter.toString()};\n`,
).toString("base64")}`;
