import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	killOrphanedProcesses,
	killOrphanedProcessesAsync,
} from "../src/switchyard/adapter/orphan-kill.mjs";

describe("killOrphanedProcesses — backend-aware dispatch", () => {
	it("prefers a backend's cleanupProviderProcess over the Docker fallback", () => {
		const calls = [];
		const executionBackend = {
			cleanupProviderProcess(command, args, opts) {
				calls.push({ command, args, opts });
			},
		};
		// An identifier the Docker fallback would reject outright, so a pass here
		// can only be explained by the backend path — proof the Docker branch was
		// never reached, not just that it silently no-oped on a bad name.
		killOrphanedProcesses("unsafe;name", {
			executionBackend,
			command: "prlctl",
			args: ["exec", "switchyard-guest", "sh", "-lc", "kill-tree"],
			onStatus: () => {},
		});
		strictEqual(calls.length, 1);
		strictEqual(calls[0].command, "prlctl");
		strictEqual(
			killOrphanedProcesses("unsafe;name", {
				executionBackend,
				command: "prlctl",
				args: [],
			}).cleanupFailed,
			false,
			"a backend cleanup that returns must report success",
		);
		deepStrictEqual(calls[0].args, [
			"exec",
			"switchyard-guest",
			"sh",
			"-lc",
			"kill-tree",
		]);
	});

	it("falls back silently when the backend has no cleanupProviderProcess", () => {
		// No executionBackend at all — the pre-existing Docker-only shape. Should
		// not throw even against a container name Docker can't reach.
		killOrphanedProcesses("switchyard-nonexistent-container", {});
	});

	it("still runs the Docker backstop when the backend's cleanup throws, but reports the failure", () => {
		// This used to assert only that nothing threw, which is exactly what
		// let a failed guest cleanup pass for a successful one: the function
		// returned void, so no caller could tell the difference. The Docker
		// backstop still runs — that control flow is deliberate — but a
		// backstop that reaches a container cannot confirm a VM guest process
		// died, so it must not overwrite the failure with a clean result.
		// Task 6.3 covers the classification itself.
		const executionBackend = {
			cleanupProviderProcess() {
				throw new Error("guest unreachable");
			},
		};
		const outcome = killOrphanedProcesses("switchyard-nonexistent-container", {
			executionBackend,
			command: "prlctl",
			args: ["exec", "switchyard-guest"],
		});
		strictEqual(outcome.cleanupFailed, true);
		strictEqual(outcome.failurePhase, "provider_cleanup");
	});
});

describe("killOrphanedProcessesAsync — Docker-only backstop", () => {
	it("resolves without throwing for a nonexistent container", async () => {
		await killOrphanedProcessesAsync("switchyard-nonexistent-container");
	});

	it("resolves without throwing for an unsafe identifier", async () => {
		await killOrphanedProcessesAsync("unsafe;name");
	});
});
