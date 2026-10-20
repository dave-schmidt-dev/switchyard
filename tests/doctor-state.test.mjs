// @test-phase: other
import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { quickDoctorLine } from "../src/switchyard/doctor/quick.mjs";
import {
	readQualificationSlots,
	readRepairHolds,
	readStrandedPending,
} from "../src/switchyard/doctor/state.mjs";
import { getInvocationDescriptorIdentity } from "../src/switchyard/roster/index.mjs";
import { STALE_MAX_AGE_SECONDS } from "../src/switchyard/roster/schema.mjs";
import { handleSimple } from "../src/switchyard/simple/cli.mjs";
import { HANG_GUARD_MS } from "./helpers/hang-guard.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

// handleSimple writes invocation failure records; keep them out of the real
// state root.
process.env.SWITCHYARD_RUN_STORE_ROOT ??= tempDir("doctor-state-store-");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const MAX_AGE_MS = STALE_MAX_AGE_SECONDS * 1000;

/** The fixture roster cut to codex, with one receipt per slot as given. */
function codexRoster(receipts) {
	const roster = JSON.parse(
		readFileSync("tests/fixtures/roster.fixture.json", "utf8"),
	);
	roster.targets = {
		codex: roster.targets.codex,
		vibe: roster.targets.vibe,
	};
	const target = roster.targets.codex;
	target.qualifications = {};
	for (const [capability, receipt] of Object.entries(receipts)) {
		const slot = target.slots[capability][0];
		const model = roster.models[slot.model_ref];
		const descriptor = {
			target_id: "codex",
			model_ref: slot.model_ref,
			selector: model.selector,
			effort: slot.effort ?? null,
			variant: slot.variant ?? null,
			invocation_args: slot.invocation_args ?? [],
		};
		const identity = getInvocationDescriptorIdentity(descriptor, "codex");
		target.qualifications[identity] = {
			...descriptor,
			descriptor_identity: identity,
			...receipt,
		};
	}
	return roster;
}
const qualified = (at) => ({
	status: "dispatch_qualified",
	tested_at: new Date(at).toISOString(),
});

function writeHold(root, targetId, descriptorIdentity = "sha256:aa11") {
	mkdirSync(join(root, "control"), { recursive: true });
	writeFileSync(
		join(root, "control", `${targetId}.json`),
		JSON.stringify({
			schemaVersion: 1,
			targetId,
			descriptorIdentity,
			repairEpoch: 0,
			attestations: [],
			holds: [
				{
					code: "auth_expired",
					publicConfigurationEpoch: "sha256:e",
					repairEpoch: 0,
					at: 1,
				},
			],
		}),
	);
}

function writePending(routingRoot, project, routingRunId, runId) {
	const dir = join(
		routingRoot,
		`${createHash("sha256").update(project).digest("hex")}-${routingRunId}`,
	);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "state.json"),
		JSON.stringify({
			canonicalProjectPath: project,
			routingRunId,
			pendingAttempt: {
				attemptId: "a1",
				taskId: `task-${routingRunId}`,
				runId,
				targetId: "codex",
			},
		}),
	);
}

