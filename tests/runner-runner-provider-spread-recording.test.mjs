import { strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	__resetRosterCacheForTests,
	getInvocationDescriptorIdentity,
} from "../src/switchyard/roster/index.mjs";
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
function writeDispatchQualifiedRosterFixture() {
	const roster = JSON.parse(readFileSync(ROSTER_FIXTURE_PATH, "utf8"));
	const testedAt = new Date().toISOString();
	for (const [targetId, target] of Object.entries(roster.targets)) {
		if (!target.enabled) continue;
		for (const slots of Object.values(target.slots ?? {})) {
			for (const slot of slots ?? []) {
				if (slot.manual_only) continue;
				const model = roster.models[slot.model_ref];
				if (model?.status !== "active") continue;
				const core = {
					target_id: targetId,
					model_ref: slot.model_ref,
					selector: model.selector,
					effort: slot.effort ?? null,
					variant: slot.variant ?? null,
					invocation_args: slot.invocation_args ?? [],
				};
				const descriptorIdentity = getInvocationDescriptorIdentity(
					core,
					target.harness,
				);
				target.qualifications ??= {};
				target.qualifications[descriptorIdentity] = {
					...core,
					descriptor_identity: descriptorIdentity,
					status: "dispatch_qualified",
					tested_at: testedAt,
					credential_profile: target.credential_profile,
				};
			}
		}
	}
	const fixturePath = join(
		tmpdir(),
		`switchyard-runner-qualified-roster-${process.pid}-${randomUUID()}.json`,
	);
	writeFileSync(fixturePath, JSON.stringify(roster), "utf8");
	return fixturePath;
}
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
describe("runner provider spread recording", { concurrency: false }, () => {
	it("revalidates default macOS qualification immediately before fake adapter launch", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Runtime qualification
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** exercise the production router through the runner
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const snapshotPath = join(
			tmpdir(),
			`switchyard-runtime-qualification-${process.pid}-${randomUUID()}.json`,
		);
		const previousSnapshotPath = process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;
		const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
		const qualifiedRosterPath = writeDispatchQualifiedRosterFixture();
		process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = snapshotPath;
		process.env.SWITCHYARD_ROSTER_PATH = qualifiedRosterPath;
		__resetRosterCacheForTests();
		try {
			writeFileSync(
				snapshotPath,
				JSON.stringify({
					schema_version: 2,
					updated_at: new Date().toISOString(),
					providers: [
						{ name: "claude", ok: true, windows: [{ percent_left: 99 }] },
						{ name: "codex", ok: true, windows: [{ percent_left: 20 }] },
					],
				}),
				"utf8",
			);
			const result = runQueueImpl({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				checkpointPath,
				platform: "macos",
				dependencies: {
					// The point is precedence: claude has far more headroom (99 vs
					// 20) and still must lose to codex because it is off the
					// golden-image allowlist. The allowlist is injected rather
					// than defaulted, so the test states its own premise instead
					// of inheriting whichever real logins exist — it silently
					// stopped testing anything on 2026-09-18, when claude-code
					// joined the default list and claude began winning on quota.
					goldenImageVerifiedProviders: ["codex"],
					queuePreflight: () => ({ ok: true, eligible: true }),
					recordDispatchIntent: () => {},
					recordDispatch: () => {},
					integrationGate: () => ({ success: true }),
					backendFactory: () => ({
						readiness: () => ({ inventoryCount: 0 }),
						create: () => "fake-container",
						destroy: () => {},
						seed: () => {},
						commit: () => {},
						reset: () => {},
					}),
					adapters: {
						claude: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/a b/a",
						},
						codex: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/a b/a",
						},
					},
				},
			});
			strictEqual(result.results[0].provider, "codex");
		} finally {
			if (previousSnapshotPath === undefined) {
				delete process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;
			} else {
				process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = previousSnapshotPath;
			}
			if (previousRosterPath === undefined)
				delete process.env.SWITCHYARD_ROSTER_PATH;
			else process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
			__resetRosterCacheForTests();
			rmSync(snapshotPath, { force: true });
			rmSync(qualifiedRosterPath, { force: true });
		}
	});
});
