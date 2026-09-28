import { TASK_BASE_REF_PREFIX, ZERO_OBJECT_ID } from "./overlay-paths.mjs";
import {
	backendGit,
	backendGitAsync,
	emitTaskBaseRecovery,
	isParallelsLostResult,
	taskBaseComponent,
	taskBaseProbeOptions,
	taskBaseTree,
} from "./task-base-probe.mjs";
export function captureTaskStartTree(
	executionBackend,
	workspaceId,
	{ runId, taskId, ...inputOptions } = {},
) {
	if (!executionBackend || typeof executionBackend.execArgv !== "function") {
		throw new TypeError("execution backend does not support task-base capture");
	}
	const safeRunId = taskBaseComponent(runId, "runId");
	const safeTaskId = taskBaseComponent(taskId, "taskId");
	const options = taskBaseProbeOptions(inputOptions);
	backendGit(
		executionBackend,
		workspaceId,
		["add", "-A"],
		options,
		"task_base_stage",
		{ retryLostResult: true },
	);
	const tree = taskBaseTree(
		backendGit(
			executionBackend,
			workspaceId,
			["write-tree"],
			options,
			"task_base_write",
			{ retryLostResult: true },
		).trim(),
	);
	const ref = `${TASK_BASE_REF_PREFIX}/${safeRunId}/${safeTaskId}`;
	try {
		backendGit(
			executionBackend,
			workspaceId,
			["update-ref", ref, tree, ZERO_OBJECT_ID],
			options,
			"task_base_anchor",
		);
	} catch (error) {
		if (!isParallelsLostResult(error)) throw error;
		let observed = null;
		try {
			observed = taskBaseTree(
				backendGit(
					executionBackend,
					workspaceId,
					["rev-parse", "--verify", `${ref}^{tree}`],
					options,
					"task_base_anchor_reconcile",
					{ retryLostResult: true },
				).trim(),
			);
		} catch {
			// The lost result may mean update-ref never ran. An absent ref leaves
			// the original compare-and-swap safe to replay once.
		}
		if (observed === tree) {
			emitTaskBaseRecovery(options, "task_base_anchor", "reconcile");
			return { ref, tree };
		}
		if (observed !== null) throw error;
		try {
			backendGit(
				executionBackend,
				workspaceId,
				["update-ref", ref, tree, ZERO_OBJECT_ID],
				options,
				"task_base_anchor_replay",
			);
		} catch {
			try {
				observed = taskBaseTree(
					backendGit(
						executionBackend,
						workspaceId,
						["rev-parse", "--verify", `${ref}^{tree}`],
						options,
						"task_base_anchor_replay_reconcile",
						{ retryLostResult: true },
					).trim(),
				);
			} catch {
				throw error;
			}
			if (observed !== tree) throw error;
		}
		emitTaskBaseRecovery(options, "task_base_anchor", "replay");
	}
	return { ref, tree };
}
export async function captureTaskStartTreeAsync(
	executionBackend,
	workspaceId,
	{ runId, taskId, ...inputOptions } = {},
) {
	if (!executionBackend || typeof executionBackend.execArgv !== "function") {
		throw new TypeError("execution backend does not support task-base capture");
	}
	const safeRunId = taskBaseComponent(runId, "runId");
	const safeTaskId = taskBaseComponent(taskId, "taskId");
	const options = taskBaseProbeOptions(inputOptions);
	await backendGitAsync(
		executionBackend,
		workspaceId,
		["add", "-A"],
		options,
		"task_base_stage",
		{ retryLostResult: true },
	);
	const tree = taskBaseTree(
		(
			await backendGitAsync(
				executionBackend,
				workspaceId,
				["write-tree"],
				options,
				"task_base_write",
				{ retryLostResult: true },
			)
		).trim(),
	);
	const ref = `${TASK_BASE_REF_PREFIX}/${safeRunId}/${safeTaskId}`;
	try {
		await backendGitAsync(
			executionBackend,
			workspaceId,
			["update-ref", ref, tree, ZERO_OBJECT_ID],
			options,
			"task_base_anchor",
		);
	} catch (error) {
		if (!isParallelsLostResult(error)) throw error;
		let observed = null;
		try {
			observed = taskBaseTree(
				(
					await backendGitAsync(
						executionBackend,
						workspaceId,
						["rev-parse", "--verify", `${ref}^{tree}`],
						options,
						"task_base_anchor_reconcile",
						{ retryLostResult: true },
					)
				).trim(),
			);
		} catch {
			// The lost result may mean update-ref never ran. An absent ref leaves
			// the original compare-and-swap safe to replay once.
		}
		if (observed === tree) {
			emitTaskBaseRecovery(options, "task_base_anchor", "reconcile");
			return { ref, tree };
		}
		if (observed !== null) throw error;
		try {
			await backendGitAsync(
				executionBackend,
				workspaceId,
				["update-ref", ref, tree, ZERO_OBJECT_ID],
				options,
				"task_base_anchor_replay",
			);
		} catch {
			try {
				observed = taskBaseTree(
					(
						await backendGitAsync(
							executionBackend,
							workspaceId,
							["rev-parse", "--verify", `${ref}^{tree}`],
							options,
							"task_base_anchor_replay_reconcile",
							{ retryLostResult: true },
						)
					).trim(),
				);
			} catch {
				throw error;
			}
			if (observed !== tree) throw error;
		}
		emitTaskBaseRecovery(options, "task_base_anchor", "replay");
	}
	return { ref, tree };
}
export function validateTaskStartTree(
	executionBackend,
	workspaceId,
	{ ref, tree } = {},
	inputOptions = {},
) {
	const options = taskBaseProbeOptions(inputOptions);
	const expectedTree = taskBaseTree(tree);
	if (
		typeof ref !== "string" ||
		!new RegExp(
			`^${TASK_BASE_REF_PREFIX}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`,
			"u",
		).test(ref)
	) {
		throw new TypeError("task base ref must be in refs/switchyard/task-base");
	}
	// `rev-parse --verify` is a pure read, and every other idempotent task-base
	// probe already absorbs the Parallels 27.0.0 job misfire this way (see
	// `task_base_stage`, `task_base_write`, and both `_reconcile` probes). This
	// one was the omission, and it sits first in `releaseTaskStartTree` —
	// ahead of the try block that reconciles a lost `update-ref -d`. So a
	// misfire here aborted the release before any of that recovery could run,
	// stamped the base `taskBaseReleaseUncertain`, and reported
	// `task_base_release_transport_lost` for a release that was never attempted.
	// Measured on 2026-09-18: 2 of 12 canaries, against a documented ~3.3%
	// per-call serial misfire rate that a single retry clears.
	const actualTree = backendGit(
		executionBackend,
		workspaceId,
		["rev-parse", "--verify", `${ref}^{tree}`],
		options,
		"task_base_validate",
		{ retryLostResult: true },
	).trim();
	if (actualTree !== expectedTree) {
		throw new Error("task base ref does not match the recorded tree");
	}
	return { ref, tree: expectedTree };
}
export async function validateTaskStartTreeAsync(
	executionBackend,
	workspaceId,
	{ ref, tree } = {},
	inputOptions = {},
) {
	const expectedTree = taskBaseTree(tree);
	if (
		typeof ref !== "string" ||
		!new RegExp(
			`^${TASK_BASE_REF_PREFIX}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`,
			"u",
		).test(ref)
	)
		throw new TypeError("task base ref must be in refs/switchyard/task-base");
	const options = taskBaseProbeOptions(inputOptions);
	const actualTree = (
		await backendGitAsync(
			executionBackend,
			workspaceId,
			["rev-parse", "--verify", `${ref}^{tree}`],
			options,
			"task_base_validate",
			{ retryLostResult: true },
		)
	).trim();
	if (actualTree !== expectedTree)
		throw new Error("task base ref does not match the recorded tree");
	return { ref, tree: expectedTree };
}
function observeTaskStartTreeRef(
	executionBackend,
	workspaceId,
	ref,
	options,
	stage,
) {
	const observed = backendGit(
		executionBackend,
		workspaceId,
		["for-each-ref", "--format=%(objectname)", ref],
		options,
		stage,
		{ retryLostResult: true },
	).trim();
	return observed === "" ? null : taskBaseTree(observed);
}
async function observeTaskStartTreeRefAsync(
	executionBackend,
	workspaceId,
	ref,
	options,
	stage,
) {
	const observed = (
		await backendGitAsync(
			executionBackend,
			workspaceId,
			["for-each-ref", "--format=%(objectname)", ref],
			options,
			stage,
			{ retryLostResult: true },
		)
	).trim();
	return observed === "" ? null : taskBaseTree(observed);
}
export function releaseTaskStartTree(
	executionBackend,
	workspaceId,
	{ ref, tree } = {},
	inputOptions = {},
) {
	const options = taskBaseProbeOptions(inputOptions);
	const base = validateTaskStartTree(
		executionBackend,
		workspaceId,
		{
			ref,
			tree,
		},
		options,
	);
	try {
		backendGit(
			executionBackend,
			workspaceId,
			["update-ref", "-d", base.ref, base.tree],
			options,
			"task_base_release",
		);
	} catch (error) {
		if (!isParallelsLostResult(error)) throw error;
		const observed = observeTaskStartTreeRef(
			executionBackend,
			workspaceId,
			base.ref,
			options,
			"task_base_release_reconcile",
		);
		if (observed === null) {
			emitTaskBaseRecovery(options, "task_base_release", "reconcile");
			return;
		}
		if (observed !== base.tree) throw error;
		try {
			backendGit(
				executionBackend,
				workspaceId,
				["update-ref", "-d", base.ref, base.tree],
				options,
				"task_base_release_replay",
			);
		} catch (replayError) {
			if (!isParallelsLostResult(replayError)) throw replayError;
			const replayObserved = observeTaskStartTreeRef(
				executionBackend,
				workspaceId,
				base.ref,
				options,
				"task_base_release_replay_reconcile",
			);
			if (replayObserved !== null) throw error;
		}
		emitTaskBaseRecovery(options, "task_base_release", "replay");
	}
}
export async function releaseTaskStartTreeAsync(
	executionBackend,
	workspaceId,
	{ ref, tree } = {},
	inputOptions = {},
) {
	const options = taskBaseProbeOptions(inputOptions);
	const base = await validateTaskStartTreeAsync(
		executionBackend,
		workspaceId,
		{ ref, tree },
		options,
	);
	try {
		await backendGitAsync(
			executionBackend,
			workspaceId,
			["update-ref", "-d", base.ref, base.tree],
			options,
			"task_base_release",
		);
	} catch (error) {
		if (!isParallelsLostResult(error)) throw error;
		const observed = await observeTaskStartTreeRefAsync(
			executionBackend,
			workspaceId,
			base.ref,
			options,
			"task_base_release_reconcile",
		);
		if (observed === null) {
			emitTaskBaseRecovery(options, "task_base_release", "reconcile");
			return;
		}
		if (observed !== base.tree) throw error;
		try {
			await backendGitAsync(
				executionBackend,
				workspaceId,
				["update-ref", "-d", base.ref, base.tree],
				options,
				"task_base_release_replay",
			);
		} catch (replayError) {
			if (!isParallelsLostResult(replayError)) throw replayError;
			const replayObserved = await observeTaskStartTreeRefAsync(
				executionBackend,
				workspaceId,
				base.ref,
				options,
				"task_base_release_replay_reconcile",
			);
			if (replayObserved !== null) throw error;
		}
		emitTaskBaseRecovery(options, "task_base_release", "replay");
	}
}
