import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";

import { createHash } from "node:crypto";

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";

import { join } from "node:path";

import { describe, it } from "node:test";

import {
	buildParallelsWorkingName,
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

function listed(entries) {
	return [
		"uuid\tstatus\tname",
		...entries.map((entry) => `${entry.uuid}\t${entry.status}\t${entry.name}`),
	].join("\n");
}

describe("VM ownership metadata", () => {
	it("retains allocation intent evidence across crash fixtures", () => {
		const root = tempDir("switchyard-allocation-crash-");
		const runId = "crash-after-intent";
		const resourceRoot = join(root, "runs", runId, "resources");
		const context = ownedOptions(runId, 5151, {
			resourceRoot,
		}).ownershipContext;
		const name = buildParallelsWorkingName(runId, 5151);
		const backend = new ParallelsExecutionBackend({ prlctlFn: () => "" });

		try {
			// Crash before the clone call: intent is the only durable evidence and
			// must remain auditable without invoking a mutating command.
			backend.writeAllocationIntent(name, context);
			const intentPath = backend.allocationIntentPath(name, resourceRoot);
			ok(existsSync(intentPath));
			strictEqual(
				statSync(resourceRoot).mode & 0o777,
				0o700,
				"allocation metadata must be written beneath an owner-only resource root",
			);
			const fresh = new ParallelsExecutionBackend({
				prlctlFn: () => {
					throw new Error("allocation audit must remain read-only");
				},
			});
			deepStrictEqual(
				fresh.auditAllocationIntents({
					knownResourceRoots: [
						{
							resourceRoot,
							runId,
							runRecordStatus: "valid",
							projectPath: context.projectRoot,
							cleanupState: "pending",
							liveness: "dead",
						},
					],
				}),
				[
					{
						file: `parallels-allocation-${createHash("sha256")
							.update(name)
							.digest("hex")}.intent.json`,
						runId,
						vmName: name,
						classification: "stale",
						reason: "stale_run",
					},
				],
			);

			// Crash after a clone side effect but before a UUID receipt: preserve
			// the explicit uncertainty rather than inventing an allocation identity.
			backend.writeAllocationUncertainty(
				name,
				context,
				"allocation_identity_unknown",
			);
			const persisted = JSON.parse(readFileSync(intentPath, "utf8"));
			strictEqual(persisted.state, "cleanup_uncertain");
			strictEqual(persisted.reasonCode, "allocation_identity_unknown");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("bounds every Parallels call and pins the production backend cleanup contract", () => {
		// parallels-transfer.mjs is unchanged by task 4.1 and keeps its exact
		// byte pin. The three lifecycle sources beside it were rewritten by
		// task 4.1's destroy-only cleanup, so their whole-file digests are
		// pinned through contract anchors instead: the exact lines the new
		// cleanup contract is made of must be present, and every identifier it
		// removed (getGuestPid, the guest kill script, the PID-observing
		// stages, strongStart) must stay absent.
		const exactBytePins = [
			[
				"../src/switchyard/lifecycle/parallels-transfer.mjs",
				"8d472c7f4ba7fc641c1ef99613fe15f54f28dc4ac711c0a105e11569f86cf9a1",
			],
		];
		for (const [relativePath, expectedHash] of exactBytePins) {
			const sourcePath = new URL(relativePath, import.meta.url);
			const source = readFileSync(sourcePath, "utf8");
			strictEqual(
				createHash("sha256").update(source, "utf8").digest("hex"),
				expectedHash,
			);
		}
		const contractPins = [
			[
				"../src/switchyard/lifecycle/parallels-execution-backend.mjs",
				[
					'return { cleanupStage: "destroy_pending", workspaceId };',
					"return { cleanupStage: INDEX_LOCK_REMOVED, workspaceId };",
				],
				["getGuestPid", "KILL_GUEST_PROCESS_TREE"],
			],
			[
				"../src/switchyard/lifecycle/parallels-primitives.mjs",
				[
					'export const INDEX_LOCK_PATH = "/project/.git/index.lock";',
					'export const INDEX_LOCK_REMOVED = "index_lock_removed";',
				],
				[
					"CLEANUP_STARTED",
					"PID_OBSERVED",
					"TREE_TERMINATED",
					"PID_MARKER_REMOVED",
					"KILL_GUEST_PROCESS_TREE",
				],
			],
			[
				"../src/switchyard/lifecycle/parallels-validation.mjs",
				["export function markerIdentity(workspaceId, cleanupContext = {}) {"],
				["strongStart"],
			],
		];
		for (const [relativePath, anchors, forbidden] of contractPins) {
			const sourcePath = new URL(relativePath, import.meta.url);
			const source = readFileSync(sourcePath, "utf8");
			for (const anchor of anchors) {
				ok(
					source.includes(anchor),
					`${relativePath} must keep the contract line: ${anchor}`,
				);
			}
			for (const name of forbidden) {
				ok(
					!source.includes(name),
					`${relativePath} must no longer contain ${name}`,
				);
			}
		}

		const calls = [];
		const backend = new ParallelsExecutionBackend({
			prlctlCallTimeoutMs: 321,
			prlctlFn: (args, options) => {
				calls.push({ args, options });
				return "ok";
			},
		});
		strictEqual(backend._call(["list", "-a"]), "ok");
		strictEqual(calls[0].options.timeout, 321);
		strictEqual(calls[0].options.killSignal, "SIGKILL");
	});

	it("uses the exact UUID when a false-success delete leaves a similarly named VM", () => {
		const calls = [];
		const otherUuid = "{33333333-3333-4333-8333-333333333333}";
		const entry = {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("uuid-proof", process.pid),
			status: "running",
		};
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list")
					return listed([
						{ ...entry, status: "running" },
						{ uuid: otherUuid, status: "stopped", name: entry.name },
					]);
				if (args[0] === "delete") deleted = true;
				return "";
			},
		});

		throws(
			() => backend.stopAndDelete(entry, { forceOnly: true }),
			(error) => error.cleanupUncertain === true,
		);
		strictEqual(calls.filter((args) => args[0] === "delete").length, 0);
		ok(
			calls
				.filter((args) => args[0] === "list")
				.every((args) => args[1] === "-a"),
		);
	});

	it("audits known allocation intents as valid, stale, malformed, or unknown without mutation", () => {
		const root = tempDir("switchyard-allocation-audit-");
		const projectRoot = "/private/tmp/switchyard-fixture-project";
		let mutations = 0;
		const backend = new ParallelsExecutionBackend({
			prlctlFn: () => {
				mutations += 1;
				return "";
			},
		});
		const descriptors = [];
		for (const [runId, liveness, runRecordStatus] of [
			["active-intent", "live", "valid"],
			["stale-intent", "dead", "valid"],
			["unknown-intent", "unknown", "missing"],
		]) {
			const resourceRoot = join(root, "runs", runId, "resources");
			const context = ownedOptions(runId, 5151, {
				resourceRoot,
				projectRoot,
			}).ownershipContext;
			backend.writeAllocationIntent(
				buildParallelsWorkingName(runId, 5151),
				context,
			);
			descriptors.push({
				resourceRoot,
				runId,
				runRecordStatus,
				projectPath: projectRoot,
				cleanupState: "pending",
				liveness,
			});
		}
		const malformedRoot = join(root, "runs", "malformed", "resources");
		mkdirSync(malformedRoot, { recursive: true });
		writeFileSync(
			join(
				malformedRoot,
				"parallels-allocation-0000000000000000000000000000000000000000000000000000000000000000.intent.json",
			),
			"{not-json",
			"utf8",
		);
		descriptors.push({
			resourceRoot: malformedRoot,
			runId: "malformed",
			runRecordStatus: "valid",
			projectPath: projectRoot,
			cleanupState: "pending",
			liveness: "dead",
		});

		const audit = backend.auditAllocationIntents({
			knownResourceRoots: descriptors,
		});
		deepStrictEqual(
			audit.map(({ runId, classification, reason }) => ({
				runId,
				classification,
				reason,
			})),
			[
				{
					runId: "active-intent",
					classification: "valid",
					reason: "active_run",
				},
				{
					runId: "stale-intent",
					classification: "stale",
					reason: "stale_run",
				},
				{
					runId: "unknown-intent",
					classification: "unknown",
					reason: "run_missing",
				},
				{
					runId: null,
					classification: "malformed",
					reason: "intent_malformed",
				},
			],
		);
		strictEqual(mutations, 0, "the allocation-intent audit is read-only");
		rmSync(root, { recursive: true, force: true });
	});

	it("refuses an unproven bare handle before any VM mutation", () => {
		const calls = [];
		const name = buildParallelsWorkingName("bare-handle", 5151);
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list")
					return listed([{ uuid: WORK_UUID, status: "stopped", name }]);
				return "";
			},
		});
		throws(() => backend.destroy(WORK_UUID), /recovery_evidence_missing/);
		strictEqual(
			calls.filter((args) => ["stop", "delete"].includes(args[0])).length,
			0,
		);
	});

	it("refuses allocation before clone when authoritative ownership context is absent", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			requireLinkedCloneMeasurement: false,
			prlctlFn: (args) => {
				calls.push(args);
				return "";
			},
		});
		throws(
			() =>
				backend.create("macOS", { linked: false, runId: "missing-context" }),
			/ownership context/,
		);
		strictEqual(
			calls.length,
			0,
			"metadata refusal must precede clone mutation",
		);
	});

	it("resolves a fresh backend targeted destroy from registered UUID ownership", () => {
		const name = buildParallelsWorkingName("fresh-destroy", 5151);
		const context = ownedOptions("fresh-destroy", 5151).ownershipContext;
		const writer = new ParallelsExecutionBackend({ prlctlFn: () => "" });
		writer.writeVmOwnership(WORK_UUID, name, context);
		const calls = [];
		let destroyed = false;
		const fresh = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") {
					if (destroyed) return listed([]);
					return listed([{ uuid: WORK_UUID, status: "stopped", name }]);
				}
				if (args[0] === "delete") destroyed = true;
				return "";
			},
		});
		const handle = {
			uuid: WORK_UUID,
			name,
			runId: "fresh-destroy",
			taskId: context.taskId,
			attemptId: context.attemptId,
			processStartIdentity: context.processStartIdentity,
		};
		fresh.destroy(handle);
		ok(calls.some((args) => args[0] === "delete" && args[1] === WORK_UUID));

		writer.writeVmOwnership(WORK_UUID, name, context);
		destroyed = false;
		const beforeMismatch = calls.length;
		throws(
			() => fresh.destroy({ ...handle, processStartIdentity: "other-birth" }),
			/identity changed/,
		);
		strictEqual(
			calls
				.slice(beforeMismatch)
				.filter((args) => ["stop", "delete"].includes(args[0])).length,
			0,
		);
	});
});
