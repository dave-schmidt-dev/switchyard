/**
 * Read and parse the machine-readable report a test-runner check wrote.
 *
 * Both parsers return one entry per test identity, or throw a `report_invalid`
 * error: a report that is malformed, incomplete, ambiguous, or names a file
 * outside the checkout never yields a partial set. Statuses are `passed`,
 * `failed`, `skipped` and `todo`.
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
 * than `maxBytes`.
 *
 * @param {string} path
 * @param {number} [maxBytes]
 * @returns {string|null}
 */
export function readReportFile(path, maxBytes = MAX_REPORT_BYTES) {
	let fd;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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

/** Element tags in document order; text, comments and declarations are skipped. */
function* xmlTags(xml) {
	let index = 0;
	for (;;) {
		const open = xml.indexOf("<", index);
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

function addTest(tests, id, entry) {
	if (tests.has(id)) throw invalid("duplicate test id");
	if (tests.size >= MAX_TESTS) throw invalid("too many tests");
	tests.set(id, entry);
}

/**
 * Parse pytest's junit XML (`-o junit_family=xunit1`). Identity is
 * `<file>::<classname>::<name>`. The testcase count must equal the sum of the
 * `testsuite tests=` attributes, so a truncated report is refused.
 *
 * @param {string} xml
 * @returns {Map<string, {status: string, file: string|null}>}
 */
export function parsePytestJunit(xml) {
	if (typeof xml !== "string") throw invalid("not text");
	const tests = new Map();
	const open = [];
	let declared = 0;
	let suites = 0;
	let current = null;
	const finish = () => {
		const { attributes } = current;
		if (typeof attributes.name !== "string" || attributes.name === "")
			throw invalid("testcase name");
		const file = attributes.file ?? null;
		const classname = attributes.classname ?? "";
		const status = current.failed
			? "failed"
			: current.skipped
				? "skipped"
				: "passed";
		addTest(tests, `${file ?? ""}::${classname}::${attributes.name}`, {
			status,
			file,
		});
		current = null;
	};
	for (const tag of xmlTags(xml)) {
		if (tag.closing) {
			if (open.pop() !== tag.name) throw invalid("mismatched close");
			if (tag.name === "testcase") finish();
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
 * @returns {Map<string, {status: string, file: string|null}>}
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
		const { path, file, status } = entry ?? {};
		if (
			!Array.isArray(path) ||
			path.length === 0 ||
			!path.every((name) => typeof name === "string") ||
			!NODE_STATUSES.has(status) ||
			(file !== null && typeof file !== "string")
		)
			throw invalid("entry shape");
		const relative =
			file === null ? null : checkoutRelative(file, checkoutRoots);
		if (file !== null && relative === null)
			throw invalid("file outside checkout");
		addTest(tests, `${relative ?? ""}::${path.join(" > ")}`, {
			status,
			file: relative,
		});
	}
	if (!ended) throw invalid("incomplete");
	return tests;
}

/**
 * A node:test custom reporter that writes one JSON line per finished test or
 * suite, then `{"end":true,"count":N}`. It rebuilds each test's suite path
 * with the same `test:start` nesting logic as node's own junit reporter, but
 * keeps every node's own result: junit turns a parent test into a
 * `<testsuite>` and drops a failure thrown by the parent itself.
 *
 * It is serialized into the checker runtime as a standalone module, so it
 * must not reference anything outside its own body.
 *
 * @param {AsyncIterable<{type: string, data: object}>} source
 */
export async function* nodeTestJsonReporter(source) {
	const stack = [];
	let count = 0;
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
			})}\n`;
		}
	}
	yield `${JSON.stringify({ end: true, count })}\n`;
}

/** Module source written into the checker runtime for `--test-reporter`. */
export const NODE_TEST_REPORTER_SOURCE = `export default ${nodeTestJsonReporter.toString()};\n`;
