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

	it("falls back silently when the backend's cleanupProviderProcess throws", () => {
		const executionBackend = {
			cleanupProviderProcess() {
				throw new Error("guest unreachable");
			},
		};
		killOrphanedProcesses("switchyard-nonexistent-container", {
			executionBackend,
			command: "prlctl",
			args: ["exec", "switchyard-guest"],
		});
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
