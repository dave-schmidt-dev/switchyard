import { strictEqual } from "node:assert";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	resolveSnapshotPath,
	SNAPSHOT_PATH,
} from "../src/switchyard/router/index.mjs";

const previousOverride = process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;

afterEach(() => {
	if (previousOverride === undefined) {
		delete process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;
	} else {
		process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = previousOverride;
	}
});

describe("production Gradus snapshot path", () => {
	it("reads the installed runtime's canonical snapshot by default", () => {
		delete process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;
		const installedPath = join(
			homedir(),
			"Library/Application Support/Gradus/Installed/snapshot-v2.json",
		);

		strictEqual(SNAPSHOT_PATH, installedPath);
		strictEqual(resolveSnapshotPath(), installedPath);
	});

	it("retains the isolated test override", () => {
		process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = "/tmp/test-snapshot.json";
		strictEqual(resolveSnapshotPath(), "/tmp/test-snapshot.json");
	});
});