describe("doctor state readers", () => {
	it("dates each active slot from its newest dispatch-qualified receipt", () => {
		const { slots } = readQualificationSlots({
			roster: codexRoster({
				low: qualified(NOW - 25 * DAY),
				standard: {
					status: "probe_qualified",
					tested_at: new Date(NOW).toISOString(),
				},
				high: qualified(NOW - DAY),
			}),
		});
		deepStrictEqual(slots, [
			{
				targetId: "codex",
				capability: "low",
				expiresAt: NOW - 25 * DAY + MAX_AGE_MS,
			},
			{ targetId: "codex", capability: "standard", expiresAt: null },
			{
				targetId: "codex",
				capability: "high",
				expiresAt: NOW - DAY + MAX_AGE_MS,
			},
		]);
		const previous = process.env.SWITCHYARD_ROSTER_PATH;
		process.env.SWITCHYARD_ROSTER_PATH = join(
			tempDir("doctor-roster-"),
			"absent.json",
		);
		try {
			match(readQualificationSlots().error, /failed to read roster/u);
		} finally {
			if (previous === undefined) delete process.env.SWITCHYARD_ROSTER_PATH;
			else process.env.SWITCHYARD_ROSTER_PATH = previous;
		}
	});

	it("reads control records, treats a missing root as empty and reports bad JSON", () => {
		const root = tempDir("doctor-health-");
		deepStrictEqual(readRepairHolds({ root }), { root, controls: [] });
		writeHold(root, "codex");
		const roster = codexRoster({ low: qualified(NOW) });
		const {
			controls,
			activeDescriptorIdentities,
			currentPublicConfigurationEpoch,
		} = readRepairHolds({
			root,
			roster,
			publicConfigurationEpoch: "sha256:current",
		});
		strictEqual(controls[0].targetId, "codex");
		strictEqual(currentPublicConfigurationEpoch, "sha256:current");
		ok(
			activeDescriptorIdentities.includes(
				Object.keys(roster.targets.codex.qualifications)[0],
			),
		);
		roster.targets.codex.enabled = false;
		const disabled = readRepairHolds({
			root,
			roster,
			publicConfigurationEpoch: "sha256:current",
		});
		deepStrictEqual(disabled.activeDescriptorIdentities, []);
		writeFileSync(join(root, "control", "broken.json"), "{");
		ok(readRepairHolds({ root }).error);
	});

	it("keeps readable controls when roster scope is unavailable", () => {
		const root = tempDir("doctor-health-scope-");
		writeHold(root, "codex");
		const previous = process.env.SWITCHYARD_ROSTER_PATH;
		process.env.SWITCHYARD_ROSTER_PATH = join(
			tempDir("doctor-roster-"),
			"absent.json",
		);
		try {
			const result = readRepairHolds({ root });
			strictEqual(result.error, undefined);
			strictEqual(result.controls[0]?.holds[0]?.code, "auth_expired");
			strictEqual(
				Object.hasOwn(result, "currentPublicConfigurationEpoch"),
				false,
			);
			strictEqual(Object.hasOwn(result, "activeDescriptorIdentities"), false);
		} finally {
			if (previous === undefined) delete process.env.SWITCHYARD_ROSTER_PATH;
			else process.env.SWITCHYARD_ROSTER_PATH = previous;
		}
	});

	it("classifies pending attempts from their run records and scopes to one project", async () => {
		const routingRoot = tempDir("doctor-routing-");
		const project = realpathSync(tempDir("doctor-project-"));
		const other = realpathSync(tempDir("doctor-other-"));
		writePending(routingRoot, project, "closable", "run-done");
		writePending(routingRoot, project, "live", "run-live");
		writePending(routingRoot, project, "orphan", "run-missing");
		writePending(routingRoot, other, "elsewhere", "run-done");
		const records = {
			"run-done": { state: "failed", workerPid: null, worktree: null },
			"run-live": { state: "running", workerPid: 4242, worktree: null },
		};
		const readRunRecord = async (runId) => {
			if (!records[runId])
				throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return records[runId];
		};
		const probePid = () => {}; // every recorded worker answers: alive
		const scoped = await readStrandedPending({
			stateRoot: routingRoot,
			project,
			readRunRecord,
			probePid,
		});
		deepStrictEqual(
			scoped.pending.map(({ routingRunId, live, closable, runState }) => ({
				routingRunId,
				live,
				closable,
				runState,
			})),
			[
				{
					routingRunId: "closable",
					live: false,
					closable: true,
					runState: "failed",
				},
				{
					routingRunId: "live",
					live: true,
					closable: false,
					runState: "running",
				},
				{
					routingRunId: "orphan",
					live: false,
					closable: false,
					runState: null,
				},
			],
		);
		const one = await readStrandedPending({
			stateRoot: routingRoot,
			project,
			routingRunId: "orphan",
			readRunRecord,
			probePid,
		});
		deepStrictEqual(
			one.pending.map((entry) => entry.routingRunId),
			["orphan"],
		);
		const all = await readStrandedPending({
			stateRoot: routingRoot,
			readRunRecord,
			probePid,
		});
		strictEqual(all.pending.length, 4);
		deepStrictEqual(
			await readStrandedPending({ stateRoot: join(routingRoot, "none") }),
			{ pending: [] },
		);
	});
});

