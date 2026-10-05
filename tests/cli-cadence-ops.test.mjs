import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const path = (name) =>
	fileURLToPath(new URL(`../ops/cli-cadence/${name}`, import.meta.url));
const TEMPLATE = readFileSync(
	path("com.zerodelta.switchyard.cli-cadence.plist.template"),
	"utf8",
);
const INSTALLER = readFileSync(path("install-cli-cadence.sh"), "utf8");
const WRAPPER = readFileSync(path("cli-cadence.sh"), "utf8");

describe("cli-cadence launchd ops", () => {
	it("scripts parse and the wrapper runs strict", () => {
		execFileSync("bash", ["-n", path("cli-cadence.sh")]);
		execFileSync("sh", ["-n", path("install-cli-cadence.sh")]);
		assert.match(WRAPPER, /^set -Eeuo pipefail$/mu);
		assert.match(INSTALLER, /^set -eu$/mu);
	});

	it("the installer substitutes every placeholder the template and wrapper use", () => {
		const placeholders = new Set(
			[...`${TEMPLATE}\n${WRAPPER}`.matchAll(/__([A-Z_]+)__/gu)].map(
				(match) => match[1],
			),
		);
		assert.ok(placeholders.size >= 6);
		for (const name of placeholders)
			assert.match(
				INSTALLER,
				new RegExp(`s\\|__${name}__\\|`, "u"),
				`${name} is never rendered`,
			);
	});

	it("schedules a daily calendar run, not a run at every login", () => {
		assert.match(TEMPLATE, /<key>StartCalendarInterval<\/key>/u);
		assert.match(TEMPLATE, /<key>RunAtLoad<\/key>\s*<false\/>/u);
		assert.match(
			TEMPLATE,
			/<string>com\.zerodelta\.switchyard\.cli-cadence<\/string>/u,
		);
	});

	it("defaults the scheduled job to promote and the launchd dir to ~/.launchd", () => {
		assert.match(WRAPPER, /SWITCHYARD_CLI_CADENCE_MODE:-promote/u);
		assert.match(INSTALLER, /SWITCHYARD_LAUNCHD_DIR:-\$HOME\/\.launchd/u);
	});
});
