import { ok, strictEqual } from "node:assert/strict";

import { join } from "node:path";

import { describe, it } from "node:test";

import {
	buildParallelsWorkingName,
	parseParallelsWorkingName,
	ParallelsExecutionBackend as RealParallelsExecutionBackend,
} from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";

import { tempDir } from "./helpers/tempdir.mjs";

const GOLDEN_UUID = "{11111111-1111-4111-8111-111111111111}";

const WORK_UUID = "{22222222-2222-4222-8222-222222222222}";

const TEST_BOOT_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const TEST_RUN_STORE_ROOT = tempDir("switchyard-ownership-store-");

process.env.SWITCHYARD_RUN_STORE_ROOT = TEST_RUN_STORE_ROOT;

function fixtureBirth(pid, ticks = String(pid * 10 + 1)) {
	return `switchyard-host-process-v1:${TEST_BOOT_UUID}:${pid}:${ticks}`;
}

function fixtureHostProbe(pid) {
	return {
		state: "present",
		pid,
		bootSessionUuid: TEST_BOOT_UUID,
		startTicks: String(pid * 10 + 1),
		identity: fixtureBirth(pid),
	};
}

class ParallelsExecutionBackend extends RealParallelsExecutionBackend {
	constructor(options = {}) {
		super({ hostProcessIdentityProbe: fixtureHostProbe, ...options });
	}
}

function ownedOptions(runId, creatorPid = process.pid, overrides = {}) {
	return {
		runId,
		creatorPid,
		ownershipContext: {
			resourceRoot: join(TEST_RUN_STORE_ROOT, "runs", runId, "resources"),
			runId,
			taskId: "backend-fixture",
			attemptId: "attempt-1",
			projectRoot: "/private/tmp/switchyard-fixture-project",
			purpose: "backend-test",
			creatorPid,
			processStartIdentity: fixtureBirth(creatorPid),
			...overrides,
		},
	};
}

function registerOwnedEntry(backend, entry, overrides = {}) {
	const parsed = parseParallelsWorkingName(entry.name);
	const options = ownedOptions(parsed.runId, parsed.creatorPid, overrides);
	backend.writeVmOwnership(entry.uuid, entry.name, options.ownershipContext);
	backend.hostProcessIdentityProbe = (pid) =>
		backend.pidIsAlive(pid)
			? fixtureHostProbe(pid)
			: {
					state: "absent",
					pid,
					bootSessionUuid: TEST_BOOT_UUID,
					identity: null,
				};
	return options.ownershipContext;
}

function listed(entries) {
	return [
		"uuid\tstatus\tname",
		...entries.map((entry) => `${entry.uuid}\t${entry.status}\t${entry.name}`),
	].join("\n");
}

