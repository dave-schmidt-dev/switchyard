import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	loadWorkspaceLifecycleHooks,
	runWorkspaceLifecycleHook,
} from "../src/switchyard/lifecycle/hooks.mjs";

function fixture(contents) {
	const path = mkdtempSync(join(tmpdir(), "switchyard-hooks-"));
	if (contents !== null)
		writeFileSync(join(path, "switchyard.hooks.json"), contents);
	return path;
}

describe("workspace lifecycle hooks", () => {
	it("accepts a bounded argv-only after_create hook", () => {
		const path = fixture(
			JSON.stringify({
				timeout_ms: 1000,
				after_create: { argv: ["npm", "ci"] },
			}),
		);
		try {
			const declaration = loadWorkspaceLifecycleHooks(path);
			deepStrictEqual(declaration.hooks.get("after_create").argv, [
				"npm",
				"ci",
			]);
		} finally {
			rmSync(path, { recursive: true, force: true });
		}
	});

	it("rejects shell-shaped hooks and unsupported keys", () => {
		const path = fixture(
			JSON.stringify({
				after_create: { argv: ["/bin/sh", "-c", "echo unsafe"] },
			}),
		);
		try {
			throws(() => loadWorkspaceLifecycleHooks(path), /PATH command name/);
		} finally {
			rmSync(path, { recursive: true, force: true });
		}
	});

	it("runs hooks through the backend without recording a provider PID", () => {
		const path = fixture(
			JSON.stringify({ after_create: { argv: ["npm", "ci"] } }),
		);
		const calls = [];
		const backend = {
			execArgv(_workspaceId, options) {
				calls.push(options);
				return { command: process.execPath, args: ["-e", "process.exit(0)"] };
			},
		};
		try {
			strictEqual(
				runWorkspaceLifecycleHook(
					backend,
					"{vm}",
					loadWorkspaceLifecycleHooks(path),
					"after_create",
				),
				true,
			);
			strictEqual(calls.length, 3);
			strictEqual(
				calls.every((call) => call.recordPid === false),
				true,
			);
		} finally {
			rmSync(path, { recursive: true, force: true });
		}
	});
});
