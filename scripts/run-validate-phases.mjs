#!/usr/bin/env node

/**
 * Run every validate phase unconditionally and report each one's exit status.
 *
 * `validate` was `lint && deadcode && test && roster:coherence`, so the first
 * red phase short-circuited the rest: with the INV-1 clipboard gate failing,
 * `npm test` exited 1 and `roster:coherence` never reported at all. That can
 * never produce a false pass, since any failing phase still exits non-zero,
 * but it turns one known red into an unknown number of unknowns and costs a
 * full re-run to learn what else was broken.
 *
 * The aggregation itself is `runPhases` from `run-test-phases.mjs`, reused
 * rather than reimplemented. Its entrypoint and `DEFAULT_PHASES` are
 * deliberately left alone: `tests/test-phase-aggregation.test.mjs` pins both
 * to the two test phases, and widening either would break assertions that
 * exist to hold them still.
 */

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runPhases } from "./run-test-phases.mjs";

/** Ordered so the cheap static checks report before the expensive suites. */
export const VALIDATE_PHASES = ["lint", "deadcode", "test", "roster:coherence"];

export function runValidatePhases({ run, log = console.log } = {}) {
	return runPhases({
		phases: VALIDATE_PHASES,
		...(run ? { run } : {}),
		// `runPhases` labels its summary for the test phases. Relabel here
		// rather than parameterising the shared runner, which is pinned.
		log: (message) =>
			log(message.replace(/^Test phase summary:/, "Validate phase summary:")),
	});
}

if (
	process.argv[1] &&
	(fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
		(existsSync(process.argv[1]) &&
			import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href))
) {
	process.exit(runValidatePhases());
}
