import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import { runQueue as runQueueImpl } from "../src/switchyard/runner/index.mjs";
import {
	runnerTestDir,
	withExplicitSwitchyardExecutor,
} from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROSTER_FIXTURE_PATH = resolve(
	__dirname,
	"fixtures",
	"roster.fixture.json",
);
function writeTasksFile(content) {
	mkdirSync(TEST_DIR, { recursive: true });
	const tasksPath = join(TEST_DIR, "tasks.md");
	writeFileSync(tasksPath, withExplicitSwitchyardExecutor(content), "utf8");
	return tasksPath;
}
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("queue platform admission ordering (Tasks 6.1-6.2)", () => {
	it("formats a closed provider reason in the preflight failure", () => {
		const events = [];
		const rosterPath = join(
			tmpdir(),
			`switchyard-runner-closed-reason-${process.pid}-${randomUUID()}.json`,
		);
		const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Native queue gate
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **RequiredCapability:** high
- **RequiredCapabilityJustification:** test gate
- **Description:** fixture
`);
		try {
			writeFileSync(
				rosterPath,
				readFileSync(ROSTER_FIXTURE_PATH, "utf8"),
				"utf8",
			);
			process.env.SWITCHYARD_ROSTER_PATH = rosterPath;
			__resetRosterCacheForTests();
			throws(
				() =>
					runQueueImpl({
						tasksFilePath: tasksPath,
						projectPath: TEST_DIR,
						platform: "macos",
						dependencies: {
							backendFactory: () => ({
								create: () => {
									events.push("create");
									return "vm";
								},
								seed: () => {},
								commit: () => {},
								reset: () => {},
								destroy: () => {},
								acquireSlot: () => events.push("acquire"),
							}),
							adapters: { claude: {} },
							goldenImageVerifiedProviders: ["claude"],
							preflightReadSnapshot: () => ({
								snapshot: {
									schema_version: 2,
									updated_at: new Date().toISOString(),
									providers: [
										{
											name: "claude",
											ok: true,
											windows: [{ percent_left: 80, pace_delta: 1 }],
										},
									],
								},
								snapshotStatus: "fresh",
								snapshotMtime: 1,
								snapshotAgeMsAtRoute: 0,
							}),
						},
					}),
				(error) => {
					strictEqual(error.name, "QueuePreflightError");
					strictEqual(
						error.message,
						"macOS queue provider preflight failed: high: no_golden_image_verified_provider_with_quota_headroom (excluded: claude; reasons: claude: qualification_missing)",
					);
					return true;
				},
			);
		} finally {
			if (previousRosterPath === undefined) {
				delete process.env.SWITCHYARD_ROSTER_PATH;
			} else {
				process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
			}
			__resetRosterCacheForTests();
			rmSync(rosterPath, { force: true });
		}
		deepStrictEqual(events, []);
	});
	it("keeps provider exclusion and reason lists in sorted order", () => {
		const events = [];
		const rosterPath = join(
			tmpdir(),
			`switchyard-runner-provider-order-${process.pid}-${randomUUID()}.json`,
		);
		const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Native queue gate
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **RequiredCapability:** high
- **RequiredCapabilityJustification:** test gate
- **Description:** fixture
`);
		try {
			writeFileSync(
				rosterPath,
				readFileSync(ROSTER_FIXTURE_PATH, "utf8"),
				"utf8",
			);
			process.env.SWITCHYARD_ROSTER_PATH = rosterPath;
			__resetRosterCacheForTests();
			throws(
				() =>
					runQueueImpl({
						tasksFilePath: tasksPath,
						projectPath: TEST_DIR,
						platform: "macos",
						dependencies: {
							backendFactory: () => ({
								create: () => {
									events.push("create");
									return "vm";
								},
								seed: () => {},
								commit: () => {},
								reset: () => {},
								destroy: () => {},
								acquireSlot: () => events.push("acquire"),
							}),
							adapters: { claude: {}, codex: {} },
							goldenImageVerifiedProviders: ["claude", "codex"],
							preflightReadSnapshot: () => ({
								snapshot: {
									schema_version: 2,
									updated_at: new Date().toISOString(),
									// Deliberately reverse alphabetical order. Both lists must
									// use the stable sorted presentation order.
									providers: [
										{
											name: "codex",
											ok: true,
											windows: [{ percent_left: 80, pace_delta: 1 }],
										},
										{
											name: "claude",
											ok: true,
											windows: [{ percent_left: 80, pace_delta: 1 }],
										},
									],
								},
								snapshotStatus: "fresh",
								snapshotMtime: 1,
								snapshotAgeMsAtRoute: 0,
							}),
						},
					}),
				(error) => {
					strictEqual(error.name, "QueuePreflightError");
					strictEqual(
						error.message,
						"macOS queue provider preflight failed: high: no_golden_image_verified_provider_with_quota_headroom (excluded: claude, codex; reasons: claude: qualification_missing, codex: qualification_missing)",
					);
					return true;
				},
			);
		} finally {
			if (previousRosterPath === undefined) {
				delete process.env.SWITCHYARD_ROSTER_PATH;
			} else {
				process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
			}
			__resetRosterCacheForTests();
			rmSync(rosterPath, { force: true });
		}
		deepStrictEqual(events, []);
	});
});
