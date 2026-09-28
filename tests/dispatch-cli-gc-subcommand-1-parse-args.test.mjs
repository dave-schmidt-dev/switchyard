import { ok, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseGcArgs } from "../src/switchyard/dispatch/index.mjs";
import { ROSTER_FIXTURE_PATH } from "./helpers/dispatch-cli-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let dir;
let tasksFile;
let projectDir;
let stateRoot;
beforeEach(async () => {
	dir = tempDir("switchyard-dispatch-cli-");
	stateRoot = join(dir, "state-root");
	tasksFile = join(dir, "tasks.md");
	writeFileSync(
		tasksFile,
		"### Task 1.1: Test task\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** A test\n",
		"utf8",
	);
	projectDir = join(dir, "project");
	mkdirSync(join(projectDir, ".git"), { recursive: true });

	// Set env var so direct run-store calls in tests target the temp dir
	process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;
	process.env.SWITCHYARD_ROSTER_PATH = ROSTER_FIXTURE_PATH;
	// Real dispatch subprocesses go through the real, unmocked ledger writer —
	// redirect it so this suite never writes to the real dispatch-ledger.jsonl.
	process.env.SWITCHYARD_LEDGER_PATH = join(dir, "dispatch-ledger.jsonl");
});
afterEach(() => {
	delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	delete process.env.SWITCHYARD_ROSTER_PATH;
	delete process.env.SWITCHYARD_LEDGER_PATH;
	rmSync(dir, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});
describe("gc subcommand (T62)", () => {
	it("parseGcArgs parses valid flags", () => {
		const parsed = parseGcArgs(["--state-root", "/tmp/state", "--json"]);
		strictEqual(parsed.stateRoot, resolve("/tmp/state"));
		strictEqual(parsed.json, true);
		strictEqual(parsed.help, false);
	});
	it("parseGcArgs returns help: true for --help", () => {
		const parsed = parseGcArgs(["--help"]);
		strictEqual(parsed.help, true);
	});
	it("parseGcArgs accepts explicit --apply while defaulting to dry-run", () => {
		strictEqual(parseGcArgs([]).apply, false);
		strictEqual(parseGcArgs(["--apply"]).apply, true);
	});
	it("parseGcArgs rejects unexpected positionals or options", () => {
		let thrown = null;
		try {
			parseGcArgs(["unexpected-positional"]);
		} catch (err) {
			thrown = err;
		}
		ok(thrown instanceof Error);
	});
});
