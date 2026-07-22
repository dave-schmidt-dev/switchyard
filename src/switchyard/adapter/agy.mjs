// Agy (Antigravity CLI) adapter - write-enabled implementer
// Executes agy CLI inside the container (never host-spawn)
// CR-4: Adapters exec inside container, never host-spawn
// PW-4: Independent in-container login
//
// Agy has no explicit login subcommand: running it unauthenticated
// auto-triggers a real Google OAuth flow (prints a URL to visit, then waits
// for a pasted authorization code) — run once by a human directly against
// the standing agent container, see `src/switchyard/auth/index.mjs`.
// TASKS.md Task 24: this replaces an earlier BWS-credential-injection design.

import { execFileSync } from "node:child_process";
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";
import { validateIdentifier, validateModelArg } from "./shell-safety.mjs";

const AGY_CMD = "agy";

// A completed OAuth login persists the token to
// `~/.gemini/antigravity-cli/antigravity-oauth-token` — live-verified 2026-07-21
// against the real standing agent container immediately after a real
// `agy --print "hi"` login completed (a fresh 498-byte, mode-0600 file
// appeared at exactly that path/timestamp). The earlier assumed path,
// `~/.gemini/gemini-credentials.json`, does not exist under a real login —
// it was carried over from an older local-install check and was never
// re-verified against this container image; `isAgyAuthenticated()` reported
// a real, working login as unauthenticated until this was caught.
const AGY_CREDENTIALS_PATH =
	"/root/.gemini/antigravity-cli/antigravity-oauth-token";

// A real credentials JSON is hundreds of bytes; this floor rejects an empty
// file (the exact bug that shipped once — a printf writing nothing) and
// trivial JSON stubs (`{}`, `null`, `""`). It deliberately does NOT attempt
// server-side validity — a well-formed but revoked/garbage token still
// passes — because that needs a network round-trip the container can't make
// reliably. Scope: presence + substance, not liveness against the API.
const MIN_CREDENTIAL_BYTES = 16;

/**
 * Check that the persisted credential file exists inside the container and is
 * non-trivial (not empty, not a placeholder stub). INV-1: the credential
 * VALUE never crosses to the host and never appears in argv — only the
 * constant file path and byte threshold do, and `wc -c` reports a byte
 * count, not content. The host reads only the check's exit code.
 * @param {string} containerName
 * @returns {boolean}
 */
function hasNonTrivialCredential(containerName) {
	try {
		execFileSync(
			"docker",
			[
				"exec",
				containerName,
				"sh",
				"-c",
				`[ -f ${AGY_CREDENTIALS_PATH} ] && [ "$(wc -c < ${AGY_CREDENTIALS_PATH} | tr -d '[:space:]')" -ge ${MIN_CREDENTIAL_BYTES} ]`,
			],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if Agy is authenticated in the container. `agy --version` has no
 * vendor keyword to match, so liveness here is just "binary runs, non-empty
 * output"; the real signal is the credential check that supplements it — the
 * persisted OAuth token (`AGY_CREDENTIALS_PATH`) must exist and be non-trivial.
 * Liveness alone treated an installed-but-unauthenticated CLI as authenticated,
 * so `npm run auth` would have skipped a provider that still needed a real
 * interactive login (TASKS.md Task 15).
 * @param {string} [containerName] Container to check (defaults to the standing agent container).
 * @returns {boolean}
 */
export function isAgyAuthenticated(containerName = AGENT_CONTAINER_NAME) {
	try {
		const result = execFileSync(
			"docker",
			["exec", containerName, AGY_CMD, "--version"],
			{ encoding: "utf8", stdio: "pipe" },
		);
		if (!(typeof result === "string" && result.trim().length > 0)) {
			return false;
		}
	} catch {
		return false;
	}
	return hasNonTrivialCredential(containerName);
}

/**
 * Execute a task with Agy in the container.
 * Unlike claude/codex, agy's prompt is a `--print <value>` flag argument, not
 * stdin (confirmed against the installed CLI's own --help) — still delivered
 * as a single execFileSync argv element, never shell-interpolated.
 * `--new-project` is required so each task gets an isolated conversation
 * rather than resuming a stale prior one.
 * @param {string} prompt The task prompt
 * @param {string} workingContainerName Working container to exec in
 * @param {object} options Execution options
 * @param {string} [options.model] Model to use
 * @returns {{output: string, success: boolean, error?: string}}
 */
export function executeAgy(prompt, workingContainerName, options = {}) {
	const { model } = options;

	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}

	const args = [
		"exec",
		"-w",
		"/project",
		workingContainerName,
		AGY_CMD,
		"--new-project",
		"--mode",
		"accept-edits",
	];
	if (model) {
		try {
			validateModelArg(model, "model");
		} catch (error) {
			return { output: "", success: false, error: error.message };
		}
		args.push("--model", model);
	}
	args.push(
		"--add-dir",
		"/project",
		"--print-timeout",
		"9m",
		"--print",
		prompt,
	);

	try {
		const result = execFileSync("docker", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			// Must exceed the `--print-timeout 9m` passed above — the host
			// kill is a backstop for a hung/unresponsive process, not the
			// primary timeout mechanism. A shorter host timeout would force-
			// kill a run that Agy's own flag would otherwise let finish or
			// time out gracefully.
			timeout: 600000,
		});

		return { output: result, success: true };
	} catch (error) {
		return {
			output: error.stdout || "",
			success: false,
			error: error.message,
		};
	}
}

/**
 * Capture the diff produced by Agy in the working container.
 * @param {string} workingContainerName Working container name
 * @returns {string|null} Git diff or null
 */
export function captureDiff(workingContainerName) {
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch {
		return null;
	}
	try {
		const diff = execFileSync(
			"docker",
			["exec", "-w", "/project", workingContainerName, "git", "diff"],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return diff.trim() || null;
	} catch {
		return null;
	}
}
