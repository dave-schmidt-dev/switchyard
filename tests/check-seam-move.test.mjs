import { strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(
	new URL("../scripts/check-seam-move.mjs", import.meta.url),
);
const SOURCE = "lib/facade.mjs";

function fixture(t, base, targets = ["lib/part.mjs"]) {
	const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "seam-move-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd: root });
	write(root, SOURCE, base);
	execFileSync("git", ["add", "."], { cwd: root });
	commit(root, "base");
	write(
		root,
		"manifest.json",
		JSON.stringify({
			sources: {
				[SOURCE]: {
					targets: Object.fromEntries(targets.map((target) => [target, {}])),
				},
			},
		}),
	);
	return root;
}

function commit(root, message) {
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Checker",
			"-c",
			"user.email=checker@example.test",
			"commit",
			"-qm",
			message,
		],
		{ cwd: root },
	);
}

function write(root, path, contents) {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), contents);
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
			SOURCE,
			"--expect",
			"manifest.json",
		],
		{
			cwd: root,
			encoding: "utf8",
		},
	);
}

function split(root, facade, targets) {
	write(root, SOURCE, facade);
	for (const [path, contents] of Object.entries(targets))
		write(root, path, contents);
}

const BASE = `export const alpha = 1;
export const beta = 2;
console.log(alpha);
`;
const VALID_FACADE = `import { beta } from "./part.mjs";
export { beta };
export const alpha = 1;
console.log(alpha);
`;
const VALID_TARGET = "export const beta = 2;\n";

function validFixture(t) {
	const root = fixture(t, BASE);
	split(root, VALID_FACADE, { "lib/part.mjs": VALID_TARGET });
	return root;
}

describe("check-seam-move module mode", () => {
	it("accepts a correct split", (t) => {
		strictEqual(check(validFixture(t)).status, 0);
	});

	for (const [name, mutate] of [
		[
			"dropped statement",
			(root) =>
				split(
					root,
					`import { beta } from "./part.mjs";\nexport { beta };\nexport const alpha = 1;\n`,
					{ "lib/part.mjs": "" },
				),
		],
		[
			"duplicated statement",
			(root) =>
				split(root, `${VALID_FACADE}export const beta = 2;\n`, {
					"lib/part.mjs": VALID_TARGET,
				}),
		],
		[
			"edited body",
			(root) =>
				split(root, VALID_FACADE, {
					"lib/part.mjs": "export const beta = 3;\n",
				}),
		],
		[
			"renamed export",
			(root) =>
				split(
					root,
					`import { renamed } from "./part.mjs";\nexport { renamed as beta };\nexport const alpha = 1;\nconsole.log(alpha);\n`,
					{ "lib/part.mjs": "export const renamed = 2;\n" },
				),
		],
		[
			"lost façade export",
			(root) =>
				split(
					root,
					`import { beta } from "./part.mjs";\nexport const alpha = 1;\nconsole.log(alpha);\n`,
					{ "lib/part.mjs": VALID_TARGET },
				),
		],
		[
			"export star",
			(root) =>
				split(
					root,
					`import { beta } from "./part.mjs";\nexport * from "./part.mjs";\nexport const alpha = 1;\nconsole.log(alpha);\n`,
					{ "lib/part.mjs": VALID_TARGET },
				),
		],
		[
			"import cycle",
			(root) =>
				split(root, `${VALID_FACADE}`, {
					"lib/part.mjs":
						'import { alpha } from "./facade.mjs";\nexport const beta = 2;\n',
				}),
		],
		[
			"out-of-directory target import",
			(root) =>
				split(root, VALID_FACADE, {
					"lib/part.mjs": 'import "../outside.mjs";\nexport const beta = 2;\n',
				}),
		],
		[
			"altered pin line",
			(root) => {
				const base = `const pin = import.meta.url;\nexport const beta = 2;\n`;
				write(root, SOURCE, base);
				execFileSync("git", ["add", SOURCE], { cwd: root });
				commit(root, "pinned");
				split(
					root,
					`import { beta } from "./part.mjs";\nexport { beta };\nconst pin = import.meta.url + "";\n`,
					{ "lib/part.mjs": VALID_TARGET },
				);
			},
		],
		[
			"unreachable target",
			(root) => {
				write(
					root,
					"manifest.json",
					JSON.stringify({
						sources: {
							[SOURCE]: {
								targets: { "lib/part.mjs": {}, "lib/unreachable.mjs": {} },
							},
						},
					}),
				);
				split(root, `export const alpha = 1;\nconsole.log(alpha);\n`, {
					"lib/part.mjs": VALID_TARGET,
					"lib/unreachable.mjs": "",
				});
			},
		],
		[
			"kept environment assignment before moved impure declaration",
			(root) => {
				const base = `process.env.FLAG = "on";\nexport const value = resolveValue();\n`;
				write(root, SOURCE, base);
				execFileSync("git", ["add", SOURCE], { cwd: root });
				commit(root, "effects");
				split(
					root,
					`import { value } from "./part.mjs";\nexport { value };\nprocess.env.FLAG = "on";\n`,
					{ "lib/part.mjs": "export const value = resolveValue();\n" },
				);
			},
		],
		[
			"swapped statements inside a target",
			(root) =>
				split(
					root,
					`import { alpha, beta } from "./part.mjs";\nexport { alpha, beta };\nconsole.log(alpha);\n`,
					{
						"lib/part.mjs": "export const beta = 2;\nexport const alpha = 1;\n",
					},
				),
		],
		[
			"effectful targets imported in reverse source order",
			(root) => {
				const base = `export const first = sideEffect("first");\nexport const second = sideEffect("second");\n`;
				write(root, SOURCE, base);
				execFileSync("git", ["add", SOURCE], { cwd: root });
				commit(root, "order");
				write(
					root,
					"manifest.json",
					JSON.stringify({
						sources: {
							[SOURCE]: {
								targets: { "lib/first.mjs": {}, "lib/second.mjs": {} },
							},
						},
					}),
				);
				split(
					root,
					`import { second } from "./second.mjs";\nimport { first } from "./first.mjs";\nexport { first, second };\n`,
					{
						"lib/first.mjs": 'export const first = sideEffect("first");\n',
						"lib/second.mjs": 'export const second = sideEffect("second");\n',
					},
				);
			},
		],
	]) {
		it(`rejects a ${name}`, (t) => {
			const root = validFixture(t);
			mutate(root);
			strictEqual(check(root).status, 1);
		});
	}
});
