import { rmSync } from "node:fs";
import { test } from "node:test";
import { tempDir, tempDirAsync, tempDirIn } from "../helpers/tempdir.mjs";

// Deliberately failing fixture, run as a child process by
// tests/tempdir-hygiene.test.mjs. It is not named *.test.mjs and sits a level
// down in tests/fixtures/, so the suite's non-recursive `tests/*.test.mjs`
// glob never picks it up.
//
// Each of the four shapes below is a way the suite used to leak, or a way the
// cleanup could fail while claiming to have run: a test that throws before its
// cleanup line, a rejected promise, a directory nested under a tracked parent,
// and a tracked directory whose parent was already removed - which leaves the
// exit handler holding a path that no longer exists.
test("fails after removing the parent of a tracked directory", () => {
	const parent = tempDir("switchyard-fixture-orphan-parent-");
	tempDirIn(parent, "switchyard-fixture-orphan-child-");
	// The exit handler now holds a tracked path whose parent is gone. If it
	// threw on the missing path it would abandon every entry after it, turning
	// one stale directory into a whole run's worth.
	rmSync(parent, { recursive: true, force: true });
	throw new Error("deliberate failure after orphaning a tracked path");
});

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
