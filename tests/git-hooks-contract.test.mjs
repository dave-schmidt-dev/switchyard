import { ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = process.cwd();
const HOOKS = ["pre-commit", "pre-push"];

function git(...args) {
	return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

/** First line that is neither blank nor a comment, after the shebang. */
function firstCommandLine(script) {
	return script
		.split("\n")
		.slice(1)
		.find((line) => line.trim() !== "" && !line.trim().startsWith("#"));
}

// Git runs hooks from `core.hooksPath`, and `prepare` (run by `npm install`)
// is the only thing that sets it. The live config is deliberately not asserted:
// checker clones install with `--ignore-scripts`, so `prepare` never runs there.
// What this pins is the tracked state that makes the hooks run in every checkout
// and linked worktree: executable and `set -e`, with no generated wrapper layer.
describe("tracked git hooks", () => {
	for (const hook of HOOKS) {
		const path = `.githooks/${hook}`;

		it(`${hook} is tracked as an executable file`, () => {
			const [entry] = git("ls-files", "-s", path).split("\t");
			strictEqual(entry.split(" ")[0], "100755");
		});

		it(`${hook} is a standalone sh script that stops on the first failure`, () => {
			const script = readFileSync(join(ROOT, path), "utf8");
			strictEqual(script.split("\n")[0], "#!/bin/sh");
			strictEqual(firstCommandLine(script), "set -e");
		});
	}

	it("prepare points core.hooksPath at the tracked directory", () => {
		const packageJson = JSON.parse(
			readFileSync(join(ROOT, "package.json"), "utf8"),
		);
		strictEqual(
			packageJson.scripts.prepare,
			"git config core.hooksPath .githooks",
		);
	});

	it("husky is gone from the dependencies and the tracked tree", () => {
		const packageJson = JSON.parse(
			readFileSync(join(ROOT, "package.json"), "utf8"),
		);
		ok(!("husky" in (packageJson.devDependencies ?? {})));
		strictEqual(git("ls-files", ".husky").trim(), "");
	});
});
