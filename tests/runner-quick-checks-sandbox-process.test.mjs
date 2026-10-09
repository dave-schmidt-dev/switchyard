import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import {
	homebrewOpenSslConfigs,
	quickCheckSandboxProfile,
	safeEnv,
} from "../src/switchyard/runner/checks-sandbox.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const root = tempDir("sy-check-proc-");
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

	it("enumerates Homebrew OpenSSL configs as files, for any major", () => {
		const etc = join(root, "homebrew-etc");
		for (const file of [
			"openssl@3/openssl.cnf",
			"openssl@4/openssl.cnf",
			"openssl@4/private/key.pem",
			"opensslx/openssl.cnf",
		]) {
			mkdirSync(dirname(join(etc, file)), { recursive: true });
			writeFileSync(join(etc, file), "fixture\n");
		}
		deepStrictEqual(homebrewOpenSslConfigs(etc), [
			join(etc, "openssl@3/openssl.cnf"),
			join(etc, "openssl@4/openssl.cnf"),
		]);
		deepStrictEqual(homebrewOpenSslConfigs(join(root, "no-such-etc")), []);
	});

	it("grants each installed OpenSSL config as a literal file and denies its private dir", (t) => {
		const configs = homebrewOpenSslConfigs();
		if (!configs.length) {
			t.skip("no Homebrew OpenSSL config on this host");
			return;
		}
		const profile = quickCheckSandboxProfile(
			join(root, "clone"),
			join(root, "runtime"),
		);
		const subpaths = [
			...profile.matchAll(/\(subpath ("(?:[^"\\]|\\.)*")\)/gu),
		].map((match) => JSON.parse(match[1]));
		for (const config of configs) {
			ok(profile.includes(`(literal ${JSON.stringify(config)})`), config);
			const denied = join(dirname(config), "private");
			const covering = subpaths.filter(
				(path) =>
					path === denied ||
					denied.startsWith(path.endsWith("/") ? path : `${path}/`),
			);
			deepStrictEqual(covering, [], `${denied} is readable`);
		}
		const privateDirs = configs
			.map((config) => join(dirname(config), "private"))
			.filter((path) => existsSync(path));
		const report = runConfined(`
const fs = require("node:fs");
const attempt = (read) => { try { read(); return "ok"; } catch (error) { return error.code; } };
process.stdout.write(JSON.stringify({
	configs: ${JSON.stringify(configs)}.map((path) => attempt(() => fs.readFileSync(path))),
	privateDirs: ${JSON.stringify(privateDirs)}.map((path) => attempt(() => fs.readdirSync(path))),
}));
`);
		deepStrictEqual(
			report.configs,
			configs.map(() => "ok"),
		);
		for (const code of report.privateDirs)
			ok(["EPERM", "EACCES"].includes(code), code);
	});
});
