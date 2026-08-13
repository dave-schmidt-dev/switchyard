// Execution backend seam for disposable workspaces.

import { execFileSync } from "node:child_process";
import { checkContainerRuntime } from "../container/index.mjs";

// The lifecycle barrel configures these operations after its declarations have
// initialized. Keeping the callbacks here instead of importing the barrel
// avoids a circular module graph when a provider adapter imports this seam
// directly.
let configuredDockerLifecycle = null;

export function configureDockerLifecycle(operations) {
	if (!operations || typeof operations !== "object") {
		throw new TypeError("Docker lifecycle operations are required");
	}
	configuredDockerLifecycle = operations;
}

function lifecycleOperation(instance, name) {
	const operations = instance.lifecycle ?? configuredDockerLifecycle;
	const operation = operations?.[name];
	if (typeof operation !== "function") {
		throw new Error(
			`DockerExecutionBackend.${name}() is unavailable before lifecycle initialization`,
		);
	}
	return operation;
}

function abstractMethod(name) {
	throw new Error(
		`ExecutionBackend.${name}() must be implemented by a backend`,
	);
}

/**
 * Contract implemented by every workspace execution substrate.
 *
 * `execArgv` returns the transport command and its workspace prefix; callers
 * append the provider command and arguments. The backend owns `cwd`: honoring
 * it is not optional transport behavior. In particular, `prlctl exec` carries
 * no working-directory field and lands in a different launchd domain than the
 * Aqua domain in which a provider must run, so a VM backend must enforce both
 * the directory and execution domain itself.
 * @public
 */
export class ExecutionBackend {
	preflight(...args) {
		return abstractMethod("preflight", args);
	}

	create(...args) {
		return abstractMethod("create", args);
	}

	execArgv(workspaceId, { cwd = "/project" } = {}) {
		return abstractMethod("execArgv", [workspaceId, { cwd }]);
	}

	pushTar(...args) {
		return abstractMethod("pushTar", args);
	}

	pullTar(...args) {
		return abstractMethod("pullTar", args);
	}

	destroy(...args) {
		return abstractMethod("destroy", args);
	}

	listManaged(...args) {
		return abstractMethod("listManaged", args);
	}

	inspectProcess(...args) {
		return abstractMethod("inspectProcess", args);
	}
}

/**
 * Docker implementation of the execution backend.
 *
 * This class is intentionally not wired into adapters or runner call sites in
 * Task 3.1. Existing Docker lifecycle helpers remain the behavior contract
 * until the later conversion tasks move callers onto this seam.
 * @public
 */
export class DockerExecutionBackend extends ExecutionBackend {
	constructor({ execFn = execFileSync, lifecycle = null } = {}) {
		super();
		this.execFn = execFn;
		this.lifecycle = lifecycle;
	}

	preflight() {
		return checkContainerRuntime({ execFn: this.execFn });
	}

	create(projectPath, image, options) {
		return lifecycleOperation(this, "create").call(
			this.lifecycle ?? configuredDockerLifecycle,
			projectPath,
			image,
			options,
		);
	}

	execArgv(workspaceId, { cwd = "/project" } = {}) {
		return {
			command: "docker",
			// Keep stdin attached for provider prompts. This is part of the
			// Docker transport prefix; VM backends must not receive this flag.
			args: ["exec", "-i", "-w", cwd, workspaceId],
		};
	}

	pushTar(workspaceId, tar, destination = "/project") {
		return this.execFn("docker", ["cp", "-", `${workspaceId}:${destination}`], {
			input: tar,
			maxBuffer: 256 * 1024 * 1024,
			stdio: ["pipe", "pipe", "pipe"],
		});
	}

	pullTar(workspaceId, sourcePath) {
		return this.execFn("docker", ["cp", `${workspaceId}:${sourcePath}`, "-"], {
			maxBuffer: 256 * 1024 * 1024,
		});
	}

	destroy(workspaceId) {
		return lifecycleOperation(this, "destroy").call(
			this.lifecycle ?? configuredDockerLifecycle,
			workspaceId,
		);
	}

	listManaged() {
		return lifecycleOperation(this, "listManaged").call(
			this.lifecycle ?? configuredDockerLifecycle,
		);
	}

	inspectProcess(workspaceId) {
		return this.execFn("docker", ["top", workspaceId, "-eo", "pid,args"], {
			encoding: "utf8",
			stdio: "pipe",
			timeout: 5000,
		});
	}
}
