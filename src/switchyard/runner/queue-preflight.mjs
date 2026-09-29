import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { getConfiguredInvocationDescriptor } from "../roster/index.mjs";
import { preflightMacosQueue } from "../router/index.mjs";
import { DEFAULT_ADAPTERS } from "./halts.mjs";

export function runBackendGitCommand(executionBackend, workspaceId, script) {
	if (typeof executionBackend.execGuest === "function") {
		executionBackend.execGuest(workspaceId, "/bin/bash", ["-lc", script], {
			cwd: "/project",
		});
		return { status: 0 };
	}
	const execution = executionBackend.execArgv(workspaceId, {
		cwd: "/project",
		argv: ["/bin/bash", "-lc", `cd /project && ${script}`],
	});
	const result = spawnSync(execution.command, execution.args, {
		stdio: "pipe",
	});
	if (result.status !== 0) {
		throw new Error(
			`backend workspace command failed (${result.status ?? result.signal ?? "unknown"})`,
		);
	}
	return result;
}

export function formatQueuePreflightFailure(result) {
	const details = (result.rejections ?? []).map((rejection) => {
		const capability = rejection.capability ?? "unknown";
		// A selector-level rejection is not about any one capability tier, so the
		// excluded-provider list would be empty and misleading. Name the selector
		// instead: it is the only thing the operator can act on.
		if (rejection.selector) {
			return `${capability}: ${rejection.reason} (selector: ${rejection.selector}; use an exact target id)`;
		}
		const excluded = rejection.excludedProviders?.length
			? rejection.excludedProviders.join(", ")
			: "none";
		const providerReasons = Object.entries(rejection.excludedReasons ?? {})
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([provider, reason]) => `${provider}: ${reason}`);
		const reasonDetails = providerReasons.length
			? `; reasons: ${providerReasons.join(", ")}`
			: "";
		return `${capability}: ${rejection.reason} (excluded: ${excluded}${reasonDetails})`;
	});
	return `macOS queue provider preflight failed: ${details.join("; ") || result.reason}`;
}

export function sanitizeQueuePreflightDetail(result) {
	if (!result || typeof result !== "object" || Array.isArray(result))
		return null;
	const isPlainObject = (value) =>
		value !== null && typeof value === "object" && !Array.isArray(value);
	const boundedText = (value, limit = 160) =>
		typeof value === "string"
			? value.replace(/[\p{Cc}]/gu, " ").slice(0, limit)
			: null;
	return {
		reason: boundedText(result?.reason) ?? "unknown",
		rejections: (Array.isArray(result.rejections) ? result.rejections : [])
			.filter(isPlainObject)
			.slice(0, 8)
			.map((rejection) => ({
				capability: boundedText(rejection.capability, 80),
				reason: boundedText(rejection.reason, 160) ?? "unknown",
				...(rejection.selector
					? { selector: boundedText(rejection.selector, 160) }
					: {}),
				...(Array.isArray(rejection.excludedProviders) &&
				rejection.excludedProviders.length
					? {
							excludedProviders: rejection.excludedProviders
								.slice(0, 16)
								.map((provider) => boundedText(provider, 80))
								.filter(Boolean),
						}
					: {}),
				...(isPlainObject(rejection.excludedReasons)
					? {
							excludedReasons: Object.entries(rejection.excludedReasons)
								.slice(0, 16)
								.reduce((reasons, [provider, reason]) => {
									const safeProvider = boundedText(provider, 80);
									const safeReason = boundedText(reason, 160);
									if (safeProvider && safeReason)
										reasons[safeProvider] = safeReason;
									return reasons;
								}, {}),
						}
					: {}),
			})),
	};
}

export function queuePreflightDetail(result) {
	return sanitizeQueuePreflightDetail(result);
}

export class QueuePreflightError extends Error {
	constructor(message, detail = null) {
		super(message);
		this.name = "QueuePreflightError";
		this.preflightDetail = sanitizeQueuePreflightDetail(detail);
	}
}

export function createDefaultQueuePreflight({
	selectedPlatform,
	dependencies,
}) {
	if (selectedPlatform !== "macos") return () => ({ ok: true, eligible: true });

	const adapters = dependencies.adapters ?? DEFAULT_ADAPTERS;
	return (input = {}) => {
		const result = preflightMacosQueue({
			...input,
			platform: selectedPlatform,
			availableProviders: Object.keys(adapters),
			...(Object.hasOwn(dependencies, "goldenImageVerifiedProviders")
				? {
						goldenImageVerifiedProviders:
							dependencies.goldenImageVerifiedProviders,
					}
				: {}),
			...(dependencies.preflightReadSnapshot
				? { readSnapshot: dependencies.preflightReadSnapshot }
				: {}),
			...(dependencies.healthDecision
				? { healthDecision: dependencies.healthDecision }
				: {}),
			...(dependencies.onHealthDecision
				? { onHealthDecision: dependencies.onHealthDecision }
				: {}),
			...(dependencies.qualificationAttempt === true
				? { hasInvocationDescriptor: getConfiguredInvocationDescriptor }
				: {}),
		});
		if (!result.ok)
			throw new QueuePreflightError(
				formatQueuePreflightFailure(result),
				queuePreflightDetail(result),
			);
		return result;
	};
}

export function createQueueBootstrapStatusEmitter(onStatus) {
	if (typeof onStatus !== "function") return undefined;
	return (event) => {
		if (event?.type === "aqua-wait") {
			onStatus({
				phase: "bootstrap",
				event: "aqua_wait",
				status: "Waiting for Aqua session to become ready",
				...(event.uuid !== undefined ? { uuid: event.uuid } : {}),
				...(event.domain !== undefined ? { domain: event.domain } : {}),
				...(event.elapsedMs !== undefined
					? { elapsedMs: event.elapsedMs }
					: {}),
			});
			return;
		}
		if (event?.type === "aqua-ready") {
			onStatus({
				phase: "bootstrap",
				event: "aqua_ready",
				status: "Aqua session ready",
				...(event.uuid !== undefined ? { uuid: event.uuid } : {}),
				...(event.domain !== undefined ? { domain: event.domain } : {}),
			});
			return;
		}
		if (event?.type === "host-readiness") {
			onStatus({
				phase: "bootstrap",
				event: event.event,
				status: event.status,
				...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
				...(event.elapsedMs !== undefined
					? { elapsedMs: event.elapsedMs }
					: {}),
				...(event.delayMs !== undefined ? { delayMs: event.delayMs } : {}),
				...(event.inventoryCount !== undefined
					? { inventoryCount: event.inventoryCount }
					: {}),
			});
			return;
		}
		// Preserve any future backend lifecycle events rather than dropping
		// visibility when the backend grows its status vocabulary.
		onStatus(event);
	};
}

export function queueOwnershipContext({
	projectPath,
	runId,
	taskId = "queue-bootstrap",
	attemptId = "bootstrap",
	purpose = "dispatch",
	processStartIdentity = null,
}) {
	const runStoreRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
	if (!runStoreRoot) {
		throw new Error(
			"macos queue requires SWITCHYARD_RUN_STORE_ROOT for VM ownership metadata",
		);
	}
	if (typeof runId !== "string" || !runId) {
		throw new Error("macos queue requires a runId for VM ownership metadata");
	}
	return {
		resourceRoot: join(resolve(runStoreRoot), "runs", runId, "resources"),
		runId,
		taskId,
		attemptId,
		projectRoot: resolve(projectPath),
		creatorPid: process.pid,
		processStartIdentity,
		purpose,
	};
}
