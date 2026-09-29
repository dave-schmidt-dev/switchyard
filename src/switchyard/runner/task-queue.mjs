import { readFileSync } from "node:fs";
import { parseQuickChecks } from "./checks.mjs";
import { createQueueIdentity } from "./constants.mjs";
import {
	hasTaskField,
	parseBlockedByField,
	parseExecutorField,
	parseExternalBlockersField,
	parseFilePaths,
	parseRequiredCapabilityField,
	parseRequiredCapabilityJustificationField,
	parseTimeoutField,
	parseTypeField,
} from "./task-fields.mjs";
export function computeQueueIdentityFromFile(
	tasksFilePath,
	projectRevision,
	runOptions,
) {
	const markdown = readFileSync(tasksFilePath, "utf8");
	const tasks = parseTaskQueue(markdown);
	return {
		markdown,
		tasks,
		queueIdentity: createQueueIdentity({
			tasksFilePath,
			markdown,
			tasks,
			projectRevision,
			runOptions,
		}),
	};
}
export function parseTaskQueue(markdown) {
	const tasks = [];
	const taskBlockRegex =
		/### Task ([0-9.]+):\s*(.+)\n([\s\S]*?)(?=\n### Task [0-9.]+:|\n## |\n---|$)/g;

	for (const match of markdown.matchAll(taskBlockRegex)) {
		const [, id, title, block] = match;
		const statusMatch = block.match(/- \*\*Status:\*\*\s*(.+)/i);
		const descriptionMatch = block.match(
			/- \*\*(?:Description|Work|Details|Overview):\*\*\s*([\s\S]*?)(?=\n- \*\*|$)/i,
		);

		const rawDesc =
			descriptionMatch?.[1] ?? block.replace(/- \*\*Status:\*\*\s*.*/gi, "");
		const fullPrompt = `### Task ${id.trim()}: ${title.trim()}\n${block.trim()}`;
		const taskId = id.trim();

		if (hasTaskField(block, "Tier")) {
			throw new Error(
				`Task ${taskId}: Tier is a retired task-contract field; use RequiredCapability instead (Tier is not an alias)`,
			);
		}

		let requiredPaths = null;
		const filesLine = block
			.split("\n")
			.find((line) => /^- \*\*Files:\*\*\s/.test(line));
		if (filesLine) {
			const filesValue = filesLine.replace(/^- \*\*Files:\*\*\s*/, "").trim();
			requiredPaths = parseFilePaths(filesValue, taskId);
		}

		let timeoutMs = null;
		const timeoutLine = block
			.split("\n")
			.find((line) => /^- \*\*Timeout:\*\*\s/.test(line));
		if (timeoutLine) {
			const timeoutValue = timeoutLine
				.replace(/^- \*\*Timeout:\*\*\s*/, "")
				.trim();
			timeoutMs = parseTimeoutField(timeoutValue, taskId);
		}

		const requiredCapability = parseRequiredCapabilityField(block, taskId);
		const requiredCapabilityJustification =
			parseRequiredCapabilityJustificationField(block, taskId);
		if (
			requiredCapability &&
			requiredCapability !== "standard" &&
			requiredCapabilityJustification === null
		) {
			throw new Error(
				`Task ${taskId}: RequiredCapabilityJustification is required for explicit ${requiredCapability} capability tasks`,
			);
		}
		const executor = parseExecutorField(block, taskId);
		const blockedBy = parseBlockedByField(block, taskId);
		const externalBlockers = parseExternalBlockersField(block, taskId);

		let type = "implementation";
		const typeLine = block
			.split("\n")
			.find((line) => /^- \*\*Type:\*\*\s/.test(line));
		if (typeLine) {
			const typeValue = typeLine.replace(/^- \*\*Type:\*\*\s*/, "").trim();
			type = parseTypeField(typeValue, taskId);
		}

		if (
			executor === "switchyard" &&
			type === "implementation" &&
			requiredPaths === null
		) {
			throw new Error(
				`Task ${taskId}: switchyard implementation task requires a Files: field (declare project-relative paths)`,
			);
		}
		const quickChecks = parseQuickChecks(block, taskId, type, executor);

		const allowManifestsLines = block
			.split("\n")
			.filter((line) => /^- \*\*AllowManifests:\*\*(?:\s|$)/.test(line));
		let allowManifests = false;
		if (allowManifestsLines.length > 0) {
			if (type !== "implementation") {
				throw new Error(
					`Task ${taskId}: AllowManifests is only supported for implementation-type tasks`,
				);
			}
			if (allowManifestsLines.length > 1) {
				throw new Error(
					`Task ${taskId}: duplicate AllowManifests declarations are not allowed`,
				);
			}
			const value = allowManifestsLines[0]
				.replace(/^- \*\*AllowManifests:\*\*\s*/, "")
				.trim();
			if (value === "true") {
				allowManifests = true;
			} else if (value === "false") {
				allowManifests = false;
			} else {
				throw new Error(
					`Task ${taskId}: AllowManifests must be true or false when present`,
				);
			}
		}

		tasks.push({
			id: taskId,
			title: title.trim(),
			status: (statusMatch?.[1] ?? "pending").trim().toLowerCase(),
			description: rawDesc.trim(),
			prompt: fullPrompt,
			requiredPaths,
			allowManifests,
			quickChecks,
			timeoutMs,
			requiredCapability,
			requiredCapabilityJustification,
			executor,
			type,
			blockedBy,
			externalBlockers,
		});
	}

	validateTaskGraph(tasks);
	return tasks;
}
export function loadTaskQueue(tasksFilePath) {
	const markdown = readFileSync(tasksFilePath, "utf8");
	return parseTaskQueue(markdown);
}
export function validateTaskGraph(tasks) {
	if (!Array.isArray(tasks)) {
		throw new Error("tasks queue must be an array");
	}

	const byId = new Map();
	for (const task of tasks) {
		if (!task || typeof task.id !== "string" || !task.id.trim()) {
			throw new Error("tasks queue contains a task without a valid id");
		}
		if (byId.has(task.id)) {
			throw new Error(
				`tasks queue contains a duplicate task id "${task.id}"; refusing to ` +
					`run the same id twice in one pass — fix the malformed tasks file`,
			);
		}
		byId.set(task.id, task);
	}

	for (const task of tasks) {
		const dependencies = task.blockedBy ?? [];
		if (!Array.isArray(dependencies)) {
			throw new Error(
				`Task ${task.id}: blockedBy must be an array of exact task IDs`,
			);
		}
		for (const dependency of dependencies) {
			if (typeof dependency !== "string" || !byId.has(dependency)) {
				throw new Error(
					`Task ${task.id}: unknown Blocked by task "${dependency}"`,
				);
			}
			if (dependency === task.id) {
				throw new Error(
					`Task ${task.id}: self-dependency is not allowed in Blocked by`,
				);
			}
		}
	}

	const visiting = new Set();
	const visited = new Set();
	const visit = (taskId, path) => {
		if (visiting.has(taskId)) {
			const cycleStart = path.indexOf(taskId);
			const cycle = [...path.slice(cycleStart), taskId].join(" -> ");
			throw new Error(`task dependency cycle detected: ${cycle}`);
		}
		if (visited.has(taskId)) return;

		visiting.add(taskId);
		const task = byId.get(taskId);
		for (const dependency of task.blockedBy ?? []) {
			visit(dependency, [...path, taskId]);
		}
		visiting.delete(taskId);
		visited.add(taskId);
	};

	for (const task of tasks) visit(task.id, []);
	return tasks;
}
