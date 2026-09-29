import {
	deepStrictEqual,
	equal,
	match,
	notStrictEqual,
	ok,
	strictEqual,
	throws,
} from "node:assert/strict";

import { execFileSync, spawnSync } from "node:child_process";

import { createHash, randomUUID } from "node:crypto";

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
	describeExecError,
	PrlctlCallError,
	prlctlFailureMetadata,
	WorkerBootStageError,
	workerBootStageDiagnosticCode,
} from "../src/switchyard/adapter/exec-error.mjs";

import { seedProjectWithBackend } from "../src/switchyard/lifecycle/index.mjs";

import {
	BULK_TRANSFER_HELPER,
	buildParallelsWorkingName,
	describeBulkTransferFailure,
	MAX_AQUA_EXEC_ARGV_BYTES,
	PARALLELS_WORKING_PREFIX,
	ParallelsHostReadinessError,
	parseParallelsWorkingName,
	probeHostProcessIdentity,
	ParallelsExecutionBackend as RealParallelsExecutionBackend,
	validateLinkedCloneMeasurement,
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

	it("bounds every Parallels call and preserves the production backend bytes", () => {
		const productionSources = [
			[
				"../src/switchyard/lifecycle/parallels-execution-backend.mjs",
				"63d9f0b9b9e50b57f7a24be1589cb4b72793b7a26f73b2ff3f9fce4418dd48d6",
			],
			[
				"../src/switchyard/lifecycle/parallels-primitives.mjs",
				"650ebabc4ec649c307a603b7bb6b245e400203275c2df5eb07ca9c1ee453019c",
			],
			[
				"../src/switchyard/lifecycle/parallels-transfer.mjs",
				"090b2a6f8f118dadf035b5429a17cd8559decb7d869fe11088e53f7e7ca65e1e",
			],
			[
				"../src/switchyard/lifecycle/parallels-validation.mjs",
				"40728f2f79adb98a7f43d447b77d8e595062eaff94a6ffa56bc5462d1cb13d81",
			],
		];
		for (const [relativePath, expectedHash] of productionSources) {
			const sourcePath = new URL(relativePath, import.meta.url);
			const source = readFileSync(sourcePath, "utf8");
			strictEqual(
				createHash("sha256").update(source, "utf8").digest("hex"),
				expectedHash,
			);
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
