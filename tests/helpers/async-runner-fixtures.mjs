import { basename, dirname, join } from "node:path";
import { cwd, env } from "node:process";
import { fileURLToPath } from "node:url";
import { getInvocationDescriptorIdentity } from "../../src/switchyard/roster/index.mjs";
import { runQueueAsync as runQueueAsyncImpl } from "../../src/switchyard/runner/index.mjs";

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

// These runner fixtures predate the mandatory task-contract Executor: field.
// Normalize only the fixture text so the real parser receives an explicit
// field.
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

// Legacy per-method container-lifecycle stubs (ensureAgentContainer,
// createWorkingContainer, provisionCredentials, seedProject,
// commitWorkingTree, resetWorkingTree, wipeWorkingContainer) predate
// createQueueBackend's dependencies.backendFactory seam and are no longer
// read directly by production code -- only a backendFactory returning a
// full {create, destroy, seed, commit, reset, ...} object is honored.
// Synthesize a backendFactory from these flat keys here so tests written
// against the old shape keep exercising the same stub behavior. Call
// signatures mirror the real production call sites exactly:
// create(projectPath, {runId}), provision(name), seed(name, projectPath),
// commit(name), reset(name), destroy(name), ensureAgentContainer().
function legacyBackendFactory(dependencies) {
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

// Async-only twin of runner-fixtures' withTestDescriptorContext: the broker
// resolves roster identity and the dispatch descriptor from the latest route
// result instead of re-invoking route, so per-test route call counts stay
// exact on the async queue.
function withAsyncDescriptorContext(context) {
	let latestRouted = null;
	let latestDescriptor = null;
	const originalRoute = context.route;
	const route = (options) => {
		const routed = originalRoute(options);
		latestRouted = routed ?? null;
		latestDescriptor = descriptorForRoute(routed);
		if (
			!latestDescriptor ||
			!routed ||
			Object.hasOwn(routed, "invocationDescriptor")
		) {
			return routed;
		}
		return { ...routed, invocationDescriptor: latestDescriptor };
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
	const resolveTargetIdentity = (provider) => {
		const routed = latestRouted;
		if (!routed || routed.provider !== provider) {
			return { targetId: null, harnessKey: null, ambiguous: true };
		}
		const targetId =
			routed.resolvedTargetId ?? routed.resolvedTarget ?? routed.provider;
		const harnessKey = routed.resolved_harness ?? routed.harness ?? provider;
		return { targetId, harnessKey, ambiguous: false };
	};
	return {
		...context,
		adapters,
		route,
		resolveDescriptor: () => latestDescriptor,
		resolveTargetIdentity,
	};
}

export async function runQueueAsync(options) {
	const dependencies = options.dependencies ?? {};
	const context = withAsyncDescriptorContext(dependencies);
	return runQueueAsyncImpl({
		...options,
		platform: options.platform ?? "macos",
		dependencies: {
			...dependencies,
			route: context.route,
			resolveDescriptor: context.resolveDescriptor,
			resolveTargetIdentity: context.resolveTargetIdentity,
			adapters: context.adapters,
			queuePreflight:
				dependencies.queuePreflight ?? (() => ({ ok: true, eligible: true })),
			backendFactory:
				dependencies.backendFactory ?? legacyBackendFactory(dependencies),
		},
	});
}
