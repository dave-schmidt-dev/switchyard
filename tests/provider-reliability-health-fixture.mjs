import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import {
	__resetRosterCacheForTests,
	getInvocationDescriptor,
	resolveTargetIdentity,
	validateInvocationDescriptor,
} from "../src/switchyard/roster/index.mjs";
import {
	createDefaultRouteHealthDecision,
	createRouteHealthTerminalBinding,
	derivePublicConfigurationEpoch,
	ingestRouteHealthEvents,
} from "../src/switchyard/router/health.mjs";
import { GOLDEN_IMAGE_VERIFIED_PROVIDERS } from "../src/switchyard/router/index.mjs";
import {
	createRouteHealthEvent,
	getRunRoot,
	initializeRun,
	readAuthorizedRunEvents,
} from "../src/switchyard/run-store/index.mjs";
import {
	createSimpleRouteHealthController,
	SIMPLE_ROUTE_HEALTH_EPOCH,
} from "../src/switchyard/simple/health.mjs";
import { withDispatchQualifiedDescriptors } from "./helpers/router-fixtures.mjs";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "provider-health-test-"));
const RUN_STORE_ROOT = join(TEST_ROOT, "run-store");
export const HEALTH_ROOT = join(TEST_ROOT, "health");
const ROSTER_PATH = join(TEST_ROOT, "roster.json");
let previousRunStoreRoot;
let previousRosterPath;

export function setupHealthFixture() {
	previousRunStoreRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
	previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
	process.env.SWITCHYARD_RUN_STORE_ROOT = RUN_STORE_ROOT;
	process.env.SWITCHYARD_ROSTER_PATH = ROSTER_PATH;
	const roster = JSON.parse(
		readFileSync(resolve("tests/fixtures/roster.fixture.json"), "utf8"),
	);
	roster.targets["antigravity-claude"] = {
		...structuredClone(roster.targets.antigravity),
		snapshot_name: "Antigravity Claude fixture",
	};
	roster.targets["vibe-code"] = {
		...structuredClone(roster.targets.vibe),
		snapshot_name: "Vibe Code fixture",
	};
	writeFileSync(
		ROSTER_PATH,
		JSON.stringify(withDispatchQualifiedDescriptors(roster)),
		"utf8",
	);
	__resetRosterCacheForTests();
}

export function cleanupHealthFixture() {
	if (previousRunStoreRoot === undefined)
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRunStoreRoot;
	if (previousRosterPath === undefined)
		delete process.env.SWITCHYARD_ROSTER_PATH;
	else process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
	__resetRosterCacheForTests();
	rmSync(TEST_ROOT, { recursive: true, force: true });
}

export function descriptorFor(targetId) {
	if (targetId !== "vibe" && targetId !== "vibe-code") {
		const descriptor = getInvocationDescriptor(targetId, "standard");
		if (descriptor) return descriptor;
	}
	const target = resolveTargetIdentity(targetId);
	const fixtures = {
		vibe: ["vibe", "fixture/vibe-standard", "fixture-vibe-standard", null, []],
		"vibe-code": [
			"vibe",
			"fixture/vibe-code-standard",
			"fixture-vibe-code-standard",
			null,
			[],
		],
		"antigravity-claude": [
			"agy",
			"fixture/agy-standard",
			"fixture-agy-standard",
			null,
			[],
		],
	};
	const [harness, modelRef, selector, variant, invocationArgs] =
		fixtures[targetId] ?? [];
	if (!harness || target.targetId !== targetId) return null;
	return validateInvocationDescriptor(
		{
			target_id: targetId,
			model_ref: modelRef,
			selector,
			effort: null,
			variant,
			invocation_args: invocationArgs,
		},
		harness,
	);
}

export function fakeHealthDecision(
	descriptors,
	{ mode = "shadow", epoch, stateForCall } = {},
) {
	const configurationEpoch = epoch ?? `sha256:${"a".repeat(64)}`;
	let decisionCalls = 0;
	const byTarget = new Map(
		descriptors.map((descriptor) => [descriptor.target_id, descriptor]),
	);
	const decision = () => {
		decisionCalls += 1;
		const state = {
			available: true,
			state: "healthy",
			mode,
			suppress: false,
			repairEpoch: 0,
			initializable: true,
			trialAvailable: false,
		};
		return { ...state, ...(stateForCall?.(decisionCalls, state) ?? {}) };
	};
	Object.defineProperties(decision, {
		mode: { value: mode },
		publicConfigurationEpoch: { value: configurationEpoch },
		healthStateRoot: { value: HEALTH_ROOT },
		identityFor: {
			value: ({ provider }) => {
				const descriptor = byTarget.get(provider);
				return descriptor
					? {
							targetId: descriptor.target_id,
							descriptorIdentity: descriptor.descriptor_identity,
							publicConfigurationEpoch: configurationEpoch,
							repairEpoch: 0,
						}
					: null;
			},
		},
	});
	return decision;
}

