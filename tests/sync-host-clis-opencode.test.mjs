import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/tempdir.mjs";

const SCRIPT = fileURLToPath(
	new URL("../ops/macos-vm/sync-host-clis.sh", import.meta.url),
);
const MANIFEST = fileURLToPath(
	new URL("../ops/macos-vm/cli-manifest.txt", import.meta.url),
);

// Stub brew/npm/uv/opencode: brew reports whether the formula is installed,
// npm records its argv and "installs" by rewriting the fake opencode version.
function fixture({ brewHasOpencode }) {
	const dir = tempDir("switchyard-sync-host-opencode-");
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const pin = readFileSync(MANIFEST, "utf8")
		.split("\n")
		.find((line) => line.startsWith("opencode|"))
		.split("|")[5];
	const stub = (name, body) => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	writeFileSync(join(dir, "version"), "2.0.20\n");
	stub("opencode", `cat "${dir}/version"`);
	stub(
		"brew",
		`[ "$1 $2 $3" = "list --formula opencode" ] && exit ${brewHasOpencode ? 0 : 1}; exit 0`,
	);
	stub("uv", "exit 0");
	stub(
		"npm",
		`echo "$*" >> "${dir}/npm.log"; echo "${pin}" > "${dir}/version"`,
	);
	return { dir, bin, pin };
}

const run = (bin, ...args) =>
	spawnSync(
		"bash",
		[SCRIPT, "--cli-manifest", MANIFEST, "--only", "opencode", ...args],
		{
			encoding: "utf8",
			env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
		},
	);

describe("sync-host-clis.sh opencode pin", () => {
	it("installs exactly the pinned opencode-ai from npm", () => {
		const { dir, bin, pin } = fixture({ brewHasOpencode: false });
		const result = run(bin);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			readFileSync(join(dir, "npm.log"), "utf8").trim(),
			`install --global opencode-ai@${pin}`,
		);
		assert.match(
			result.stderr,
			new RegExp(`opencode ${pin.replaceAll(".", "\\.")} ok`, "u"),
		);
	});

	it("refuses while Homebrew's unpinnable opencode formula is installed", () => {
		const { bin } = fixture({ brewHasOpencode: true });
		const result = run(bin);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Run: brew uninstall opencode/u);
	});

	it("reports the 2.0.20 host as drift under --check without changing it", () => {
		const { dir, bin, pin } = fixture({ brewHasOpencode: true });
		const result = run(bin, "--check");
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			new RegExp(
				`DRIFT opencode: host 2\\.0\\.20, pinned ${pin.replaceAll(".", "\\.")}`,
				"u",
			),
		);
		assert.equal(readFileSync(join(dir, "version"), "utf8").trim(), "2.0.20");
	});
});
