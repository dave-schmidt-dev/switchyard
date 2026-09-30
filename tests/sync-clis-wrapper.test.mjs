import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"ops",
	"macos-vm",
	"sync-clis.sh",
);

function run(flag) {
	return spawnSync("bash", [script, flag], { encoding: "utf8" });
}

test("sync-clis.sh --help prints usage to stderr and exits 2", () => {
	const r = run("--help");
	assert.equal(r.status, 2);
	assert.equal(r.stdout, "");
	assert.match(r.stderr, /^Usage: sync-clis\.sh \[--check\]\n$/);
});

test("sync-clis.sh --bogus prints usage to stderr and exits 2", () => {
	const r = run("--bogus");
	assert.equal(r.status, 2);
	assert.equal(r.stdout, "");
	assert.match(r.stderr, /^Usage: sync-clis\.sh \[--check\]\n$/);
});
