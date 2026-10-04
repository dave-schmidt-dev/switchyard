import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";

import { mkdirSync, rmSync, writeFileSync } from "node:fs";

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

const CLIPBOARD_LABEL = "gui/501/com.parallels.copypaste";

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

function probeChild(value, overrides = {}) {
	return {
		status: 0,
		signal: null,
		stdout: JSON.stringify(value),
		stderr: "ignored fixture stderr",
		...overrides,
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

function markerContext(operation = "provider", overrides = {}) {
	return {
		runId: "marker-run",
		taskId: "1.4",
		attemptId: "attempt-1",
		descriptorIdentity: "descriptor-1",
		workspaceId: WORK_UUID,
		processStartIdentity: "fixture-birth:marker-run",
		operation,
		...overrides,
	};
}

const WORKSPACE_READY = "switchyard:700\nswitchyard:700\n";

const WORKSPACE_UNAPPLIED = "switchyard:755\nswitchyard:755\n";

function causedBy(error, original) {
	for (let current = error, depth = 0; current && depth < 16; depth += 1) {
		if (current === original) return true;
		current = current.cause;
	}
	return false;
}

function lostExitCode() {
	const error = new Error(
		"Command failed: prlctl exec\nPrlJob_GetRetCode: Invalid argument. An invalid argument was passed.",
	);
	error.status = 255;
	error.stderr = "PrlJob_GetRetCode: Invalid argument.";
	error.stdout = "";
	return error;
}

function workspaceBackend(respond, options = {}) {
	return new ParallelsExecutionBackend({
		hostProcessIdentityProbe: fixtureHostProbe,
		aquaUid: 501,
		sleepFn: () => {},
		workspaceVerifyPollMs: 1,
		prlctlFn: (args) => respond(args),
		...options,
	});
}

function decodeGuestScript(args) {
	const match = /^'eval "\$\(printf %s ([A-Za-z0-9+/=]+) \| .*\)"'$/.exec(
		args.at(-1),
	);
	ok(match, `no base64 payload in ${args.at(-1)}`);
	return Buffer.from(match[1], "base64").toString("utf8");
}

function listed(entries) {
	return [
		"uuid\tstatus\tname",
		...entries.map((entry) => `${entry.uuid}\t${entry.status}\t${entry.name}`),
	].join("\n");
}

describe("linked-clone snapshot sidecar (INV-3 cross-process reclamation)", () => {
	const GOLDEN = "switchyard-golden-test";

	const FOREIGN_SNAPSHOT = "{51f4e833-0000-4000-8000-000000000000}";

	const CLONE_SNAPSHOT = "{9f6e0d53-0000-4000-8000-000000000000}";

	function snapshotJson(ids) {
		return JSON.stringify(
			Object.fromEntries(ids.map((id) => [id, { name: "snap" }])),
		);
	}

	function makeSidecarRoot() {
		return tempDir("switchyard-sidecar-");
	}

	function makeCloningBackend(
		sidecarRoot,
		cloneName,
		{
			runId = "run-1",
			deleteRemoves = true,
			deleteFailure = null,
			inventoryFailure = false,
			stopSettleTimeoutMs,
		} = {},
	) {
		const calls = [];
		let snapshots = [FOREIGN_SNAPSHOT];
		// The clone honours `stop`. Destroy observes the postcondition rather
		// than reading the exit code, so a stub whose VM reports `running`
		// forever waits out the settle window and escalates to a kill -- turning
		// a snapshot-cleanup test into a slow test of the forced path.
		let running = true;
		let deleted = false;
		let deleteAttempted = false;
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			creatorPid: process.pid,
			goldenImage: GOLDEN,
			snapshotSidecarRoot: sidecarRoot,
			runId,
			...(stopSettleTimeoutMs === undefined ? {} : { stopSettleTimeoutMs }),
			requireLinkedCloneMeasurement: false,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "stop") running = false;
				if (args[0] === "snapshot-list") return snapshotJson(snapshots);
				if (args[0] === "clone") {
					// The clone is what creates the parent snapshot.
					snapshots = [FOREIGN_SNAPSHOT, CLONE_SNAPSHOT];
					return "";
				}
				if (args[0] === "snapshot-delete") {
					snapshots = snapshots.filter((id) => id !== args[3]);
					return "";
				}
				if (args[0] === "list") {
					if (inventoryFailure && deleteAttempted)
						throw new Error("inventory unavailable after delete");
					if (deleted) return listed([]);
					return listed([
						{
							uuid: WORK_UUID,
							status: running ? "running" : "stopped",
							name: cloneName,
						},
					]);
				}
				if (args[0] === "delete") {
					deleteAttempted = true;
					if (deleteFailure) throw deleteFailure;
					if (deleteRemoves) deleted = true;
				}
				return "";
			},
		});
		return { backend, calls, snapshotsNow: () => snapshots };
	}

	it("skips a corrupt or unreadable sidecar without throwing and without deleting", () => {
		const root = makeSidecarRoot();
		const deadName = buildParallelsWorkingName("dead", 999_999);
		const { backend, calls, snapshotsNow } = makeCloningBackend(root, deadName);
		mkdirSync(backend.snapshotSidecarDir(), { recursive: true });
		writeFileSync(
			backend.snapshotSidecarPath(WORK_UUID),
			"{not json at all",
			"utf8",
		);
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			name: deadName,
			status: "running",
		});
		let sidecarReads = 0;
		const readSnapshotSidecar = backend.readSnapshotSidecar.bind(backend);
		backend.readSnapshotSidecar = (uuid) => {
			sidecarReads += 1;
			return readSnapshotSidecar(uuid);
		};

		const result = backend.reclaim({ eligibility: () => true });

		strictEqual(result.errors.length, 0, JSON.stringify(result.errors));
		strictEqual(
			sidecarReads,
			1,
			"corrupt-sidecar fixture must reach the durable sidecar read",
		);
		deepStrictEqual(result.reclaimedSnapshots, []);
		ok(!calls.some((args) => args[0] === "snapshot-delete"));
		ok(snapshotsNow().includes(FOREIGN_SNAPSHOT));

		// A structurally valid file missing the fields a delete decision needs
		// is the same case, and must not be trusted into a delete either.
		writeFileSync(
			backend.snapshotSidecarPath(WORK_UUID),
			JSON.stringify({ goldenImage: GOLDEN, snapshotIds: [null] }),
			"utf8",
		);
		strictEqual(backend.readSnapshotSidecar(WORK_UUID), null);
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps a uuid from escaping the sidecar directory", () => {
		const root = makeSidecarRoot();
		const { backend } = makeCloningBackend(root, "x");
		const path = backend.snapshotSidecarPath("../../etc/{passwd}");
		ok(
			path.startsWith(backend.snapshotSidecarDir()),
			`sidecar path escaped its directory: ${path}`,
		);
		ok(!path.includes(".."));
		rmSync(root, { recursive: true, force: true });
	});

	it("stays inert when no durable root is injected", () => {
		// A backend with nowhere to write must not throw; destroy() still cleans
		// up from the in-process map, which is the pre-sidecar behavior.
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			prlctlFn: () => "",
		});
		strictEqual(backend.snapshotSidecarDir(), null);
		strictEqual(backend.snapshotSidecarPath(WORK_UUID), null);
		strictEqual(backend.readSnapshotSidecar(WORK_UUID), null);
		backend.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});
		backend.deleteSnapshotSidecar(WORK_UUID);
	});
});
