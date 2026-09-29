import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { sanitizeFailureMetadata } from "../adapter/exec-error.mjs";
import { validateDirtyOverlayReceipt } from "../lifecycle/index.mjs";
import { isValidCapabilityClass } from "../roster/classifier.mjs";
import { normalizeProviderName } from "../roster/index.mjs";
import { sleep } from "./checkpoint-errors.mjs";
import { TERMINAL_JOB_STATES } from "./constants.mjs";

function selectAdapter(harnessOrProvider, adapters) {
	const harness = normalizeProviderName(harnessOrProvider);
	if (!harness) return null;
	return adapters?.[harness] ?? null;
}
export function parseExpectedBy(status) {
	const raw = status?.expected_by ?? status?.expectedBy ?? null;
	if (!raw || typeof raw !== "string") return null;
	const epochMs = Date.parse(raw);
	return Number.isFinite(epochMs) ? epochMs : null;
}
export async function waitForJobCompletion(options) {
	const {
		jobId,
		orchestrator,
		pollIntervalMs = 10_000,
		maxPolls = 1_000,
		now = Date.now,
		sleepFn = sleep,
		onPoll = null,
	} = options;

	let polls = 0;
	let lastStatus = { state: "missing" };

	while (polls < maxPolls) {
		let status;
		try {
			// eslint-disable-next-line no-await-in-loop
			status = await orchestrator.status(jobId);
		} catch (error) {
			return {
				state: "status_error",
				status: { error: error?.message ?? "orchestrator status failed" },
				timedOut: false,
				polls: polls + 1,
			};
		}
		const state = String(status?.state ?? "missing");
		lastStatus = status ?? { state: "missing" };
		polls += 1;

		if (typeof onPoll === "function") {
			onPoll({ jobId, status: lastStatus, state, polls });
		}

		if (TERMINAL_JOB_STATES.has(state)) {
			return { state, status: lastStatus, timedOut: false, polls };
		}

		const expectedByMs = parseExpectedBy(status);
		if (expectedByMs !== null && now() > expectedByMs) {
			return { state: "timed_out", status: lastStatus, timedOut: true, polls };
		}

		// eslint-disable-next-line no-await-in-loop
		await sleepFn(pollIntervalMs);
	}

	return { state: "poll_limit", status: lastStatus, timedOut: true, polls };
}
function resolveTaskExecutor(task) {
	if (!Object.hasOwn(task, "executor")) return "switchyard";
	if (["native", "switchyard", "human"].includes(task.executor)) {
		return task.executor;
	}
	throw new Error(
		`Task ${task.id}: invalid Executor field "${task.executor}" (expected one of: native, switchyard, human)`,
	);
}
function resolveTaskRequiredCapability(task) {
	if (Object.hasOwn(task, "tier")) {
		throw new Error(
			`Task ${task.id}: Tier is a retired task-contract field; use requiredCapability instead (Tier is not an alias)`,
		);
	}
	if (task.requiredCapability != null) {
		if (!isValidCapabilityClass(task.requiredCapability)) {
			throw new Error(
				`Task ${task.id}: invalid declared RequiredCapability "${task.requiredCapability}" (expected one of: high, standard, low) — refusing to silently route at a fallback capability`,
			);
		}
		if (
			task.requiredCapability !== "standard" &&
			(typeof task.requiredCapabilityJustification !== "string" ||
				task.requiredCapabilityJustification.trim() === "")
		) {
			throw new Error(
				`Task ${task.id}: RequiredCapabilityJustification is required for explicit ${task.requiredCapability} capability tasks`,
			);
		}
		return task.requiredCapability;
	}
	return "standard";
}
function nonSwitchyardExecutorResult(task, executor, requiredCapability) {
	return {
		taskId: task.id,
		success: false,
		provider: null,
		model: null,
		requiredCapability,
		result: "executor_not_switchyard",
		...sanitizeFailureMetadata({
			taskId: task.id,
			result: "executor_not_switchyard",
		}),
		reason: `Task ${task.id} declares Executor: ${executor}; Switchyard does not route ${executor} tasks to a provider`,
	};
}
export function findIgnoredDeclaredPath(paths, projectPath = process.cwd()) {
	if (!paths) return null;
	const rawList = Array.isArray(paths)
		? paths
		: typeof paths === "string"
			? [paths]
			: null;
	if (!rawList) return null;
	const pathList = rawList
		.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
		.filter(Boolean);
	if (pathList.length === 0) return null;
	try {
		const workingDir =
			projectPath && existsSync(projectPath) ? projectPath : process.cwd();
		const result = spawnSync("git", ["check-ignore", "--", ...pathList], {
			cwd: workingDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.status === 0 && result.stdout) {
			const ignored = result.stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);
			return ignored[0] ?? null;
		}
		return null;
	} catch {
		return null;
	}
}
function declaredPathNotSeededResult(task, requiredCapability) {
	const failure = sanitizeFailureMetadata({
		taskId: task.id,
		result: "declared_path_not_seeded",
		errorKind: "declared_path_not_seeded",
	});
	return {
		taskId: task.id,
		success: false,
		provider: null,
		model: null,
		requiredCapability,
		result: "declared_path_not_seeded",
		...(failure ?? {}),
	};
}
function dirtyOverlayResult(task, context, requiredCapability) {
	if (!context.dirtyOverlayReceipt) return null;
	const checked = validateDirtyOverlayReceipt(
		context.projectPath,
		context.dirtyOverlayReceipt,
	);
	const receiptPaths = new Set(
		context.dirtyOverlayReceipt.paths?.map((entry) => entry.path) ?? [],
	);
	// An empty `requiredPaths` passes `.every()` vacuously, which would admit a
	// task that declared nothing into a workspace seeded with overlay bytes.
	// Every task in an overlay queue declares its own scope or is refused.
	const requiredPaths = task.requiredPaths ?? [];
	if (
		checked.ok &&
		requiredPaths.length > 0 &&
		requiredPaths.every((path) => receiptPaths.has(path))
	)
		return null;
	const reason = checked.ok ? "dirty_overlay_scope_mismatch" : checked.reason;
	context.onStatus?.({
		phase: "preflight",
		event: "dirty_overlay_rejected",
		status: "Dirty overlay rejected before provider allocation",
		taskId: task.id,
		reasonCode: reason,
	});
	return {
		taskId: task.id,
		success: false,
		provider: null,
		model: null,
		requiredCapability,
		result: "dirty_overlay_rejected",
		errorKind: "queue_contract",
		reasonCode: reason,
		dirtyOverlayReceiptHash: context.dirtyOverlayReceipt.receiptHash,
	};
}
function decorateDirtyOverlayResult(result, context) {
	if (context?.dirtyOverlayReceipt && result && typeof result === "object") {
		result.dirtyOverlayReceiptHash = context.dirtyOverlayReceipt.receiptHash;
	}
	return result;
}
function dirtyOverlayIntegrationGate(context) {
	if (!context.dirtyOverlayReceipt) return null;
	const checked = validateDirtyOverlayReceipt(
		context.projectPath,
		context.dirtyOverlayReceipt,
	);
	if (checked.ok) return null;
	context.onStatus?.({
		phase: "integration",
		event: "dirty_overlay_rejected",
		status: "Dirty overlay drifted before integration",
		reasonCode: checked.reason,
	});
	return {
		success: false,
		message: "Dirty overlay changed before integration",
		reason: "dirty_overlay_drift",
		reasonKind: "dirty_overlay_drift",
	};
}

export {
	declaredPathNotSeededResult,
	decorateDirtyOverlayResult,
	dirtyOverlayIntegrationGate,
	dirtyOverlayResult,
	nonSwitchyardExecutorResult,
	resolveTaskExecutor,
	resolveTaskRequiredCapability,
	selectAdapter,
};
