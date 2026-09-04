import { ok, strictEqual } from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { executeAsync } from "../src/switchyard/adapter/vibe.mjs";
import { validateInvocationDescriptor } from "../src/switchyard/roster/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";

const DESCRIPTOR = validateInvocationDescriptor(
	{
		target_id: "vibe",
		model_ref: "zhipu/glm-5.2-high",
		selector: "glm-5.2-high",
		effort: null,
		variant: null,
		invocation_args: [],
	},
	"vibe",
);

function isServedProbe(candidate) {
	return candidate.argv.some(
		(arg) => typeof arg === "string" && arg.includes("logs/session"),
	);
}

function isConfigWrite(candidate) {
	return candidate.argv.some(
		(arg) => typeof arg === "string" && arg.includes("config"),
	);
}

function node(script, { exit = 0 } = {}) {
	return {
		command: process.execPath,
		args: ["-e", `${script}; process.exit(${exit})`],
	};
}

function options(executionBackend, extra = {}) {
	return {
		model: DESCRIPTOR.selector,
		resolvedTargetId: DESCRIPTOR.target_id,
		descriptorHarness: "vibe",
		invocationDescriptor: DESCRIPTOR,
		descriptorIdentity: DESCRIPTOR.descriptor_identity,
		executionBackend,
		...extra,
	};
}

describe("Vibe async failure evidence", () => {
	it("keeps a failed run's own diagnosis instead of the served-model probe's", async () => {
		const probes = [];
		const executionBackend = {
			execArgv(_workspaceId, candidate) {
				if (isServedProbe(candidate)) {
					probes.push(candidate);
					// The working container is reused across every task in a queue,
					// so the newest session directory belongs to whichever task last
					// got far enough to write one. Reading it after a failure names
					// the PREVIOUS task's model.
					return node('process.stdout.write("glm-5.2-low")');
				}
				if (isConfigWrite(candidate)) return node("");
				return node('process.stderr.write("vibe blew up")', { exit: 1 });
			},
		};

		const result = await executeAsync("change one file", WORKSPACE, {
			...options(executionBackend),
		});

		strictEqual(result.success, false);
		ok(
			!/silently substituted/.test(result.error ?? ""),
			`a failed run must keep its own cause, got: ${result.error}`,
		);
		strictEqual(
			probes.length,
			0,
			"the probe must not run at all once the invocation has already failed",
		);
	});

	it("retries the served-model probe the same number of times as the sync path", async () => {
		// The adapter builds the probe command once and reuses it, so counting
		// execArgv calls would report 1 however many times the probe actually
		// ran. The tally has to come from the spawned process itself.
		const tally = join(tempDir("switchyard-vibe-probe-"), "attempts");
		const probeScript = [
			'const fs = require("node:fs");',
			`const p = ${JSON.stringify(tally)};`,
			'const n = (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "").length + 1;',
			'fs.writeFileSync(p, "x".repeat(n));',
			// Two transient prlctl misfires, then the real answer. A single
			// attempt would leave the substitution guard inactive here.
			"if (n < 3) process.exit(1);",
			'process.stdout.write("glm-5.2-high");',
		].join(" ");
		const executionBackend = {
			execArgv(_workspaceId, candidate) {
				if (isServedProbe(candidate))
					return { command: process.execPath, args: ["-e", probeScript] };
				if (isConfigWrite(candidate)) return node("");
				return node('process.stdout.write("vibe-ran")');
			},
		};

		const result = await executeAsync("change one file", WORKSPACE, {
			...options(executionBackend),
		});

		const attempts = existsSync(tally) ? readFileSync(tally, "utf8").length : 0;
		strictEqual(attempts, 3);
		strictEqual(result.success, true);
		strictEqual(result.servedModel, "glm-5.2-high");
	});

	it("announces each helper wait rather than blocking silently", async () => {
		const events = [];
		const executionBackend = {
			execArgv(_workspaceId, candidate) {
				if (isServedProbe(candidate))
					return node('process.stdout.write("glm-5.2-high")');
				if (isConfigWrite(candidate)) return node("");
				return node('process.stdout.write("vibe-ran")');
			},
		};

		await executeAsync("change one file", WORKSPACE, {
			...options(executionBackend, {
				onStatus: (event) => events.push(event.event),
			}),
		});

		// Each helper exec can sit for a minute per attempt, three attempts deep.
		// A blocking call with no feedback path is an incomplete implementation
		// here, not a style nit.
		ok(
			events.includes("provider_config_write_started"),
			`config write wait was silent: ${events.join(", ")}`,
		);
		ok(
			events.includes("served_model_probe_started"),
			`served-model probe wait was silent: ${events.join(", ")}`,
		);
	});
});
