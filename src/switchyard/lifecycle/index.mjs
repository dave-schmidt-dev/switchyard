// Lifecycle module - workspace seeding
// INV-3: The workspace is wiped at project end (see ExecutionBackend.destroy)

import { execFileSync } from "node:child_process";

/**
 * Seed a backend workspace from the host repository's committed tree.
 * `pushTar` is the only payload transfer; the baseline git setup runs through
 * the same backend execution prefix, so this works for any ExecutionBackend
 * implementation without a host mount.
 * @param {import("./execution-backend.mjs").ExecutionBackend} executionBackend
 * @param {string} workspaceId
 * @param {string} projectPath
 * @returns {object} backend transfer receipt
 */
export function seedProjectWithBackend(
	executionBackend,
	workspaceId,
	projectPath,
) {
	if (!executionBackend || typeof executionBackend.pushTar !== "function") {
		throw new TypeError("execution backend does not support tar transfer");
	}
	if (typeof workspaceId !== "string" || workspaceId.length === 0) {
		throw new TypeError("workspaceId must be a non-empty backend handle");
	}
	const tar = execFileSync("git", ["-C", projectPath, "archive", "HEAD"], {
		maxBuffer: 256 * 1024 * 1024,
	});
	const receipt = executionBackend.pushTar(workspaceId, tar, "/project");
	const script =
		"git init -q && git add -A -f && git -c user.name=switchyard -c user.email=switchyard@localhost commit --allow-empty -qm baseline";
	if (typeof executionBackend.execGuest === "function") {
		executionBackend.execGuest(workspaceId, "/bin/bash", ["-lc", script], {
			cwd: "/project",
		});
	} else {
		const execution = executionBackend.execArgv(workspaceId, {
			cwd: "/project",
			argv: ["/bin/bash", "-lc", script],
		});
		execFileSync(execution.command, execution.args, { stdio: "pipe" });
	}
	return receipt;
}

export * from "./execution-backend.mjs";
export * from "./parallels-execution-backend.mjs";
