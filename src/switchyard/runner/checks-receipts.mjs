import { sha } from "./checks-sandbox.mjs";
export function isPassingQuickCheckReceipt(
	receipt,
	{ taskId, attempt, baseTree, diff, checks, setup = null },
) {
	return (
		receipt?.version === 1 &&
		receipt.status === "passed" &&
		Object.keys(receipt).sort().join(",") ===
			"attempt,baseTree,candidateTree,checks,cleanup,commandSetSha256,diffSha256,setup,status,taskId,version" &&
		Object.keys(receipt.cleanup ?? {}).join(",") === "status" &&
		receipt.cleanup?.status === "complete" &&
		receipt.taskId === taskId &&
		Number.isSafeInteger(attempt) &&
		attempt > 0 &&
		receipt.attempt === attempt &&
		/^[a-f0-9]{40,64}$/u.test(baseTree ?? "") &&
		receipt.baseTree === baseTree &&
		/^[a-f0-9]{40,64}$/u.test(receipt.candidateTree ?? "") &&
		/^[a-f0-9]{64}$/u.test(receipt.diffSha256 ?? "") &&
		(diff === undefined ||
			receipt.diffSha256 === sha(diff.endsWith("\n") ? diff : `${diff}\n`)) &&
		receipt.commandSetSha256 === sha(JSON.stringify({ setup, checks })) &&
		Array.isArray(receipt.checks) &&
		receipt.checks.length === checks.length &&
		receipt.checks.every(
			(item, index) =>
				Object.keys(item).sort().join(",") ===
					"commandSha256,exitCode,groupCleanup,index,signal,timedOut" &&
				item.index === index &&
				item.commandSha256 === sha(JSON.stringify(checks[index])) &&
				item.exitCode === 0 &&
				item.signal === null &&
				item.timedOut === false &&
				item.groupCleanup === "complete",
		) &&
		(setup === null
			? receipt.setup === null
			: Object.keys(receipt.setup ?? {})
					.sort()
					.join(",") ===
					"commandSha256,exitCode,groupCleanup,signal,timedOut" &&
				receipt.setup?.commandSha256 === sha(JSON.stringify(setup)) &&
				receipt.setup.exitCode === 0 &&
				receipt.setup.signal === null &&
				receipt.setup.timedOut === false &&
				receipt.setup.groupCleanup === "complete")
	);
}
export function enforceQuickCheckCompletion(task, result, attempt, checkpoint) {
	if (result.success !== true || (task.quickChecks?.checks?.length ?? 0) === 0)
		return;
	const integration = checkpoint.integrationIntents?.[task.id];
	const intent = integration?.operation;
	if (
		integration?.status === "completed" &&
		intent?.taskId === task.id &&
		intent.attempt === attempt &&
		intent.baseTree === checkpoint.taskBases?.[task.id]?.tree &&
		result.quickCheckReceipt?.diffSha256 === intent.patchHash &&
		isPassingQuickCheckReceipt(result.quickCheckReceipt, {
			taskId: task.id,
			attempt,
			baseTree: intent.baseTree,
			checks: task.quickChecks.checks,
			setup: task.quickChecks.setup,
		})
	)
		return;
	result.success = false;
	result.result = "check_failed";
	result.errorKind = "check_failed";
	result.reasonCode = "check_failed";
	result.reason = "Task check receipt missing or invalid.";
}
export function invalidCompletedQuickCheckTaskIds(tasks, checkpoint) {
	const invalid = [];
	for (const task of tasks) {
		if (
			!checkpoint.completedTaskIds?.includes(task.id) ||
			(task.quickChecks?.checks?.length ?? 0) === 0
		)
			continue;
		const entry = [...(checkpoint.results ?? [])]
			.reverse()
			.find((item) => item.taskId === task.id && item.success === true);
		const integration = checkpoint.integrationIntents?.[task.id];
		const intent = integration?.operation;
		if (
			!entry ||
			integration?.status !== "completed" ||
			!intent ||
			intent.taskId !== task.id ||
			intent.attempt !== entry.attempt ||
			entry.quickCheckReceipt?.diffSha256 !== intent.patchHash ||
			!isPassingQuickCheckReceipt(entry.quickCheckReceipt, {
				taskId: task.id,
				attempt: entry.attempt,
				baseTree: intent.baseTree,
				checks: task.quickChecks.checks,
				setup: task.quickChecks.setup,
			})
		)
			invalid.push(task.id);
	}
	return invalid;
}
