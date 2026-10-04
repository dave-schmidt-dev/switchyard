import { strictEqual, throws } from "node:assert/strict";

import { describe, it } from "node:test";

import {
	PrlctlCallError,
	prlctlFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";

import { tempDir } from "./helpers/tempdir.mjs";

const TEST_RUN_STORE_ROOT = tempDir("switchyard-ownership-store-");

process.env.SWITCHYARD_RUN_STORE_ROOT = TEST_RUN_STORE_ROOT;

describe("prlctl job-misfire tolerance", () => {
	it("reports nothing for an error that is not a reviewed prlctl failure", () => {
		strictEqual(prlctlFailureMetadata(new Error("unrelated")), null);
		strictEqual(prlctlFailureMetadata(null), null);
	});

	it("refuses an unrecognized diagnostic code", () => {
		throws(
			() => new PrlctlCallError({ diagnosticCode: "prlctl_made_up" }),
			TypeError,
		);
	});
});
