import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";

import { describe, it } from "node:test";

import { prlctlFailureMetadata } from "../src/switchyard/adapter/exec-error.mjs";

import { describeBulkTransferFailure } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";

import { tempDir } from "./helpers/tempdir.mjs";

const TEST_RUN_STORE_ROOT = tempDir("switchyard-ownership-store-");

process.env.SWITCHYARD_RUN_STORE_ROOT = TEST_RUN_STORE_ROOT;

describe("bulk-transfer failures reach the run record classified", () => {
	it("reads the misfire, the attempt count and prlctl's own exit code", () => {
		const error = describeBulkTransferFailure(
			`bulk transfer failed after 4 attempt(s): prlctl failed (255): PrlJob_GetRetCode: Invalid argument. An invalid argument was passed.`,
		);

		deepStrictEqual(prlctlFailureMetadata(error), {
			diagnosticCode: "prlctl_job_misfire",
			exitCode: 255,
		});
		strictEqual(error.attempts, 4);
	});

	it("classifies an ordinary transfer failure without inventing metadata", () => {
		// The helper's process exit status is 1 for every failure and is not
		// prlctl's, so nothing may be recorded as an exit code here.
		const error = describeBulkTransferFailure(
			"bulk transfer failed after 1 attempt(s): guest did not upload a tar",
		);

		deepStrictEqual(prlctlFailureMetadata(error), {
			diagnosticCode: "prlctl_call_failed",
		});
		ok(/guest did not upload a tar/.test(error.message), error.message);
	});

	it("still produces a closed code when the helper said nothing", () => {
		const error = describeBulkTransferFailure("");
		strictEqual(error.diagnosticCode, "prlctl_call_failed");
		strictEqual(error.attempts, 1);
		ok(/Parallels bulk transfer failed/.test(error.message), error.message);
	});

	it("reaches prlctl_call_timed_out from the spawn error when the helper never wrote to stderr", () => {
		// A spawnSync-level failure -- killed on a timeout, or its output blew
		// past maxBuffer on a large tar -- never produces the helper's own
		// stderr line, so `spawnError` is the only cause there is. Without
		// forwarding it, this can only ever fall through to the generic
		// prlctl_call_failed code, which is the defect this parameter exists
		// to remove.
		const spawnError = new Error("spawnSync helper ETIMEDOUT");
		spawnError.code = "ETIMEDOUT";
		spawnError.killed = true;

		const error = describeBulkTransferFailure("", spawnError);

		strictEqual(error.diagnosticCode, "prlctl_call_timed_out");
		deepStrictEqual(prlctlFailureMetadata(error), {
			diagnosticCode: "prlctl_call_timed_out",
		});
		strictEqual(error.attempts, 1);
		ok(/ETIMEDOUT/.test(error.message), error.message);
	});

	it("still reports the kill even when the helper also wrote its own stderr line", () => {
		// classifyPrlctlFailure checks spawnError.killed/code unconditionally,
		// after the text-based regexes fail to match -- it is not gated on
		// whether stderr was empty. So a helper that logged a specific reason
		// and was then killed still classifies as timed_out, not as the text's
		// own (weaker) reason; only the message's wording prefers the helper's
		// own words over the spawn error's.
		const spawnError = new Error("spawnSync helper ETIMEDOUT");
		spawnError.code = "ETIMEDOUT";
		spawnError.killed = true;

		const error = describeBulkTransferFailure(
			"bulk transfer failed after 2 attempt(s): guest did not upload a tar",
			spawnError,
		);

		strictEqual(error.diagnosticCode, "prlctl_call_timed_out");
		strictEqual(error.attempts, 2);
		ok(/guest did not upload a tar/.test(error.message), error.message);
	});
});
