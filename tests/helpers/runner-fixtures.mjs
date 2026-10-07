import { basename, dirname, join } from "node:path";
import { cwd, env } from "node:process";
import { fileURLToPath } from "node:url";
import {
	getInvocationDescriptorIdentity,
	validateInvocationDescriptor,
} from "../../src/switchyard/roster/index.mjs";
import { route as realRoute } from "../../src/switchyard/router/index.mjs";
import {
	executeTaskAsync as executeTaskAsyncImpl,
	executeTask as executeTaskImpl,
	parseTaskQueue,
	runQueueAsync as runQueueAsyncImpl,
	runQueue as runQueueImpl,
} from "../../src/switchyard/runner/index.mjs";

// Runner tests must not read the host roster: the check sandbox runs them
// under an isolated HOME with no ~/.agent/roster.json. The roster loads
// lazily, so pinning the env here (before any runner call) is sufficient.
env.SWITCHYARD_ROSTER_PATH ??= join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"roster.fixture.json",
);

export function runnerTestDir(url) {
	return join(cwd(), ".switchyard-runner-test", basename(fileURLToPath(url)));
}

export const TASK_BASE = {
	ref: "refs/switchyard/task-base/runner-tests/1.1",
	tree: "3".repeat(40),
};

// These older runner fixtures predate the mandatory task-contract Executor:
// field. Normalize only the fixture text so the real parser receives an
// explicit field; the missing-Executor rejection is tested directly below.
export function withExplicitSwitchyardExecutor(markdown) {
	const lines = markdown.split("\n");
	return lines
		.flatMap((line, index) => {
			if (!/^- \*\*Status:\*\*/.test(line)) return [line];
			const nextHeading = lines.findIndex(
				(candidate, candidateIndex) =>
					candidateIndex > index && /^### Task /.test(candidate),
			);
			const blockEnd = nextHeading === -1 ? lines.length : nextHeading;
			const hasExecutor = lines
				.slice(index + 1, blockEnd)
				.some((candidate) => /^- \*\*Executor:\*\*/.test(candidate));
			const hasQuickChecks = lines
				.slice(index + 1, blockEnd)
				.some((candidate) => /^- \*\*Quick checks:\*\*/.test(candidate));
			return [
				line,
				...(hasExecutor ? [] : ["- **Executor:** switchyard"]),
				...(hasQuickChecks ? [] : ["- **Quick checks:** none"]),
			];
		})
		.join("\n");
}

export function parseFixture(markdown) {
	return parseTaskQueue(withExplicitSwitchyardExecutor(markdown));
}

export function testDescriptor(overrides = {}) {
	const core = {
		target_id: "claude",
		model_ref: "claude-sonnet-5",
		selector: "claude-sonnet-5",
		effort: null,
		variant: null,
		invocation_args: [],
		...overrides,
	};
	return validateInvocationDescriptor(
		{
			...core,
			descriptor_identity: getInvocationDescriptorIdentity(core, "claude"),
		},
		"claude",
	);
}

export function descriptorForRoute(routeResult) {
	if (!routeResult?.provider) return null;
	const harness = routeResult.provider
		.replace(/^antigravity-claude$/, "agy")
		.replace(/^opencode-go$/, "opencode");
	const model = routeResult.model ?? "test-model";
	const core = {
		target_id: routeResult.resolvedTargetId ?? routeResult.provider,
		model_ref: model,
		selector: model,
		effort: null,
		variant: null,
		invocation_args: [],
	};
	return {
		...core,
		descriptor_identity: getInvocationDescriptorIdentity(core, harness),
	};
}

export function withTestDescriptorContext(context) {
	let latest = null;
	const originalRoute = context.route;
	const originalResolveDescriptor = context.resolveDescriptor;
	const route = (options) => {
		const routed = originalRoute(options);
		// Routed providers without a fixture adapter get an empty diff capture.
		if (routed?.provider && !adapters[routed.provider]) {
			adapters[routed.provider] = { captureDiffAsync: async () => "" };
		}
		latest = descriptorForRoute(routed);
		return latest && routed && !Object.hasOwn(routed, "invocationDescriptor")
			? { ...routed, invocationDescriptor: latest }
			: routed;
	};
	const adapters = Object.fromEntries(
		Object.entries(context.adapters ?? {}).map(([name, adapter]) => [
			name,
			{
				...adapter,
				captureDiffAsync: adapter.captureDiffAsync ?? (async () => ""),
			},
		]),
	);
	return {
		...context,
		adapters,
		queueBackend: context.queueBackend ?? {
			beforeRun: () => {},
			afterRun: () => {},
			captureTaskBase: () => TASK_BASE,
			validateTaskBase: (_workspaceId, base) => base,
			releaseTaskBase: () => {},
		},
		taskBases: context.taskBases ?? {},
		persistTaskBase: context.persistTaskBase ?? (() => {}),
		route,
		resolveDescriptor: (...args) =>
			latest ?? originalResolveDescriptor?.(...args) ?? null,
	};
}

export function executeTask(task, context) {
	return executeTaskImpl(task, withTestDescriptorContext(context));
}

export async function executeTaskAsync(task, context) {
	return executeTaskAsyncImpl(task, withTestDescriptorContext(context));
}

