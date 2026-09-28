import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { __resetRosterCacheForTests } from "../../src/switchyard/roster/index.mjs";

const __dirname = fileURLToPath(new URL("..", import.meta.url));

const FIXTURE_PATH = resolve(__dirname, "fixtures", "roster.fixture.json");

const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;

const previousHomeDir = process.env.HOME;

function setRosterPath(value) {
	if (value === undefined) delete process.env.SWITCHYARD_ROSTER_PATH;
	else process.env.SWITCHYARD_ROSTER_PATH = value;
	__resetRosterCacheForTests();
}

function setHomeDir(value) {
	if (value === undefined) delete process.env.HOME;
	else process.env.HOME = value;
	__resetRosterCacheForTests();
}

const PROVENANCE_KEYS = [
	"roster_schema_version",
	"roster_sha256",
	"resolved_target",
	"resolved_harness",
	"resolved_selector",
	"resolved_credential_profile",
];

export {
	__dirname,
	FIXTURE_PATH,
	PROVENANCE_KEYS,
	previousHomeDir,
	previousRosterPath,
	setHomeDir,
	setRosterPath,
};
