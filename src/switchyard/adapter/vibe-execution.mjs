import { execFileSync } from "node:child_process";
import { validateAdapterInvocation } from "./invocation.mjs";
import { getWorkspaceExecution } from "./provider-lifecycle.mjs";
import { validateIdentifier, validateModelArg } from "./shell-safety.mjs";
import {
	buildConfigWriteExecution,
	buildServedModelExecution,
	SERVED_MODEL_TIMEOUT_MS,
	VIBE_CMD,
	VIBE_HELPER_ATTEMPTS,
	VIBE_HOME_PATH,
	VIBE_MODELS,
} from "./vibe-config.mjs";

function buildExecution(workspaceId, prompt, options) {
	validateIdentifier(workspaceId, "workingContainerName");
	const selector = options.model;
	if (!Object.hasOwn(VIBE_MODELS, selector)) {
		throw new Error(
			`Vibe does not serve model ${selector}; routable selectors: ${Object.keys(
				VIBE_MODELS,
			).join(", ")}`,
		);
	}
	const invocationArgs = validateAdapterInvocation(options, {
		expectedHarness: "vibe",
		expectedTargetId: options.resolvedTargetId,
		expectedModel: selector,
	});
	validateModelArg(selector, "model");
	return {
		selector,
		...getWorkspaceExecution(workspaceId, {
			...options,
			argv: [
				VIBE_CMD,
				...invocationArgs,
				"-p",
				prompt,
				"--auto-approve",
				"--output",
				"streaming",
				"--trust",
			],
			env: [`VIBE_HOME=${VIBE_HOME_PATH}`, `VIBE_ACTIVE_MODEL=${selector}`],
		}),
		input: "",
	};
}
function readServedModelSync(workspaceId, options) {
	const probe = buildServedModelExecution(workspaceId, options);
	for (let attempt = 1; attempt <= VIBE_HELPER_ATTEMPTS; attempt += 1) {
		try {
			return execFileSync(probe.command, probe.args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: SERVED_MODEL_TIMEOUT_MS,
			});
		} catch {
			// Missing evidence, not contrary evidence — see classifyServedModel.
		}
	}
	return null;
}
function writeVibeConfigSync(workspaceId, options, selector) {
	const write = buildConfigWriteExecution(workspaceId, options, selector);
	let lastError = null;
	for (let attempt = 1; attempt <= VIBE_HELPER_ATTEMPTS; attempt += 1) {
		try {
			execFileSync(write.command, write.args, {
				input: write.input,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: SERVED_MODEL_TIMEOUT_MS,
			});
			return null;
		} catch (error) {
			lastError = error;
		}
	}
	return lastError;
}

export { buildExecution, readServedModelSync, writeVibeConfigSync };
