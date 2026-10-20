// @test-phase: other
import { strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import { buildSimpleRepairPrompt } from "../src/switchyard/simple/repair.mjs";

const CONTEXT = {
	originalTask: "Fix the bug.",
	checkIndex: 2,
	causeCode: "acceptance_check_failed",
};
const REPAIR =
	"Fix the bug.\n\nOne correction is allowed. Acceptance check 2 failed with acceptance_check_failed. Make only the correction needed to complete the original task within its declared file scope. Do not request or reproduce check output.";

test("the default repair prompt is unchanged", () => {
	strictEqual(buildSimpleRepairPrompt(CONTEXT), REPAIR);
	strictEqual(
		buildSimpleRepairPrompt({ ...CONTEXT, redAtBaseline: false }),
		REPAIR,
	);
});

test("redAtBaseline appends the pre-existing-failure sentence", () => {
	strictEqual(
		buildSimpleRepairPrompt({ ...CONTEXT, redAtBaseline: true }),
		`${REPAIR} This check also failed on the unmodified checkout before your change, so some of its failures may predate the task; fix only what the task requires.`,
	);
});

test("a red check judged test by test gets the differential sentence", () => {
	strictEqual(
		buildSimpleRepairPrompt({
			...CONTEXT,
			redAtBaseline: true,
			differential: true,
		}),
		`${REPAIR} This check also failed on the unmodified checkout before your change and is judged test by test: the task's own tests must pass and no new failure may appear; failures that predate the task outside your declared files may remain.`,
	);
	// The differential flag alone, without a red baseline, adds nothing.
	strictEqual(
		buildSimpleRepairPrompt({ ...CONTEXT, differential: true }),
		REPAIR,
	);
});

test("an invalid repair context still throws", () => {
	throws(
		() => buildSimpleRepairPrompt({ ...CONTEXT, checkIndex: 0 }),
		TypeError,
	);
});
