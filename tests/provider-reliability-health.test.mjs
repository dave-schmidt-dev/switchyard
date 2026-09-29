import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import { getInvocationDescriptor } from "../src/switchyard/roster/index.mjs";
import {
	acquireHalfOpenClaim,
	createDefaultRouteHealthDecision,
	createRouteHealthTerminalBinding,
	ingestRouteHealthEvents,
	inspectRouteHealth,
} from "../src/switchyard/router/health.mjs";
import { COOLDOWN_MS } from "../src/switchyard/router/health-schema.mjs";
import { GOLDEN_IMAGE_VERIFIED_PROVIDERS } from "../src/switchyard/router/index.mjs";
import {
	createEvent,
	readAuthorizedRunEvents,
} from "../src/switchyard/run-store/index.mjs";
import {
	attachRouteHealthTerminal,
	prepareRouteHealthTrial,
} from "../src/switchyard/runner/route-health.mjs";
import { SIMPLE_TARGET_ADAPTERS } from "../src/switchyard/simple/args.mjs";
import {
	createSimpleRouteHealthController,
	SIMPLE_ROUTE_HEALTH_EPOCH,
} from "../src/switchyard/simple/health.mjs";
import {
	cleanupHealthFixture,
	defaultHealthDecision,
	descriptorFor,
	enforcingController,
	fakeHealthDecision,
	HEALTH_ROOT,
	healthIdentity,
	initializeHealthRun,
	localLifecycle,
	seedVmQuotaCooldown,
	setupHealthFixture,
	simpleInput,
	vmLifecycle,
	withSystemClock,
} from "./provider-reliability-health-fixture.mjs";

before(setupHealthFixture);
after(cleanupHealthFixture);

