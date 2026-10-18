import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { extractCliVersion } from "../src/switchyard/cli-contract/help-flags.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const VM_OPS = fileURLToPath(new URL("../ops/macos-vm/", import.meta.url));
// Real --version text from each installed CLI, plus the edges of the rule.
const SAMPLES = [
	"opencode v2.0.32",
	"1.18.30",
	"codex-cli 0.163.0",
	"WARNING: proceeding, even though we could not create PATH aliases\ncodex-cli 0.163.0",
	"GitHub Copilot CLI 1.0.96.\nRun 'copilot update' to check for updates.",
	"2.1.302 (Claude Code)",
	"vibe 2.25.0",
	"1.4.2",
	"V3.1",
	"tool v1.2.3-beta+4.",
	"version v-1",
	"vibe version",
	"v",
	"",
];

function shellFunction(body, name) {
	const start = body.indexOf(`${name}() {`);
	ok(start !== -1, `no ${name}() in script`);
	const end = body.indexOf("\n}\n", start);
	ok(end !== -1, `unterminated ${name}()`);
	return body.slice(start, end + 3);
}

/** Each sample's version as one shell copy of extract_cli_version prints it. */
function shellVersions(fn) {
	const dir = tempDir("cli-version-parity-");
	const harness = join(dir, "extract.sh");
	writeFileSync(
		harness,
		[
			"#!/bin/bash",
			"set -Eeuo pipefail",
			fn,
			'for sample in "$@"; do printf \'[%s]\\n\' "$(extract_cli_version "$sample")"; done',
			"",
		].join("\n"),
	);
	const run = spawnSync("/bin/bash", [harness, ...SAMPLES], {
		encoding: "utf8",
	});
	strictEqual(run.status, 0, run.stderr);
	return run.stdout
		.trimEnd()
		.split("\n")
		.map((line) => line.slice(1, -1));
}

test("every shell copy of extract_cli_version agrees with the canary's parser", () => {
	const expected = SAMPLES.map((sample) => extractCliVersion(sample) ?? "");
	deepStrictEqual(expected.slice(0, 3), ["2.0.32", "1.18.30", "0.163.0"]);
	for (const script of ["sync-host-clis.sh", "update-guest-clis.sh"])
		deepStrictEqual(
			shellVersions(
				shellFunction(
					readFileSync(join(VM_OPS, script), "utf8"),
					"extract_cli_version",
				),
			),
			expected,
			script,
		);
	// The golden-image copy lives in an unquoted guest heredoc; render it the
	// way the guest receives it before running it.
	const escaped = shellFunction(
		readFileSync(join(VM_OPS, "build-golden-image.sh"), "utf8"),
		"extract_cli_version",
	);
	const render = spawnSync("/bin/bash", ["-c", `cat <<EOF\n${escaped}EOF\n`], {
		encoding: "utf8",
	});
	strictEqual(render.status, 0, render.stderr);
	deepStrictEqual(
		shellVersions(render.stdout),
		expected,
		"build-golden-image.sh",
	);
});
