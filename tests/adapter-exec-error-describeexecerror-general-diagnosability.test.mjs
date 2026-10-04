import { match, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	describeExecError,
	reauthHintFor,
} from "../src/switchyard/adapter/exec-error.mjs";

function fakeExecError({ message, stdout = "", stderr = "", code } = {}) {
	const err = new Error(message ?? "Command failed: docker exec -i …");
	if (stdout) err.stdout = stdout;
	if (stderr) err.stderr = stderr;
	if (code !== undefined) err.code = code;
	return err;
}

describe("describeExecError — general diagnosability", () => {
	it("surfaces the provider's real output for a NON-auth failure instead of Node's wrapper", () => {
		const described = describeExecError(
			fakeExecError({
				message: "Command failed: docker exec -i … claude --print",
				stdout: "Error: model 'claude-nonexistent' is not available",
				code: 1,
			}),
			{ provider: "claude" },
		);
		strictEqual(described.errorKind, null);
		ok(described.error.includes("model 'claude-nonexistent' is not available"));
		ok(!described.error.includes("Command failed"));
	});

	it("falls back to error.message only when the provider printed nothing", () => {
		const described = describeExecError(
			fakeExecError({ message: "Command failed: docker exec -i …", code: 1 }),
			{ provider: "claude" },
		);
		strictEqual(described.errorKind, null);
		strictEqual(described.error, "Command failed: docker exec -i …");
	});

	it("preserves stdout verbatim in the output field", () => {
		const described = describeExecError(
			fakeExecError({ stdout: "partial work here", stderr: "warn", code: 1 }),
			{ provider: "agy" },
		);
		strictEqual(described.output, "partial work here");
	});

	it("truncates a runaway provider dump so it cannot bloat the ledger line", () => {
		const huge = "x".repeat(5000);
		const described = describeExecError(
			fakeExecError({ stdout: huge, code: 1 }),
		);
		ok(described.error.length < huge.length);
		match(described.error, /truncated/);
	});
});

describe("describeExecError — streams carried as Buffers", () => {
	// execFileSync only returns strings when the caller asks for utf8. Callers in
	// this codebase do not always ask: the bulk-transfer helper is spawned with
	// `encoding: null`, and any injected exec seam chooses for itself. A Buffer
	// reaching the classifier used to empty its haystack, and every classification
	// is gated on that haystack being non-empty — so the reason string still read
	// correctly while `errorKind` silently came back null. That is the worse
	// failure: auth/index.mjs keys its headless re-login on `errorKind`, so an
	// expired session presented as an unclassified error and the re-auth that
	// would have fixed the run never fired.
	const AUTH_TEXT = "OAuth session expired. Please run /login";

	it("classifies an auth expiry carried on a Buffer stderr", () => {
		const described = describeExecError(
			Object.assign(new Error("Command failed"), {
				stderr: Buffer.from(AUTH_TEXT),
			}),
			{ provider: "claude" },
		);
		strictEqual(described.errorKind, "auth_expired");
	});

	it("classifies an auth expiry carried on a Buffer stdout", () => {
		// The documented incident printed to stdout, not stderr.
		const described = describeExecError(
			Object.assign(new Error("Command failed"), {
				stdout: Buffer.from(AUTH_TEXT),
			}),
			{ provider: "claude" },
		);
		strictEqual(described.errorKind, "auth_expired");
	});

	it("reaches the same verdict whether a stream arrives as a Buffer or a string", () => {
		// Parity is the real contract: the encoding a caller happened to request
		// must not change what the failure is classified as. Asserting the pair
		// rather than one side keeps this honest if the signature list changes.
		for (const text of [AUTH_TEXT, "quota exceeded", "no such model"]) {
			const asString = describeExecError(fakeExecError({ stderr: text }), {
				provider: "claude",
			});
			const asBuffer = describeExecError(
				Object.assign(new Error("Command failed"), {
					stderr: Buffer.from(text),
				}),
				{ provider: "claude" },
			);
			strictEqual(
				asBuffer.errorKind,
				asString.errorKind,
				`Buffer and string must classify "${text}" identically`,
			);
		}
	});

	it("still reports nothing for a Buffer that carries no known signature", () => {
		// Guards the other direction: decoding must not make the classifier
		// credulous, only capable of reading what it was already given.
		const described = describeExecError(
			Object.assign(new Error("Command failed"), {
				stderr: Buffer.from("the guest ran out of disk"),
			}),
			{ provider: "claude" },
		);
		strictEqual(described.errorKind, null);
		match(described.error, /ran out of disk/);
	});
});

describe("reauthHintFor", () => {
	it("points at `npm run auth` with each known provider's real login command", () => {
		for (const [provider, needle] of [
			["claude", "claude auth login"],
			["codex", "codex login --device-auth"],
			["cursor", "cursor-agent login"],
			["copilot", "copilot login"],
			["opencode", "opencode auth login"],
			["agy", "agy --print hi"],
		]) {
			const hint = reauthHintFor(provider);
			ok(hint.includes("npm run auth"));
			ok(hint.includes(needle), `${provider} hint should include ${needle}`);
		}
	});

	it("returns null for an unknown provider rather than inventing a command", () => {
		strictEqual(reauthHintFor("nope"), null);
	});
});
