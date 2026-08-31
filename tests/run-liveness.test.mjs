import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	classifyRunLiveness,
	RUN_STARTUP_GRACE_MS,
} from "../src/switchyard/run-store/run-liveness.mjs";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");

function run(overrides = {}) {
	return {
		state: "running",
		cleanupState: "not_started",
		workerPid: 1234,
		createdAt: new Date(NOW - 1_000).toISOString(),
		...overrides,
	};
}

describe("classifyRunLiveness", () => {
	it("returns terminal_clean only for a terminal run with complete cleanup", () => {
		strictEqual(
			classifyRunLiveness(
				run({ state: "succeeded", cleanupState: "complete" }),
			),
			"terminal_clean",
		);
	});

	it("protects a live terminal finalizer", () => {
		strictEqual(
			classifyRunLiveness(run({ state: "failed", cleanupState: "pending" }), {
				now: NOW,
				probePid: () => "live",
			}),
			"live",
		);
	});

	it("treats signalable and EPERM-equivalent workers as live", () => {
		strictEqual(
			classifyRunLiveness(run(), { now: NOW, probePid: () => "live" }),
			"live",
		);
	});

	it("returns dead for a recorded worker proven absent", () => {
		strictEqual(
			classifyRunLiveness(run(), { now: NOW, probePid: () => "dead" }),
			"dead",
		);
	});

	it("holds a fresh null-PID launch in startup grace", () => {
		strictEqual(
			classifyRunLiveness(run({ workerPid: null }), { now: NOW }),
			"startup_grace",
		);
	});

	it("returns dead for an expired null-PID launch", () => {
		strictEqual(
			classifyRunLiveness(
				run({
					workerPid: null,
					createdAt: new Date(NOW - RUN_STARTUP_GRACE_MS - 1).toISOString(),
				}),
				{ now: NOW },
			),
			"dead",
		);
	});

	it("fails closed for malformed, missing, and unresolved evidence", () => {
		strictEqual(
			classifyRunLiveness(run({ workerPid: null, createdAt: "bad" }), {
				now: NOW,
			}),
			"unknown",
		);
		strictEqual(
			classifyRunLiveness({ state: "running" }, { now: NOW }),
			"unknown",
		);
		strictEqual(
			classifyRunLiveness(run(), { now: NOW, probePid: () => "unknown" }),
			"unknown",
		);
	});
});
