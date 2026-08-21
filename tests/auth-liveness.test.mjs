import { deepStrictEqual, match, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	LIVENESS_PROBES,
	LIVENESS_PROMPT,
	probeLiveness,
	repliesOk,
} from "../src/switchyard/auth/liveness.mjs";

// Every probe here runs through the `run` seam. The real invocations were
// confirmed against the live container by hand (see liveness.mjs); what these
// tests own is the decision logic on top of them — what counts as an answer,
// what counts as a failure, and which of those two an ambiguous output is.

describe("repliesOk", () => {
	it("accepts a bare OK, with or without surrounding noise", () => {
		strictEqual(repliesOk("OK"), true);
		strictEqual(repliesOk("OK\n"), true);
		strictEqual(repliesOk("> build · mistral-medium-latest\n\nOK\n"), true);
		strictEqual(repliesOk("[0m\nOK\n[0m"), true, "ANSI-wrapped");
	});

	it("rejects an output whose only OK is the echoed prompt", () => {
		// Not hypothetical: `codex exec` prints the prompt back before answering,
		// and the prompt ends in the word OK. Matching the raw text would report a
		// provider live on the strength of its own transcript of the question —
		// a check that passes when the model never replied at all.
		strictEqual(
			repliesOk(`Reading additional input from stdin...\n${LIVENESS_PROMPT}\n`),
			false,
		);
	});

	it("rejects silence, a refusal, and OK embedded in a longer word", () => {
		strictEqual(repliesOk(""), false);
		strictEqual(
			repliesOk("OAuth session expired and could not be refreshed"),
			false,
		);
		strictEqual(repliesOk("OKAY then"), false);
		strictEqual(repliesOk(undefined), false);
	});
});

describe("probeLiveness", () => {
	function specFor(name) {
		let seen = null;
		probeLiveness(name, {
			run: (spec) => {
				seen = spec;
				return "OK";
			},
		});
		return seen;
	}

	it("reports live when the provider answers", () => {
		const result = probeLiveness("claude", { run: () => "OK" });
		deepStrictEqual(result, { live: true, reason: null, kind: null });
	});

	it("reports not-live with the provider's own words when it answers something else", () => {
		const result = probeLiveness("claude", { run: () => "I cannot do that" });
		strictEqual(result.live, false);
		match(result.reason, /no OK in reply/);
		match(result.reason, /I cannot do that/);
	});

	it("classifies an expired session with the dispatch path's own classifier", () => {
		// Reusing describeExecError rather than a second signature list is the
		// point: whatever a real run calls an expired session, this calls an
		// expired session. A private copy here would drift silently.
		const result = probeLiveness("claude", {
			run: () => {
				const error = new Error("Command failed");
				error.stdout = "OAuth session expired and could not be refreshed";
				error.stderr = "";
				throw error;
			},
		});
		strictEqual(result.live, false);
		strictEqual(result.kind, "auth_expired");
	});

	it("reports a timeout as a timeout, not as an auth failure", () => {
		// `opencode run` without an explicit model did exactly this: it never
		// exited. Calling that an auth failure would send a human through an OAuth
		// flow to fix a hung CLI.
		const result = probeLiveness("opencode", {
			timeoutMs: 1000,
			run: () => {
				const error = new Error("ETIMEDOUT");
				error.code = "ETIMEDOUT";
				throw error;
			},
		});
		strictEqual(result.live, false);
		strictEqual(result.kind, null);
		match(result.reason, /timed out after 1000ms/);
	});

	it("refuses to guess an invocation for an unknown provider", () => {
		const result = probeLiveness("nonesuch", { run: () => "OK" });
		strictEqual(result.live, false);
		strictEqual(result.kind, null);
		match(result.reason, /no liveness probe defined/);
	});

	it("covers all six providers and passes the prompt as a single argv element", () => {
		deepStrictEqual(Object.keys(LIVENESS_PROBES).sort(), [
			"agy",
			"claude",
			"codex",
			"copilot",
			"cursor",
			"opencode",
		]);
		for (const name of Object.keys(LIVENESS_PROBES)) {
			const spec = specFor(name);
			strictEqual(
				Array.isArray(spec.args),
				true,
				`${name} builds an argv array`,
			);
			// The prompt is never concatenated into a shell string; codex is the
			// one provider that takes it on stdin instead.
			const carriesPrompt =
				spec.args.includes(LIVENESS_PROMPT) || spec.stdin === true;
			strictEqual(carriesPrompt, true, `${name} delivers the prompt unsplit`);
		}
	});

	it("gives codex the trusted working directory its exec subcommand requires", () => {
		const spec = specFor("codex");
		strictEqual(spec.cwd, "/tmp");
		strictEqual(spec.stdin, true);
		strictEqual(
			spec.args.includes("--dangerously-bypass-approvals-and-sandbox"),
			true,
		);
	});

	it("probes claude in /tmp", () => {
		const spec = specFor("claude");
		strictEqual(spec.cwd, "/tmp");
		strictEqual(spec.args.includes("-p"), true);
	});

	it("probes agy in /tmp", () => {
		const spec = specFor("agy");
		strictEqual(spec.cwd, "/tmp");
		strictEqual(spec.args.includes("--print"), true);
	});

	it("probes the no-variant MiMo lane used for low-capability dispatch", () => {
		const spec = specFor("opencode");
		deepStrictEqual(spec.args.slice(0, 4), [
			"opencode",
			"run",
			"--model",
			"opencode-go/mimo-v2.5",
		]);
		strictEqual(spec.args.includes("--variant"), false);
	});
});