describe("Parallels execution backend lifecycle", () => {
	it("reclaims only dead owned VMs and force-stops a running one", () => {
		const calls = [];
		const entries = [
			{
				uuid: WORK_UUID,
				status: "running",
				name: buildParallelsWorkingName("dead-run", 999999),
			},
			{
				uuid: GOLDEN_UUID,
				status: "stopped",
				name: buildParallelsWorkingName("dead-stopped", 999998),
			},
			{
				uuid: "{88888888-8888-4888-8888-888888888888}",
				status: "running",
				name: "developer-vm",
			},
		];
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") return listed(entries);
				if (args[0] === "stop") {
					const current = entries.find((entry) => entry.uuid === args[1]);
					if (current) current.status = "stopped";
				}
				if (args[0] === "delete") {
					const index = entries.findIndex((entry) => entry.uuid === args[1]);
					if (index >= 0) entries.splice(index, 1);
				}
				return "ok";
			},
			pidIsAlive: () => false,
		});
		for (const entry of entries.slice(0, 2)) registerOwnedEntry(backend, entry);

		const result = backend.reclaim({ eligibility: () => true });
		strictEqual(result.reclaimed.length, 2);
		ok(
			calls.some(
				(args) =>
					args[0] === "stop" && args[1] === WORK_UUID && args[2] === "--kill",
			),
		);
		ok(!calls.some((args) => args[1] === "foreign"));
	});

	it("honors an exact reclaim eligibility filter before any VM mutation", () => {
		const calls = [];
		const entries = [
			{
				uuid: WORK_UUID,
				status: "running",
				name: buildParallelsWorkingName("eligible", 999999),
			},
			{
				uuid: GOLDEN_UUID,
				status: "running",
				name: buildParallelsWorkingName("foreign-run", 999998),
			},
		];
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") return listed(entries);
				if (args[0] === "stop") {
					const current = entries.find((entry) => entry.uuid === args[1]);
					if (current) current.status = "stopped";
				}
				if (args[0] === "delete") {
					const index = entries.findIndex((entry) => entry.uuid === args[1]);
					if (index >= 0) entries.splice(index, 1);
				}
				return "ok";
			},
			pidIsAlive: () => false,
		});
		for (const entry of entries) registerOwnedEntry(backend, entry);

		const result = backend.reclaim({
			eligibility: (entry) => entry.runId === "eligible",
		});
		strictEqual(result.reclaimed.length, 1);
		ok(
			calls.some(
				(args) =>
					args[0] === "stop" && args[1] === WORK_UUID && args[2] === "--kill",
			),
		);
		ok(!calls.some((args) => args[1] === GOLDEN_UUID));
	});

	it("lets the caller authorize terminal-clean ownership despite a live creator PID", () => {
		const calls = [];
		let deleted = false;
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") {
					if (deleted) return listed([]);
					return listed([
						{
							uuid: WORK_UUID,
							status: "stopped",
							name: buildParallelsWorkingName("terminal", process.pid),
						},
					]);
				}
				if (args[0] === "delete") deleted = true;
				return "ok";
			},
			pidIsAlive: () => true,
		});
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			status: "stopped",
			name: buildParallelsWorkingName("terminal", process.pid),
		});

		const result = backend.reclaim({
			eligibility: (entry) => entry.runId === "terminal",
		});
		strictEqual(result.reclaimed.length, 1);
		ok(calls.some((args) => args[0] === "delete" && args[1] === WORK_UUID));
	});

	for (const [label, probe] of [
		[
			"PID reuse",
			(pid) => ({
				...fixtureHostProbe(pid),
				identity: fixtureBirth(pid, "999"),
			}),
		],
		[
			"boot mismatch",
			(pid) => ({
				state: "absent",
				pid,
				bootSessionUuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
				identity: null,
			}),
		],
		["unknown kernel result", () => ({ state: "unknown" })],
	]) {
		it(`refuses reclaim on ${label}`, () => {
			const calls = [];
			const entry = {
				uuid: WORK_UUID,
				status: "stopped",
				name: buildParallelsWorkingName("birth-guard", 999999),
			};
			const backend = new ParallelsExecutionBackend({
				prlctlFn: (args) => {
					calls.push(args);
					return args[0] === "list" ? listed([entry]) : "ok";
				},
				pidIsAlive: () => false,
			});
			registerOwnedEntry(backend, entry);
			backend.hostProcessIdentityProbe = probe;
			const result = backend.reclaim({ eligibility: () => true });
			strictEqual(result.reclaimed.length, 0);
			strictEqual(
				calls.filter((args) => args[0] === "stop" || args[0] === "delete")
					.length,
				0,
			);
		});
	}

	it("fails closed when reclaim eligibility is omitted", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") {
					return listed([
						{
							uuid: WORK_UUID,
							status: "running",
							name: buildParallelsWorkingName("dead", 999999),
						},
					]);
				}
				return "ok";
			},
			pidIsAlive: () => false,
		});
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			status: "running",
			name: buildParallelsWorkingName("dead", 999999),
		});
		const result = backend.reclaim();
		strictEqual(result.reclaimed.length, 0);
		strictEqual(result.skipped[0].reason, "ineligible");
		ok(!calls.some((args) => args[0] === "stop" || args[0] === "delete"));
	});

	it("rechecks exact resource identity immediately before reclaim mutation", () => {
		const calls = [];
		let lists = 0;
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") {
					lists += 1;
					return listed([
						{
							uuid: WORK_UUID,
							status: "running",
							name: buildParallelsWorkingName(
								lists === 1 ? "original" : "replacement",
								999999,
							),
						},
					]);
				}
				return "ok";
			},
			pidIsAlive: () => false,
		});
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			status: "running",
			name: buildParallelsWorkingName("original", 999999),
		});
		const result = backend.reclaim({ eligibility: () => true });
		strictEqual(result.reclaimed.length, 0);
		strictEqual(result.skipped[0].reason, "identity-or-eligibility-changed");
		ok(!calls.some((args) => args[0] === "stop" || args[0] === "delete"));
	});

	it("rechecks caller liveness eligibility at the final mutation boundary", () => {
		const calls = [];
		const entry = {
			uuid: WORK_UUID,
			status: "running",
			name: buildParallelsWorkingName("liveness-race", 999999),
		};
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				return args[0] === "list" ? listed([entry]) : "ok";
			},
			pidIsAlive: () => false,
		});
		const ownershipContext = registerOwnedEntry(backend, entry);

		const result = backend.reclaim({
			ownershipContext,
			eligibility: (candidate) => candidate.recoveryPhase !== "pre_mutation",
		});

		strictEqual(result.reclaimed.length, 0);
		strictEqual(result.skipped[0].reason, "identity-or-eligibility-changed");
		strictEqual(
			calls.filter((args) => args[0] === "stop" || args[0] === "delete").length,
			0,
		);
	});

	it("preserves well-formed ownership from a different project", () => {
		const calls = [];
		const entry = {
			uuid: WORK_UUID,
			status: "stopped",
			name: buildParallelsWorkingName("project-mismatch", 999999),
		};
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				return args[0] === "list" ? listed([entry]) : "ok";
			},
			pidIsAlive: () => false,
		});
		const stored = registerOwnedEntry(backend, entry, {
			projectRoot: "/private/tmp/foreign-project",
		});

		const result = backend.reclaim({
			ownershipContext: {
				...stored,
				projectRoot: "/private/tmp/authoritative-project",
			},
			eligibility: () => true,
		});

		strictEqual(result.reclaimed.length, 0);
		strictEqual(result.skipped[0].reason, "recovery_evidence_missing");
		strictEqual(
			calls.filter((args) => args[0] === "stop" || args[0] === "delete").length,
			0,
		);
	});
});
