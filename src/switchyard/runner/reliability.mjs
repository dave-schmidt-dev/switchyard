import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PERSISTED_SIGNALS } from "../adapter/exec-error-kinds.mjs";
import { createProviderReliabilityDiagnostic } from "../diagnostics/provider-reliability.mjs";
import { quickCheckSandboxProfile, safeEnv } from "./checks-sandbox.mjs";

const SELF = fileURLToPath(new URL("./checks.mjs", import.meta.url));
const DIAGNOSTIC_CODES = new Set([
	"acceptance_check_failed",
	"acceptance_check_timeout",
	"baseline_check_failed",
	"baseline_mutation",
	"check_repair_failed",
	"check_repair_succeeded",
	"unknown",
]);
const WORKER_GROUP_CLEANUP = new Set(["complete", "unknown"]);
const WORKER_RESULT_KEYS = "exitCode,groupCleanup,signal,timedOut";

function unknownCommandResult(timedOut = false) {
	return {
		exitCode: null,
		signal: null,
		timedOut,
		groupCleanup: "unknown",
	};
}

function closedWorkerResult(value) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(",") !== WORKER_RESULT_KEYS
	)
		return null;
	if (
		(value.exitCode !== null &&
			(!Number.isSafeInteger(value.exitCode) ||
				value.exitCode < 0 ||
				value.exitCode > 255)) ||
		(value.signal !== null && !PERSISTED_SIGNALS.has(value.signal)) ||
		(value.exitCode !== null && value.signal !== null) ||
		typeof value.timedOut !== "boolean" ||
		!WORKER_GROUP_CLEANUP.has(value.groupCleanup)
	)
		return null;
	return {
		exitCode: value.exitCode,
		signal: value.signal,
		timedOut: value.timedOut,
		groupCleanup: value.groupCleanup,
	};
}

export function runCommand(
	cwd,
	env,
	argv,
	timeoutMs,
	{ sandbox = true, spawnSync: runSpawnSync = spawnSync } = {},
) {
	if (process.platform !== "darwin" && runSpawnSync === spawnSync)
		return unknownCommandResult();
	let result;
	try {
		result = runSpawnSync(
			process.execPath,
			[
				SELF,
				"--quick-check-worker",
				JSON.stringify({
					cwd,
					argv,
					timeoutMs,
					sandbox,
					profile: sandbox ? quickCheckSandboxProfile(cwd, env.HOME) : null,
				}),
			],
			{
				cwd,
				env,
				encoding: "utf8",
				timeout: timeoutMs + 10_000,
				maxBuffer: 1024,
				stdio: ["ignore", "pipe", "inherit"],
			},
		);
	} catch {
		return unknownCommandResult();
	}
	if (result?.error?.code === "ETIMEDOUT") return unknownCommandResult(true);
	if (result?.error || result?.status !== 0) return unknownCommandResult();
	try {
		const parsed = JSON.parse(result.stdout);
		const closed = closedWorkerResult(parsed);
		if (closed) return closed;
	} catch {
		/* closed unknown receipt */
	}
	return unknownCommandResult();
}

