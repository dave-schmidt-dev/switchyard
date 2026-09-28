import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	__resetRosterCacheForTests,
	validateInvocationDescriptor,
} from "../src/switchyard/roster/index.mjs";
import {
	acquireHalfOpenClaim,
	attestRouteRepair,
	createRouteHealthTerminalBinding,
	derivePublicConfigurationEpoch,
	ingestRouteHealthEvents,
	inspectRouteHealth,
	rebuildRouteHealth,
	recordRouteHealthObservation,
	releaseHalfOpenClaim,
	startHalfOpenClaim,
} from "../src/switchyard/router/health.mjs";
import { preflightMacosQueue } from "../src/switchyard/router/index.mjs";
import {
	createRouteHealthEvent,
	getRunRoot,
	initializeRun,
} from "../src/switchyard/run-store/index.mjs";
import {
	FIXTURE_PATH,
	HEALTH_ROOT,
	HEALTH_RUN_ROOT,
	previousRosterPath,
	previousRunStoreRoot,
	ROUTER_ROSTER_PATH,
	SNAPSHOT_PATH,
	withDispatchQualifiedDescriptors,
} from "./helpers/router-fixtures.mjs";

before(() => {
	rmSync(HEALTH_ROOT, { recursive: true, force: true });
	rmSync(HEALTH_RUN_ROOT, { recursive: true, force: true });
	process.env.SWITCHYARD_RUN_STORE_ROOT = HEALTH_RUN_ROOT;
	process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = SNAPSHOT_PATH;
	writeFileSync(
		ROUTER_ROSTER_PATH,
		JSON.stringify(
			withDispatchQualifiedDescriptors(
				JSON.parse(readFileSync(FIXTURE_PATH, "utf8")),
			),
		),
		"utf8",
	);
	process.env.SWITCHYARD_ROSTER_PATH = ROUTER_ROSTER_PATH;
	__resetRosterCacheForTests();
});

after(() => {
	delete process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;
	if (previousRosterPath === undefined) {
		delete process.env.SWITCHYARD_ROSTER_PATH;
	} else {
		process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
	}
	__resetRosterCacheForTests();
	try {
		rmSync(SNAPSHOT_PATH, { force: true });
		rmSync(ROUTER_ROSTER_PATH, { force: true });
		rmSync(HEALTH_ROOT, { recursive: true, force: true });
		rmSync(HEALTH_RUN_ROOT, { recursive: true, force: true });
		if (previousRunStoreRoot === undefined)
			delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRunStoreRoot;
	} catch {
		// Ignore
	}
});

