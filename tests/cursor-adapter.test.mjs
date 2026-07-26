import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	captureDiff,
	executeCursor,
} from "../src/switchyard/adapter/cursor.mjs";

function hasDocker() {
	try {
		execSync("docker --version", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const dockerAvailable = hasDocker();
const testRoot = mkdtempSync(join(tmpdir(), "switchyard-cursor-adapter-"));
const containerName = `switchyard-cursor-adapter-${Date.now()}`;

const CURSOR_MODEL = "composer-2.5";
const CURSOR_PROMPT = "apply a small change";

// Fake `cursor-agent` that ENFORCES the adapter's invocation shape: it exits
// non-zero unless --print, --force, --trust, --output-format text, and
// --model <value> are all present (--output-format/--model correctly paired
// with their own value), with <prompt> anchored as the final positional
// arg — so a dropped or misordered flag turns this test red instead of
// passing silently, the argv-blind-stub gap Task 19 tracks. executeCursor
// invokes cursor-agent directly (TASKS.md Task 24: auth is now a real
// in-container OAuth login, not a generated wrapper binary that exports an
// injected API key). cursor-agent can't read stdin, so — unlike the codex
// stub — this one never drains stdin.
const CURSOR_STUB = `#!/bin/sh
case " $* " in
  *" --print "*) ;;
  *) echo "stub: executeCursor did not pass --print; args: $*" >&2; exit 3 ;;
esac
case " $* " in
  *" --force "*) ;;
  *) echo "stub: executeCursor did not pass --force; args: $*" >&2; exit 3 ;;
esac
case " $* " in
  *" --trust "*) ;;
  *) echo "stub: executeCursor did not pass --trust; args: $*" >&2; exit 3 ;;
esac
case " $* " in
  *" --output-format text "*) ;;
  *) echo "stub: executeCursor did not pass --output-format text; args: $*" >&2; exit 3 ;;
esac
case " $* " in
  *" --model ${CURSOR_MODEL} "*) ;;
  *) echo "stub: executeCursor did not pass --model ${CURSOR_MODEL}; args: $*" >&2; exit 3 ;;
esac
case " $* " in
  *" ${CURSOR_PROMPT} ") ;;
  *) echo "stub: executeCursor did not pass ${CURSOR_PROMPT} as the final positional arg; args: $*" >&2; exit 3 ;;
esac
echo updated >> test.txt
echo cursor-agent
`;

describe("cursor adapter container execution", () => {
	before(() => {
		if (!dockerAvailable) return;

		writeFileSync(join(testRoot, "test.txt"), "base\n", "utf8");
		execSync("git init", { cwd: testRoot, stdio: "pipe" });
		execSync('git config user.email "test@test.com"', {
			cwd: testRoot,
			stdio: "pipe",
		});
		execSync('git config user.name "Test"', { cwd: testRoot, stdio: "pipe" });
		execSync("git add test.txt", { cwd: testRoot, stdio: "pipe" });
		execSync('git commit -m "base"', { cwd: testRoot, stdio: "pipe" });

		execSync(
			`docker run -d --name ${containerName} --entrypoint sh -v ${testRoot}:/project -w /project alpine/git -c "sleep infinity"`,
			{ stdio: "pipe" },
		);

		// Write the arg-checking stub on the host and copy it in (docker cp, not
		// the /project mount) so the multi-line `case` script survives intact
		// rather than fighting nested printf/quote escaping. It lands untracked,
		// so `git diff` (captureDiff) only ever sees the edit to test.txt.
		const stubPath = join(testRoot, "cursor-agent-stub.sh");
		writeFileSync(stubPath, CURSOR_STUB, { mode: 0o755 });
		execSync(
			`docker cp ${stubPath} ${containerName}:/usr/local/bin/cursor-agent`,
			{ stdio: "pipe" },
		);
		execSync(
			`docker exec ${containerName} chmod +x /usr/local/bin/cursor-agent`,
			{ stdio: "pipe" },
		);
	});

	after(() => {
		if (dockerAvailable) {
			try {
				execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
			} catch {
				// ignore cleanup errors
			}
		}
		rmSync(testRoot, { recursive: true, force: true });
	});

	it("passes --print --force --trust --output-format text --model and <prompt>, and captures the applied diff", {
		skip: !dockerAvailable,
	}, () => {
		// The stub exits non-zero unless the required flags, model arg, and
		// prompt are all present and correctly paired, so a green result here is
		// itself the assertion that executeCursor sends them.
		const result = executeCursor(CURSOR_PROMPT, containerName, {
			model: CURSOR_MODEL,
		});
		strictEqual(result.success, true, result.error);

		const diff = captureDiff(containerName);
		ok(typeof diff === "string" && diff.includes("updated"));
		ok(diff.includes("diff --git"));
	});
});
