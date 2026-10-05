import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../scripts/check-cli-flag-contract.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const SCRIPT = fileURLToPath(
	new URL("../scripts/check-cli-flag-contract.mjs", import.meta.url),
);

// Behaves like opencode 2.0.20: `run --help` no longer lists --variant/--dir
// and the parser rejects them.
const FAKE_OPENCODE_2 = `#!/bin/sh
case "$*" in
  --version) echo 2.0.20; exit 0 ;;
  *--variant*|*--dir*|*--switchyard-flag-contract-bogus*)
    for a in "$@"; do case "$a" in --variant|--dir|--switchyard-flag-contract-bogus) echo "Error: Unrecognized flag: $a" >&2; exit 1 ;; esac; done ;;
esac
cat <<'HELP'
opencode run [message..]

Options:
  -h, --help         show help
  -m, --model        model to use as provider/model[#variant]
      --agent        agent to use
      --format       default or json
HELP
`;

function run(args, path) {
	return spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${path}:/usr/bin:/bin` },
	});
}

describe("check-cli-flag-contract.mjs", () => {
	const dir = tempDir("switchyard-flag-contract-");
	const bin = join(dir, "bin");
	spawnSync("mkdir", ["-p", bin]);
	writeFileSync(join(bin, "opencode"), FAKE_OPENCODE_2);
	chmodSync(join(bin, "opencode"), 0o755);
	const contract = join(dir, "contract.json");
	writeFileSync(
		contract,
		JSON.stringify({
			sites: [
				{
					site: "agent-headless:opencode",
					argv: [
						"opencode",
						"run",
						"--agent",
						"plan",
						"--variant",
						"max",
						"--dir",
						"/w",
						"--format",
						"json",
					],
				},
			],
		}),
	);

	it("exits 1 naming the CLI, version and offending flags", () => {
		const result = run(["--no-switchyard", "--contract", contract], bin);
		assert.equal(result.status, 1, result.stderr);
		assert.match(
			result.stdout,
			/FLAG-CONTRACT FAIL opencode 2\.0\.20: "opencode run --help" does not list --variant \(used by agent-headless:opencode/u,
		);
		assert.match(result.stdout, /does not list --dir/u);
		assert.match(result.stdout, /flag contract FAILED/u);
	});

	it("emits the same verdict as JSON", () => {
		const result = run(
			["--no-switchyard", "--contract", contract, "--json"],
			bin,
		);
		assert.equal(result.status, 1);
		const report = JSON.parse(result.stdout);
		assert.equal(report.ok, false);
		assert.deepEqual(
			report.results[0].violations.map((violation) => violation.flag),
			["--variant", "--dir"],
		);
	});

	it("fails --strict when a contracted CLI is not installed", () => {
		const empty = join(dir, "empty");
		spawnSync("mkdir", ["-p", empty]);
		const result = run(
			["--no-switchyard", "--contract", contract, "--strict"],
			empty,
		);
		assert.equal(result.status, 1);
		assert.match(result.stdout, /FLAG-CONTRACT FAIL opencode: not installed/u);
	});

	it("rejects bad usage with exit 2", () => {
		assert.equal(run(["--bogus"], bin).status, 2);
		assert.equal(run(["--no-switchyard"], bin).status, 2);
		assert.throws(() => parseArgs(["--bin", "opencode=relative"]), /absolute/u);
		assert.deepEqual(
			parseArgs(["--bin", "opencode=/x/opencode"]).binOverrides,
			{
				opencode: "/x/opencode",
			},
		);
	});
});