export function routeHealthEpoch() {
	const qualified = GOLDEN_IMAGE_VERIFIED_PROVIDERS;
	return derivePublicConfigurationEpoch({
		approvedConfiguration: {
			rosterSchemaVersion: 1,
			approvedTargets: [
				...new Set(
					qualified.map((target) => resolveTargetIdentity(target).targetId),
				),
			],
			qualifiedProviders: [...qualified],
		},
		goldenImageReference: SIMPLE_ROUTE_HEALTH_EPOCH,
	});
}

export function defaultHealthDecision(healthStateRoot, now) {
	return createDefaultRouteHealthDecision({
		healthStateRoot,
		qualifiedProviders: GOLDEN_IMAGE_VERIFIED_PROVIDERS,
		goldenImageReference: SIMPLE_ROUTE_HEALTH_EPOCH,
		...(now ? { now } : {}),
	});
}

export function withSystemClock(at, operation) {
	const originalNow = Date.now;
	Date.now = () => at;
	try {
		return operation();
	} finally {
		Date.now = originalNow;
	}
}

export function localLifecycle(exitCode = 0) {
	return {
		schemaVersion: 1,
		terminalStatus: "exited",
		writerLifecycle: "stopped",
		cleanupStatus: "not_required",
		cleanupStage: null,
		exitCode,
		signal: null,
	};
}

export function vmLifecycle(exitCode = 1) {
	return {
		schemaVersion: 1,
		terminalStatus: "exited",
		writerLifecycle: "stopped",
		cleanupStatus: "succeeded",
		cleanupStage: "index_lock_removed",
		exitCode,
		signal: null,
	};
}

export async function initializeHealthRun(taskIds = ["task-health"]) {
	const orderedTaskIds = Array.isArray(taskIds) ? taskIds : [taskIds];
	const runId = `health-${randomUUID()}`;
	await initializeRun({
		runId,
		tasksFilePath: join(TEST_ROOT, `${runId}.md`),
		projectPath: join(TEST_ROOT, runId),
		orderedTaskIds,
		initialHostFingerprint: { git: "fixture", worktree: "clean" },
	});
	return {
		runId,
		taskId: orderedTaskIds[0],
		orderedTaskIds,
		runRoot: getRunRoot(runId),
	};
}

export async function seedVmQuotaCooldown({ healthStateRoot, descriptor }) {
	const run = await initializeHealthRun();
	const epoch = routeHealthEpoch();
	const diagnostic = createProviderReliabilityDiagnostic({
		causeCode: "quota_exhausted",
		phase: "provider",
		exitCode: 1,
	});
	const binding = createRouteHealthTerminalBinding({
		targetId: descriptor.target_id,
		descriptorIdentity: descriptor.descriptor_identity,
		invocationDescriptor: descriptor,
		descriptorHarness: resolveTargetIdentity(descriptor.target_id).harnessKey,
		publicConfigurationEpoch: epoch,
		repairEpoch: 0,
		runId: run.runId,
		taskId: run.taskId,
		attempt: "provider-seed",
		healthLane: "queue-vm",
		providerReliability: diagnostic,
		providerLifecycle: vmLifecycle(1),
		providerExecutionSucceeded: false,
		diagnosticCode: "quota_exhausted",
		diagnosticOrigin: "adapter",
		diagnosticEvidenceAvailable: true,
		failurePhase: "provider_execution",
		exitCode: 1,
		signal: null,
	});
	if (!binding) throw new Error("VM quota binding was not accepted");
	await createRouteHealthEvent(
		run.runId,
		{
			phase: "execution",
			event: "provider_attempt_terminal",
			status: "failed",
			taskId: run.taskId,
			attempt: "provider-seed",
			provider: "codex",
			model: descriptor.selector,
			resolvedTargetId: descriptor.target_id,
			descriptorHarness: "codex",
			descriptorIdentity: descriptor.descriptor_identity,
			invocationDescriptor: descriptor,
			providerReliability: diagnostic,
			diagnosticCode: "quota_exhausted",
			diagnosticOrigin: "adapter",
			diagnosticEvidenceAvailable: true,
			failurePhase: "provider_execution",
			exitCode: 1,
			signal: null,
		},
		binding,
	);
	const results = await ingestRouteHealthEvents({
		authorisedRuns: [{ runId: run.runId, runRoot: run.runRoot }],
		healthStateRoot,
	});
	const [event] = await readAuthorizedRunEvents(run.runRoot);
	return { run, epoch, results, at: Date.parse(event.timestamp), event };
}

export function healthIdentity(healthStateRoot, descriptor, epoch, extra = {}) {
	return {
		healthStateRoot,
		targetId: descriptor.target_id,
		descriptorIdentity: descriptor.descriptor_identity,
		publicConfigurationEpoch: epoch,
		repairEpoch: 0,
		...extra,
	};
}

export function simpleInput(descriptor) {
	return {
		provider: descriptor.target_id,
		targetId: descriptor.target_id,
		capability: "standard",
		descriptor,
	};
}

export function enforcingController(options) {
	return createSimpleRouteHealthController({
		healthMode: "enforce",
		...options,
	});
}
