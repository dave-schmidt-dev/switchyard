import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { describe, it } from "node:test";

import {
	buildParallelsWorkingName,
	parseParallelsWorkingName,
	ParallelsExecutionBackend as RealParallelsExecutionBackend,
} from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";

import { tempDir } from "./helpers/tempdir.mjs";

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

function causedBy(error, original) {
	for (let current = error, depth = 0; current && depth < 16; depth += 1) {
		if (current === original) return true;
		current = current.cause;
	}
	return false;
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

	it("writes a sidecar at clone time carrying image, snapshots, run id, and creator pid", () => {
		const root = makeSidecarRoot();
		const name = buildParallelsWorkingName("live", process.pid);
		const { backend } = makeCloningBackend(root, name);

		backend.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});

		const record = JSON.parse(
			readFileSync(backend.snapshotSidecarPath(WORK_UUID), "utf8"),
		);
		strictEqual(record.goldenImage, GOLDEN);
		deepStrictEqual(record.snapshotIds, [CLONE_SNAPSHOT]);
		strictEqual(record.runId, "run-1");
		strictEqual(record.creatorPid, process.pid);
		strictEqual(record.vmUuid, WORK_UUID);
		ok(Number.isFinite(record.recordedAt));
		rmSync(root, { recursive: true, force: true });
	});

	it("removes both the snapshots and the sidecar on destroy", () => {
		const root = makeSidecarRoot();
		const name = buildParallelsWorkingName("live", process.pid);
		const { backend, snapshotsNow } = makeCloningBackend(root, name);
		backend.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});
		registerOwnedEntry(backend, { uuid: WORK_UUID, name, status: "running" });
		const sidecarPath = backend.snapshotSidecarPath(WORK_UUID);
		ok(existsSync(sidecarPath));

		backend.destroy(WORK_UUID);

		ok(!snapshotsNow().includes(CLONE_SNAPSHOT), "clone snapshot must be gone");
		ok(
			snapshotsNow().includes(FOREIGN_SNAPSHOT),
			"a snapshot no sidecar names must survive destroy",
		);
		ok(!existsSync(sidecarPath), "sidecar must be removed after cleanup");
		rmSync(root, { recursive: true, force: true });
	});

	it("preserves sidecar evidence when final VM absence is uncertain", () => {
		const root = makeSidecarRoot();
		const name = buildParallelsWorkingName("uncertain", process.pid);
		const { backend } = makeCloningBackend(root, name, {
			deleteRemoves: false,
			stopSettleTimeoutMs: 0,
		});
		backend.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});
		registerOwnedEntry(backend, { uuid: WORK_UUID, name, status: "stopped" });
		const sidecarPath = backend.snapshotSidecarPath(WORK_UUID);

		throws(() => backend.destroy(WORK_UUID), /remained present after delete/);
		ok(existsSync(sidecarPath));
		rmSync(root, { recursive: true, force: true });
	});

	it("deleted VM inventory failure preserves sidecars", () => {
		const root = makeSidecarRoot();
		const name = buildParallelsWorkingName("inventory-failure", process.pid);
		const { backend } = makeCloningBackend(root, name, {
			inventoryFailure: true,
			stopSettleTimeoutMs: 0,
		});
		backend.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});
		registerOwnedEntry(backend, { uuid: WORK_UUID, name, status: "stopped" });
		const sidecarPath = backend.snapshotSidecarPath(WORK_UUID);
		const ownershipPath = backend.vmOwnershipPath(
			WORK_UUID,
			join(TEST_RUN_STORE_ROOT, "runs", "inventory-failure", "resources"),
		);

		throws(() => backend.destroy(WORK_UUID), /could not verify absence/);
		ok(existsSync(sidecarPath));
		ok(existsSync(ownershipPath));
		rmSync(root, { recursive: true, force: true });
	});

	it("deleted VM inventory failure reports uncertainty", () => {
		const root = makeSidecarRoot();
		const name = buildParallelsWorkingName("inventory-cause", process.pid);
		const deleteFailure = new Error("delete returned 255");
		const { backend } = makeCloningBackend(root, name, {
			deleteFailure,
			inventoryFailure: true,
			stopSettleTimeoutMs: 0,
		});
		registerOwnedEntry(backend, { uuid: WORK_UUID, name, status: "running" });

		throws(
			() => backend.destroy(WORK_UUID),
			(error) =>
				error.cleanupUncertain === true && causedBy(error, deleteFailure),
		);
		rmSync(root, { recursive: true, force: true });
	});

	it("reclaims a dead owner's snapshots from a fresh backend with an empty map", () => {
		// The whole point: reclaim() runs in a different process from create(),
		// so the in-process map is always empty here. Before the sidecar, this
		// path deleted the VM and left its parent snapshot on the golden
		// forever — one such orphan sat on switchyard-golden-6 for 13 days.
		const root = makeSidecarRoot();
		const deadName = buildParallelsWorkingName("dead", 999_999);
		const { backend: writer } = makeCloningBackend(root, deadName);
		writer.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});
		registerOwnedEntry(writer, {
			uuid: WORK_UUID,
			name: deadName,
			status: "running",
		});

		const { backend: fresh, snapshotsNow } = makeCloningBackend(root, deadName);
		strictEqual(fresh.linkedSnapshotsByUuid.size, 0);

		const result = fresh.reclaim({ eligibility: () => true });

		strictEqual(result.reclaimed.length, 1);
		deepStrictEqual(result.reclaimedSnapshots, [
			{
				name: deadName,
				goldenImage: GOLDEN,
				snapshotIds: [CLONE_SNAPSHOT],
			},
		]);
		ok(!snapshotsNow().includes(CLONE_SNAPSHOT));
		ok(!existsSync(fresh.snapshotSidecarPath(WORK_UUID)));
		rmSync(root, { recursive: true, force: true });
	});

	it("never passes a snapshot absent from every sidecar to a delete call", () => {
		// The absolute rule: reclaim deletes only ids it read from a sidecar,
		// never one discovered by listing. switchyard-golden-26-5 predates the
		// convention and must survive.
		const root = makeSidecarRoot();
		const deadName = buildParallelsWorkingName("dead", 999_999);
		const { backend: writer } = makeCloningBackend(root, deadName);
		// No sidecar written at all, yet the golden carries a snapshot.
		registerOwnedEntry(writer, {
			uuid: WORK_UUID,
			name: deadName,
			status: "running",
		});
		const unrelatedMetadata = join(root, "unrelated-metadata.json");
		writeFileSync(unrelatedMetadata, "{}\n", "utf8");
		const { backend, calls, snapshotsNow } = makeCloningBackend(root, deadName);
		backend.hostProcessIdentityProbe = (pid) => ({
			state: "absent",
			pid,
			bootSessionUuid: TEST_BOOT_UUID,
			identity: null,
		});
		strictEqual(backend.ownedResourcesByUuid.size, 0);
		const ownershipPath = backend.vmOwnershipPath(
			WORK_UUID,
			join(TEST_RUN_STORE_ROOT, "runs", "dead", "resources"),
		);
		ok(existsSync(ownershipPath), "writer must publish durable VM ownership");

		const result = backend.reclaim({ eligibility: () => true });

		strictEqual(result.reclaimed.length, 1, "the VM itself is still reclaimed");
		deepStrictEqual(result.reclaimedSnapshots, []);
		deepStrictEqual(result.skippedSnapshots, [
			{ name: deadName, uuid: WORK_UUID, reason: "no-snapshot-sidecar" },
		]);
		// A reclaimed VM must never also appear in `skipped`: that list answers
		// "which VMs were left alone", and this one was not.
		deepStrictEqual(result.skipped, []);
		ok(
			!calls.some((args) => args[0] === "snapshot-delete"),
			`no snapshot may be deleted: ${JSON.stringify(calls)}`,
		);
		ok(snapshotsNow().includes(FOREIGN_SNAPSHOT));
		ok(!existsSync(ownershipPath), "deleted VM must lose its ownership record");
		ok(existsSync(unrelatedMetadata), "unrelated metadata must survive");
		rmSync(root, { recursive: true, force: true });
	});

	it("does not touch a live owner's clone or its snapshots", () => {
		const root = makeSidecarRoot();
		const liveName = buildParallelsWorkingName("live", process.pid);
		const { backend, calls, snapshotsNow } = makeCloningBackend(root, liveName);
		backend.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			name: liveName,
			status: "running",
		});

		const result = backend.reclaim({ eligibility: () => false });

		strictEqual(result.reclaimed.length, 0);
		deepStrictEqual(result.reclaimedSnapshots, []);
		strictEqual(result.skipped[0]?.reason, "ineligible");
		ok(!calls.some((args) => args[0] === "snapshot-delete"));
		deepStrictEqual(
			snapshotsNow(),
			[FOREIGN_SNAPSHOT],
			"the golden's snapshot list must be untouched",
		);
		ok(
			existsSync(backend.snapshotSidecarPath(WORK_UUID)),
			"a live owner's sidecar must survive another process's reclaim",
		);
		rmSync(root, { recursive: true, force: true });
	});
});
