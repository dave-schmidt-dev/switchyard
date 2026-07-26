import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	captureDiff,
	executeClaude,
} from "../src/switchyard/adapter/claude.mjs";

function hasDocker() {
	try {
		execSync("docker --version", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const dockerAvailable = hasDocker();
const testRoot = mkdtempSync(join(tmpdir(), "switchyard-claude-adapter-"));
const containerName = `switchyard-claude-adapter-${Date.now()}`;

// Fake `claude` that ENFORCES the adapter's headless invocation shape (Task 25):
// it exits non-zero unless executeClaude passed BOTH --print (non-interactive
// dispatch) and --permission-mode acceptEdits (auto-apply edits). A regression
// that drops either flag turns this test red instead of passing silently — the
// argv-blind-stub gap Task 19 tracks for the other adapters. Only when both
// flags are present does it apply the edit the diff assertion looks for.
const CLAUDE_STUB = `#!/bin/sh
cat >/dev/null
case " $* " in
  *" --print "*) ;;
  *) echo "stub: executeClaude did not pass --print (Task 25); args: $*" >&2; exit 3 ;;
esac
case " $* " in
  *" --permission-mode acceptEdits "*) ;;
  *) echo "stub: executeClaude did not pass --permission-mode acceptEdits (Task 25); args: $*" >&2; exit 3 ;;
esac
echo updated >> test.txt
echo claude
`;

describe("claude adapter container execution", () => {
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
		// rather than fighting nested printf/quote escaping. captureDiff now
		// stages untracked files, so the stub copy the bind mount leaves in
		// /project also shows in the diff — harmless here: the assertion only
		// requires the tracked test.txt edit to be present.
		const stubPath = join(testRoot, "claude-stub.sh");
		writeFileSync(stubPath, CLAUDE_STUB, { mode: 0o755 });
		execSync(`docker cp ${stubPath} ${containerName}:/usr/local/bin/claude`, {
			stdio: "pipe",
		});
		execSync(`docker exec ${containerName} chmod +x /usr/local/bin/claude`, {
			stdio: "pipe",
		});
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

	it("passes --print --permission-mode acceptEdits and captures the applied diff", {
		skip: !dockerAvailable,
	}, () => {
		// The stub exits non-zero unless BOTH headless flags were passed, so a
		// green result here is itself the assertion that executeClaude sends
		// them (Task 25) — not just that some diff came back.
		const result = executeClaude("apply a small change", containerName, {
			model: "fake-model",
		});
		strictEqual(result.success, true);

		const diff = captureDiff(containerName);
		ok(typeof diff === "string" && diff.includes("updated"));
		ok(diff.includes("diff --git"));
	});
});
