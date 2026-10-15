import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	HOST_VALIDATE_PHASES,
	runHostValidation,
	runPythonHostChecks,
} from "../scripts/run-host-validation.mjs";
import {
	runValidatePhases,
	VALIDATE_PHASES,
} from "../scripts/run-validate-phases.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const PACKAGE_JSON_PATH = resolve(PKG_ROOT, "package.json");

describe("validate phase aggregation runner", () => {
	it("runs roster:coherence even when the test phase exits non-zero", () => {
		// The concrete loss the && chain caused: a red INV-1 gate made `npm test`
		// exit 1, so the roster coherence check never reported at all and its
		// state stayed unknown until someone re-ran validate after a fix.
		const executed = [];
		const status = runValidatePhases({
			run(phase) {
				executed.push(phase);
				return phase === "test" ? 1 : 0;
			},
			log: () => {},
		});

		deepStrictEqual(executed, VALIDATE_PHASES);
		ok(
			executed.includes("roster:coherence"),
			"roster:coherence must run after a failing test phase",
		);
		strictEqual(status, 1);
	});

	it("returns the first non-zero phase status, and 0 only when every phase exits 0", () => {
		strictEqual(runValidatePhases({ run: () => 0, log: () => {} }), 0);

		strictEqual(
			runValidatePhases({
				run: (phase) => (phase === "lint" ? 2 : 0),
				log: () => {},
			}),
			2,
		);

		strictEqual(
			runValidatePhases({
				run: (phase) => (phase === "roster:coherence" ? 3 : 0),
				log: () => {},
			}),
			3,
		);

		// Two reds: the aggregated status is the first, not the last.
		strictEqual(
			runValidatePhases({
				run: (phase) => (phase === "deadcode" ? 4 : phase === "test" ? 5 : 0),
				log: () => {},
			}),
			4,
		);
	});

	it("names all four phases and their exit statuses in one summary", () => {
		const logs = [];
		runValidatePhases({
			run: (phase) => (phase === "deadcode" ? 1 : 0),
			log: (message) => logs.push(message),
		});

		strictEqual(logs.length, 1);
		const summary = logs[0];
		ok(
			summary.startsWith("Validate phase summary:"),
			`summary must label itself as validate, got: ${summary}`,
		);
		for (const phase of VALIDATE_PHASES) {
			ok(summary.includes(phase), `summary must name ${phase}: ${summary}`);
		}
		ok(
			/lint \(exit 0\)/.test(summary) && /deadcode \(exit 1\)/.test(summary),
			`summary must report each phase's exit status: ${summary}`,
		);
	});

	it("covers exactly the phases the old chain ran, in the same order", () => {
		deepStrictEqual(VALIDATE_PHASES, [
			"lint",
			"deadcode",
			"test",
			"roster:coherence",
		]);
	});

	it("points package.json's validate script at the aggregator with no &&", () => {
		const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
		strictEqual(pkg.scripts.validate, "node scripts/run-validate-phases.mjs");
		ok(
			!pkg.scripts.validate.includes("&&"),
			"validate must not short-circuit on the first red phase",
		);
		for (const phase of VALIDATE_PHASES) {
			ok(
				typeof pkg.scripts[phase] === "string" && pkg.scripts[phase].length > 0,
				`${phase} script must remain defined`,
			);
		}
	});
});

describe("host validate phase aggregation runner", () => {
	it("runs canary:sandbox even when validate exits non-zero", () => {
		const executed = [];
		const status = runHostValidation({
			run(phase) {
				executed.push(phase);
				return phase === "validate" ? 1 : 0;
			},
			log: () => {},
		});

		deepStrictEqual(executed, HOST_VALIDATE_PHASES);
		ok(
			executed.includes("canary:sandbox"),
			"canary:sandbox must run after a failing validate phase",
		);
		strictEqual(status, 1);
	});

	it("returns the first non-zero phase status, and 0 only when every phase exits 0", () => {
		strictEqual(runHostValidation({ run: () => 0, log: () => {} }), 0);

		strictEqual(
			runHostValidation({
				run: (phase) => (phase === "canary:sandbox" ? 2 : 0),
				log: () => {},
			}),
			2,
		);

		strictEqual(
			runHostValidation({
				run: (phase) => (phase === "validate" ? 3 : 0),
				log: () => {},
			}),
			3,
		);

		strictEqual(
			runHostValidation({
				run: (phase) =>
					phase === "validate" ? 4 : phase === "canary:sandbox" ? 5 : 0,
				log: () => {},
			}),
			4,
		);
	});

	it("names all host validate phases and their exit statuses in one summary", () => {
		const logs = [];
		runHostValidation({
			run: (phase) => (phase === "canary:sandbox" ? 1 : 0),
			log: (message) => logs.push(message),
		});

		strictEqual(logs.length, 1);
		const summary = logs[0];
		ok(
			summary.startsWith("Host validate phase summary:"),
			`summary must label itself as host validate, got: ${summary}`,
		);
		for (const phase of HOST_VALIDATE_PHASES) {
			ok(summary.includes(phase), `summary must name ${phase}: ${summary}`);
		}
		ok(
			/validate \(exit 0\)/.test(summary) &&
				/canary:sandbox \(exit 1\)/.test(summary),
			`summary must report each phase's exit status: ${summary}`,
		);
	});

	it("covers validate, canary and counted Python host phases", () => {
		deepStrictEqual(HOST_VALIDATE_PHASES, [
			"validate",
			"canary:sandbox",
			"python:host",
		]);
	});

	it("points package.json's validate:host script at the host aggregator", () => {
		const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
		strictEqual(
			pkg.scripts["validate:host"],
			"node scripts/run-host-validation.mjs",
		);
		strictEqual(
			pkg.scripts["canary:sandbox"],
			"node scripts/sandbox-canary.mjs",
		);
	});

	it("points .githooks/pre-push at npm run validate:host", () => {
		const prePush = readFileSync(
			resolve(PKG_ROOT, ".githooks/pre-push"),
			"utf8",
		);
		ok(
			prePush.includes("npm run validate:host"),
			"pre-push hook must execute npm run validate:host",
		);
	});

	it("keeps ordinary validate unchanged for confinement", () => {
		const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
		strictEqual(pkg.scripts.validate, "node scripts/run-validate-phases.mjs");
		ok(
			!VALIDATE_PHASES.includes("canary:sandbox"),
			"ordinary validate must not include canary:sandbox",
		);
	});
});

