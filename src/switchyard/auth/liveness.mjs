// Liveness probes: does this provider actually answer a request right now?
//
// Every isXAuthenticated() in the adapters answers a different question — "is
// the binary installed and is there a credential file of non-trivial size" —
// and that question has now been wrong twice in one day, in both directions
// that matter:
//
//   * `auth:check` reported `opencode: authenticated` while Mistral was
//     rejecting the container's key outright; and
//   * it reported `claude: authenticated` while `claude -p hi` in that same
//     container returned "OAuth session expired and could not be refreshed".
//
// The second one cost more than a wrong status line. `ensureProvidersAuthenticated`
// gates the interactive login on the same presence check, so `npm run auth`
// skipped claude and reported success — a presence check does not merely fail to
// detect the failure, it also gates the repair.
//
// Each command below was confirmed live against the standing `switchyard-agent`
// Docker container on 2026-08-13, by running it and reading the reply — not
// inferred from a --help page. The execution lane has since moved to a
// Parallels VM (see auth/index.mjs), but the invocations themselves are
// unchanged: the same flags, run inside the guest instead of the container. A
// probe that fails for flag reasons reports "not live" and reintroduces
// exactly the same class of lie in the opposite direction, so these are
// empirical or they are nothing:
//
//   claude    claude -p <prompt>                                    -> OK
//   codex     codex exec --dangerously-bypass-approvals-and-sandbox -> OK   (prompt on stdin, cwd /tmp)
//   agy       agy --print <prompt>                                  -> OK
//   cursor    cursor-agent -p <prompt> --force --trust              -> OK
//   copilot   copilot -p <prompt> --allow-all-tools --no-ask-user   -> OK
//   opencode  opencode run --model <model> <prompt>                 -> OK
//
// Flags mirror each adapter's real executeX() invocation so a probe exercises
// the same path a dispatch would. Two deviations, both deliberate: codex needs a
// working directory it will treat as trusted (`-w /tmp`), and opencode needs an
// explicit model because a bare `opencode run` did not terminate — it wandered
// off reading files in the working directory until the 120s timeout killed it
// (reproduced 2026-08-13, and the same non-exit already recorded in TASKS.md).

import { describeExecError } from "../adapter/exec-error.mjs";

/** The smallest request that still proves a round trip to the provider. */
export const LIVENESS_PROMPT = "reply with the single word OK";

/**
 * Generous: a cold provider CLI can take tens of seconds to answer at all.
 * Module-local on purpose — the only consumer is `probeLiveness`'s `timeoutMs`
 * default below, and exporting it tripped the `deadcode` (knip) gate.
 */
const LIVENESS_TIMEOUT_MS = 120_000;

const MAX_REASON_CHARS = 240;

// opencode holds several provider credentials at once (`auth.json` currently
// carries four), so one probe proves one lane, not the CLI as a whole. The model
// is the one whose live call is verified; override when probing another lane.
const OPENCODE_PROBE_MODEL =
	process.env.SWITCHYARD_OPENCODE_PROBE_MODEL ?? "opencode-go/mimo-v2.5";
const OPENCODE_PROBE_VARIANT =
	process.env.SWITCHYARD_OPENCODE_PROBE_VARIANT ?? "";

/**
 * @typedef {{args: string[], cwd?: string, stdin?: boolean, env?: string[]}} ProbeSpec
 * @type {Readonly<Record<string, (prompt: string) => ProbeSpec>>}
 */
export const LIVENESS_PROBES = Object.freeze({
	claude: (prompt) => ({
		args: ["claude", "-p", prompt],
		cwd: "/tmp",
	}),
	codex: () => ({
		// The prompt goes on stdin exactly as executeCodex() delivers it. `-w /tmp`
		// because `codex exec` refuses to run outside a directory it trusts
		// ("Not inside a trusted directory and --skip-git-repo-check was not
		// specified") — a refusal that has nothing to do with credentials and
		// would otherwise read as an auth failure.
		args: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"],
		cwd: "/tmp",
		stdin: true,
	}),
	agy: (prompt) => ({
		args: ["agy", "--print", prompt],
		cwd: "/tmp",
	}),
	cursor: (prompt) => ({
		args: ["cursor-agent", "-p", prompt, "--force", "--trust"],
		cwd: "/tmp",
	}),
	copilot: (prompt) => ({
		args: ["copilot", "-p", prompt, "--allow-all-tools", "--no-ask-user"],
		cwd: "/tmp",
	}),
	opencode: (prompt) => {
		const args = ["opencode", "run"];
		if (OPENCODE_PROBE_VARIANT) {
			args.push("--variant", OPENCODE_PROBE_VARIANT);
		}
		args.push("--model", OPENCODE_PROBE_MODEL, prompt);
		return { args, cwd: "/tmp" };
	},
	vibe: (prompt) => ({
		args: [
			"vibe",
			"-p",
			prompt,
			"--max-turns",
			"1",
			"--max-tokens",
			"64",
			"--output",
			"text",
			"--agent",
			"ask",
			"--trust",
			"--disabled-tools",
			"*",
		],
		cwd: "/tmp",
		env: ["VIBE_ACTIVE_MODEL=glm-5.2"],
	}),
});

