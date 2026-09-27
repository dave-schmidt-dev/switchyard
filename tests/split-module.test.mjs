import { strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SPLITTER = fileURLToPath(
	new URL("../scripts/split-module.mjs", import.meta.url),
);
const CHECKER = fileURLToPath(
	new URL("../scripts/check-seam-move.mjs", import.meta.url),
);

function write(root, path, contents) {
	const output = join(root, path);
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, contents);
}

function fixture(t, source) {
	const root = mkdtempSync(join(tmpdir(), "split-module-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.invalid"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	write(root, "lib/facade.mjs", source);
	execFileSync("git", ["add", "lib/facade.mjs"], { cwd: root });
	execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
	return root;
}

function split(root, spec) {
	write(
		root,
		"manifest.json",
		JSON.stringify({ sources: { "lib/facade.mjs": spec } }),
	);
	const result = spawnSync(
		process.execPath,
		[SPLITTER, "--source", "lib/facade.mjs", "--spec", "manifest.json"],
		{ cwd: root, encoding: "utf8" },
	);
	strictEqual(result.status, 0, result.stderr);
}

function check(root) {
	return spawnSync(
		process.execPath,
		[
			CHECKER,
			"--mode",
			"module",
			"--base",
			"HEAD",
			"--source",
			"lib/facade.mjs",
			"--expect",
			"manifest.json",
		],
		{ cwd: root, encoding: "utf8" },
	);
}

describe("split-module", () => {
	it("moves complete declarations, copies imports, and preserves the façade seam", (t) => {
		const root = fixture(
			t,
			[
				'import { external } from "pkg";',
				"export const kept = 1;",
				"const helper = external();",
				"export const value = helper;",
				"console.log(kept);",
				"",
			].join("\n"),
		);
		split(root, {
			targets: { "lib/part.mjs": { names: ["helper", "value"] } },
			facade: { keeps: ["kept"] },
		});
		const result = check(root);
		strictEqual(result.status, 0, result.stderr);
	});

	it("keeps an unlisted declaration in the façade", (t) => {
		const root = fixture(
			t,
			"export const left = 1;\nexport const right = 2;\n",
		);
		split(root, {
			targets: { "lib/part.mjs": { names: ["left"] } },
			facade: { keeps: [] },
		});
		const result = check(root);
		strictEqual(result.status, 0, result.stderr);
	});

	it("moves a direct writer with its let declaration", (t) => {
		const root = fixture(t, "export let count = 0;\ncount += 1;\n");
		split(root, {
			targets: { "lib/part.mjs": { names: ["count"] } },
			facade: { keeps: [] },
		});
		const result = check(root);
		strictEqual(result.status, 0, result.stderr);
	});

	it("keeps a function-local name separate from a façade declaration", (t) => {
		const root = fixture(
			t,
			"export function run() { return 1; }\nexport function helper() { const run = 2; return run; }\n",
		);
		split(root, {
			targets: { "lib/part.mjs": { names: ["helper"] } },
			facade: { keeps: ["run"] },
		});
		const result = check(root);
		strictEqual(result.status, 0, result.stderr);
	});

	it("rejects a declaration assigned to multiple targets", (t) => {
		const root = fixture(t, "export const left = 1, right = 2;\n");
		write(
			root,
			"manifest.json",
			JSON.stringify({
				targets: {
					"lib/left.mjs": { names: ["left"] },
					"lib/right.mjs": { names: ["right"] },
				},
				facade: { keeps: [] },
			}),
		);
		const result = spawnSync(
			process.execPath,
			[SPLITTER, "--source", "lib/facade.mjs", "--spec", "manifest.json"],
			{ cwd: root, encoding: "utf8" },
		);
		strictEqual(result.status, 1);
	});
});
