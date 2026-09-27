import { match, strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(
	new URL("../scripts/check-file-size.mjs", import.meta.url),
);

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "switchyard-size-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd: root });
	return root;
}

function writeLines(root, path, count) {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), "line\n".repeat(count));
}

function check(root, ...args) {
	return spawnSync(process.execPath, [CHECKER, ...args], {
		cwd: root,
		encoding: "utf8",
	});
}

describe("check-file-size", () => {
	it("passes a file below the 800-line ceiling", (t) => {
		const root = fixture(t);
		writeLines(root, "src/small.mjs", 499);
		strictEqual(check(root, "--all").status, 0);
	});

	it("fails an unlisted file over 800 lines", (t) => {
		const root = fixture(t);
		writeLines(root, "src/large.mjs", 801);
		const result = check(root, "--all");
		strictEqual(result.status, 1);
		match(result.stderr, /src\/large\.mjs has 801 lines \(maximum 800\)/);
	});

	it("accepts a reasoned legacy entry and notices a touched legacy file", (t) => {
		const root = fixture(t);
		writeLines(root, "src/large.mjs", 801);
		writeFileSync(
			join(root, ".file-size-exceptions"),
			"src/large.mjs: legacy 2026-09-27: pending split\n",
		);
		strictEqual(check(root, "--all").status, 0);
		const touched = check(root, "src/large.mjs");
		strictEqual(touched.status, 0);
		match(touched.stdout, /legacy exception/);
	});

	it("warns for 501 through 800 lines without failing", (t) => {
		const root = fixture(t);
		writeLines(root, "src/mid.js", 501);
		const result = check(root, "--all");
		strictEqual(result.status, 0);
		match(result.stdout, /src\/mid\.js has 501 lines \(target 500\)/);
	});

	for (const [name, entry, diagnostic] of [
		["missing reason", "src/large.mjs:\n", /needs a reason/],
		[
			"line cap",
			"src/large.mjs: 1200 old limit\n",
			/line caps are no longer supported/,
		],
		[
			"duplicate",
			"src/large.mjs: first\nsrc/large.mjs: second\n",
			/duplicate exception path/,
		],
		["missing colon", "src/large.mjs reason\n", /path: reason/],
	]) {
		it(`rejects an exception with ${name}`, (t) => {
			const root = fixture(t);
			writeLines(root, "src/large.mjs", 801);
			writeFileSync(join(root, ".file-size-exceptions"), entry);
			const result = check(root, "--all");
			strictEqual(result.status, 1);
			match(result.stderr, diagnostic);
		});
	}

	for (const [name, lines] of [
		["missing", null],
		["at the ceiling", 800],
	]) {
		it(`rejects a stale exception for a file ${name}`, (t) => {
			const root = fixture(t);
			if (lines !== null) writeLines(root, "src/old.py", lines);
			writeFileSync(
				join(root, ".file-size-exceptions"),
				"src/old.py: legacy 2026-09-27: old split\n",
			);
			const result = check(root, "--all");
			strictEqual(result.status, 1);
			match(result.stderr, /remove its exception/);
		});
	}

	it("reads indexed bytes in staged mode", (t) => {
		const root = fixture(t);
		writeLines(root, "src/index.sh", 801);
		writeFileSync(
			join(root, ".file-size-exceptions"),
			"src/index.sh: legacy 2026-09-27: pending split\n",
		);
		execFileSync("git", ["add", "src/index.sh", ".file-size-exceptions"], {
			cwd: root,
		});
		writeLines(root, "src/index.sh", 4);
		const result = check(root, "--staged");
		strictEqual(result.status, 0);
		match(result.stdout, /legacy exception \(801 lines\)/);
	});
});
