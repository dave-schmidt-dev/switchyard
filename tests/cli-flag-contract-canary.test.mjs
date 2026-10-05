import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseContractSites } from "../src/switchyard/cli-contract/call-sites.mjs";
import { runCanaries } from "../src/switchyard/cli-contract/check.mjs";
import { extractCliVersion } from "../src/switchyard/cli-contract/help-flags.mjs";

describe("parseContractSites", () => {
	it("reads an agent-headless contract and normalizes argv[0]", () => {
		const [entry] = parseContractSites(
			JSON.stringify({
				sites: [
					{ site: "agent-headless:pi", argv: ["/opt/homebrew/bin/pi", "-p"] },
				],
			}),
		);
		assert.equal(entry.cli, "pi");
		assert.deepEqual(entry.argv, ["pi", "-p"]);
	});

	it("rejects malformed contracts with the offending entry", () => {
		assert.throws(() => parseContractSites("{"), /not valid JSON/u);
		assert.throws(
			() => parseContractSites('{"sites":[]}'),
			/non-empty "sites"/u,
		);
		assert.throws(
			() => parseContractSites('{"sites":[{"site":"x","argv":[1]}]}', "f.json"),
			/f\.json: sites\[0\]\.argv/u,
		);
		assert.throws(
			() =>
				parseContractSites(
					'{"sites":[{"site":"x","argv":["a"],"binary":"rel"}]}',
				),
			/absolute path/u,
		);
	});
});

describe("runCanaries", () => {
	const fakeProcess = (outcomes) => async (binary) => outcomes[binary];
	it("separates a rejected flag from missing auth and a live reply", async () => {
		const results = await runCanaries({
			names: ["claude", "opencode", "codex", "agy", "copilot", "vibe"],
			resolve: (cli) => (cli === "agy" ? null : `/bin/${cli}`),
			log: () => {},
			runProcess: fakeProcess({
				"/bin/claude": {
					status: 0,
					stdout: "OK\n",
					stderr: "",
					timedOut: false,
				},
				"/bin/opencode": {
					status: 1,
					stdout: "",
					stderr: "Error: Unrecognized flag: --variant\n",
					timedOut: false,
				},
				"/bin/codex": {
					status: 1,
					stdout: "",
					stderr: "Not logged in\n",
					timedOut: false,
				},
				// Seen live on 2026-10-05 from hosts without a login.
				"/bin/copilot": {
					status: 1,
					stdout: "",
					stderr:
						"Error: Authentication token found but could not be validated.\n",
					timedOut: false,
				},
				"/bin/vibe": {
					status: 1,
					stdout: "",
					stderr:
						"Error: Missing MISTRAL_API_KEY environment variable for mistral provider.\n",
					timedOut: false,
				},
			}),
		});
		assert.deepEqual(
			results.map((result) => [result.cli, result.status]),
			[
				["claude", "live"],
				["opencode", "flag_rejected"],
				["codex", "auth_unavailable"],
				["agy", "not_installed"],
				["copilot", "auth_unavailable"],
				["vibe", "auth_unavailable"],
			],
		);
	});
});

describe("extractCliVersion", () => {
	it("matches sync-host-clis.sh's version token rule", () => {
		assert.equal(extractCliVersion("codex-cli 0.159.2\n"), "0.159.2");
		assert.equal(extractCliVersion("GitHub Copilot CLI 1.0.89.\n"), "1.0.89");
		assert.equal(extractCliVersion("2.1.289 (Claude Code)"), "2.1.289");
		assert.equal(extractCliVersion("no version"), null);
	});
});
