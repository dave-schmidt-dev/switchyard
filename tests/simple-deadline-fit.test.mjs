import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import { parseSimpleArgs } from "../src/switchyard/simple/args.mjs";
import { observedP80 } from "../src/switchyard/simple/deadline-fit.mjs";
import { routeDiagnosticPatch } from "../src/switchyard/simple/route-evidence.mjs";
import { createSimpleRouteSelection } from "../src/switchyard/simple/route-selection.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const PROJECT = "/deadline-fit/project";
const NOW = 1_800_000_000_000;
const BASE_MS = 1_700_000_000_000;
const originalRunStoreEnv = process.env.SWITCHYARD_RUN_STORE_ROOT;
const originalRosterEnv = process.env.SWITCHYARD_ROSTER_PATH;

// Route evidence target ids resolve through the roster; pin a minimal fixture
// so the evidence assertions do not depend on the host's real roster.
const rosterDir = tempDir("switchyard-deadline-fit-roster-");
writeFileSync(
	join(rosterDir, "roster.json"),
	JSON.stringify({
		models: {},
		targets: {
			codex: { harness: "codex" },
			antigravity: { harness: "agy" },
		},
	}),
	"utf8",
);
process.env.SWITCHYARD_ROSTER_PATH = join(rosterDir, "roster.json");
__resetRosterCacheForTests();

const DESCRIPTORS = {
	codex: { target_id: "codex", selector: "any-model", invocation_args: [] },
	antigravity: {
		target_id: "antigravity",
		selector: "gemini-3.8-flash-medium",
		invocation_args: [],
	},
};

function writeRun(runsDir, name, run) {
	const runDir = join(runsDir, name);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(
		join(runDir, "run.json"),
		JSON.stringify({
			state: run.state ?? "succeeded",
			projectPath: run.project ?? PROJECT,
			resolvedTargetId: run.targetId,
			createdAt: new Date(BASE_MS).toISOString(),
			finishedAt:
				run.finishedAt === undefined
					? new Date(BASE_MS + run.durationMs).toISOString()
					: run.finishedAt,
		}),
		"utf8",
	);
	if (run.mtimeMs !== undefined)
		utimesSync(runDir, run.mtimeMs / 1000, run.mtimeMs / 1000);
}

function runsFixture() {
	const root = tempDir("switchyard-deadline-fit-");
	const runsDir = join(root, "runs");
	mkdirSync(runsDir, { recursive: true });
	return { root, runsDir };
}

function selectionFixture(options) {
	const decisions = [];
	const routed = [];
	const result = createSimpleRouteSelection({
		options,
		resolveIdentity: (targetId) => ({
			targetId,
			harnessKey: targetId === "codex" ? "codex" : "agy",
		}),
		descriptorFor: (targetId) => DESCRIPTORS[targetId] ?? null,
		routeProvider: ({ availableProviders }) => {
			const provider = availableProviders[0];
			routed.push({ availableProviders: [...availableProviders] });
			return {
				provider,
				routeEvidence: {
					schemaVersion: 1,
					snapshotStatus: "not_checked",
					snapshotMtime: null,
					snapshotAgeMsAtRoute: null,
					selectionReason: "spread",
					selectedTargetId: provider,
					candidates: [],
					excluded: [],
				},
			};
		},
		healthController: {
			decision: () => ({}),
			prepare: async () => ({ allowed: true }),
		},
		funded: () => {},
		onDecision: async (decision) => {
			decisions.push(decision);
		},
		now: () => NOW,
	});
	return { result, decisions, routed };
}

const routeOptions = (overrides = {}) => ({
	capability: "standard",
	onlyProviders: [],
	projectPath: PROJECT,
	checks: ["true"],
	deadlineMs: NOW + 300_000,
	...overrides,
});

