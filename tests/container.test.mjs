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

import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { getPlatformInfo } from "../src/switchyard/container/index.mjs";

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
});