// Built rather than written as a literal: the pattern starts with ESC, and a
// control character inside a regex literal is both invisible in review and a
// lint error (biome's noControlCharactersInRegex). opencode colors its output,
// so stripping this is what keeps `OK` findable.
const ANSI_PATTERN = new RegExp(
	`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`,
	"g",
);

/**
 * Did the provider actually answer with OK?
 *
 * A POSITIVE assertion, deliberately — not "the output contains no error string
 * I thought of". A check that can only fail on a named error string passes on
 * every error nobody named, which is how the container's rejected Mistral key
 * passed its own verification earlier today.
 *
 * The prompt is removed before matching because several CLIs echo it back, and
 * the prompt itself ends in the word OK: matching the raw output would report a
 * provider live on the strength of its own transcript of the question.
 * @param {string} text Combined provider output.
 * @param {string} [prompt]
 * @returns {boolean}
 */
export function repliesOk(text, prompt = LIVENESS_PROMPT) {
	if (typeof text !== "string") return false;
	const withoutEcho = text.split(prompt).join(" ").replace(ANSI_PATTERN, " ");
	return /(^|[^A-Za-z])OK([^A-Za-z]|$)/i.test(withoutEcho);
}

function truncate(text) {
	const clean = text.replace(ANSI_PATTERN, "").trim();
	return clean.length <= MAX_REASON_CHARS
		? clean
		: `${clean.slice(0, MAX_REASON_CHARS)}… (truncated)`;
}

/**
 * Ask a provider for a one-word answer inside the booted golden image.
 *
 * Never throws: a probe that cannot run is reported as not-live with a reason,
 * matching the fail-soft contract the auth report already promises.
 * @param {string} name Provider key in LIVENESS_PROBES.
 * @param {object} [options]
 * @param {string} [options.workspaceId] Booted VM handle (the golden image's
 *   own uuid — see auth/index.mjs) to run the probe against.
 * @param {import("../lifecycle/parallels-execution-backend.mjs").ParallelsExecutionBackend} [options.executionBackend]
 * @param {number} [options.timeoutMs]
 * @param {(spec: {args: string[], cwd?: string, stdin?: boolean}) => string} [options.run] Test seam.
 * `kind` is whatever describeExecError() classified, forwarded verbatim — so it
 * tracks PERSISTED_ERROR_KINDS rather than being an enum of its own.
 * @returns {{live: boolean, reason: string|null, kind: ("auth_expired"|"quota_exhausted"|"model_unavailable"|null)}}
 */
export function probeLiveness(name, options = {}) {
	const {
		workspaceId,
		executionBackend,
		timeoutMs = LIVENESS_TIMEOUT_MS,
		run,
	} = options;

	const build = LIVENESS_PROBES[name];
	if (!build) {
		// No guessed invocation. An unknown provider is reported as unprobed
		// rather than probed-and-failed, so a caller can tell "we did not look"
		// from "we looked and it did not answer".
		return {
			live: false,
			reason: `no liveness probe defined for ${name}`,
			kind: null,
		};
	}

	const spec = build(LIVENESS_PROMPT);
	try {
		const output = run
			? run(spec)
			: executionBackend
					.execGuest(workspaceId, spec.args[0], spec.args.slice(1), {
						cwd: spec.cwd,
						env: spec.env,
						prlctlOptions: {
							// The one provider invocation that rides the retrying control
							// route, opted in deliberately. A misfire here would report a
							// healthy provider as dead and send the caller into a needless
							// headless re-login; the probe is a one-word prompt with no
							// workspace side effects, so repeating it costs far less than
							// that false negative.
							retry: true,
							input: spec.stdin ? LIVENESS_PROMPT : undefined,
							timeout: timeoutMs,
							maxBuffer: 8 * 1024 * 1024,
						},
					})
					.toString();
		if (repliesOk(output)) return { live: true, reason: null, kind: null };
		return {
			live: false,
			reason: `no OK in reply: ${truncate(output ?? "")}`,
			kind: null,
		};
	} catch (error) {
		if (error?.code === "ETIMEDOUT") {
			return {
				live: false,
				reason: `probe timed out after ${timeoutMs}ms`,
				kind: null,
			};
		}
		// Reuse the dispatch path's own classifier rather than a second set of
		// signatures: whatever a real run would call an expired session, this
		// calls an expired session.
		const described = describeExecError(error, { provider: name });
		return {
			live: false,
			reason: truncate(described.error),
			kind: described.errorKind,
		};
	}
}
