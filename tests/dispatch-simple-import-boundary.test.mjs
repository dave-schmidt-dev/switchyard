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
// Control-plane modules `simple` must not load: the recovery and health CLI,
// and the run-store barrel. Simple reaches the run store through its defining
// modules.
const CONTROL_CHAIN = [
	"src/switchyard/dispatch/cli.mjs",
	"src/switchyard/run-store/index.mjs",
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
// so an import-time defect in that code could stop the default lane. The
// queue and VM lane are retired (O1); the boundary still keeps simple off the
// control-plane modules.
describe("switchyard-dispatch simple import boundary", () => {
	it("routes simple without loading the control-plane modules", () => {
		const { result, loaded } = runBin("simple", ["simple", "--help"]);
		strictEqual(result.status, 0, result.stderr);
		ok(result.stdout.startsWith("Usage: switchyard-dispatch simple"));
		ok(loaded.has("src/switchyard/simple/index.mjs"));
		ok(loaded.has("src/switchyard/simple/lock-disposition.mjs"));
		deepStrictEqual(
			CONTROL_CHAIN.filter((path) => loaded.has(path)),
			[],
		);
	});

	it("loads the control-plane CLI lazily for a control subcommand", () => {
		const { result, loaded } = runBin("recover", ["recover", "--help"]);
		strictEqual(result.status, 0, result.stderr);
		ok(loaded.has("src/switchyard/dispatch/cli.mjs"));
	});
});
