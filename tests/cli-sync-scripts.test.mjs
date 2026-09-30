import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = [
	"sync-clis.sh",
	"sync-host-clis.sh",
	"update-guest-clis.sh",
	"generate-cli-manifest.sh",
];

for (const script of scripts) {
	test(`${script} bash -n and set -Eeuo pipefail`, () => {
		const scriptPath = fileURLToPath(
			new URL(`../ops/macos-vm/${script}`, import.meta.url),
		);
		assert.doesNotThrow(() => execFileSync("bash", ["-n", scriptPath]));
		const content = readFileSync(scriptPath, "utf8");
		assert.match(content, /^set -Eeuo pipefail$/m);
	});
}
