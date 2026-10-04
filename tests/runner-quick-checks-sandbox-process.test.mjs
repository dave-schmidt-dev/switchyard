import { strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	quickCheckSandboxProfile,
	safeEnv,
} from "../src/switchyard/runner/checks-sandbox.mjs";

const root = mkdtempSync(join(realpathSync(tmpdir()), "sy-check-proc-"));
after(() => rmSync(root, { recursive: true, force: true }));

// Runs a node script under the real quick-check profile with the checker's own
// environment and returns its parsed JSON report.
function runConfined(script) {
	const clone = join(root, "clone");
	const runtime = join(root, "runtime");
	mkdirSync(clone, { recursive: true });
	mkdirSync(runtime, { recursive: true });
	const result = spawnSync(
		"/usr/bin/sandbox-exec",
		[
			"-p",
			quickCheckSandboxProfile(clone, runtime),
			process.execPath,
			"-e",
			script,
		],
		{
			cwd: clone,
			env: safeEnv(runtime),
			encoding: "utf8",
			timeout: 20_000,
		},
	);
	strictEqual(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

describe("quick-check sandbox process and path access", () => {
	it("lets checks signal their own process group but not host processes", () => {
		const report = runConfined(`
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { detached: true, stdio: "ignore" });
const attempt = (pid, signal) => { try { process.kill(pid, signal); return "ok"; } catch (error) { return error.code; } };
setTimeout(() => {
	const probe = attempt(-child.pid, 0);
	const kill = attempt(-child.pid, "SIGKILL");
	const host = attempt(${process.pid}, 0);
	process.stdout.write(JSON.stringify({ probe, kill, host }));
}, 200);
`);
		strictEqual(report.probe, "ok");
		strictEqual(report.kill, "ok");
		strictEqual(report.host, "EPERM");
	});

	it("runs /bin/sh cleanly and resolves TMPDIR through the /var symlink", () => {
		const report = runConfined(`
const { spawnSync } = require("node:child_process");
const { lstatSync, realpathSync } = require("node:fs");
const { tmpdir } = require("node:os");
const shell = spawnSync("/bin/sh", ["-c", "printf ok"], { encoding: "utf8" });
let resolved = "error";
try { resolved = realpathSync(tmpdir().replace(/^\\/private/u, "")); } catch (error) { resolved = error.code; }
let varLink = "error";
try { varLink = lstatSync("/var").isSymbolicLink() ? "symlink" : "other"; } catch (error) { varLink = error.code; }
process.stdout.write(JSON.stringify({ stdout: shell.stdout, stderr: shell.stderr, resolved: resolved === realpathSync(tmpdir()), varLink }));
`);
		strictEqual(report.stdout, "ok");
		strictEqual(report.stderr, "");
		strictEqual(report.resolved, true);
		strictEqual(report.varLink, "symlink");
	});
});
