// @test-phase: other
import { strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { HANG_GUARD_MS } from "./helpers/hang-guard.mjs";

const SRC = fileURLToPath(new URL("../src/switchyard", import.meta.url));

// os.homedir() throws when HOME is unset and the account has no passwd entry
// (a sandbox, a container with an arbitrary uid). The child makes that
// failure deterministic, then imports the given modules.
const CHILD = `
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
const os = createRequire(import.meta.url)("node:os");
os.homedir = () => {
	throw new Error("uv_os_homedir returned ENOENT");
};
syncBuiltinESMExports();
const failures = [];
for (const path of JSON.parse(process.env.SY_IMPORT_PATHS)) {
	try {
		await import(pathToFileURL(path).href);
	} catch (error) {
		failures.push(path + ": " + error.message);
	}
}
process.stdout.write(JSON.stringify(failures));
`;

function importWithoutHome(paths) {
	const env = { ...process.env, SY_IMPORT_PATHS: JSON.stringify(paths) };
	delete env.HOME;
	delete env.USERPROFILE;
	const child = spawnSync(
		process.execPath,
		["--input-type=module", "-e", CHILD],
		{ encoding: "utf8", env, timeout: HANG_GUARD_MS },
	);
	strictEqual(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

function sourceModules(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceModules(path);
		return entry.name.endsWith(".mjs") ? [path] : [];
	});
}

describe("importing without a resolvable home directory", () => {
	it("imports the router eligibility module", () => {
		const failures = importWithoutHome([
			join(SRC, "router", "eligibility.mjs"),
			join(SRC, "router", "index.mjs"),
		]);
		strictEqual(failures.length, 0, failures.join("\n"));
	});

	it("imports every source module without calling homedir() at module scope", () => {
		const failures = importWithoutHome(sourceModules(SRC));
		strictEqual(failures.length, 0, failures.join("\n"));
	});
});
