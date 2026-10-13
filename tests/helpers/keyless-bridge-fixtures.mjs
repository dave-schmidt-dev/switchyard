import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBridge } from "../../ops/simple-provider-keyless-bridge.mjs";

export const SECRET = "synthetic-real-api-key-bridge-123456";
export function setup() {
	const root = join(
		realpathSync(tmpdir()),
		`switchyard-simple-${randomUUID()}`,
	);
	const worktree = join(root, "worktree");
	mkdirSync(join(worktree, ".git"), { recursive: true });
	writeFileSync(join(root, ".switchyard-cleanup-owner.json"), "{}\n");
	return {
		root,
		worktree,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}
export const seatbeltBlocked = () => {
	const check = spawnSync(
		"/usr/bin/sandbox-exec",
		[
			"-p",
			"(version 1) (deny default) (allow process*) (allow file-read*)",
			"/usr/bin/true",
		],
		{ encoding: "utf8" },
	);
	return check.status !== 0 && /Operation not permitted/u.test(check.stderr);
};
export async function captureStderr(run) {
	const write = process.stderr.write;
	const chunks = [];
	process.stderr.write = (chunk, ...rest) => {
		chunks.push(String(chunk));
		rest.find((item) => typeof item === "function")?.();
		return true;
	};
	try {
		return { value: await run(), stderr: chunks.join("") };
	} catch (error) {
		return { error, stderr: chunks.join("") };
	} finally {
		process.stderr.write = write;
	}
}
export function runFake(
	item,
	script,
	{ target = "opencode-go", shebang = "#!/bin/sh", ...extra } = {},
) {
	const cliPath = join(item.worktree, "fake-provider");
	writeFileSync(cliPath, `${shebang}\n${script}\n`, { mode: 0o755 });
	return captureStderr(() =>
		runBridge({
			target,
			model: target === "vibe" ? "glm-5-3" : "opencode-go/deepseek-v4.1-flash",
			variant: target === "vibe" ? undefined : "low",
			worktree: item.worktree,
			prompt: "synthetic task",
			secret: SECRET,
			cliPath,
			timeoutMs: 5_000,
			verifySession: false,
			...extra,
		}),
	);
}
export const leftovers = (item) =>
	readdirSync(item.root).filter((name) =>
		name.startsWith(".switchyard-keyless-"),
	);
