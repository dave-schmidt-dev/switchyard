import { strictEqual, throws } from "node:assert";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	__resetRosterCacheForTests,
	getRightSizedModel,
	passesCapabilityFilter,
} from "../src/switchyard/roster/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures", "roster.fixture.json");
let tmpDir;
const previousEnv = {};
function setRosterPath(value) {
	if (!("SWITCHYARD_ROSTER_PATH" in previousEnv)) {
		previousEnv.SWITCHYARD_ROSTER_PATH = process.env.SWITCHYARD_ROSTER_PATH;
	}
	if (value === undefined) {
		delete process.env.SWITCHYARD_ROSTER_PATH;
	} else {
		process.env.SWITCHYARD_ROSTER_PATH = value;
	}
	__resetRosterCacheForTests();
}
function setHomeDir(value) {
	if (!("HOME" in previousEnv)) {
		previousEnv.HOME = process.env.HOME;
	}
	if (value === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = value;
	}
	__resetRosterCacheForTests();
}
afterEach(() => {
	if ("SWITCHYARD_ROSTER_PATH" in previousEnv) {
		if (previousEnv.SWITCHYARD_ROSTER_PATH === undefined) {
			delete process.env.SWITCHYARD_ROSTER_PATH;
		} else {
			process.env.SWITCHYARD_ROSTER_PATH = previousEnv.SWITCHYARD_ROSTER_PATH;
		}
		delete previousEnv.SWITCHYARD_ROSTER_PATH;
	}
	if ("HOME" in previousEnv) {
		if (previousEnv.HOME === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousEnv.HOME;
		}
		delete previousEnv.HOME;
	}
	__resetRosterCacheForTests();
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
});
describe("roster loader — path resolution (default ~/.agent/roster.json & SWITCHYARD_ROSTER_PATH override)", () => {
	it("resolves to canonical ~/.agent/roster.json when SWITCHYARD_ROSTER_PATH is unset", () => {
		tmpDir = tempDir("switchyard-roster-home-");
		const agentDir = join(tmpDir, ".agent");
		mkdirSync(agentDir, { recursive: true });
		copyFileSync(FIXTURE_PATH, join(agentDir, "roster.json"));

		setRosterPath(undefined);
		setHomeDir(tmpDir);

		strictEqual(getRightSizedModel("claude", "low"), "fixture-claude-low");
		strictEqual(passesCapabilityFilter("claude", "low"), true);
	});

	it("resolves to canonical ~/.agent/roster.json when SWITCHYARD_ROSTER_PATH is empty string", () => {
		tmpDir = tempDir("switchyard-roster-home-");
		const agentDir = join(tmpDir, ".agent");
		mkdirSync(agentDir, { recursive: true });
		copyFileSync(FIXTURE_PATH, join(agentDir, "roster.json"));

		setRosterPath("");
		setHomeDir(tmpDir);

		strictEqual(getRightSizedModel("claude", "low"), "fixture-claude-low");
	});

	it("uses SWITCHYARD_ROSTER_PATH as an explicit override over default home roster", () => {
		tmpDir = tempDir("switchyard-roster-home-");
		const agentDir = join(tmpDir, ".agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "roster.json"),
			JSON.stringify({
				schema_version: 1,
				models: {
					"home/model": { selector: "home-selector", status: "active" },
				},
				targets: {
					"claude-code": {
						harness: "claude",
						enabled: true,
						qualifications: { "home-selector": { status: "qualified" } },
						slots: { low: [{ model_ref: "home/model", priority: 1 }] },
					},
				},
			}),
			"utf8",
		);

		setHomeDir(tmpDir);
		setRosterPath(FIXTURE_PATH);

		strictEqual(getRightSizedModel("claude", "low"), "fixture-claude-low");
	});

	it("throws fail-loud error when default ~/.agent/roster.json is missing", () => {
		tmpDir = tempDir("switchyard-roster-home-");
		setRosterPath(undefined);
		setHomeDir(tmpDir);

		throws(
			() => passesCapabilityFilter("claude", "low"),
			/failed to read roster/,
		);
	});

	it("throws fail-loud error when default ~/.agent/roster.json is malformed JSON", () => {
		tmpDir = tempDir("switchyard-roster-home-");
		const agentDir = join(tmpDir, ".agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "roster.json"), "{ not valid json", "utf8");

		setRosterPath(undefined);
		setHomeDir(tmpDir);

		throws(() => getRightSizedModel("codex", "high"), /is not valid JSON/);
	});

	it("throws fail-loud error when default ~/.agent/roster.json is structurally invalid", () => {
		tmpDir = tempDir("switchyard-roster-home-");
		const agentDir = join(tmpDir, ".agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "roster.json"),
			JSON.stringify({ schema_version: 1, models: {} }),
			"utf8",
		);

		setRosterPath(undefined);
		setHomeDir(tmpDir);

		throws(
			() => passesCapabilityFilter("claude", "low"),
			/failed structural validation/,
		);
	});

	it("throws when SWITCHYARD_ROSTER_PATH override points at a nonexistent file", () => {
		tmpDir = tempDir("switchyard-roster-loader-");
		setRosterPath(join(tmpDir, "does-not-exist.json"));
		throws(
			() => passesCapabilityFilter("claude", "low"),
			/failed to read roster/,
		);
	});

	it("throws when SWITCHYARD_ROSTER_PATH override file is not valid JSON", () => {
		tmpDir = tempDir("switchyard-roster-loader-");
		const badPath = join(tmpDir, "malformed.json");
		writeFileSync(badPath, "{ not valid json at all", "utf8");
		setRosterPath(badPath);
		throws(() => getRightSizedModel("codex", "high"), /is not valid JSON/);
	});

	it("throws when a slot's model_ref does not resolve in the catalog", () => {
		tmpDir = tempDir("switchyard-roster-loader-");
		const badPath = join(tmpDir, "dangling-ref.json");
		writeFileSync(
			badPath,
			JSON.stringify({
				schema_version: 1,
				models: {},
				targets: {
					"claude-code": {
						harness: "claude",
						enabled: true,
						technical_ceiling: "high",
						qualifications: {},
						slots: {
							low: [{ model_ref: "nonexistent/model", priority: 1 }],
						},
					},
				},
			}),
			"utf8",
		);
		setRosterPath(badPath);
		throws(
			() => passesCapabilityFilter("claude", "low"),
			/does not resolve to any catalog model/,
		);
	});
});
