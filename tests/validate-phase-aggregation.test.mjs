import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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
