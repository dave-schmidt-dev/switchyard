import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { captureDiff, executeCodex } from "../src/switchyard/adapter/codex.mjs";

function hasDocker() {
	try {
		execSync("docker --version", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const dockerAvailable = hasDocker();
const testRoot = mkdtempSync(join(tmpdir(), "switchyard-codex-adapter-"));
const containerName = `switchyard-codex-adapter-${Date.now()}`;

// Fake `codex` that ENFORCES the adapter's headless invocation shape (Task 25):
// it exits non-zero unless executeCodex passed BOTH the `exec` subcommand
// (non-interactive dispatch) and --dangerously-bypass-approvals-and-sandbox
// (the only mode that applies edits inside a container, where codex's own
// bubblewrap sandbox can't initialize). Dropping either flag turns this test
// red instead of passing silently — the argv-blind-stub gap Task 19 tracks.
const CODEX_STUB = `#!/bin/sh
cat >/dev/null
case " $* " in
  *" exec "*) ;;
  *) echo "stub: executeCodex did not pass the exec subcommand; args: $*" >&2; exit 3 ;;
esac
case " $* " in
  *" --dangerously-bypass-approvals-and-sandbox "*) ;;
  *) echo "stub: executeCodex did not pass --dangerously-bypass-approvals-and-sandbox (Task 25); args: $*" >&2; exit 3 ;;
esac
echo updated >> test.txt
echo codex
`;

describe("codex adapter container execution", () => {
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
		const stubPath = join(testRoot, "codex-stub.sh");
		writeFileSync(stubPath, CODEX_STUB, { mode: 0o755 });
		execSync(`docker cp ${stubPath} ${containerName}:/usr/local/bin/codex`, {
			stdio: "pipe",
		});
		execSync(`docker exec ${containerName} chmod +x /usr/local/bin/codex`, {
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

	it("passes exec --dangerously-bypass-approvals-and-sandbox and captures the applied diff", {
		skip: !dockerAvailable,
	}, () => {
		// The stub exits non-zero unless BOTH the exec subcommand and the
		// sandbox-bypass flag were passed, so a green result here is itself the
		// assertion that executeCodex sends them (Task 25).
		const result = executeCodex("apply a small change", containerName, {
			model: "fake-model",
		});
		strictEqual(result.success, true);

		const diff = captureDiff(containerName);
		ok(typeof diff === "string" && diff.includes("updated"));
		ok(diff.includes("diff --git"));
	});
});