describe("provider reliability health", () => {
	it("tracks exact local descriptors across every harness and both AGY targets", async () => {
		const targets = SIMPLE_TARGET_ADAPTERS.map(({ targetId }) => targetId);
		strictEqual(targets.includes("antigravity"), true);
		strictEqual(targets.includes("antigravity-claude"), true);
		const descriptors = targets.map(descriptorFor);
		strictEqual(descriptors.every(Boolean), true);
		const events = [];
		const controller = createSimpleRouteHealthController({
			healthDecision: fakeHealthDecision(descriptors),
			runId: "matrix-run",
			taskId: "matrix-task",
			createRouteHealthEvent: async (runId, event, binding) => {
				events.push({ runId, event, binding });
			},
			ingestRouteHealthEvents: async () => {
				const { runId, event, binding } = events.at(-1);
				return [
					{
						accepted: true,
						runId,
						taskId: event.taskId,
						attempt: event.attempt,
						targetId: event.resolvedTargetId,
						descriptorIdentity: event.descriptorIdentity,
						publicConfigurationEpoch: binding.publicConfigurationEpoch,
						repairEpoch: binding.repairEpoch,
					},
				];
			},
		});
		const attempts = new Set();
		for (const descriptor of descriptors) {
			const input = {
				provider: descriptor.target_id,
				targetId: descriptor.target_id,
				capability: "standard",
				descriptor,
			};
			const prepared = await controller.prepare(input);
			strictEqual(prepared.allowed, true);
			strictEqual(prepared.tracked, true);
			attempts.add(prepared.attempt);
			strictEqual((await controller.start()).allowed, true);
			const terminal = await controller.terminal({
				providerResult: { success: true, servedModelVerified: true },
				providerLifecycle: localLifecycle(),
			});
			strictEqual(terminal.settled, true);
		}
		strictEqual(attempts.size, descriptors.length);
		strictEqual(events.length, descriptors.length);
		for (const { event } of events) {
			strictEqual(event.event, "provider_attempt_terminal");
			strictEqual(Object.hasOwn(event, "result"), false);
			strictEqual(Object.hasOwn(event, "errorKind"), false);
		}
		const codex = descriptors.find(({ target_id }) => target_id === "codex");
		const agyTargets = descriptors.filter(({ target_id }) =>
			target_id.startsWith("antigravity"),
		);
		notStrictEqual(
			codex.descriptor_identity,
			agyTargets[0].descriptor_identity,
		);
		notStrictEqual(
			agyTargets[0].descriptor_identity,
			agyTargets[1].descriptor_identity,
		);

		const mutated = { ...codex, selector: "forged-selector" };
		const rejectedController = createSimpleRouteHealthController({
			healthDecision: fakeHealthDecision([codex]),
			runId: "matrix-run",
			taskId: "matrix-task",
		});
		const mismatched = await rejectedController.prepare({
			provider: "codex",
			targetId: "codex",
			capability: "standard",
			descriptor: mutated,
		});
		strictEqual(mismatched.tracked, false);
	});

	it("ingests exact VM quota evidence into a finite cooldown and fences unresolved half-open replay", async () => {
		const descriptor = getInvocationDescriptor("codex", "standard");
		const healthStateRoot = join(HEALTH_ROOT, "vm-cooldown");
		const seeded = await seedVmQuotaCooldown({ healthStateRoot, descriptor });
		strictEqual(seeded.results[0].accepted, true);
		strictEqual(seeded.results[0].attempt, "provider-seed");
		strictEqual(seeded.event.routeHealthBinding.transportVerified, false);
		strictEqual(seeded.event.routeHealthBinding.lifecycleVerified, true);
		strictEqual(seeded.event.diagnosticCode, "quota_exhausted");
		const identity = healthIdentity(healthStateRoot, descriptor, seeded.epoch);
		const beforeExpiry = await inspectRouteHealth({
			...identity,
			nowMs: seeded.at + COOLDOWN_MS[0] - 1,
		});
		strictEqual(beforeExpiry.state, "cooldown");
		strictEqual(beforeExpiry.trialAvailable, false);
		const afterExpiry = await inspectRouteHealth({
			...identity,
			nowMs: seeded.at + COOLDOWN_MS[0] + 1,
		});
		strictEqual(afterExpiry.state, "cooldown");
		strictEqual(afterExpiry.trialAvailable, true);
		const differentDescriptor = getInvocationDescriptor("codex", "low");
		const isolated = await inspectRouteHealth({
			...healthIdentity(healthStateRoot, differentDescriptor, seeded.epoch),
		});
		strictEqual(isolated.state, "health-unavailable");
		const otherTarget = descriptorFor("vibe");
		strictEqual(
			(
				await inspectRouteHealth(
					healthIdentity(healthStateRoot, otherTarget, seeded.epoch),
				)
			).state,
			"health-unavailable",
		);
		const otherEpoch = await inspectRouteHealth({
			...healthIdentity(
				healthStateRoot,
				descriptor,
				`sha256:${"b".repeat(64)}`,
			),
		});
		strictEqual(otherEpoch.state, "healthy");

		const clockNow = seeded.at + COOLDOWN_MS[0] + 1_000;
		const events = [];
		const claimRunId = `claim-${randomUUID()}`;
		const staleOnlyController = enforcingController({
			healthStateRoot,
			runId: claimRunId,
			taskId: "task-claim",
			now: () => clockNow,
			createRouteHealthEvent: async (runId, event, binding) => {
				events.push({ runId, event, binding });
			},
			ingestRouteHealthEvents: async () => seeded.results,
		});
		const input = simpleInput(descriptor);
		const prepared = await staleOnlyController.prepare(input);
		strictEqual(prepared.allowed, true);
		strictEqual(prepared.tracked, true);
		strictEqual((await staleOnlyController.start()).trial, true);
		strictEqual(seeded.results[0].runId === claimRunId, false);
		const competingClaim = await acquireHalfOpenClaim({
			...identity,
			runId: `competing-${randomUUID()}`,
			taskId: "task-competing",
			attempt: "provider-competing",
			nowMs: clockNow,
		});
		strictEqual(competingClaim.claimed, false);
		strictEqual(competingClaim.reason, "claim-active");
		const terminal = await staleOnlyController.terminal({
			providerResult: { success: true, servedModelVerified: true },
			providerLifecycle: localLifecycle(),
		});
		strictEqual(terminal.settled, false);
		strictEqual(events[0].event.attempt, prepared.attempt);
		const retry = await staleOnlyController.prepare(input);
		strictEqual(retry.allowed, false);
		strictEqual(retry.reason, "provider-invocation-unsettled");

		// The VM terminal shape is accepted only at its approved cleanup stage.
		const quotaDiagnostic = createProviderReliabilityDiagnostic({
			causeCode: "quota_exhausted",
			phase: "provider",
			exitCode: 1,
		});
		strictEqual(
			createRouteHealthTerminalBinding({
				targetId: descriptor.target_id,
				descriptorIdentity: descriptor.descriptor_identity,
				invocationDescriptor: descriptor,
				descriptorHarness: "codex",
				publicConfigurationEpoch: seeded.epoch,
				repairEpoch: 0,
				runId: seeded.run.runId,
				taskId: seeded.run.taskId,
				attempt: "bad-vm-cleanup",
				healthLane: "queue-vm",
				providerReliability: quotaDiagnostic,
				providerLifecycle: {
					...vmLifecycle(1),
					cleanupStage: "cleanup_started",
				},
				providerExecutionSucceeded: false,
				diagnosticCode: "quota_exhausted",
				diagnosticOrigin: "adapter",
				diagnosticEvidenceAvailable: true,
				failurePhase: "provider_execution",
				exitCode: 1,
			}),
			null,
		);
	});

	it("refuses half-open start when the validated repair epoch disappears", async () => {
		const descriptor = getInvocationDescriptor("codex", "standard");
		const healthStateRoot = join(HEALTH_ROOT, "missing-start-epoch");
		const seeded = await seedVmQuotaCooldown({ healthStateRoot, descriptor });
		const clockNow = seeded.at + COOLDOWN_MS[0] + 1_000;
		const run = await initializeHealthRun("task-missing-start-epoch");
		const decision = fakeHealthDecision([descriptor], {
			mode: "enforce",
			epoch: seeded.epoch,
			stateForCall: (call) =>
				call === 2
					? {
							available: false,
							state: "health-unavailable",
							repairEpoch: null,
							initializable: false,
							trialAvailable: true,
						}
					: {},
		});
		const controller = enforcingController({
			healthDecision: decision,
			healthStateRoot,
			runId: run.runId,
			taskId: run.taskId,
			now: () => clockNow,
		});
		const input = simpleInput(descriptor);
		const prepared = await controller.prepare(input);
		strictEqual(prepared.allowed, true);
		strictEqual(prepared.tracked, true);

		const refused = await controller.start();
		strictEqual(refused.allowed, false);
		strictEqual(refused.reroute, true);
		strictEqual(refused.tracked, false);
		strictEqual(refused.reason, "health-state-unavailable");
		const afterRefusal = await inspectRouteHealth(
			healthIdentity(healthStateRoot, descriptor, seeded.epoch, {
				nowMs: clockNow,
			}),
		);
		strictEqual(afterRefusal.state, "cooldown");
		strictEqual(afterRefusal.trialAvailable, true);
		strictEqual(afterRefusal.claimStatus, null);

		const retried = await controller.prepare(input);
		strictEqual(retried.allowed, true);
		strictEqual(retried.tracked, true);
	});

	it("settles verified transport before later checks and starts a fresh trial", async () => {
		const descriptor = getInvocationDescriptor("codex", "standard");
		const healthStateRoot = join(HEALTH_ROOT, "settled-transport");
		const seeded = await seedVmQuotaCooldown({ healthStateRoot, descriptor });
		const clockNow = seeded.at + COOLDOWN_MS[0] + 1_000;
		const run = await initializeHealthRun("task-transport");
		const controller = enforcingController({
			healthStateRoot,
			runId: run.runId,
			taskId: run.taskId,
			now: () => clockNow,
		});
		const input = simpleInput(descriptor);
		const first = await controller.prepare(input);
		strictEqual(first.allowed, true);
		strictEqual(first.tracked, true);
		strictEqual((await controller.start()).trial, true);
		const terminal = await controller.terminal({
			providerResult: { success: true, servedModelVerified: true },
			providerLifecycle: localLifecycle(),
		});
		strictEqual(terminal.settled, true);
		strictEqual(terminal.binding.transportVerified, true);
		const identity = healthIdentity(healthStateRoot, descriptor, seeded.epoch);
		const settled = await inspectRouteHealth(identity);
		strictEqual(settled.state, "healthy");
		strictEqual(settled.claimStatus, null);

		const next = await controller.prepare(input);
		notStrictEqual(next.attempt, first.attempt);
		strictEqual(next.allowed, true);
		strictEqual((await controller.start()).allowed, true);
		const secondTerminal = await controller.terminal({
			providerResult: { success: true, servedModelVerified: true },
			providerLifecycle: localLifecycle(),
		});
		strictEqual(secondTerminal.settled, true);
		const checkFailure = createProviderReliabilityDiagnostic({
			causeCode: "acceptance_check_failed",
			phase: "check",
			checkIndex: 1,
		});
		await createEvent(run.runId, {
			phase: "execution",
			event: "task_failed",
			status: "failed",
			taskId: run.taskId,
			attempt: "task-attempt",
			result: checkFailure.causeCode,
			errorKind: checkFailure.causeCode,
			providerReliability: checkFailure,
		});
		const persisted = await readAuthorizedRunEvents(run.runRoot);
		const providerEvents = persisted.filter(
			(event) => event.event === "provider_attempt_terminal",
		);
		strictEqual(providerEvents.length, 2);
		for (const event of providerEvents) {
			strictEqual(event.status, "completed");
			strictEqual(event.resolvedTargetId, "codex");
			strictEqual(event.descriptorIdentity, descriptor.descriptor_identity);
			strictEqual(event.routeHealthBinding.transportVerified, true);
			strictEqual(Object.hasOwn(event, "result"), false);
			strictEqual(Object.hasOwn(event, "errorKind"), false);
		}
		const checkEvent = persisted.find((event) => event.event === "task_failed");
		strictEqual(checkEvent.providerReliability.causeCategory, "check");
		strictEqual(Object.hasOwn(checkEvent, "routeHealthBinding"), false);
		const replay = await ingestRouteHealthEvents({
			authorisedRuns: [{ runId: run.runId, runRoot: run.runRoot }],
			healthStateRoot,
		});
		strictEqual(replay.length, 2);
		strictEqual(
			replay.every(({ reason }) => reason === "duplicate-attempt"),
			true,
		);
		strictEqual((await inspectRouteHealth(identity)).state, "healthy");

		const genericCases = [
			["generic-exit", "provider_exit_nonzero", "provider"],
			["generic-check", "acceptance_check_failed", "check"],
			["generic-diff", "diff_rejected", "diff"],
			["generic-baseline", "baseline_check_failed", "baseline"],
			["generic-cancel", "cancelled", "provider"],
		];
		const genericRun = await initializeHealthRun(
			genericCases.map(([taskId]) => taskId),
		);
		for (const [taskId, causeCode, phase] of genericCases) {
			const diagnostic = createProviderReliabilityDiagnostic({
				causeCode,
				phase,
				checkIndex: phase === "check" ? 1 : undefined,
				diffRejectionCategory: phase === "diff" ? "empty" : undefined,
				baselineStatus: phase === "baseline" ? "failed" : undefined,
				cancelled: causeCode === "cancelled" ? true : undefined,
			});
			await createEvent(genericRun.runId, {
				phase: "execution",
				event: "task_failed",
				status: "failed",
				taskId,
				attempt: `attempt-${taskId}`,
				result: causeCode,
				errorKind: causeCode,
				providerReliability: diagnostic,
			});
		}
		const genericResults = await ingestRouteHealthEvents({
			authorisedRuns: [
				{ runId: genericRun.runId, runRoot: genericRun.runRoot },
			],
			healthStateRoot,
		});
		deepStrictEqual(genericResults, []);
		strictEqual((await inspectRouteHealth(identity)).state, "healthy");
	});

	it("keeps default shadow failures runnable and releases a baseline-only claim", async () => {
		const descriptor = getInvocationDescriptor("codex", "standard");
		const healthStateRoot = join(HEALTH_ROOT, "shadow-and-baseline");
		const seeded = await seedVmQuotaCooldown({ healthStateRoot, descriptor });
		const clockNow = seeded.at + 1_000;
		const shadowDecision = defaultHealthDecision(
			healthStateRoot,
			() => clockNow,
		);
		strictEqual(shadowDecision.mode, "shadow");
		const shadowRun = await initializeHealthRun("task-shadow");
		const shadow = createSimpleRouteHealthController({
			healthDecision: shadowDecision,
			healthStateRoot,
			runId: shadowRun.runId,
			taskId: shadowRun.taskId,
			now: () => clockNow,
		});
		const input = simpleInput(descriptor);
		strictEqual((await shadow.prepare(input)).allowed, true);
		strictEqual((await shadow.start()).allowed, true);
		const genericExit = createProviderReliabilityDiagnostic({
			causeCode: "provider_exit_nonzero",
			phase: "provider",
			exitCode: 1,
		});
		const shadowTerminal = await shadow.terminal({
			providerResult: { success: false, code: 1 },
			providerReliability: genericExit,
			providerLifecycle: localLifecycle(1),
		});
		strictEqual(shadowTerminal.settled, true);
		strictEqual(
			(
				await inspectRouteHealth(
					healthIdentity(healthStateRoot, descriptor, seeded.epoch),
				)
			).state,
			"cooldown",
		);

		const baselineRun = await initializeHealthRun("task-baseline");
		const enforceDecision = createDefaultRouteHealthDecision({
			healthStateRoot,
			mode: "enforce",
			qualifiedProviders: GOLDEN_IMAGE_VERIFIED_PROVIDERS,
			goldenImageReference: SIMPLE_ROUTE_HEALTH_EPOCH,
			now: () => seeded.at + COOLDOWN_MS[0] + 1_000,
		});
		const context = {
			healthDecision: enforceDecision,
			runId: baselineRun.runId,
			healthAttempt: "attempt-baseline",
			workingContainerName: "fixture-vm",
		};
		const routeResult = {
			provider: "codex",
			resolved_harness: "codex",
			requiredCapability: "standard",
		};
		const allocated = withSystemClock(seeded.at + COOLDOWN_MS[0] + 1_000, () =>
			prepareRouteHealthTrial(
				context,
				{ id: baselineRun.taskId },
				routeResult,
				descriptor,
			),
		);
		strictEqual(
			allocated.allowed,
			true,
			JSON.stringify({
				allocated,
				decision: enforceDecision({
					provider: "codex",
					requiredCapability: "standard",
				}),
			}),
		);
		strictEqual(
			(
				await inspectRouteHealth(
					healthIdentity(healthStateRoot, descriptor, seeded.epoch),
				)
			).claimStatus,
			"allocated",
		);
		const baselineFailure = createProviderReliabilityDiagnostic({
			causeCode: "baseline_check_failed",
			phase: "baseline",
			baselineStatus: "failed",
			exitCode: 7,
		});
		attachRouteHealthTerminal(
			{ providerReliability: baselineFailure, providerLifecycle: null },
			context,
		);
		strictEqual(context._activeRouteHealth, null);
		await createEvent(baselineRun.runId, {
			phase: "execution",
			event: "task_failed",
			status: "failed",
			taskId: baselineRun.taskId,
			attempt: "attempt-baseline",
			result: baselineFailure.causeCode,
			providerReliability: baselineFailure,
		});
		const baselineResults = await ingestRouteHealthEvents({
			authorisedRuns: [
				{ runId: baselineRun.runId, runRoot: baselineRun.runRoot },
			],
			healthStateRoot,
		});
		deepStrictEqual(baselineResults, []);
		const released = await inspectRouteHealth(
			healthIdentity(healthStateRoot, descriptor, seeded.epoch, {
				nowMs: seeded.at + COOLDOWN_MS[0] + 1_000,
			}),
		);
		strictEqual(released.state, "cooldown");
		strictEqual(released.trialAvailable, true);
		strictEqual(released.claimStatus, null);
	});

	it("keeps an enforce lease fenced after unknown provider cleanup", async () => {
		const descriptor = getInvocationDescriptor("codex", "standard");
		const healthStateRoot = join(HEALTH_ROOT, "unknown-cleanup");
		const seeded = await seedVmQuotaCooldown({ healthStateRoot, descriptor });
		const run = await initializeHealthRun("task-unknown-cleanup");
		const controller = enforcingController({
			healthStateRoot,
			runId: run.runId,
			taskId: run.taskId,
			now: () => seeded.at + COOLDOWN_MS[0] + 1_000,
		});
		const input = simpleInput(descriptor);
		strictEqual((await controller.prepare(input)).allowed, true);
		strictEqual((await controller.start()).trial, true);
		const unknownCleanup = createProviderReliabilityDiagnostic({
			causeCode: "provider_cleanup_failed",
			phase: "cleanup",
		});
		const terminal = await controller.terminal({
			providerResult: { success: false, code: 1 },
			providerReliability: unknownCleanup,
			providerLifecycle: {
				...localLifecycle(1),
				cleanupStatus: "unknown",
				cleanupStage: "cleanup_started",
			},
		});
		strictEqual(terminal.settled, false);
		strictEqual(terminal.reason, "provider-terminal-unverified");
		strictEqual((await readAuthorizedRunEvents(run.runRoot)).length, 0);
		const retry = await controller.prepare(input);
		strictEqual(retry.allowed, false);
		strictEqual(retry.reason, "provider-invocation-unsettled");
		const health = await inspectRouteHealth(
			healthIdentity(healthStateRoot, descriptor, seeded.epoch),
		);
		strictEqual(health.state, "half-open");
		strictEqual(health.claimStatus, "started");
	});
});
