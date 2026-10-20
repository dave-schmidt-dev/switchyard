// @test-phase: other
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
// and linked worktree: executable and fail-closed, with no generated wrapper layer.
describe("tracked git hooks", () => {
	for (const hook of HOOKS) {
		const path = `.githooks/${hook}`;

		it(`${hook} is tracked as an executable file`, () => {
			const [entry] = git("ls-files", "-s", path).split("\t");
			strictEqual(entry.split(" ")[0], "100755");
		});

		it(`${hook} is a standalone sh script that preserves gate failures`, () => {
			const script = readFileSync(join(ROOT, path), "utf8");
			strictEqual(script.split("\n")[0], "#!/bin/sh");
			if (hook === "pre-commit") {
				strictEqual(firstCommandLine(script), "set -e");
			} else {
				const lines = script.split("\n").map((line) => line.trim());
				const initialStatus = 'echo "1" > "$STATUS_FILE"';
				const runGate = 'eval "$GATE" </dev/null || status=$?';
				for (const line of [
					"GATE='npm run validate:host'",
					initialStatus,
					`trap 'status=$?; echo "$status" > "$STATUS_FILE"' EXIT`,
					runGate,
					'EXIT_CODE="$(cat "$STATUS_FILE")"',
					'if [ "$EXIT_CODE" -eq 0 ]; then',
					'exit "$EXIT_CODE"',
				])
					ok(lines.includes(line), `pre-push must preserve ${line}`);
				ok(lines.indexOf(initialStatus) < lines.indexOf(runGate));
			}
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

	it("pre-push clears Git repository variables before validation", () => {
		const prePush = readFileSync(join(ROOT, ".githooks/pre-push"), "utf8");
		const preCommit = readFileSync(join(ROOT, ".githooks/pre-commit"), "utf8");
		const unsetLine = "unset $(git rev-parse --local-env-vars)";
		const validateLine = "npm run validate";

		strictEqual(prePush.split("\n").includes(unsetLine), true);
		strictEqual(
			prePush.indexOf(unsetLine) < prePush.indexOf(validateLine),
			true,
		);
		strictEqual(preCommit.includes("--local-env-vars"), false);
	});

	it("husky is gone from the dependencies and the tracked tree", () => {
		const packageJson = JSON.parse(
			readFileSync(join(ROOT, "package.json"), "utf8"),
		);
		ok(!("husky" in (packageJson.devDependencies ?? {})));
		strictEqual(git("ls-files", ".husky").trim(), "");
	});
});