describe("fenced route-health projection", () => {
	const publicConfigurationEpoch = `sha256:${"d".repeat(64)}`;
	let runIndex = 0;

	function descriptor(targetId = "codex-health") {
		return validateInvocationDescriptor(
			{
				target_id: targetId,
				model_ref: "fixture/codex-standard",
				selector: "fixture-codex-standard",
				effort: null,
				variant: null,
				invocation_args: [],
			},
			"codex",
		);
	}

	async function initializeHealthRun({
		targetId = "codex-health",
		taskId = "1.1",
	} = {}) {
		runIndex += 1;
		const runId = `health-${runIndex}-${randomUUID()}`;
		await initializeRun({
			runId,
			tasksFilePath: join(HEALTH_RUN_ROOT, `${runId}.md`),
			projectPath: join(HEALTH_RUN_ROOT, `project-${runId}`),
			orderedTaskIds: [taskId],
			initialHostFingerprint: { git: "fixture", worktree: "clean" },
		});
		return {
			runId,
			runRoot: getRunRoot(runId),
			taskId,
			descriptor: descriptor(targetId),
		};
	}

	function evidenceSource(run) {
		return { runId: run.runId, runRoot: run.runRoot };
	}

	async function emitHealthEvent(run, event, binding = {}) {
		const lifecycleVerified =
			event.event === "task_completed" && event.servedModelVerified === true;
		await createRouteHealthEvent(
			run.runId,
			{
				phase: "execution",
				status: "fixture",
				taskId: run.taskId,
				attempt: 1,
				resolvedTargetId: run.descriptor.target_id,
				invocationDescriptor: run.descriptor,
				descriptorIdentity: run.descriptor.descriptor_identity,
				descriptorHarness: "codex",
				...event,
			},
			{
				adapterContractId: "switchyard-route-health-v1",
				publicConfigurationEpoch,
				repairEpoch: 0,
				transportVerified: lifecycleVerified,
				lifecycleVerified,
				...binding,
			},
		);
	}

	it("uses a closed public configuration schema and refuses direct observation authority", async () => {
		const epoch = derivePublicConfigurationEpoch({
			approvedConfiguration: {
				rosterSchemaVersion: 1,
				approvedTargets: ["codex-health"],
				qualifiedProviders: ["codex"],
			},
			goldenImageReference: "golden-v1",
		});
		strictEqual(/^sha256:[a-f0-9]{64}$/.test(epoch), true);
		throws(
			() =>
				derivePublicConfigurationEpoch({
					approvedConfiguration: { arbitrary: true },
					goldenImageReference: "golden-v1",
				}),
			/approved public configuration/,
		);
		const direct = await recordRouteHealthObservation({});
		strictEqual(direct.accepted, false);
		strictEqual(direct.reason, "untrusted-observation");
		const uninitialized = await inspectRouteHealth({
			healthStateRoot: HEALTH_ROOT,
			targetId: "never-observed",
			descriptorIdentity: descriptor().descriptor_identity,
			publicConfigurationEpoch,
			repairEpoch: 0,
		});
		strictEqual(uninitialized.state, "health-unavailable");
	});

	it("mints terminal authority only from exact transport and lifecycle proof", () => {
		const invocationDescriptor = descriptor();
		const input = {
			targetId: invocationDescriptor.target_id,
			descriptorIdentity: invocationDescriptor.descriptor_identity,
			descriptorHarness: "codex",
			invocationDescriptor,
			publicConfigurationEpoch,
			repairEpoch: 3,
			runId: "run-terminal",
			taskId: "1.1",
			attempt: "attempt-1",
			workspaceId: "workspace-terminal",
			servedModelVerified: true,
			providerExecutionSucceeded: true,
		};
		strictEqual(createRouteHealthTerminalBinding(input), null);
		const lifecycleReceipt = {
			version: 1,
			kind: "completion_continuation_lifecycle",
			providerExited: true,
			childrenExited: true,
			cleanupSucceeded: true,
			taskId: input.taskId,
			attemptId: input.attempt,
			descriptorIdentity: input.descriptorIdentity,
			workspaceId: input.workspaceId,
		};
		deepStrictEqual(
			createRouteHealthTerminalBinding({ ...input, lifecycleReceipt }),
			{
				adapterContractId: "switchyard-route-health-v1",
				publicConfigurationEpoch,
				repairEpoch: 3,
				transportVerified: true,
				lifecycleVerified: true,
			},
		);
		strictEqual(
			createRouteHealthTerminalBinding({
				...input,
				claimRevision: 7,
				lifecycleReceipt: { ...lifecycleReceipt, workspaceId: "other" },
			}),
			null,
		);
	});

	it("ingests a real host-bound auth failure and requires one started attested trial", async () => {
		const failedRun = await initializeHealthRun();
		await emitHealthEvent(failedRun, {
			event: "task_failed",
			result: "execution_failed",
			errorKind: "auth_expired",
			reasonCode: "auth_expired",
			diagnosticCode: "auth_expired",
			diagnosticOrigin: "adapter",
			diagnosticEvidenceAvailable: true,
			failurePhase: "provider_execution",
		});
		const failedIngest = await ingestRouteHealthEvents({
			authorisedRuns: [evidenceSource(failedRun)],
			healthStateRoot: HEALTH_ROOT,
		});
		strictEqual(
			failedIngest[0].available,
			true,
			JSON.stringify(failedIngest[0]),
		);
		const identity = {
			healthStateRoot: HEALTH_ROOT,
			targetId: failedRun.descriptor.target_id,
			descriptorIdentity: failedRun.descriptor.descriptor_identity,
			publicConfigurationEpoch,
			repairEpoch: 0,
		};
		strictEqual((await inspectRouteHealth(identity)).state, "repair-hold");
		strictEqual(
			(
				await inspectRouteHealth({
					...identity,
					publicConfigurationEpoch: `sha256:${"e".repeat(64)}`,
				})
			).state,
			"repair-hold",
		);
		const attestation = await attestRouteRepair({
			...identity,
			repairKind: "auth_repaired",
			nowMs: Date.now() + 10_000,
		});
		const successRun = await initializeHealthRun();
		const claimInput = {
			...identity,
			repairEpoch: attestation.repairEpoch,
			runId: successRun.runId,
			taskId: successRun.taskId,
			attempt: 1,
		};
		const claims = await Promise.all([
			acquireHalfOpenClaim(claimInput),
			acquireHalfOpenClaim(claimInput),
		]);
		const claim = claims.find((item) => item.claimed);
		strictEqual(claims.filter((item) => item.claimed).length, 1);
		await rejects(
			startHalfOpenClaim({
				...claimInput,
				leaseRevision: claim.lease.revision,
			}),
			/lease token/,
		);
		const wrongEpoch = await startHalfOpenClaim({
			...claimInput,
			publicConfigurationEpoch: `sha256:${"f".repeat(64)}`,
			leaseToken: claim.lease.token,
			leaseRevision: claim.lease.revision,
		});
		strictEqual(wrongEpoch.started, false);
		const repairDuringClaim = await attestRouteRepair({
			...claimInput,
			repairKind: "auth_repaired",
			nowMs: Date.now() + 20_000,
		});
		strictEqual(repairDuringClaim.reason, "claim-active");
		strictEqual(repairDuringClaim.repairEpoch, attestation.repairEpoch);
		const started = await startHalfOpenClaim({
			...claimInput,
			leaseToken: claim.lease.token,
			leaseRevision: claim.lease.revision,
		});
		strictEqual(started.started, true);
		await rejects(
			releaseHalfOpenClaim({
				...claimInput,
				leaseRevision: claim.lease.revision,
				provenNeverStarted: true,
			}),
			/lease token/,
		);
		const repairDuringStartedClaim = await attestRouteRepair({
			...claimInput,
			repairKind: "auth_repaired",
			nowMs: Date.now() + 30_000,
		});
		strictEqual(repairDuringStartedClaim.reason, "claim-active");
		strictEqual(repairDuringStartedClaim.repairEpoch, attestation.repairEpoch);
		const deniedRelease = await releaseHalfOpenClaim({
			...claimInput,
			leaseToken: claim.lease.token,
			leaseRevision: claim.lease.revision,
			provenNeverStarted: true,
		});
		strictEqual(deniedRelease.released, false);
		await emitHealthEvent(
			successRun,
			{ event: "task_completed", servedModelVerified: true },
			{
				repairEpoch: attestation.repairEpoch,
				claimRevision: claim.lease.revision,
			},
		);
		await ingestRouteHealthEvents({
			authorisedRuns: [evidenceSource(successRun)],
			healthStateRoot: HEALTH_ROOT,
		});
		strictEqual((await inspectRouteHealth(claimInput)).state, "healthy");
	});

	it("reclaims a health lock whose writer was killed, but not one still held", async () => {
		// A process killed between creating the lock and removing it used to
		// strand the target: every later reader got health-lease-held, forever,
		// with no path back short of deleting the file by hand. That is the one
		// failure mode shadow mode cannot recover from on its own.
		//
		// Private state root: these cases plant lock files by hand, and the
		// shared root's other cases find locks by scanning the directory.
		const lockRoot = join(
			tmpdir(),
			`switchyard-health-locks-${process.pid}-${randomUUID()}`,
		);
		try {
			const run = await initializeHealthRun({ targetId: "abandoned-lock" });
			await emitHealthEvent(run, {
				event: "task_completed",
				servedModelVerified: true,
			});
			const source = evidenceSource(run);
			// One clean ingest so the scope's files, and its lock leaf, exist.
			const first = await ingestRouteHealthEvents({
				authorisedRuns: [source],
				healthStateRoot: lockRoot,
			});
			strictEqual(first[0].available, true, JSON.stringify(first[0]));
			const leaf = readdirSync(join(lockRoot, "control")).find((name) =>
				name.endsWith(".json"),
			);
			const lockPath = join(
				lockRoot,
				"locks",
				`${leaf.replace(/\.json$/, "")}.lock`,
			);
			mkdirSync(join(lockRoot, "locks"), { recursive: true, mode: 0o700 });

			// A live owner is still exclusive: this must NOT be reclaimed.
			writeFileSync(
				lockPath,
				`${randomUUID()}\n${JSON.stringify({
					pid: process.pid,
					acquiredAt: Date.now(),
				})}\n`,
				{ mode: 0o600 },
			);
			const held = await ingestRouteHealthEvents({
				authorisedRuns: [source],
				healthStateRoot: lockRoot,
			});
			strictEqual(held[0].available, false);
			strictEqual(held[0].reason, "health-lease-held");
			strictEqual(existsSync(lockPath), true);

			// The same lock, owned by a process that is gone, is reclaimed and the
			// update goes through. `ownerAlive` is the seam so the case does not
			// depend on guessing a pid that is really dead on this host.
			const recovered = await ingestRouteHealthEvents({
				authorisedRuns: [source],
				healthStateRoot: lockRoot,
				ownerAlive: () => false,
			});
			strictEqual(recovered[0].available, true, JSON.stringify(recovered[0]));
			strictEqual(existsSync(lockPath), false);

			// An age-expired lock is retired too, whatever its pid says: after a
			// reboot the recorded pid can belong to an unrelated live process.
			writeFileSync(
				lockPath,
				`${randomUUID()}\n${JSON.stringify({
					pid: process.pid,
					acquiredAt: Date.now() - 3_600_000,
				})}\n`,
				{ mode: 0o600 },
			);
			const aged = await ingestRouteHealthEvents({
				authorisedRuns: [source],
				healthStateRoot: lockRoot,
			});
			strictEqual(aged[0].available, true, JSON.stringify(aged[0]));
		} finally {
			rmSync(lockRoot, { recursive: true, force: true });
		}
	});

	it("recovers an interrupted control-first publication without losing its auth hold", async () => {
		const run = await initializeHealthRun({ targetId: "interrupted-auth" });
		await emitHealthEvent(run, {
			event: "task_failed",
			result: "execution_failed",
			errorKind: "auth_expired",
			reasonCode: "auth_expired",
			diagnosticCode: "auth_expired",
			diagnosticOrigin: "adapter",
			diagnosticEvidenceAvailable: true,
			failurePhase: "provider_execution",
		});
		const interrupted = await ingestRouteHealthEvents({
			authorisedRuns: [evidenceSource(run)],
			healthStateRoot: HEALTH_ROOT,
			onStatus: ({ event }) => {
				if (event === "health_control_published") {
					throw new Error("simulated publication interruption");
				}
			},
		});
		strictEqual(interrupted[0].available, false);
		const identity = {
			healthStateRoot: HEALTH_ROOT,
			targetId: run.descriptor.target_id,
			descriptorIdentity: run.descriptor.descriptor_identity,
			publicConfigurationEpoch,
			repairEpoch: 0,
		};
		strictEqual(
			(await inspectRouteHealth(identity)).state,
			"health-unavailable",
		);
		const rebuilt = await rebuildRouteHealth({
			authorisedRuns: [evidenceSource(run)],
			healthStateRoot: HEALTH_ROOT,
		});
		strictEqual(rebuilt[0].rebuilt, true);
		strictEqual((await inspectRouteHealth(identity)).state, "repair-hold");
	});

	it("keeps missing control unavailable through rebuild", async () => {
		const controlsBefore = new Set(
			existsSync(join(HEALTH_ROOT, "control"))
				? readdirSync(join(HEALTH_ROOT, "control"))
				: [],
		);
		const run = await initializeHealthRun({ targetId: "missing-control" });
		await emitHealthEvent(run, {
			event: "task_completed",
			servedModelVerified: true,
		});
		await ingestRouteHealthEvents({
			authorisedRuns: [evidenceSource(run)],
			healthStateRoot: HEALTH_ROOT,
		});
		const controlDir = join(HEALTH_ROOT, "control");
		const control = readdirSync(controlDir).find(
			(name) => name.endsWith(".json") && !controlsBefore.has(name),
		);
		unlinkSync(join(controlDir, control));
		const rebuilt = await rebuildRouteHealth({
			authorisedRuns: [evidenceSource(run)],
			healthStateRoot: HEALTH_ROOT,
		});
		strictEqual(rebuilt[0].available, false);
		strictEqual(
			(
				await inspectRouteHealth({
					healthStateRoot: HEALTH_ROOT,
					targetId: run.descriptor.target_id,
					descriptorIdentity: run.descriptor.descriptor_identity,
					publicConfigurationEpoch,
					repairEpoch: 0,
				})
			).state,
			"health-unavailable",
		);
	});

	it("refuses a claim when committed derived observations are missing", async () => {
		const observationsBefore = new Set(
			existsSync(join(HEALTH_ROOT, "observations"))
				? readdirSync(join(HEALTH_ROOT, "observations"))
				: [],
		);
		const run = await initializeHealthRun({ targetId: "missing-derived" });
		await emitHealthEvent(run, {
			event: "task_failed",
			result: "execution_failed",
			errorKind: "auth_expired",
			reasonCode: "auth_expired",
			diagnosticCode: "auth_expired",
			diagnosticOrigin: "adapter",
			diagnosticEvidenceAvailable: true,
			failurePhase: "provider_execution",
		});
		await ingestRouteHealthEvents({
			authorisedRuns: [evidenceSource(run)],
			healthStateRoot: HEALTH_ROOT,
		});
		const identity = {
			healthStateRoot: HEALTH_ROOT,
			targetId: run.descriptor.target_id,
			descriptorIdentity: run.descriptor.descriptor_identity,
			publicConfigurationEpoch,
			repairEpoch: 0,
		};
		const attested = await attestRouteRepair({
			...identity,
			repairKind: "auth_repaired",
			nowMs: Date.now() + 10_000,
		});
		const observationsDir = join(HEALTH_ROOT, "observations");
		const derived = readdirSync(observationsDir).find(
			(name) => name.endsWith(".json") && !observationsBefore.has(name),
		);
		unlinkSync(join(observationsDir, derived));
		const claim = await acquireHalfOpenClaim({
			...identity,
			repairEpoch: attested.repairEpoch,
			runId: "claim-missing-derived",
			taskId: "1.1",
			attempt: 1,
		});
		strictEqual(claim.available, false);
		strictEqual(claim.state, "health-unavailable");
	});

	it("rebuilds schema-corrupt derived observations under intact control", async () => {
		const observationsBefore = new Set(
			readdirSync(join(HEALTH_ROOT, "observations")),
		);
		const run = await initializeHealthRun({ targetId: "corrupt-derived" });
		await emitHealthEvent(run, {
			event: "task_completed",
			servedModelVerified: true,
		});
		await ingestRouteHealthEvents({
			authorisedRuns: [evidenceSource(run)],
			healthStateRoot: HEALTH_ROOT,
		});
		const observationsDir = join(HEALTH_ROOT, "observations");
		const derived = readdirSync(observationsDir).find(
			(name) => name.endsWith(".json") && !observationsBefore.has(name),
		);
		writeFileSync(join(observationsDir, derived), "{}", { mode: 0o600 });
		const rebuilt = await rebuildRouteHealth({
			authorisedRuns: [evidenceSource(run)],
			healthStateRoot: HEALTH_ROOT,
		});
		strictEqual(rebuilt[0].rebuilt, true);
		strictEqual(
			(
				await inspectRouteHealth({
					healthStateRoot: HEALTH_ROOT,
					targetId: run.descriptor.target_id,
					descriptorIdentity: run.descriptor.descriptor_identity,
					publicConfigurationEpoch,
					repairEpoch: 0,
				})
			).state,
			"healthy",
		);
	});

	it("rejects lease replacement and leaves the replacement lock intact", async () => {
		const targetId = "lease-displaced";
		const d = descriptor(targetId);
		const base = {
			healthStateRoot: HEALTH_ROOT,
			targetId,
			descriptorIdentity: d.descriptor_identity,
			publicConfigurationEpoch,
			repairKind: "auth_repaired",
			nowMs: 1,
		};
		const initialized = await attestRouteRepair(base);
		const displaced = await attestRouteRepair({
			...base,
			expectedRevision: initialized.revision,
			onStatus: ({ event }) => {
				if (event !== "health_publish_staged") return;
				const lockDir = join(HEALTH_ROOT, "locks");
				const lock = join(
					lockDir,
					readdirSync(lockDir).find((name) => name.endsWith(".lock")),
				);
				renameSync(lock, `${lock}.old`);
				writeFileSync(lock, "replacement-owner\n", { mode: 0o600 });
			},
		});
		strictEqual(displaced.available, false);
		const lockDir = join(HEALTH_ROOT, "locks");
		ok(
			readdirSync(lockDir).some(
				(name) =>
					readFileSync(join(lockDir, name), "utf8") === "replacement-owner\n",
			),
		);
	});

	it("rejects an on-disk revision displacement before publication", async () => {
		const controlsBefore = new Set(readdirSync(join(HEALTH_ROOT, "control")));
		const d = descriptor("revision-displaced");
		const base = {
			healthStateRoot: HEALTH_ROOT,
			targetId: "revision-displaced",
			descriptorIdentity: d.descriptor_identity,
			publicConfigurationEpoch,
			repairKind: "configuration_repaired",
			nowMs: 1,
		};
		const initialized = await attestRouteRepair(base);
		const controlDir = join(HEALTH_ROOT, "control");
		const controlPath = join(
			controlDir,
			readdirSync(controlDir).find(
				(name) => name.endsWith(".json") && !controlsBefore.has(name),
			),
		);
		const displaced = await attestRouteRepair({
			...base,
			expectedRevision: initialized.revision,
			onStatus: ({ event }) => {
				if (event !== "health_publish_staged") return;
				const record = JSON.parse(readFileSync(controlPath, "utf8"));
				record.revision += 1;
				writeFileSync(controlPath, JSON.stringify(record), { mode: 0o600 });
			},
		});
		strictEqual(displaced.available, false);
		const retained = JSON.parse(readFileSync(controlPath, "utf8"));
		strictEqual(retained.revision, initialized.revision + 1);
		strictEqual(retained.repairEpoch, initialized.repairEpoch);
	});

	it("shares one central record across explicit project run roots and rejects forged source identity", async () => {
		const first = await initializeHealthRun({ targetId: "shared-central" });
		const second = await initializeHealthRun({ targetId: "shared-central" });
		await emitHealthEvent(first, {
			event: "task_completed",
			servedModelVerified: true,
		});
		await emitHealthEvent(second, {
			event: "task_completed",
			servedModelVerified: true,
		});
		const results = await ingestRouteHealthEvents({
			authorisedRuns: [evidenceSource(first), evidenceSource(second)],
			healthStateRoot: HEALTH_ROOT,
		});
		strictEqual(results.filter((item) => item.accepted).length, 2);
		await rejects(
			ingestRouteHealthEvents({
				authorisedRuns: [{ ...evidenceSource(first), runId: "forged-run" }],
				healthStateRoot: HEALTH_ROOT,
			}),
			/run id mismatch/,
		);
	});

	it("deduplicates replay independently of arrival order and preserves control on rebuild", async () => {
		const run = await initializeHealthRun({ targetId: "replay-safe" });
		await emitHealthEvent(run, {
			event: "task_completed",
			servedModelVerified: true,
		});
		const first = await ingestRouteHealthEvents({
			authorisedRuns: [evidenceSource(run)],
			healthStateRoot: HEALTH_ROOT,
		});
		const replay = await ingestRouteHealthEvents({
			authorisedRuns: [evidenceSource(run)],
			healthStateRoot: HEALTH_ROOT,
		});
		strictEqual(first[0].accepted, true);
		strictEqual(replay[0].reason, "duplicate-attempt");
		const rebuilt = await rebuildRouteHealth({
			authorisedRuns: [evidenceSource(run)],
			healthStateRoot: HEALTH_ROOT,
		});
		strictEqual(rebuilt[0].observationCount, 1);
	});

	it("preflights only the bounded potential-attempt task set", () => {
		const snapshot = {
			snapshot: {
				schema_version: 2,
				updated_at: new Date().toISOString(),
				providers: [],
			},
			snapshotStatus: "fresh",
			snapshotMtime: 1,
			snapshotAgeMsAtRoute: 0,
		};
		const result = preflightMacosQueue({
			tasks: [
				{ id: "standard", status: "pending", requiredCapability: "standard" },
				{ id: "unrelated-high", status: "pending", requiredCapability: "high" },
			],
			potentialAttemptTasks: [
				{ id: "standard", status: "pending", requiredCapability: "standard" },
			],
			readSnapshot: () => snapshot,
		});
		strictEqual(result.checkedCapabilities.includes("high"), false);
	});
});
