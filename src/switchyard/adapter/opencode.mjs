import { execFileSync } from "node:child_process";
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";
import { validateIdentifier, validateModelArg } from "./shell-safety.mjs";

const OPENCODE_CMD = "opencode";
const CREDENTIALS_PATH = "/root/.config/opencode/auth.json";
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
	const { model } = options;

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
