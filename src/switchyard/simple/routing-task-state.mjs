/** Exact-key task bindings that prevent renamed retries from forgetting run memory. */
import { join } from "node:path";
import { getStateRoot } from "../run-store/index.mjs";
import {
	canonicalRoutingProject,
	openRoutingRun,
	readRoutingRunState,
	validateRoutingRunId,
} from "./routing-state.mjs";
import {
	acquireRoutingFileLock,
	ensureSafeRoutingDirectories,
	readRoutingJsonFile,
	writeRoutingJsonAtomic,
} from "./routing-state-storage.mjs";
import { routingTaskIdentityHash } from "./routing-task-identity.mjs";

const STATUSES = new Set(["in_flight", "failed", "succeeded"]);
const fail = (code) => {
	throw Object.assign(new Error(code), { code });
};

function exact(value, keys) {
	return (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).sort().join() === [...keys].sort().join()
	);
}

function validateBinding(binding, { project, origin, identityHash }) {
	if (
		!exact(binding, [
			"schemaVersion",
			"canonicalProjectPath",
			"origin",
			"taskIdentityHash",
			"routingRunId",
			"status",
			"hadFailure",
		]) ||
		binding.schemaVersion !== 1 ||
		binding.canonicalProjectPath !== project ||
		binding.origin !== origin ||
		binding.taskIdentityHash !== identityHash ||
		!STATUSES.has(binding.status) ||
		typeof binding.hadFailure !== "boolean" ||
		(binding.status === "succeeded" && binding.hadFailure) ||
		(binding.status === "failed" && !binding.hadFailure)
	)
		fail("routing_task_binding_malformed");
	try {
		validateRoutingRunId(binding.routingRunId);
	} catch {
		fail("routing_task_binding_malformed");
	}
}

function readBinding(path, context) {
	try {
		return readRoutingJsonFile(path, {
			missingCode: "routing_task_binding_missing",
			malformedCode: "routing_task_binding_malformed",
			maxBytes: 4096,
			validate: (binding) => validateBinding(binding, context),
		});
	} catch (error) {
		if (error?.code === "routing_task_binding_missing") return null;
		throw error;
	}
}

function bindingRecord({
	project,
	origin,
	identityHash,
	routingRunId,
	status,
	hadFailure = status === "failed",
}) {
	return {
		schemaVersion: 1,
		canonicalProjectPath: project,
		origin,
		taskIdentityHash: identityHash,
		routingRunId,
		status,
		hadFailure,
	};
}

function runHasUncertainty(state) {
	return (
		state.pendingAttempt !== null ||
		state.nativeLatch ||
		state.attempts.some((attempt) => attempt.partialWorktree !== null)
	);
}

/** Lock, read, and bind one task identity before routing can allocate a provider. */
export function beginRoutingTaskBinding({
	project,
	origin,
	identityHash,
	routingRunId,
	stateRoot,
}) {
	project = canonicalRoutingProject(project);
	validateRoutingRunId(routingRunId);
	if (origin !== "work" && origin !== "qualification")
		fail("routing_task_binding_malformed");
	if (typeof identityHash !== "string" || !/^[a-f0-9]{64}$/u.test(identityHash))
		fail("routing_task_binding_malformed");
	const root = stateRoot ?? join(getStateRoot(), "routing-runs");
	const dir = join(root, "task-bindings", identityHash);
	ensureSafeRoutingDirectories(dir, true);
	const releaseLock = acquireRoutingFileLock(dir, {
		fileName: ".task-lock",
		contentionCode: "routing_task_identity_lock_contention",
		writeCode: "routing_task_binding_write_failed",
		identityCode: "routing_task_identity_lock_changed",
	});
	const context = { project, origin, identityHash };
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		releaseLock();
	};
	try {
		const path = join(dir, "binding.json");
		const prior = readBinding(path, context);
		if (prior && prior.routingRunId !== routingRunId) {
			let previousState;
			try {
				previousState = readRoutingRunState(project, prior.routingRunId, {
					stateRoot,
				});
			} catch {
				const error = new Error("routing_task_binding_source_unavailable");
				error.code = "routing_task_binding_source_unavailable";
				error.previousRoutingRunId = prior.routingRunId;
				throw error;
			}
			if (!previousState) {
				const error = new Error("routing_task_binding_source_unavailable");
				error.code = "routing_task_binding_source_unavailable";
				error.previousRoutingRunId = prior.routingRunId;
				throw error;
			}
			if (
				prior.status !== "succeeded" ||
				prior.hadFailure ||
				runHasUncertainty(previousState)
			) {
				release();
				return {
					linked: true,
					previousRoutingRunId: prior.routingRunId,
				};
			}
			const taskAttempts = previousState.attempts.filter(
				(attempt) => attempt.taskId === identityHash,
			);
			if (
				!taskAttempts.some((attempt) => attempt.terminal === "succeeded") ||
				taskAttempts.some((attempt) => attempt.terminal === "failed")
			) {
				fail("routing_task_binding_source_mismatch");
			}
		}
		let hadFailure = prior?.hadFailure === true || prior?.status === "failed";
		let published = false;
		let finished = false;
		const publish = () => {
			if (released || finished) fail("routing_task_binding_write_failed");
			if (published) return;
			published = true;
			const current = bindingRecord({
				project,
				origin,
				identityHash,
				routingRunId,
				status: "in_flight",
				hadFailure,
			});
			writeRoutingJsonAtomic(
				dir,
				"binding.json",
				current,
				"routing_task_binding_write_failed",
			);
		};
		return {
			linked: false,
			publish,
			finish(status) {
				if (released || finished || !STATUSES.has(status))
					fail("routing_task_binding_write_failed");
				finished = true;
				published = true;
				hadFailure ||= status === "failed";
				writeRoutingJsonAtomic(
					dir,
					"binding.json",
					bindingRecord({
						project,
						origin,
						identityHash,
						routingRunId,
						status: hadFailure ? "failed" : "succeeded",
						hadFailure,
					}),
					"routing_task_binding_write_failed",
				);
			},
			taskId: identityHash,
			release,
		};
	} catch (error) {
		release();
		throw error;
	}
}

