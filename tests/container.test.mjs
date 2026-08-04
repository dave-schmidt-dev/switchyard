// getPlatformInfo() unit tests — host-vs-image architecture comparison.
//
// Uses dependency injection (execFn/hostArch) rather than mocking
// node:child_process or os.arch(): the module imports execFileSync as a
// live ES-module binding, which a test file cannot reassign from outside,
// and the real os.arch()/docker image inspect values depend on the machine
// running the tests (this suite must pass identically on an amd64 CI
// runner and an arm64 Apple Silicon dev machine). Injecting fakes keeps
// these tests hermetic and machine-independent — no real Docker daemon or
// built image required.

import { strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
	checkContainerRuntime,
	getPlatformInfo,
	isContainerRuntimeAvailable,
} from "../src/switchyard/container/index.mjs";
import { ensureAgentContainer } from "../src/switchyard/runner/index.mjs";

describe("getPlatformInfo", () => {
	it("reports no mismatch on an amd64 host running an amd64 image (naming-normalization false positive guard)", () => {
		// os.arch() reports "x64" for the CPU family Docker calls "amd64" —
		// a naive raw string comparison ("x64" !== "amd64") would wrongly
		// report a mismatch on every ordinary amd64 host. This is the
		// specific false positive PM-2 identified.
		const info = getPlatformInfo("switchyard-agent:latest", {
			execFn: () => "amd64",
			hostArch: "x64",
		});

		strictEqual(info.mismatch, false);
		strictEqual(info.hostArch, "amd64");
		strictEqual(info.imageArch, "amd64");
		strictEqual(info.note, null);
	});

	it("reports a mismatch on an arm64 host running an amd64 image", () => {
		const info = getPlatformInfo("switchyard-agent:latest", {
			execFn: () => "amd64",
			hostArch: "arm64",
		});

		strictEqual(info.mismatch, true);
		strictEqual(info.hostArch, "arm64");
		strictEqual(info.imageArch, "amd64");
		strictEqual(typeof info.note, "string");
		strictEqual(info.note.includes("linux/amd64"), true);
	});

	it("degrades gracefully instead of throwing when the docker probe fails", () => {
		const info = getPlatformInfo("switchyard-agent:latest", {
			execFn: () => {
				throw new Error("docker: image not found");
			},
			hostArch: "arm64",
		});

		strictEqual(info.mismatch, false);
		strictEqual(info.hostArch, "arm64");
		strictEqual(info.imageArch, null);
		strictEqual(info.note, null);
	});

	it("calls execFn with docker image inspect, an explicit args array, and a 5000ms timeout", () => {
		let capturedArgs = null;
		let capturedOptions = null;
		getPlatformInfo("switchyard-agent:latest", {
			execFn: (command, args, options) => {
				strictEqual(command, "docker");
				capturedArgs = args;
				capturedOptions = options;
				return "amd64";
			},
			hostArch: "arm64",
		});

		strictEqual(
			capturedArgs.includes("image") && capturedArgs.includes("inspect"),
			true,
		);
		strictEqual(capturedOptions.timeout, 5000);
	});

	it("degrades gracefully (never throws) when execFn itself times out", () => {
		const info = getPlatformInfo("switchyard-agent:latest", {
			execFn: () => {
				const error = new Error("Command timed out");
				error.code = "ETIMEDOUT";
				throw error;
			},
			hostArch: "arm64",
		});

		strictEqual(info.mismatch, false);
		strictEqual(info.imageArch, null);
	});
});

describe("isContainerRuntimeAvailable and checkContainerRuntime", () => {
	it("returns available true when docker info succeeds with explicit timeout", () => {
		let capturedOptions = null;
		const status = checkContainerRuntime({
			execFn: (command, args, options) => {
				strictEqual(command, "docker");
				strictEqual(args.includes("info"), true);
				capturedOptions = options;
				return "Server: Docker Engine";
			},
		});

		strictEqual(status.available, true);
		strictEqual(status.classification, null);
		strictEqual(capturedOptions.timeout, 5000);

		const isAvailable = isContainerRuntimeAvailable({
			execFn: (command, args) => {
				strictEqual(command, "docker");
				strictEqual(args.includes("info"), true);
				return "Server: Docker Engine";
			},
		});
		strictEqual(isAvailable, true);
	});

	it("classifies binary-missing when docker binary is absent (ENOENT)", () => {
		const execFn = () => {
			const err = new Error("spawnSync docker ENOENT");
			err.code = "ENOENT";
			throw err;
		};

		const status = checkContainerRuntime({ execFn });
		strictEqual(status.available, false);
		strictEqual(status.classification, "binary-missing");
		strictEqual(isContainerRuntimeAvailable({ execFn }), false);

		throws(
			() => ensureAgentContainer({ execFn }),
			(err) =>
				err.message.includes("Docker/OrbStack is not available") &&
				err.message.includes("binary-missing"),
		);
	});

	it("classifies daemon-unreachable when docker --version succeeds but docker info fails", () => {
		const execFn = (_command, args) => {
			if (args.includes("--version")) {
				return "Docker version 24.0.0";
			}
			if (args.includes("info")) {
				const err = new Error("Cannot connect to the Docker daemon");
				err.code = "ECONNREFUSED";
				throw err;
			}
			throw new Error("unexpected command");
		};

		const status = checkContainerRuntime({ execFn });
		strictEqual(status.available, false);
		strictEqual(status.classification, "daemon-unreachable");
		strictEqual(isContainerRuntimeAvailable({ execFn }), false);

		throws(
			() => ensureAgentContainer({ execFn }),
			(err) =>
				err.message.includes("Docker/OrbStack is not available") &&
				err.message.includes("daemon-unreachable"),
		);
	});

	it("asserts probe respects 5000ms timeout and classifies timeout as daemon-unreachable", () => {
		let timeoutPassed = null;
		const execFn = (_command, _args, options) => {
			timeoutPassed = options?.timeout;
			const err = new Error("Command timed out");
			err.code = "ETIMEDOUT";
			throw err;
		};

		const status = checkContainerRuntime({ execFn });
		strictEqual(timeoutPassed, 5000);
		strictEqual(status.available, false);
		strictEqual(status.classification, "daemon-unreachable");
		strictEqual(isContainerRuntimeAvailable({ execFn }), false);
	});

	it("classifies other-exec-error when execution throws a non-ENOENT error during binary check", () => {
		const execFn = (_command, args) => {
			if (args.includes("info")) {
				const err = new Error("General exec failure");
				throw err;
			}
			if (args.includes("--version")) {
				const err = new Error("Permission denied");
				err.code = "EPERM";
				throw err;
			}
			throw new Error("unexpected command");
		};

		const status = checkContainerRuntime({ execFn });
		strictEqual(status.available, false);
		strictEqual(status.classification, "other-exec-error");
		strictEqual(isContainerRuntimeAvailable({ execFn }), false);

		throws(
			() => ensureAgentContainer({ execFn }),
			(err) =>
				err.message.includes("Docker/OrbStack is not available") &&
				err.message.includes("other-exec-error"),
		);
	});
});