export function settleScopedChecksSync(root, launchedAt) {
	const result = spawnSync(
		process.execPath,
		[SELF, "--quick-check-settle", JSON.stringify({ root, launchedAt })],
		{
			env: safeEnv(root),
			encoding: "utf8",
			timeout: 12_000,
			maxBuffer: 64,
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	return result.status === 0 && result.stdout === "stopped";
}

export function gateCandidate(
	cwd,
	env,
	diff,
	allowedPaths,
	allowSensitiveManifests,
) {
	const result = spawnSync(process.execPath, [SELF, "--quick-check-gate"], {
		cwd,
		env,
		input: JSON.stringify({ diff, allowedPaths, allowSensitiveManifests }),
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 1024,
		stdio: ["pipe", "pipe", "ignore"],
	});
	return result.status === 0 && result.stdout === "passed";
}

function checkIdentity(argv) {
	return createHash("sha256").update(JSON.stringify(argv)).digest("hex");
}

function firstCheckFailure(receipt) {
	if (!Array.isArray(receipt?.checks)) return null;
	const check = receipt.checks.find(
		(item) =>
			item.exitCode !== 0 ||
			item.signal !== null ||
			item.timedOut === true ||
			item.groupCleanup !== "complete",
	);
	if (!check) return null;
	return {
		index: check.index + 1,
		identity: /^[a-f0-9]{64}$/u.test(check.commandSha256 ?? "")
			? check.commandSha256
			: null,
		exitCode: Number.isSafeInteger(check.exitCode) ? check.exitCode : null,
		signal: typeof check.signal === "string" ? check.signal : null,
		timedOut: check.timedOut === true,
		writerStopped: check.groupCleanup === "complete",
	};
}

export function acceptanceCheckDiagnostic(task, receipt, repairStatus = null) {
	const failed = firstCheckFailure(receipt);
	const exactFailedCheck = failed
		? task.quickChecks?.checks?.[failed.index - 1]
		: null;
	const eligible =
		receipt?.status === "failed" &&
		receipt?.cleanup?.status === "complete" &&
		failed?.writerStopped === true &&
		Array.isArray(task.quickChecks?.repairChecks) &&
		task.quickChecks.repairChecks.some(
			(argv) => JSON.stringify(argv) === JSON.stringify(exactFailedCheck),
		);
	const causeCode =
		receipt?.status === "failed" && failed
			? failed.timedOut
				? "acceptance_check_timeout"
				: "acceptance_check_failed"
			: "unknown";
	const input = {
		causeCode,
		phase: "check",
		exitCode: failed?.exitCode,
		signal: failed?.signal,
		timedOut: failed?.timedOut,
		checkIndex: failed?.index ?? null,
		checkIdentity: failed?.identity ?? null,
		repairCount: 0,
		repairStatus:
			repairStatus ??
			(task.quickChecks?.repairChecks?.length
				? "not_started"
				: "not_requested"),
	};
	return {
		failed,
		eligible,
		causeCode,
		diagnostic: createProviderReliabilityDiagnostic(input),
	};
}

function baselineCheckOutcome(_task, receipt) {
	const failed = firstCheckFailure(receipt);
	const mutation = receipt?.failureCode === "baseline_mutation";
	const passed =
		receipt?.status === "passed" && receipt?.cleanup?.status === "complete";
	const causeCode = passed
		? "unknown"
		: mutation
			? "baseline_mutation"
			: "baseline_check_failed";
	return {
		passed,
		mutation,
		failed,
		baselineStatus: passed
			? "passed"
			: mutation
				? "mutation_detected"
				: receipt?.status === "unknown" ||
						receipt?.cleanup?.status !== "complete"
					? "unknown"
					: "failed",
		diagnostic: createProviderReliabilityDiagnostic({
			causeCode,
			phase: "baseline",
			exitCode: failed?.exitCode,
			signal: failed?.signal,
			timedOut: failed?.timedOut,
			checkIndex: failed?.index,
			checkIdentity: failed?.identity,
			baselineStatus: passed
				? "passed"
				: mutation
					? "mutation_detected"
					: receipt?.status === "unknown" ||
							receipt?.cleanup?.status !== "complete"
						? "unknown"
						: "failed",
		}),
	};
}

function baselineCheckReceipt(receipt, checks, baseTree, taskId, attempt) {
	if (!receipt) return null;
	return {
		version: 1,
		taskId,
		attempt,
		baseTree: /^[a-f0-9]{40,64}$/u.test(baseTree ?? "") ? baseTree : null,
		commandSetSha256: /^[a-f0-9]{64}$/u.test(receipt.commandSetSha256 ?? "")
			? receipt.commandSetSha256
			: null,
		candidateTree: /^[a-f0-9]{40,64}$/u.test(receipt.candidateTree ?? "")
			? receipt.candidateTree
			: null,
		checks: (receipt.checks ?? [])
			.slice(0, checks.length)
			.map((check, index) => ({
				index,
				commandSha256: checkIdentity(checks[index]),
				exitCode: Number.isSafeInteger(check.exitCode) ? check.exitCode : null,
				signal: typeof check.signal === "string" ? check.signal : null,
				timedOut: check.timedOut === true,
				writerStopped: check.groupCleanup === "complete",
			})),
		status: ["passed", "failed", "unknown"].includes(receipt.status)
			? receipt.status
			: "unknown",
		cleanup: receipt.cleanup?.status === "complete" ? "complete" : "unknown",
	};
}

function baselineSnapshotPaths(context) {
	const paths = new Set(
		(context.dirtyOverlayReceipt?.paths ?? []).map((entry) => entry.path),
	);
	for (const [taskId, intent] of Object.entries(
		context.checkpoint?.integrationIntents ?? {},
	)) {
		if (
			intent?.status !== "completed" ||
			!context.checkpoint.completedTaskIds?.includes(taskId) ||
			!context.checkpoint.results?.some(
				(entry) => entry.taskId === taskId && entry.success === true,
			)
		)
			continue;
		for (const path of intent.operation?.paths ?? []) paths.add(path);
	}
	return [...paths];
}

function baselineInput(task, context) {
	const checks = task.quickChecks?.baselineChecks ?? [];
	if (checks.length === 0) return null;
	const baseTree = context._activeTaskBase?.tree ?? null;
	const attempt = (context.checkpoint?.taskAttempts?.[task.id] ?? 0) + 1;
	return {
		projectPath: context.projectPath,
		taskId: task.id,
		attempt,
		baseTree,
		diff: null,
		checks,
		setup: null,
		baseline: true,
		onStatus: context.onStatus,
		snapshotPaths: baselineSnapshotPaths(context),
	};
}

export function runTaskBaselineChecks(task, context, runChecks) {
	const input = baselineInput(task, context);
	if (!input) return null;
	let receipt = null;
	try {
		receipt = runChecks(input);
	} catch {
		// The closed unknown result prevents provider invocation.
	}
	const outcome = baselineCheckOutcome(task, receipt);
	return {
		...outcome,
		receipt: baselineCheckReceipt(
			receipt,
			input.checks,
			input.baseTree,
			task.id,
			input.attempt,
		),
	};
}

export async function runTaskBaselineChecksAsync(task, context, runChecks) {
	const input = baselineInput(task, context);
	if (!input) return null;
	let receipt = null;
	try {
		receipt = await runChecks(input);
	} catch {
		// The closed unknown result prevents provider invocation.
	}
	const outcome = baselineCheckOutcome(task, receipt);
	return {
		...outcome,
		receipt: baselineCheckReceipt(
			receipt,
			input.checks,
			input.baseTree,
			task.id,
			input.attempt,
		),
	};
}

export function taskRepairScopeIdentity(task) {
	const scope = {
		type: task.type ?? "implementation",
		requiredPaths: Array.isArray(task.requiredPaths)
			? [...task.requiredPaths]
			: (task.requiredPaths ?? null),
		allowManifests: task.allowManifests === true,
		checks: task.quickChecks?.checks ?? [],
		setup: task.quickChecks?.setup ?? null,
		repairChecks: task.quickChecks?.repairChecks ?? [],
	};
	return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

export function createTaskProviderPin(
	task,
	context,
	route,
	invocationDescriptor,
	attemptId,
	deadline,
) {
	return {
		taskId: task.id,
		route: structuredClone(route),
		invocationDescriptor: structuredClone(invocationDescriptor),
		provider: route.provider,
		resolvedTargetId: route.resolvedTargetId ?? null,
		selector: invocationDescriptor.selector,
		descriptorIdentity: invocationDescriptor.descriptor_identity,
		workspaceId: context.workingContainerName,
		baseTree: context._activeTaskBase?.tree ?? null,
		attemptId,
		deadline,
		scopeIdentity: taskRepairScopeIdentity(task),
	};
}

export function checkRepairCandidate(task, result) {
	if (
		result?.result !== "check_failed" ||
		result.providerLifecycle?.writerLifecycle !== "stopped" ||
		!["exited", "terminated"].includes(
			result.providerLifecycle?.terminalStatus,
		) ||
		!["complete", "not_required"].includes(
			result.providerLifecycle?.cleanupStatus,
		) ||
		!Array.isArray(task.quickChecks?.repairChecks) ||
		task.quickChecks.repairChecks.length === 0
	)
		return null;
	const decision = acceptanceCheckDiagnostic(task, result.quickCheckReceipt);
	if (!decision.eligible || !decision.failed?.identity) return null;
	return {
		index: decision.failed.index,
		identity: decision.failed.identity,
		causeCode: decision.causeCode,
		exitCode: decision.failed.exitCode,
		signal: decision.failed.signal,
		timedOut: decision.failed.timedOut,
	};
}

export function checkRepairFeedback(task, feedback) {
	if (
		!feedback ||
		!Number.isSafeInteger(feedback.index) ||
		feedback.index < 1 ||
		!DIAGNOSTIC_CODES.has(feedback.causeCode) ||
		!/^([a-f0-9]{64})$/u.test(feedback.identity ?? "")
	)
		return null;
	return {
		...task,
		prompt: `${task.prompt || task.description || task.title}\n\nA declared acceptance check failed: check ${feedback.index} (${feedback.causeCode}). Fix the task and rerun all declared Quick checks.`,
	};
}

export function repairDiagnostic(feedback, status) {
	const passed = status === "passed";
	return createProviderReliabilityDiagnostic({
		causeCode: passed ? "check_repair_succeeded" : "check_repair_failed",
		phase: "repair",
		checkIndex: feedback?.index,
		checkIdentity: feedback?.identity,
		repairCount: 1,
		repairStatus: passed ? "passed" : "failed",
	});
}

export function providerRepairLifecycleSafe(task, context, pin) {
	const intents = context.checkpoint?.integrationIntents;
	const checkpointBase = context.checkpoint?.taskBases?.[task.id];
	const cleanupContext = checkpointBase?.cleanupContext;
	return (
		context.ownsWorkingContainer === true &&
		context.checkpoint !== null &&
		typeof context.checkpoint === "object" &&
		context.checkpoint.ownershipReleased === false &&
		context.checkpoint.owner?.runId === context.runId &&
		intents !== null &&
		typeof intents === "object" &&
		!Array.isArray(intents) &&
		checkpointBase?.tree === pin?.baseTree &&
		cleanupContext?.taskId === task.id &&
		cleanupContext?.attemptId === pin?.attemptId &&
		cleanupContext?.workspaceId === pin?.workspaceId &&
		cleanupContext?.descriptorIdentity === pin?.descriptorIdentity &&
		pin?.taskId === task.id &&
		pin.workspaceId === context.workingContainerName &&
		pin.baseTree === context._activeTaskBase?.tree &&
		pin.provider === pin.route?.provider &&
		pin.resolvedTargetId === pin.route?.resolvedTargetId &&
		pin.selector === pin.invocationDescriptor?.selector &&
		pin.descriptorIdentity === pin.invocationDescriptor?.descriptor_identity &&
		pin.scopeIdentity === taskRepairScopeIdentity(task) &&
		!Object.hasOwn(intents, task.id)
	);
}