describe("doctor quick subset at simple start", () => {
	const quiet = {
		qualification: () => ({
			slots: [
				{ targetId: "codex", capability: "low", expiresAt: NOW + 20 * DAY },
			],
		}),
		holds: () => ({ root: "/h", controls: [] }),
		pending: async () => ({ pending: [] }),
	};

	it("stays silent when every quick check passes or cannot read its input", async () => {
		strictEqual(
			await quickDoctorLine({
				projectPath: "/p",
				now: () => NOW,
				readers: quiet,
			}),
			null,
		);
		strictEqual(
			await quickDoctorLine({
				projectPath: "/p",
				now: () => NOW,
				readers: {
					qualification: () => ({ error: "ENOENT" }),
					holds: () => {
						throw new Error("boom");
					},
					pending: quiet.pending,
				},
			}),
			null,
		);
		strictEqual(
			await quickDoctorLine({
				projectPath: "/p",
				now: () => NOW,
				deadlineMs: 20,
				readers: { ...quiet, holds: () => new Promise(() => {}) },
			}),
			null,
		);
	});

	it("names each problem on one line and scans pending only for a supplied run", async () => {
		const seen = [];
		const readers = {
			qualification: () => ({
				slots: [
					{ targetId: "vibe", capability: "low", expiresAt: NOW + 2 * DAY },
				],
			}),
			holds: quiet.holds,
			pending: async (scope) => {
				seen.push(scope);
				return {
					pending: [
						{
							project: "/p",
							routingRunId: "r1",
							taskId: "t",
							live: false,
							closable: true,
						},
					],
				};
			},
		};
		const generated = await quickDoctorLine({
			projectPath: "/p",
			routingRunId: "g",
			now: () => NOW,
			readers,
		});
		strictEqual(
			generated,
			'switchyard doctor: warn qualification-expiry: 1 expire within 9 d of 1 slots; soonest vibe/low in 2.0 d; run "switchyard-dispatch doctor" for fixes',
		);
		deepStrictEqual(seen, []);
		const supplied = await quickDoctorLine({
			projectPath: "/p",
			routingRunId: "r1",
			routingRunIdSource: "flag",
			now: () => NOW,
			readers,
		});
		deepStrictEqual(seen, [{ project: "/p", routingRunId: "r1" }]);
		match(
			supplied,
			/; warn stranded-pending: 1 stranded \(1 closable, 0 need inspection\);/u,
		);
	});

	it("is called by handleSimple before routing, with the parsed project and run source", async () => {
		const root = realpathSync(tempDir("doctor-simple-"));
		const project = join(root, "project");
		mkdirSync(project);
		const git = spawnSync("git", ["init", "-q", project], {
			timeout: HANG_GUARD_MS,
		});
		strictEqual(git.status, 0);
		writeFileSync(
			join(project, "prompt.txt"),
			"RequiredCapability: standard\nPerform task",
		);
		writeFileSync(join(project, "a.txt"), "content");
		const calls = [];
		const lines = [];
		const signalProcess = new EventEmitter();
		signalProcess.exitCode = 0;
		await handleSimple(
			[
				join(project, "prompt.txt"),
				"--project",
				project,
				"--capability",
				"standard",
				"--file",
				"a.txt",
				"--check",
				"true",
				"--deadline",
				new Date(NOW + 10 * 60 * 1000).toISOString(),
				"--json",
			],
			{
				now: () => NOW,
				signalProcess,
				writeResult: () => {},
				writeStderr: () => {},
				quickDoctor: async (options) => {
					calls.push(options);
					return "switchyard doctor: warn repair-holds: 1 held";
				},
				writeDoctorLine: (line) => lines.push(line),
				openRoutingRun: () => {
					throw Object.assign(new Error("stop here"), {
						code: "routing_state_locked",
					});
				},
			},
		);
		strictEqual(calls.length, 1);
		strictEqual(calls[0].projectPath, project);
		strictEqual(calls[0].routingRunIdSource, "generated");
		strictEqual(typeof calls[0].now, "function");
		deepStrictEqual(lines, ["switchyard doctor: warn repair-holds: 1 held"]);
	});
});

describe("switchyard-dispatch doctor CLI", () => {
	function runCli(args, env) {
		return spawnSync(
			process.execPath,
			["src/switchyard/dispatch/index.mjs", "doctor", ...args],
			{
				encoding: "utf8",
				env: { ...process.env, ...env },
				timeout: HANG_GUARD_MS,
			},
		);
	}

	it("reports quick state checks as JSON and exits 1 only on a failure", () => {
		const store = realpathSync(tempDir("doctor-cli-store-"));
		const health = join(store, "health");
		const project = realpathSync(tempDir("doctor-cli-project-"));
		const roster = codexRoster({
			low: qualified(Date.now()),
			standard: qualified(Date.now()),
			high: qualified(Date.now()),
		});
		writeHold(
			health,
			"codex",
			Object.keys(roster.targets.codex.qualifications)[0],
		);
		writePending(join(store, "routing-runs"), project, "stuck", "no-such-run");
		const rosterPath = join(store, "roster.json");
		writeFileSync(rosterPath, JSON.stringify(roster));
		const env = {
			SWITCHYARD_RUN_STORE_ROOT: store,
			SWITCHYARD_ROUTE_HEALTH_STATE_ROOT: health,
			SWITCHYARD_ROSTER_PATH: rosterPath,
		};
		const warned = runCli(["--quick", "--json"], env);
		strictEqual(warned.status, 0, warned.stderr);
		const report = JSON.parse(warned.stdout);
		deepStrictEqual(
			report.checks.map(({ id, status }) => `${status} ${id}`),
			["ok qualification-expiry", "warn repair-holds", "warn stranded-pending"],
		);
		match(
			report.checks[1].fixes[0],
			new RegExp(`--health-state-root ${health}$`, "u"),
		);
		strictEqual(
			report.checks[2].fixes[0],
			`switchyard-dispatch routing-run inspect --project ${project} --routing-run-id stuck`,
		);
		const failed = runCli(["--quick"], {
			...env,
			SWITCHYARD_ROSTER_PATH: join(store, "absent.json"),
		});
		strictEqual(failed.status, 1, failed.stderr);
		match(
			failed.stdout,
			/^switchyard doctor: fail \(3 checks: 1 fail, 2 warn\)\nfail {2}qualification-expiry {2}roster unreadable[^\n]*\nwarn {2}repair-holds\s+1 held: codex [a-f0-9]{8} auth_expired \(current routing scope unavailable\)/u,
		);
		strictEqual(runCli(["--bogus"], env).status, 2);
	});
});
