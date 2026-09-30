import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
	new URL("../ops/macos-vm/sync-host-clis.sh", import.meta.url),
);
const manifestPath = fileURLToPath(
	new URL("../ops/macos-vm/cli-manifest.txt", import.meta.url),
);

const run = (...args) =>
	spawnSync("bash", [scriptPath, ...args], { encoding: "utf8" });

test("--help exits 0 and prints usage", () => {
	const result = run("--help");
	assert.equal(result.status, 0);
	assert.match(result.stderr, /Usage:/);
});

test("no arguments fails requiring --cli-manifest", () => {
	const result = run();
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /--cli-manifest is required/);
});

test("--bogus fails as unknown argument", () => {
	const result = run("--bogus");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /unknown argument/);
});

test("nonexistent manifest fails demanding a readable file", () => {
	const result = run("--cli-manifest", "/nonexistent", "--check");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /readable file/);
});

test("--only with an unknown provider fails", () => {
	const result = run("--cli-manifest", manifestPath, "--only", "notaprovider");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /unknown provider/);
});
