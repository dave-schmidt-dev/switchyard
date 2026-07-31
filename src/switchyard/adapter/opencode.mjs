import { execFileSync } from "node:child_process";
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";
import { PROVIDER_EXECUTION_TIMEOUT_MS } from "./constants.mjs";
import { describeExecError } from "./exec-error.mjs";
import { killOrphanedProcesses } from "./orphan-kill.mjs";
import { validateIdentifier, validateModelArg } from "./shell-safety.mjs";

const OPENCODE_CMD = "opencode";
const CREDENTIALS_PATH = "/root/.local/share/opencode/auth.json";
const MIN_CREDENTIAL_BYTES = 16;

function hasNonTrivialCredential(containerName) {
	try {
		execFileSync(
			"docker",
			[
				"exec",
				containerName,
				"sh",
				"-c",
				`[ -f ${CREDENTIALS_PATH} ] && [ "$(wc -c < ${CREDENTIALS_PATH} | tr -d '[:space:]')" -ge ${MIN_CREDENTIAL_BYTES} ]`,
			],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return true;
	} catch {
		return false;
	}
}

export function isOpencodeAuthenticated(containerName = AGENT_CONTAINER_NAME) {
	try {
		execFileSync("docker", ["exec", containerName, OPENCODE_CMD, "--version"], {
			encoding: "utf8",
			stdio: "pipe",
		});
	} catch {
		return false;
	}
	return hasNonTrivialCredential(containerName);
}

export function execute(prompt, workingContainerName, options = {}) {
	const { model, timeoutMs = PROVIDER_EXECUTION_TIMEOUT_MS } = options;

	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}

	const args = [
		"exec",
		"-i",
		"-w",
		"/project",
		workingContainerName,
		OPENCODE_CMD,
	];
	if (model) {
		try {
			validateModelArg(model, "model");
		} catch (error) {
			return { output: "", success: false, error: error.message };
		}
		args.push("--model", model);
	}

	try {
		const result = execFileSync("docker", args, {
			input: prompt,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: timeoutMs,
			maxBuffer: 128 * 1024 * 1024, // 128 MB
		});

		return { output: result, success: true };
	} catch (error) {
		const timedOut = error.code === "ETIMEDOUT";
		if (timedOut) {
			killOrphanedProcesses(workingContainerName);
			// Keep error.message (carries ETIMEDOUT) so the runner classifies
			// this as execution_timed_out, not a generic failure.
			return {
				output: error.stdout || "",
				success: false,
				error: error.message,
				timedOut,
			};
		}
		// Non-timeout failure: surface the provider's own diagnostic (and, on an
		// expired session, an actionable re-auth hint) instead of Node's opaque
		// "Command failed: docker exec …" wrapper — see exec-error.mjs.
		const described = describeExecError(error, { provider: "opencode" });
		return {
			output: described.output,
			success: false,
			error: described.error,
			errorKind: described.errorKind,
			timedOut,
		};
	}
}

export function captureDiff(workingContainerName) {
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch {
		return null;
	}
	try {
		execFileSync(
			"docker",
			["exec", "-w", "/project", workingContainerName, "git", "add", "-A"],
			{ stdio: "pipe" },
		);
		const diff = execFileSync(
			"docker",
			[
				"exec",
				"-w",
				"/project",
				workingContainerName,
				"git",
				"diff",
				"--cached",
				"HEAD",
			],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return diff.trim() || null;
	} catch {
		return null;
	}
}
