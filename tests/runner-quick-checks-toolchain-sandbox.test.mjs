import { ok, rejects, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createSimpleCheckSessions } from "../src/switchyard/simple/check-session.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const XCODE_SELECT_LINK = "/var/db/xcode_select_link";
const HOMEBREW_BIN = "/opt/homebrew/bin";

/** Name of an installed Homebrew executable the sandbox must not reach. */
function otherHomebrewTool() {
	try {
		return readdirSync(HOMEBREW_BIN)
			.sort()
			.find((name) => name !== "git" && !/^python3(\.\d+)?$/.test(name));
	} catch {
		return undefined;
	}
}

function xcodeSelected() {
	if (process.platform !== "darwin") return false;
	try {
		return readlinkSync(XCODE_SELECT_LINK).length > 0;
	} catch {
		return false;
	}
}

const xcodeSkip = xcodeSelected()
	? false
	: "requires a selected Xcode developer directory";

function git(project, args) {
	const result = spawnSync("git", args, { cwd: project, encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

function fixture() {
	const root = tempDir("switchyard-toolchain-sandbox-");
	const project = join(root, "project");
	mkdirSync(project);
	writeFileSync(join(project, "a.txt"), "base\n");
	writeFileSync(join(project, "Makefile"), "all:\n\t@true\n");
	writeFileSync(join(project, "check.swift"), "let value = 1\n");
	writeFileSync(join(project, ".gitignore"), ".venv\n");
	git(project, ["init", "-q"]);
	git(project, ["add", "."]);
	git(project, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"base",
	]);
	return { root, project };
}

function checkSession(repo, commands) {
	return createSimpleCheckSessions({
		taskRoot: repo.root,
		projectPath: repo.project,
		baseRevision: git(repo.project, ["rev-parse", "HEAD"]),
		baseTree: git(repo.project, ["rev-parse", "HEAD^{tree}"]),
		files: ["a.txt"],
		commands,
		taskId: "toolchain-sandbox",
		deadlineMs: Date.now() + 180_000,
	});
}

// Prefer a uv-managed base interpreter: its prefix sits outside every path the
// sandbox already reads, which is the shape real project venvs have.
function baseInterpreter() {
	const uvRoot = join(process.env.HOME ?? "", ".local/share/uv/python");
	try {
		for (const name of readdirSync(uvRoot).sort()) {
			const candidate = join(uvRoot, name, "bin", "python3");
			if (name.startsWith("cpython-3") && existsSync(candidate))
				return candidate;
		}
	} catch {
		// No uv interpreters on this host.
	}
	return `${HOMEBREW_BIN}/python3`;
}

function makeVenv(project) {
	const venv = join(project, ".venv");
	const created = spawnSync(
		baseInterpreter(),
		["-m", "venv", "--without-pip", venv],
		{ encoding: "utf8" },
	);
	strictEqual(created.status, 0, created.stderr);
	return venv;
}

describe("quick-check toolchain sandbox", { skip: xcodeSkip }, () => {
	it("runs the provisioned toolchain and project venv", async () => {
		const repo = fixture();
		makeVenv(repo.project);
		const commands = [
			"git diff --check",
			"make",
			"python3 -c 1",
			"swiftc -parse check.swift",
			"xcrun swiftc -parse check.swift",
			".venv/bin/python -c 1",
			'test -d "$SDKROOT"',
		];
		const checks = checkSession(repo, commands);
		try {
			const clone = await checks.prepare();
			ok(existsSync(join(clone, ".venv", "bin", "python")));
			for (const command of commands) {
				const result = await checks.run({ command });
				strictEqual(result.success, true, `${command}: ${result.stderr}`);
				strictEqual(result.code, 0, `${command}: ${result.stderr}`);
			}
		} finally {
			checks.remove();
		}
	});

	it("keeps other Homebrew tools unreadable", async (t) => {
		const other = otherHomebrewTool();
		if (!other) {
			t.skip("no Homebrew tool outside the allowlist is installed");
			return;
		}
		const repo = fixture();
		const checks = checkSession(repo, []);
		try {
			await checks.prepare();
			const result = await checks.run({
				command: `${HOMEBREW_BIN}/${other} --version`,
			});
			strictEqual(result.success, false);
			strictEqual(result.code, 126);
		} finally {
			checks.remove();
		}
	});

	it("still denies host writes and network connects", async () => {
		const repo = fixture();
		const outside = join(repo.root, "outside.txt");
		writeFileSync(outside, "host-only");
		const listener = createServer();
		await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
		const port = listener.address().port;
		try {
			const probe = [
				'const fs = require("node:fs");',
				'const net = require("node:net");',
				'const report = { write: "allowed", network: "allowed" };',
				`try { fs.writeFileSync(${JSON.stringify(outside)}, "changed"); } catch (error) { report.write = error.code; }`,
				`const socket = net.connect({ host: "127.0.0.1", port: ${port} });`,
				"let done = false;",
				"const finish = () => { if (done) return; done = true; process.stdout.write(JSON.stringify(report)); };",
				'socket.on("connect", () => { socket.destroy(); });',
				'socket.on("error", (error) => { report.network = error.code; finish(); });',
				'socket.on("close", finish);',
				"setTimeout(finish, 5000).unref();",
			].join(" ");
			const checks = checkSession(repo, []);
			try {
				await checks.prepare();
				const result = await checks.run({ command: `node -e '${probe}'` });
				strictEqual(result.success, true, result.stderr);
				const report = JSON.parse(result.output);
				ok(["EPERM", "EACCES"].includes(report.write), report.write);
				ok(["EPERM", "EACCES"].includes(report.network), report.network);
				strictEqual(readFileSync(outside, "utf8"), "host-only");
			} finally {
				checks.remove();
			}
		} finally {
			listener.close();
		}
	});

	it("refuses a .venv whose realpath leaves the project", async () => {
		const repo = fixture();
		const outside = join(repo.root, "outside-venv");
		mkdirSync(join(outside, "bin"), { recursive: true });
		symlinkSync(outside, join(repo.project, ".venv"));
		const checks = checkSession(repo, []);
		await rejects(checks.prepare(), { code: "check_venv_outside_project" });
		checks.remove();
	});
});
