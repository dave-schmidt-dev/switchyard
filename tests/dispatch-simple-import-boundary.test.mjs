// @test-phase: other
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir } from "./helpers/tempdir.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = join(ROOT, "src/switchyard/dispatch/index.mjs");
const LEGACY_CHAIN = [
	"src/switchyard/dispatch/cli.mjs",
	"src/switchyard/dispatch/status-envelope.mjs",
	"src/switchyard/lifecycle/backend-selection.mjs",
	"src/switchyard/runner/broker.mjs",
	"src/switchyard/runner/index.mjs",
];
// O1 step 4: simple reaches the run store and lifecycle through their
// defining modules, never through the barrels that carry the VM lane.
const VM_CHAIN = [
	"src/switchyard/lifecycle/index.mjs",
	"src/switchyard/lifecycle/parallels-execution-backend.mjs",
	"src/switchyard/run-store/index.mjs",
	"src/switchyard/run-store/vm-slots.mjs",
];

const dir = tempDir("switchyard-import-boundary-");
const hook = join(dir, "record-loads.mjs");
writeFileSync(
	hook,
	`import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
registerHooks({
	load(url, context, nextLoad) {
		if (url.startsWith("file:")) appendFileSync(process.env.SWITCHYARD_TEST_LOAD_LOG, \`\${url}\\n\`);
		return nextLoad(url, context);
	},
});
`,
	"utf8",
);

/** Run the real bin and return every repository module it loaded. */
function runBin(name, args) {
	const log = join(dir, `${name}.log`);
	const result = spawnSync(
		process.execPath,
		["--import", pathToFileURL(hook).href, ENTRY, ...args],
		{
			cwd: ROOT,
			encoding: "utf8",
			env: { ...process.env, SWITCHYARD_TEST_LOAD_LOG: log },
			timeout: 30_000,
		},
	);
	const loaded = existsSync(log)
		? readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((url) => relative(ROOT, fileURLToPath(url)))
		: [];
	return { result, loaded: new Set(loaded) };
}

// Regression (stability audit 2026-10-18, SC7): `switchyard-dispatch simple`
// statically loaded the legacy queue, broker and backend selection, through
// the bin's own imports and through the lock disposition's recover command,
// so an import-time defect in that code could stop the default lane.
describe("switchyard-dispatch simple import boundary", () => {
	it("routes simple without loading the legacy chain", () => {
		const { result, loaded } = runBin("simple", ["simple", "--help"]);
		strictEqual(result.status, 0, result.stderr);
		ok(result.stdout.startsWith("Usage: switchyard-dispatch simple"));
		ok(loaded.has("src/switchyard/simple/index.mjs"));
		ok(loaded.has("src/switchyard/simple/lock-disposition.mjs"));
		deepStrictEqual(
			LEGACY_CHAIN.filter((path) => loaded.has(path)),
			[],
		);
		deepStrictEqual(
			VM_CHAIN.filter((path) => loaded.has(path)),
			[],
		);
	});

	it("still loads the legacy chain for a legacy subcommand", () => {
		const { result, loaded } = runBin("status", ["status"]);
		strictEqual(result.status, 2, result.stderr);
		ok(result.stderr.startsWith("dispatch: missing <run-id>"));
		deepStrictEqual(
			LEGACY_CHAIN.filter((path) => !loaded.has(path)),
			[],
		);
	});
});