after(() => {
	process.env.SWITCHYARD_RUN_STORE_ROOT = originalRunStoreEnv;
	process.env.SWITCHYARD_ROSTER_PATH = originalRosterEnv;
	__resetRosterCacheForTests();
});

test("observedP80 returns the p80 duration of succeeded runs in the cell", async () => {
	const { runsDir } = runsFixture();
	const durations = [60_000, 120_000, 180_000, 240_000, 600_000];
	for (const [index, durationMs] of durations.entries())
		writeRun(runsDir, `run-${index}`, { targetId: "codex", durationMs });
	// Noise that must not count: other state, other project, other target,
	// and a run without a parseable finishedAt.
	writeRun(runsDir, "failed", {
		targetId: "codex",
		durationMs: 600_000,
		state: "failed",
	});
	writeRun(runsDir, "other-project", {
		targetId: "codex",
		durationMs: 600_000,
		project: "/deadline-fit/other",
	});
	writeRun(runsDir, "other-target", {
		targetId: "antigravity",
		durationMs: 600_000,
	});
	writeRun(runsDir, "unfinished", {
		targetId: "codex",
		durationMs: 600_000,
		finishedAt: "",
	});
	assert.equal(
		await observedP80("codex", PROJECT, { runsRoot: runsDir }),
		240_000,
	);
});

test("observedP80 needs five succeeded samples and a readable run store", async () => {
	const { runsDir } = runsFixture();
	const durations = [60_000, 120_000, 180_000, 240_000];
	for (const [index, durationMs] of durations.entries())
		writeRun(runsDir, `run-${index}`, { targetId: "codex", durationMs });
	assert.equal(
		await observedP80("codex", PROJECT, { runsRoot: runsDir }),
		null,
	);
	assert.equal(
		await observedP80("codex", PROJECT, { runsRoot: join(runsDir, "missing") }),
		null,
	);
});

test("observedP80 scans only the newest limit run directories", async () => {
	const { runsDir } = runsFixture();
	for (const index of [0, 1, 2, 3, 4]) {
		writeRun(runsDir, `old-${index}`, {
			targetId: "codex",
			durationMs: 600_000,
			mtimeMs: BASE_MS,
		});
		writeRun(runsDir, `new-${index}`, {
			targetId: "codex",
			durationMs: 60_000,
			mtimeMs: BASE_MS + 10_000,
		});
	}
	assert.equal(
		await observedP80("codex", PROJECT, { runsRoot: runsDir, limit: 5 }),
		60_000,
	);
	assert.equal(
		await observedP80("codex", PROJECT, { runsRoot: runsDir }),
		600_000,
	);
});

test("a slow-history target is excluded with deadline_fit_excluded evidence", async () => {
	const { root, runsDir } = runsFixture();
	for (const index of [0, 1, 2, 3, 4]) {
		writeRun(runsDir, `slow-${index}`, {
			targetId: "codex",
			durationMs: 600_000,
		});
		writeRun(runsDir, `fast-${index}`, {
			targetId: "antigravity",
			durationMs: 10_000,
		});
	}
	process.env.SWITCHYARD_RUN_STORE_ROOT = root;
	const { result, decisions, routed } = selectionFixture(routeOptions());
	const selected = await result.selectSimpleRoute();
	assert.equal(selected.provider, "antigravity");
	assert.equal(selected.targetId, "antigravity");
	assert.deepEqual(routed[0].availableProviders, ["antigravity"]);
	const excluded = decisions[0].routeEvidence.excluded;
	const deadlineFit = excluded.find((entry) =>
		entry.reason.startsWith("deadline_fit_"),
	);
	assert.equal(deadlineFit?.targetId, "codex");
	assert.equal(deadlineFit?.reason, "deadline_fit_excluded");
	// The allowlisted reason survives the diagnostic re-bound.
	const diagnostics = routeDiagnosticPatch(decisions[0]);
	assert.deepEqual(
		diagnostics.routeEvidence.excluded.filter((entry) =>
			entry.reason.startsWith("deadline_fit_"),
		),
		[{ targetId: "codex", reason: "deadline_fit_excluded" }],
	);
});

