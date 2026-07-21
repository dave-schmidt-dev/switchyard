// Agy (Antigravity CLI) adapter - write-enabled implementer
// Executes agy CLI inside the container (never host-spawn)
// CR-4: Adapters exec inside container, never host-spawn
// PW-4: Independent in-container login

import { execFileSync } from "node:child_process";
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";
import {
	validateEnvName,
	validateIdentifier,
	validateModelArg,
} from "./shell-safety.mjs";

const AGY_CMD = "agy";

/**
 * Build the in-container script that persists the Gemini/Antigravity
 * credentials JSON forwarded via `docker exec -e ${secretName}` into the
 * path `agy` reads (`~/.gemini/gemini-credentials.json` — confirmed against
 * a real local installation; the CLI still uses the `.gemini` directory
 * namespace internally despite the `agy` rename).
 * @param {string} secretName
 * @returns {string}
 */
export function buildAuthContainerScript(secretName) {
	return `mkdir -p /root/.gemini && printf '%s' "$${secretName}" > /root/.gemini/gemini-credentials.json && chmod 600 /root/.gemini/gemini-credentials.json`;
}

/**
 * Check if Agy is installed/responding in the container. Like the
 * claude/codex equivalents, this is a liveness check (the binary runs), not
 * a real authentication check — agy's `--version` output has no vendor
 * keyword to match against.
 * @returns {boolean}
 */
export function isAgyAuthenticated() {
	try {
		const result = execFileSync(
			"docker",
			["exec", AGENT_CONTAINER_NAME, AGY_CMD, "--version"],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return typeof result === "string" && result.trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * Authenticate Agy in the container.
 * PW-4: Independent in-container login via BWS-provided credentials payload.
 *
 * The secret is never fetched host-side and never appears in any process's
 * argv (visible via `ps`/`/proc`): `bws-run` injects `secretName` as an env
 * var into the `docker exec` process it launches, and `docker exec -e NAME`
 * (bare, no `=value`) forwards that host env var into the container by
 * reference. Requires `secretName` to be the exact BWS secret key
 * (project convention: UPPERCASE_SNAKE_CASE matching the env var).
 * @param {string} [secretName] BWS secret name for the Gemini credentials JSON.
 * @returns {boolean}
 */
export function authenticateAgy(secretName = "GEMINI_CREDENTIALS") {
	try {
		validateEnvName(secretName, "secretName");
	} catch (error) {
		console.error("Failed to authenticate Agy:", error.message);
		return false;
	}

	const containerScript = buildAuthContainerScript(secretName);

	try {
		execFileSync(
			"zsh",
			[
				"-i",
				"-c",
				`bws-run -- docker exec -e ${secretName} ${AGENT_CONTAINER_NAME} sh -c '${containerScript}'`,
			],
			{ stdio: "inherit" },
		);
		return true;
	} catch (error) {
		console.error("Failed to authenticate Agy:", error.message);
		return false;
	}
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
			timeout: 300000,
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

export { AGY_CMD };
