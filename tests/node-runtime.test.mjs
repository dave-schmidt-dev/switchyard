// @test-phase: other
import { ok, strictEqual, throws } from "node:assert";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	linkSync,
	mkdirSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { currentNodeExecutable } from "../src/switchyard/node-runtime.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const SRC = join(import.meta.dirname, "..", "src", "switchyard");

function fakeCellar() {
	const root = realpathSync(tempDir("sy-node-runtime-"));
	const cellar = join(root, "Cellar", "node");
	const binary = join(cellar, "99.0.0", "bin", "node");
	mkdirSync(dirname(binary), { recursive: true });
	writeFileSync(binary, "#!/bin/sh\n");
	chmodSync(binary, 0o755);
	const link = join(root, "bin", "node");
	mkdirSync(dirname(link));
	symlinkSync(binary, link);
	return { root, cellar: `${cellar}/`, binary, link };
}

test("an existing execPath is returned unchanged", () => {
	strictEqual(currentNodeExecutable(), process.execPath);
});

test("a deleted execPath falls back to the stable link's Cellar target", () => {
	const { root, cellar, binary, link } = fakeCellar();
	strictEqual(
		currentNodeExecutable({
			execPath: join(root, "Cellar", "node", "98.0.0", "bin", "node"),
			links: [join(root, "missing"), link],
			cellar,
		}),
		binary,
	);
});

test("a fallback link that leaves the Cellar is never trusted", () => {
	const { root, link } = fakeCellar();
	throws(
		() =>
			currentNodeExecutable({
				execPath: join(root, "gone"),
				links: [link],
				cellar: join(root, "elsewhere/"),
			}),
		(error) => {
			strictEqual(error.code, "ENOENT");
			strictEqual(error.checkSetupExecutable, "node");
			return true;
		},
	);
});

test("a non-executable Cellar target is not a runtime", () => {
	const { root, cellar, binary, link } = fakeCellar();
	chmodSync(binary, 0o644);
	throws(
		() =>
			currentNodeExecutable({
				execPath: join(root, "gone"),
				links: [link],
				cellar,
			}),
		{ code: "ENOENT" },
	);
});

// Regression (2026-10-14 brew upgrade): a routing process whose own node
// binary was deleted mid-run failed `realpathSync(process.execPath)` while
// building the check sandbox and stopped as check_setup_failed. A hard link
// of the real binary, unlinked by the child itself, reproduces that exactly.
test("the sandbox profile and node spawns survive a deleted execPath", (t) => {
	if (process.platform !== "darwin") return t.skip("macOS sandbox profile");
	let real;
	try {
		real = realpathSync("/opt/homebrew/bin/node");
	} catch {
		return t.skip("requires a Homebrew node");
	}
	const root = realpathSync(tempDir("sy-node-upgrade-"));
	const execPath = join(root, "bin", "node");
	mkdirSync(dirname(execPath));
	// The binary loads libnode through @loader_path/../lib.
	symlinkSync(join(dirname(dirname(real)), "lib"), join(root, "lib"));
	try {
		linkSync(real, execPath);
	} catch (error) {
		return t.skip(`cannot hard-link node: ${error.code}`);
	}
	const clone = join(root, "clone");
	const runtime = join(root, "runtime");
	mkdirSync(clone);
	mkdirSync(runtime);
	const script = `
		import { unlinkSync } from "node:fs";
		const { currentNodeExecutable } = await import(${JSON.stringify(pathToFileURL(join(SRC, "node-runtime.mjs")).href)});
		const { quickCheckSandboxProfile } = await import(${JSON.stringify(pathToFileURL(join(SRC, "runner", "checks-sandbox.mjs")).href)});
		unlinkSync(process.execPath);
		const node = currentNodeExecutable();
		const profile = quickCheckSandboxProfile(${JSON.stringify(clone)}, ${JSON.stringify(runtime)});
		console.log(JSON.stringify({ execPath: process.execPath, node, profile: typeof profile }));
	`;
	const result = spawnSync(execPath, ["--input-type=module", "-e", script], {
		encoding: "utf8",
		timeout: 30_000,
	});
	strictEqual(result.status, 0, result.stderr);
	const report = JSON.parse(result.stdout.trim().split("\n").at(-1));
	strictEqual(report.execPath, execPath);
	strictEqual(report.node, real);
	strictEqual(report.profile, "string");
	ok(!report.node.startsWith(root));
});