test("an all-slow pool keeps every target and records deadline_fit_overridden", async () => {
	const { root, runsDir } = runsFixture();
	for (const index of [0, 1, 2, 3, 4]) {
		writeRun(runsDir, `slow-codex-${index}`, {
			targetId: "codex",
			durationMs: 600_000,
		});
		writeRun(runsDir, `slow-antigravity-${index}`, {
			targetId: "antigravity",
			durationMs: 600_000,
		});
	}
	process.env.SWITCHYARD_RUN_STORE_ROOT = root;
	const { result, decisions, routed } = selectionFixture(routeOptions());
	const selected = await result.selectSimpleRoute();
	assert.equal(selected.provider, "codex");
	assert.deepEqual(routed[0].availableProviders, ["codex", "antigravity"]);
	const overridden = decisions[0].routeEvidence.excluded.filter(
		(entry) => entry.reason === "deadline_fit_overridden",
	);
	assert.deepEqual(
		overridden.map((entry) => entry.targetId),
		["codex", "antigravity"],
	);
	assert.equal(result.excludedSimpleTargets.size, 0);
});

test("deadline fit never applies under --only-provider", async () => {
	const { root, runsDir } = runsFixture();
	for (const index of [0, 1, 2, 3, 4]) {
		writeRun(runsDir, `slow-${index}`, {
			targetId: "codex",
			durationMs: 600_000,
		});
	}
	process.env.SWITCHYARD_RUN_STORE_ROOT = root;
	const { result, decisions, routed } = selectionFixture(
		routeOptions({ onlyProviders: ["codex"] }),
	);
	const selected = await result.selectSimpleRoute();
	assert.equal(selected.provider, "codex");
	assert.deepEqual(routed[0].availableProviders, ["codex"]);
	assert.deepEqual(
		decisions[0].routeEvidence.excluded.filter((entry) =>
			entry.reason.startsWith("deadline_fit_"),
		),
		[],
	);
});

function makeRepo() {
	const root = tempDir("switchyard-deadline-fit-args-");
	const projectPath = join(root, "project");
	mkdirSync(projectPath, { recursive: true });
	writeFileSync(join(projectPath, "a.txt"), "base\n", "utf8");
	execFileSync("git", ["init", "-q"], { cwd: projectPath });
	execFileSync("git", ["add", "-A"], { cwd: projectPath });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Switchyard Tests",
			"-c",
			"user.email=switchyard@example.invalid",
			"commit",
			"-qm",
			"base",
		],
		{ cwd: projectPath },
	);
	const promptPath = join(root, "prompt.txt");
	writeFileSync(promptPath, "Change a.txt", "utf8");
	return { projectPath, promptPath };
}

test("parse-time warning fires only when the deadline is under 90 seconds", () => {
	const { projectPath, promptPath } = makeRepo();
	const nowMs = Date.now();
	const argvFor = (deadlineMs) => [
		promptPath,
		"--project",
		projectPath,
		"--capability",
		"standard",
		"--file",
		"a.txt",
		"--check",
		"true",
		"--deadline",
		new Date(deadlineMs).toISOString(),
	];
	const shortWarnings = [];
	const short = parseSimpleArgs(argvFor(nowMs + 60_000), {
		now: () => nowMs,
		onWarning: (text) => shortWarnings.push(text),
	});
	assert.equal(short.deadlineMs, nowMs + 60_000);
	assert.equal(shortWarnings.length, 1);
	assert.match(shortWarnings[0], /under 90 seconds/u);
	const longWarnings = [];
	parseSimpleArgs(argvFor(nowMs + 120_000), {
		now: () => nowMs,
		onWarning: (text) => longWarnings.push(text),
	});
	assert.deepEqual(longWarnings, []);
});