// Legacy per-method container-lifecycle stubs (ensureAgentContainer,
// createWorkingContainer, provisionCredentials, seedProject,
// commitWorkingTree, resetWorkingTree, wipeWorkingContainer) predate
// createQueueBackend's dependencies.backendFactory seam and are no longer
// read directly by production code -- only a backendFactory returning a
// full {create, destroy, seed, commit, reset, ...} object is honored (see
// runner/index.mjs's createQueueBackend, which falls through to the real
// ParallelsExecutionBackend when no backendFactory -- or an incomplete one
// -- is supplied). Synthesize a backendFactory from these flat keys here so
// the dozens of tests written against the old shape keep exercising the
// same stub behavior without a per-test rewrite. Call signatures mirror the
// real production call sites exactly: create(projectPath, {runId}),
// provision(name), seed(name, projectPath), commit(name), reset(name),
// destroy(name), ensureAgentContainer().
export function legacyBackendFactory(dependencies) {
	return () => ({
		executionBackend: dependencies.executionBackend,
		readiness: dependencies.hostReadiness ?? (() => ({ inventoryCount: 0 })),
		ensureAgentContainer: dependencies.ensureAgentContainer ?? (() => {}),
		create: dependencies.createWorkingContainer ?? (() => "test-container"),
		provision: dependencies.provisionCredentials ?? (() => null),
		seed: dependencies.seedProject ?? (() => {}),
		commit: dependencies.commitWorkingTree ?? (() => {}),
		reset: dependencies.resetWorkingTree ?? (() => {}),
		captureTaskBase: dependencies.captureTaskBase ?? (() => TASK_BASE),
		validateTaskBase:
			dependencies.validateTaskBase ?? ((_workspaceId, base) => base),
		releaseTaskBase: dependencies.releaseTaskBase ?? (() => {}),
		destroy: dependencies.wipeWorkingContainer ?? (() => {}),
	});
}

export function withTestDescriptorOptions(options) {
	const dependencies = options.dependencies ?? {};
	const context = withTestDescriptorContext({
		...dependencies,
		route: dependencies.route ?? realRoute,
	});
	const testIdentityResolver =
		dependencies.resolveTargetIdentity ??
		(dependencies.route
			? (provider) => {
					const routed = context.route({
						requiredCapability: "standard",
						availableProviders: Object.keys(context.adapters ?? {}),
					});
					if (routed?.provider !== provider) {
						return { targetId: null, harnessKey: null, ambiguous: true };
					}
					return {
						targetId: routed.resolvedTargetId ?? routed.resolvedTarget ?? null,
						harnessKey: routed.resolved_harness ?? routed.harness ?? provider,
						ambiguous: false,
					};
				}
			: undefined);
	return {
		...options,
		platform: options.platform ?? "macos",
		dependencies: {
			...dependencies,
			route: context.route,
			resolveDescriptor: context.resolveDescriptor,
			adapters: context.adapters,
			// macOS/Parallels is the sole execution backend now, so every
			// runQueue* call through this helper runs the real provider
			// preflight gate unless a test overrides it. The overwhelming
			// majority of these tests exercise dispatch/retry/ledger/
			// orchestration logic downstream of admission, not the gate
			// itself (that's covered directly in the "Task 6.1"/"Task 6.3"
			// describe blocks below, which call runQueueImpl or
			// preflightMacosQueue directly and so never pass through this
			// helper) -- so default preflight to a no-op here and let a
			// test that actually wants real gate behavior override
			// dependencies.queuePreflight explicitly.
			queuePreflight:
				dependencies.queuePreflight ?? (() => ({ ok: true, eligible: true })),
			backendFactory:
				dependencies.backendFactory ?? legacyBackendFactory(dependencies),
			...(testIdentityResolver
				? { resolveTargetIdentity: testIdentityResolver }
				: {}),
		},
	};
}

export function runQueue(options) {
	return runQueueImpl(withTestDescriptorOptions(options));
}

export async function runQueueAsync(options) {
	return runQueueAsyncImpl(withTestDescriptorOptions(options));
}

export function completionReceipt(options, overrides = {}) {
	return {
		version: 1,
		kind: "completion_continuation_lifecycle",
		providerExited: true,
		childrenExited: true,
		cleanupSucceeded: true,
		taskId: options.cleanupContext.taskId,
		attemptId: options.cleanupContext.attemptId,
		descriptorIdentity: options.cleanupContext.descriptorIdentity,
		workspaceId: options.cleanupContext.workspaceId,
		...overrides,
	};
}

export function macosBackend(
	events,
	{ failCreate = false, failDestroy = false } = {},
) {
	return {
		platform: "macos",
		preflight: () => events.push("preflight"),
		readiness: () => {
			events.push("readiness");
			return { inventoryCount: 0 };
		},
		acquireSlot: () => {
			events.push("acquire");
			return { token: "test-slot" };
		},
		releaseSlot: () => events.push("release"),
		ensureAgentContainer: () => events.push("ensure"),
		create: () => {
			events.push("create");
			if (failCreate) throw new Error("create failed");
			return "test-vm";
		},
		provision: () => events.push("provision"),
		seed: () => events.push("seed"),
		commit: () => {},
		reset: () => {},
		destroy: () => {
			events.push("destroy");
			if (failDestroy) {
				throw new Error("SECRET_CANARY synthetic backend teardown failure");
			}
		},
	};
}

export function productionQueueOptions(options) {
	const wrapped = withTestDescriptorOptions(options);
	const dependencies = { ...wrapped.dependencies };
	dependencies.route = options.dependencies.route;
	delete dependencies.resolveDescriptor;
	delete dependencies.resolveTargetIdentity;
	return { ...wrapped, dependencies };
}

export function codexHealthRoute() {
	return {
		provider: "codex",
		model: "fixture-codex-standard",
		resolvedTargetId: "codex",
		resolved_harness: "codex",
		requiredCapability: "standard",
		percentLeft: 50,
		reason: "fixture",
	};
}

export function authExpiredExecution() {
	return {
		success: false,
		errorKind: "auth_expired",
		diagnosticCode: "auth_expired",
		diagnosticOrigin: "adapter",
		diagnosticEvidenceAvailable: true,
		failurePhase: "provider_execution",
	};
}