describe("strict Python host execution evidence", () => {
	const tap = (counts = {}) => {
		const values = {
			tests: 6,
			pass: 6,
			fail: 0,
			cancelled: 0,
			skipped: 0,
			todo: 0,
			...counts,
		};
		return (
			"TAP version 13\n" +
			Array.from(
				{ length: 6 },
				(_, index) => `    ok ${index + 1} - host case`,
			).join("\n") +
			"\n    1..6\nok 1 - Python host suite\n1..1\n" +
			Object.entries(values)
				.map(([key, value]) => `# ${key} ${value}`)
				.join("\n") +
			"\n"
		);
	};
	function outcome(stdout, overrides = {}) {
		return {
			status: 0,
			signal: null,
			error: null,
			stdout,
			stderr: "",
			...overrides,
		};
	}
	it("accepts six real passed cases and bounds the direct host subprocess", () => {
		let called = false;
		strictEqual(
			runPythonHostChecks({
				log: () => {},
				spawn(command, args, options) {
					called = true;
					strictEqual(command, process.execPath);
					deepStrictEqual(args, [
						"--test",
						"--test-reporter=tap",
						"tests/runner-python-quick-checks-host.test.mjs",
					]);
					strictEqual(options.timeout, 240000);
					strictEqual(options.maxBuffer, 1048576);
					strictEqual(options.forwardOutput, true);
					strictEqual(
						options.progressLabel,
						"host validation: Python host checks still running",
					);
					strictEqual(Object.hasOwn(options.env, "NODE_TEST_CONTEXT"), false);
					return outcome(tap());
				},
			}),
			0,
		);
		strictEqual(called, true);
	});
	it("rejects skipped, unavailable, zero, partial, failed and malformed evidence", () => {
		for (const output of [
			tap({ tests: 0, pass: 0 }),
			tap({ pass: 0, skipped: 6 }),
			tap({ tests: 5, pass: 5 }),
			tap({ pass: 5, skipped: 1 }),
			tap({ pass: 5, fail: 1 }),
			tap({ cancelled: 1 }),
			tap({ todo: 1 }),
			`${tap()}# tests 6\n`,
			"",
			"fixture unavailable",
			tap().replace("    1..6\n", ""),
			tap().replace("    ok 1 - host case\n", ""),
			"TAP version 13\n# tests nope\n",
			tap().replace("# skipped 0\n", ""),
			`not ok 1 - failure\n${tap()}`,
		]) {
			strictEqual(
				runPythonHostChecks({ log: () => {}, spawn: () => outcome(output) }),
				1,
				output,
			);
		}
	});
	it("rejects nonzero, signalled, timed out, overflow and invalid subprocess reports", () => {
		for (const result of [
			outcome(tap(), { status: 1 }),
			outcome(tap(), { signal: "SIGKILL" }),
			outcome(tap(), { error: { code: "ETIMEDOUT" } }),
			{ status: 1, stdout: outcome(tap()).stdout },
			{ status: 0, error: { code: "ENOBUFS" } },
			{ status: 0, stdout: "not json" },
		]) {
			strictEqual(
				runPythonHostChecks({ log: () => {}, spawn: () => result }),
				1,
			);
		}
		strictEqual(
			runPythonHostChecks({
				log: () => {},
				spawn: () => {
					throw new Error("unavailable");
				},
			}),
			1,
		);
	});
	it("aggregates Python failure after validate and canary without short circuiting", () => {
		const executed = [];
		strictEqual(
			runHostValidation({
				run: (phase) => {
					executed.push(phase);
					return phase === "python:host" ? 1 : 0;
				},
				log: () => {},
			}),
			1,
		);
		deepStrictEqual(executed, HOST_VALIDATE_PHASES);
	});
});
