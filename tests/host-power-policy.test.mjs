import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	HOST_POWER_PROBE,
	HOST_POWER_STATES,
	normalizeHostPower,
	probeHostPower,
	readHostPower,
} from "../src/switchyard/dispatch/host-power.mjs";

describe("host power policy", () => {
	it("uses the fixed bounded pmset probe", () => {
		const calls = [];
		const result = probeHostPower({
			execFn: (...args) => {
				calls.push(args);
				return { status: 0, stdout: "Now drawing from 'AC Power'" };
			},
		});
		strictEqual(result.state, HOST_POWER_STATES.AC);
		strictEqual(result.diagnosticCode, null);
		strictEqual(calls[0][0], HOST_POWER_PROBE.path);
		deepStrictEqual(calls[0][1], ["-g", "batt"]);
		strictEqual(calls[0][2].timeout, HOST_POWER_PROBE.timeoutMs);
	});

	it("normalizes battery and unknown states without exposing probe text", () => {
		strictEqual(
			normalizeHostPower("Now drawing from 'Battery Power'"),
			HOST_POWER_STATES.BATTERY,
		);
		strictEqual(
			normalizeHostPower("unexpected output"),
			HOST_POWER_STATES.UNKNOWN,
		);
		deepStrictEqual(
			probeHostPower({
				execFn: () => ({ status: 1, stdout: "secret stderr" }),
			}),
			{
				state: HOST_POWER_STATES.UNKNOWN,
				diagnosticCode: "host_power_unknown",
			},
		);
	});

	it("accepts an injected state for deterministic lifecycle tests", () => {
		deepStrictEqual(
			readHostPower({ hostPowerProbe: () => ({ state: "battery" }) }),
			{ state: HOST_POWER_STATES.BATTERY, diagnosticCode: "host_on_battery" },
		);
		deepStrictEqual(readHostPower({ hostPowerProbe: { state: "unknown" } }), {
			state: HOST_POWER_STATES.UNKNOWN,
			diagnosticCode: "host_power_unknown",
		});
	});
});
