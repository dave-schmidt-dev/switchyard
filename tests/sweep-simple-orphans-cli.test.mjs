import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { HANG_GUARD_MS } from "./helpers/hang-guard.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const SCRIPT = fileURLToPath(
	new URL("../scripts/sweep-temp-dirs.mjs", import.meta.url),
);

// Regression (stability audit 2026-10-18): the 2026-09-28 module split left
// `listHeldPathsViaLsof` and `DEFAULT_RUN_STORE_ROOT` undeclared in the
// collector, so `sweep:temp --simple-orphans` died with a ReferenceError
// before scanning anything. Unit tests passed because they inject both.
describe("sweep-temp-dirs --simple-orphans", () => {
	it("runs a dry run end to end with the default open-handle check", () => {
		const root = tempDir("switchyard-simple-orphans-cli-");
		const tmp = join(root, "tmp");
		const store = join(root, "store");
		mkdirSync(tmp);
		mkdirSync(join(store, "runs"), { recursive: true });
		const result = spawnSync(process.execPath, [SCRIPT, "--simple-orphans"], {
			encoding: "utf8",
			env: { ...process.env, TMPDIR: tmp, SWITCHYARD_RUN_STORE_ROOT: store },
			timeout: HANG_GUARD_MS,
		});
		ok(!result.stderr.includes("ReferenceError"), result.stderr);
		// Reaching the open-handle check is the regression proof. A host-wide
		// lsof that outlives the collector's bound fails closed instead, which
		// the host decides, not this code: on 2026-10-18 four processes each
		// stalled lsof for 5 to 10 s, so the scan took about 30.5 s.
		if (result.stdout.includes("simple-orphans: lsof unavailable")) {
			strictEqual(result.status, 1, result.stdout);
			return;
		}
		strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
		ok(
			result.stdout.includes("simple-orphans dry-run: uuidRoots=0"),
			result.stdout,
		);
	});
});