function taskIdentityStopReason(error) {
	switch (error?.code) {
		case "routing_task_identity_lock_contention":
			return "task_identity_lock_contention";
		case "routing_task_identity_source_unavailable":
		case "invalid_task_id":
			return "task_identity_invalid";
		case "routing_task_binding_write_failed":
			return "task_identity_state_write_failed";
		case "routing_task_binding_source_mismatch":
		case "routing_task_binding_malformed":
		case "routing_unsafe_file":
		case "routing_unsafe_directory":
			return "task_identity_state_invalid";
		default:
			return "task_identity_state_unavailable";
	}
}

/** Prepare exact task binding and routing state before provider allocation. */
export function openRoutingTaskRun({
	options,
	project,
	origin,
	routingRunId,
	routingRunIdSource,
	stateRoot,
	now,
	openRun = openRoutingRun,
}) {
	let binding = null;
	try {
		const identityHash = routingTaskIdentityHash(options, project, origin);
		if (identityHash)
			binding = beginRoutingTaskBinding({
				project,
				origin,
				identityHash,
				routingRunId,
				stateRoot,
			});
	} catch (error) {
		const stopReason = taskIdentityStopReason(error);
		return {
			stop: {
				direction: "stop",
				origin,
				routingRunId,
				routingRunIdSource,
				attempts: [],
				failedTargetIds: [],
				retainedPartials: [],
				stopReason,
				...(error?.previousRoutingRunId
					? {
							previousRoutingRunId: error.previousRoutingRunId,
							result: {
								stopReason,
								previousRoutingRunId: error.previousRoutingRunId,
							},
						}
					: {}),
			},
		};
	}
	if (binding?.linked) {
		return {
			stop: {
				direction: "stop",
				origin,
				routingRunId,
				routingRunIdSource,
				attempts: [],
				failedTargetIds: [],
				retainedPartials: [],
				stopReason: "task_retry_linked_to_previous_run",
				previousRoutingRunId: binding.previousRoutingRunId,
				result: {
					stopReason: "task_retry_linked_to_previous_run",
					previousRoutingRunId: binding.previousRoutingRunId,
				},
			},
		};
	}
	let handle;
	try {
		handle = openRun(project, routingRunId, { stateRoot, now });
	} catch (error) {
		try {
			binding?.release();
		} catch {}
		throw error;
	}
	try {
		binding?.publish();
	} catch (error) {
		try {
			handle.release();
		} catch {}
		try {
			binding?.release();
		} catch {}
		throw error;
	}
	return { handle, binding };
}

export function finishTaskBinding(
	binding,
	handle,
	logicalTaskId,
	direction,
	extra,
) {
	let resultDirection = direction;
	let resultExtra = extra;
	try {
		const taskFailed = handle.state.attempts.some(
			(item) => item.taskId === logicalTaskId && item.terminal === "failed",
		);
		binding?.finish(
			direction === "complete" && !taskFailed ? "succeeded" : "failed",
		);
	} catch {
		resultDirection = "stop";
		resultExtra = {
			...extra,
			stopReason: "task_identity_state_write_failed",
		};
	}
	return { resultDirection, resultExtra };
}

function releaseTaskBinding(binding, settledAnswer) {
	if (!binding) return;
	try {
		binding.release();
	} catch (error) {
		if (!settledAnswer) throw error;
		return {
			...settledAnswer,
			direction: "stop",
			stopReason: "task_identity_state_release_failed",
			result: {
				...(settledAnswer.result ?? {}),
				stopReason: "task_identity_state_release_failed",
			},
		};
	}
}

/** Release both task-run locks and preserve the first cleanup or body error. */
export function releaseTaskRunResources(
	handle,
	{ taskBinding, settledAnswer, pendingError },
) {
	try {
		handle.release();
	} catch (error) {
		pendingError ??= { error };
	}
	let override;
	try {
		override = releaseTaskBinding(taskBinding, settledAnswer);
	} catch (error) {
		pendingError ??= { error };
	}
	if (pendingError) throw pendingError.error;
	return override;
}
