import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import {
	buildWorkContainerResourceArgs,
	createWorkingContainer,
	wipeWorkingContainer,
} from "../src/switchyard/lifecycle/index.mjs";
import { reapOwnManagedObjects } from "./helpers/lifecycle-fixture.mjs";

// CPU-meltdown hardening: every disposable working container must be launched
// with per-container CPU/memory/PID caps so a leaked or emulated worker can
// never saturate the host. These tests lock the argv fragment (hermetic) and,
// when Docker is present, prove the caps actually land on a real container.

function argFor(args, flag) {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
}

after(() => reapOwnManagedObjects());

describe("work-container resource limits — argv fragment", () => {
	it("emits the four caps with safe defaults for empty env", () => {
		const args = buildWorkContainerResourceArgs({});
		deepStrictEqual(args, [
			"--cpus",
			"6",
			"--memory",
			"8g",
			"--memory-swap",
			"8g",
			"--pids-limit",
			"1024",
		]);
	});

	it("pins --memory-swap equal to --memory (swap disabled)", () => {
		const args = buildWorkContainerResourceArgs({
			SWITCHYARD_WORK_MEMORY: "4g",
		});
		strictEqual(argFor(args, "--memory"), "4g");
		strictEqual(argFor(args, "--memory-swap"), "4g");
	});

	it("honors valid env overrides", () => {
		const args = buildWorkContainerResourceArgs({
			SWITCHYARD_WORK_CPUS: "2",
			SWITCHYARD_WORK_MEMORY: "512m",
			SWITCHYARD_WORK_PIDS: "256",
		});
		strictEqual(argFor(args, "--cpus"), "2");
		strictEqual(argFor(args, "--memory"), "512m");
		strictEqual(argFor(args, "--pids-limit"), "256");
	});

	it("falls back to defaults on malformed overrides (no broken docker arg)", () => {
		const args = buildWorkContainerResourceArgs({
			SWITCHYARD_WORK_CPUS: "; rm -rf /",
			SWITCHYARD_WORK_MEMORY: "lots",
			SWITCHYARD_WORK_PIDS: "-1",
		});
		strictEqual(argFor(args, "--cpus"), "6");
		strictEqual(argFor(args, "--memory"), "8g");
		strictEqual(argFor(args, "--pids-limit"), "1024");
	});

	it("rejects zero and negative numeric overrides", () => {
		const args = buildWorkContainerResourceArgs({
			SWITCHYARD_WORK_CPUS: "0",
			SWITCHYARD_WORK_PIDS: "0",
		});
		strictEqual(argFor(args, "--cpus"), "6");
		strictEqual(argFor(args, "--pids-limit"), "1024");
	});
});

let HAS_DOCKER = false;
try {
	execFileSync("docker", ["info"], { stdio: "pipe" });
	HAS_DOCKER = true;
} catch {
	HAS_DOCKER = false;
}

function describeIf(condition, ...args) {
	if (condition) return describe(...args);
	return describe.skip(...args);
}

// Uses alpine (not the multi-GB agent image) so it stays hermetic; the caps
// are applied by createWorkingContainer regardless of image.
describeIf(
	HAS_DOCKER,
	"work-container resource limits — applied to real container",
	() => {
		let name = null;

		before(() => {
			name = createWorkingContainer(
				"/tmp/switchyard-limit-test",
				"alpine:latest",
			);
		});

		after(() => {
			if (name) wipeWorkingContainer(name);
		});

		it("createWorkingContainer set NanoCpus / Memory / PidsLimit on HostConfig", () => {
			ok(name, "container should have been created");
			const out = execFileSync(
				"docker",
				[
					"inspect",
					"--format",
					"{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.PidsLimit}}",
					name,
				],
				{ encoding: "utf8" },
			).trim();
			const [nanoCpus, memory, memorySwap, pids] = out.split(/\s+/).map(Number);
			// 6 CPUs => 6e9 nano-cpus; 8g => 8589934592 bytes; swap == memory; pids 1024.
			strictEqual(nanoCpus, 6_000_000_000);
			strictEqual(memory, 8_589_934_592);
			strictEqual(memorySwap, 8_589_934_592);
			strictEqual(pids, 1024);
		});
	},
);
