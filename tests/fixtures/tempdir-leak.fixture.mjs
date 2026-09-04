import { test } from "node:test";
import { tempDir, tempDirAsync, tempDirIn } from "../helpers/tempdir.mjs";

// Deliberately failing fixture, run as a child process by
// tests/tempdir-hygiene.test.mjs. It is not named *.test.mjs and lives outside
// tests/ so the suite's own non-recursive glob never picks it up.
//
// Each of the three shapes below is a way the suite used to leak: a test that
// throws before its cleanup line, a rejected promise, and a directory whose
// tracked parent is removed early.
test("throws after creating a temp directory", () => {
	tempDir("switchyard-fixture-throw-");
	throw new Error("deliberate failure");
});

test("rejects after creating a temp directory", async () => {
	await tempDirAsync("switchyard-fixture-reject-");
	await Promise.reject(new Error("deliberate rejection"));
});

test("fails an assertion after nesting under a temp parent", () => {
	const parent = tempDir("switchyard-fixture-parent-");
	tempDirIn(parent, "switchyard-fixture-child-");
	throw new Error("deliberate failure after nesting");
});
