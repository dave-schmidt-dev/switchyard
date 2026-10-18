// @test-phase: other
import { deepStrictEqual, strictEqual } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as remediationSupport from "../src/switchyard/dispatch/remediate-orphaned-locks-support.mjs";

const SRC = fileURLToPath(new URL("../src/switchyard", import.meta.url));
const LOCK_IDENTITY = "`project:${";

// Regression (stability audit 2026-10-18, ARCH-10): orphaned-lock remediation
// kept its own copy of the run store's lock-name hash, so a change to either
// recipe would leave remediation looking for locks under names the run store
// never wrote, and a stuck project lock would stay stuck.
describe("project lock names have one source", () => {
	it("builds the project lock identity only in run-store/project-lock-files.mjs", () => {
		const owners = readdirSync(SRC, { recursive: true })
			.filter((path) => path.endsWith(".mjs"))
			.filter((path) =>
				readFileSync(join(SRC, path), "utf8").includes(LOCK_IDENTITY),
			);
		deepStrictEqual(owners, ["run-store/project-lock-files.mjs"]);
	});

	it("leaves no lock-name recipe on the remediation support surface", () => {
		strictEqual("projectLockFileName" in remediationSupport, false);
		strictEqual("cwdDerivedProjectLockFileName" in remediationSupport, false);
	});
});
