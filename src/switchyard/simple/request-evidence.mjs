import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";

export const REQUEST_EVENT_PREFIX = "SWITCHYARD_PROXY_REQUEST_V1 ";
export const REQUEST_END_PREFIX = "SWITCHYARD_PROXY_END_V1 ";
const OUTCOMES = new Set([
	"request_method_rejected",
	"request_route_rejected",
	"request_auth_rejected",
	"request_host_rejected",
	"request_body_error",
	"invalid_json",
	"model_rejected",
	"upstream_redirect_rejected",
	"upstream_http_success",
	"upstream_http_error",
	"upstream_response_too_large",
	"upstream_response_error",
	"upstream_timeout",
	"upstream_connection_error",
	"client_disconnected",
	"proxy_internal_error",
]);
const EVENT_KEYS = [
	"durationMs",
	"elapsedMs",
	"httpStatus",
	"outcome",
	"sequence",
	"upstreamStatus",
];
const MAX_PENDING_LINE_BYTES = 1024;

function validStatus(value) {
	return (
		value === null || (Number.isInteger(value) && value >= 100 && value <= 599)
	);
}

export function parseBridgeRequestEvent(line) {
	if (!line.startsWith(REQUEST_EVENT_PREFIX)) return null;
	const payload = line.slice(REQUEST_EVENT_PREFIX.length);
	if (Buffer.byteLength(payload) > MAX_PENDING_LINE_BYTES) return null;
	let event;
	try {
		event = JSON.parse(payload);
	} catch {
		return null;
	}
	if (
		!event ||
		Array.isArray(event) ||
		Object.keys(event).sort().join("\0") !== EVENT_KEYS.join("\0") ||
		!Number.isSafeInteger(event.sequence) ||
		event.sequence < 1 ||
		!Number.isSafeInteger(event.elapsedMs) ||
		event.elapsedMs < 0 ||
		!Number.isSafeInteger(event.durationMs) ||
		event.durationMs < 0 ||
		!OUTCOMES.has(event.outcome) ||
		!validStatus(event.httpStatus) ||
		!validStatus(event.upstreamStatus)
	)
		return null;
	return event;
}

// The bridge is a fixed, pinned producer. Reject unexpected event content and
// persist only the closed record, never provider output or request data.
export function createBridgeRequestRecorder(path) {
	const fd = openSync(path, "wx", 0o600);
	let pending = "";
	let count = 0;
	let highestSequence = 0;
	const seen = new Set();
	let sawEnd = false;
	let error = null;
	let closed = false;
	const accept = (chunk) => {
		if (closed || error) return;
		const segments = chunk.toString("utf8").split("\n");
		for (let index = 0; index < segments.length; index += 1) {
			pending += segments[index];
			if (Buffer.byteLength(pending) > MAX_PENDING_LINE_BYTES) {
				if (pending.startsWith(REQUEST_EVENT_PREFIX))
					error = "request_event_line_too_long";
				pending = "";
				if (error) return;
			}
			if (index === segments.length - 1) break;
			const line = pending;
			pending = "";
			if (line.startsWith(REQUEST_END_PREFIX)) {
				let end;
				try {
					end = JSON.parse(line.slice(REQUEST_END_PREFIX.length));
				} catch {
					error = "request_event_end_invalid";
					return;
				}
				if (
					sawEnd ||
					!end ||
					Array.isArray(end) ||
					Object.keys(end).join("") !== "requests" ||
					!Number.isSafeInteger(end.requests) ||
					end.requests < 0 ||
					end.requests !== count ||
					end.requests !== highestSequence
				) {
					error = "request_event_end_invalid";
					return;
				}
				try {
					writeSync(
						fd,
						`${JSON.stringify({ type: "end", requests: end.requests })}\n`,
					);
					fsyncSync(fd);
					sawEnd = true;
				} catch {
					error = "request_event_write_failed";
				}
				continue;
			}
			if (!line.startsWith(REQUEST_EVENT_PREFIX)) continue;
			if (sawEnd) {
				error = "request_event_after_end";
				return;
			}
			const event = parseBridgeRequestEvent(line);
			if (!event || seen.has(event.sequence)) {
				error = "request_event_invalid";
				return;
			}
			try {
				writeSync(fd, `${JSON.stringify(event)}\n`);
				fsyncSync(fd);
				seen.add(event.sequence);
				count += 1;
				highestSequence = Math.max(highestSequence, event.sequence);
			} catch {
				error = "request_event_write_failed";
				return;
			}
		}
	};
	const close = () => {
		if (closed) return { count, error };
		closed = true;
		if (
			pending.startsWith(REQUEST_EVENT_PREFIX) ||
			pending.startsWith(REQUEST_END_PREFIX)
		)
			error ??= "request_event_truncated";
		if (!sawEnd) error ??= "request_event_end_missing";
		try {
			closeSync(fd);
		} catch {
			error ??= "request_event_close_failed";
		}
		return { count, error };
	};
	return { accept, close };
}
