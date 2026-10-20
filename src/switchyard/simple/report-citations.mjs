import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
} from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";

const MAX_REPORT_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 8 * MAX_SOURCE_BYTES;
const MAX_CITATIONS = 128;
const MAX_DIAGNOSTICS = 20;
const IDENTIFIER =
	/^(?:--[A-Za-z_][A-Za-z0-9_-]*|[A-Za-z_$][A-Za-z0-9_$.-]*)$/u;
const SENSITIVE =
	/(?:^|\/)(?:\.git|\.env[^/]*|\.ssh|\.aws|\.netrc|\.npmrc|auth\.json|secrets?(?:\.[^/]*)?|credentials(?:\.[^/]*)?|claude_desktop_config\.json|\.claude\.json)(?:\/|$)|\.(?:pem|key)$/iu;

function readSource(root, path, budget) {
	if (
		path.length > 1024 ||
		!/^[A-Za-z0-9_./+-]+$/u.test(path) ||
		path.startsWith("/") ||
		path.split("/").some((part) => !part || part === "." || part === "..") ||
		SENSITIVE.test(path)
	) {
		return { reason: "unsupported_path" };
	}
	let fd;
	try {
		let current = root;
		for (const part of path.split("/")) {
			current = join(current, part);
			if (lstatSync(current).isSymbolicLink())
				return { reason: "unsupported_path" };
		}
		// Never follow a final symlink or block on a special file.
		fd = openSync(
			current,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		const stat = fstatSync(fd);
		if (!stat.isFile()) return { reason: "unsupported_file" };
		if (
			stat.size > MAX_SOURCE_BYTES ||
			budget.bytes + stat.size > MAX_TOTAL_SOURCE_BYTES
		)
			return { reason: "source_limit" };
		const buffer = Buffer.alloc(stat.size + 1);
		const length = readSync(fd, buffer, 0, buffer.length, 0);
		budget.bytes += length;
		if (length > stat.size) return { reason: "source_limit" };
		if (length !== stat.size) return { reason: "source_unreadable" };
		const text = new TextDecoder("utf-8", { fatal: true }).decode(
			buffer.subarray(0, length),
		);
		if (text.includes("\0")) return { reason: "unsupported_file" };
		const lines = text.split(/\r?\n/u);
		if (lines.at(-1) === "") lines.pop();
		return { lines };
	} catch (error) {
		return {
			reason:
				error?.code === "ENOENT" || error?.code === "ENOTDIR"
					? "missing_file"
					: "source_unreadable",
		};
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function identifiersBefore(text) {
	// Sentence boundaries outside code delimit the association. Multiple code
	// identifiers are ambiguous; none is chosen just because one happens to match.
	const plain = text.replace(/`[^`]*`/gu, (value) => " ".repeat(value.length));
	const boundary = [...plain.matchAll(/[.;](?:\s|$)/gu)].at(-1);
	const clause = boundary ? text.slice(boundary.index + 1) : text;
	return [
		...new Set(
			[...clause.matchAll(/`([^`]+)`/gu)]
				.map((m) => m[1])
				.filter((value) => IDENTIFIER.test(value)),
		),
	];
}

function containsIdentifier(text, identifier) {
	const boundary = identifier.includes(".")
		? /[A-Za-z0-9_$.-]/u
		: /[A-Za-z0-9_$-]/u;
	let start = text.indexOf(identifier);
	while (start !== -1) {
		const before = text[start - 1] ?? "";
		const after = text[start + identifier.length] ?? "";
		if (!boundary.test(before) && !boundary.test(after)) return true;
		start = text.indexOf(identifier, start + 1);
	}
	return false;
}

/**
 * Check bounded citation text against a stopped, scope-validated checkout.
 * Supports repo-relative path:N[-M] tokens and Markdown link destinations.
 * Exactly one preceding inline-code identifier in the same sentence is compared
 * with the exact range (at most 100 lines). This is advisory lexical evidence,
 * never semantic validation; unsupported forms remain visibly unverifiable.
 * Returned diagnostics contain only report line numbers and closed reasons.
 */
export function checkReportCitations(reportBytes, checkoutRoot) {
	const result = {
		advisory: true,
		status: "unverifiable",
		citations: 0,
		matched: 0,
		mismatched: 0,
		unverifiable: 0,
		truncated: false,
		diagnostics: [],
	};
	const note = (reportLine, reason) => {
		if (result.diagnostics.length < MAX_DIAGNOSTICS)
			result.diagnostics.push({ reportLine, reason });
		else result.truncated = true;
	};
	if (reportBytes.length > MAX_REPORT_BYTES) {
		result.truncated = true;
		note(null, "report_limit");
		return result;
	}
	let report;
	try {
		report = new TextDecoder("utf-8", { fatal: true }).decode(reportBytes);
	} catch {
		note(null, "report_not_utf8");
		return result;
	}
	const sources = new Map();
	const budget = { bytes: 0 };
	let fence = null;
	for (const [lineIndex, line] of report.split(/\r?\n/u).entries()) {
		const marker = line.match(/^\s*(`{3,}|~{3,})/u)?.[1];
		if (marker) {
			if (!fence) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length)
				fence = null;
			continue;
		}
		if (fence) continue;
		let previousEnd = 0;
		for (const token of line.matchAll(
			/`([^`]+)`|\[[^[\]\n]*\]\(([^)\n]+)\)|([^\s`()[\]<>]+)/gu,
		)) {
			const value = (token[1] ?? token[2] ?? token[3]).replace(/[,.;]+$/u, "");
			if (!/(?::\d|#L\d)/u.test(value)) continue;
			if (result.citations === MAX_CITATIONS) {
				result.truncated = true;
				note(lineIndex + 1, "citation_limit");
				break;
			}
			result.citations += 1;
			const identifiers = identifiersBefore(
				line.slice(previousEnd, token.index),
			);
			previousEnd = token.index + token[0].length;
			let reason;
			let mismatch = false;
			const parsed = value.match(/^(.+):(\d+)(?:-(\d+))?$/u);
			if (!parsed) reason = "unsupported_citation";
			else {
				const [, path, first, last = first] = parsed;
				const start = Number(first);
				const end = Number(last);
				if (
					!Number.isSafeInteger(start) ||
					!Number.isSafeInteger(end) ||
					start < 1 ||
					end < start
				) {
					reason = "invalid_range";
					mismatch = true;
				} else if (end - start >= 100) reason = "range_limit";
				else {
					if (!sources.has(path))
						sources.set(path, readSource(checkoutRoot, path, budget));
					const source = sources.get(path);
					if (source.reason) {
						reason = source.reason;
						// A missing bare name can be a host:port or clock time.
						if (
							reason === "missing_file" &&
							!path.includes("/") &&
							!/\.[A-Za-z0-9]+$/u.test(path)
						)
							reason = "unsupported_citation";
						mismatch = reason === "missing_file";
					} else if (end > source.lines.length) {
						reason = "line_out_of_range";
						mismatch = true;
					} else if (identifiers.length !== 1)
						reason = identifiers.length
							? "ambiguous_identifier"
							: "no_identifier";
					else if (
						!containsIdentifier(
							source.lines.slice(start - 1, end).join("\n"),
							identifiers[0],
						)
					) {
						reason = "identifier_not_found";
						mismatch = true;
					}
				}
			}
			if (reason) {
				result[mismatch ? "mismatched" : "unverifiable"] += 1;
				note(lineIndex + 1, reason);
			} else result.matched += 1;
		}
		if (result.citations === MAX_CITATIONS && result.truncated) break;
	}
	if (!result.citations) note(null, "no_citations");
	result.status = result.mismatched
		? "issues"
		: result.unverifiable || result.truncated || !result.matched
			? "unverifiable"
			: "matched";
	return result;
}
