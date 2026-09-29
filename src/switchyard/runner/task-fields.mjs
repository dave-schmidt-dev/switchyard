import { lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isValidCapabilityClass } from "../roster/classifier.mjs";
import { EXTERNAL_BLOCKER_ID_RE, TASK_ID_PATTERN } from "./constants.mjs";

const MIN_TASK_TIMEOUT_MS = 1000;
const MAX_TASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
function parseTimeoutField(raw, taskId) {
	const trimmed = raw.trim();
	const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(s|m|h)$/i);
	if (!match) {
		throw new Error(
			`Task ${taskId}: invalid Timeout field "${trimmed}" (expected a number followed by s/m/h, e.g. "90m")`,
		);
	}

	const [, amount, unit] = match;
	const unitMs = { s: 1000, m: 60_000, h: 3_600_000 }[unit.toLowerCase()];
	const ms = Number.parseFloat(amount) * unitMs;

	if (ms < MIN_TASK_TIMEOUT_MS || ms > MAX_TASK_TIMEOUT_MS) {
		throw new Error(
			`Task ${taskId}: Timeout must be between 1s and 24h (got "${trimmed}")`,
		);
	}

	return ms;
}
function getTaskFieldValues(block, fieldName) {
	const fieldPattern = new RegExp(`^- \\*\\*${fieldName}:\\*\\*(?:\\s(.*))?$`);
	return block.split("\n").flatMap((line) => {
		const match = line.match(fieldPattern);
		return match ? [match[1] ?? ""] : [];
	});
}
function hasTaskField(block, fieldName) {
	const fieldPattern = new RegExp(`^- \\*\\*${fieldName}:\\*\\*(?:\\s|$)`, "i");
	return block.split("\n").some((line) => fieldPattern.test(line));
}
function parseRequiredCapabilityField(block, taskId) {
	const values = getTaskFieldValues(block, "RequiredCapability");
	if (values.length === 0) return null;
	if (values.length > 1) {
		throw new Error(
			`Task ${taskId}: duplicate RequiredCapability declarations are not allowed`,
		);
	}

	const raw = values[0].trim();
	if (!raw) {
		throw new Error(`Task ${taskId}: RequiredCapability field is empty`);
	}
	if (/[,|/]+|\s/.test(raw)) {
		throw new Error(
			`Task ${taskId}: mixed RequiredCapability declaration "${raw}" is not allowed; declare exactly one of high, standard, or low`,
		);
	}

	const normalized = raw.toLowerCase();
	if (!isValidCapabilityClass(normalized)) {
		throw new Error(
			`Task ${taskId}: invalid RequiredCapability field "${raw}" (expected one of: high, standard, low)`,
		);
	}
	return normalized;
}
function parseRequiredCapabilityJustificationField(block, taskId) {
	const values = getTaskFieldValues(block, "RequiredCapabilityJustification");
	if (values.length === 0) return null;
	if (values.length > 1) {
		throw new Error(
			`Task ${taskId}: duplicate RequiredCapabilityJustification declarations are not allowed`,
		);
	}

	const justification = values[0].trim();
	if (!justification) {
		throw new Error(
			`Task ${taskId}: RequiredCapabilityJustification field is empty`,
		);
	}
	return justification;
}
function parseExecutorField(block, taskId) {
	const values = getTaskFieldValues(block, "Executor");
	if (values.length === 0) {
		throw new Error(
			`Task ${taskId}: missing Executor field (expected one of: native, switchyard, human)`,
		);
	}
	if (values.length > 1) {
		throw new Error(
			`Task ${taskId}: duplicate Executor declarations are not allowed`,
		);
	}

	const raw = values[0].trim();
	const normalized = raw.toLowerCase();
	if (!raw || !["native", "switchyard", "human"].includes(normalized)) {
		throw new Error(
			`Task ${taskId}: invalid Executor field "${raw}" (expected one of: native, switchyard, human)`,
		);
	}
	return normalized;
}
function parseTypeField(raw, taskId) {
	const trimmed = raw.trim().toLowerCase();
	if (trimmed !== "implementation" && trimmed !== "review") {
		throw new Error(
			`Task ${taskId}: invalid Type field "${raw.trim()}" (expected one of: implementation, review)`,
		);
	}
	return trimmed;
}
function parseBlockedByField(block, taskId) {
	const values = getTaskFieldValues(block, "Blocked by");
	if (values.length === 0) return [];
	if (values.length > 1) {
		throw new Error(
			`Task ${taskId}: duplicate Blocked by declarations are not allowed`,
		);
	}

	const raw = values[0].trim();
	if (!raw) {
		throw new Error(`Task ${taskId}: Blocked by field is empty`);
	}
	if (raw.toLowerCase() === "none") return [];

	const taskIdToken = `(?:${TASK_ID_PATTERN})`;
	const validList = new RegExp(
		`^(?:(?:Tasks?|tasks?)\\s+)?${taskIdToken}(?:\\s*,\\s*(?:(?:Task|task)\\s+)?${taskIdToken})*$`,
	);
	if (!validList.test(raw)) {
		throw new Error(
			`Task ${taskId}: invalid Blocked by field "${raw}" (expected none or exact task IDs)`,
		);
	}

	const dependencies = raw.match(new RegExp(TASK_ID_PATTERN, "g")) ?? [];
	const seen = new Set();
	for (const dependency of dependencies) {
		if (seen.has(dependency)) {
			throw new Error(
				`Task ${taskId}: duplicate Blocked by dependency "${dependency}"`,
			);
		}
		seen.add(dependency);
	}
	return dependencies;
}
function parseExternalBlockersField(block, taskId) {
	const values = getTaskFieldValues(block, "External blockers");
	if (values.length === 0) return [];
	if (values.length > 1) {
		throw new Error(
			`Task ${taskId}: duplicate External blockers declarations are not allowed`,
		);
	}

	const raw = values[0].trim();
	if (!raw) {
		throw new Error(`Task ${taskId}: External blockers field is empty`);
	}
	if (raw.toLowerCase() === "none") return [];

	const blockers = raw.split(",").map((value) => value.trim());
	const seen = new Set();
	for (const blocker of blockers) {
		if (!EXTERNAL_BLOCKER_ID_RE.test(blocker)) {
			throw new Error(
				`Task ${taskId}: invalid External blockers id "${blocker}" (expected stable slug)`,
			);
		}
		if (seen.has(blocker)) {
			throw new Error(
				`Task ${taskId}: duplicate External blockers id "${blocker}"`,
			);
		}
		seen.add(blocker);
	}
	return blockers;
}
function unwrapFilesInlineCode(token, taskId) {
	if (token.startsWith("`") && token.endsWith("`") && token.length >= 2) {
		const inner = token.slice(1, -1);
		if (inner.includes("`")) {
			throw new Error(
				`Task ${taskId}: malformed inline-code wrapper in Files: "${token}"`,
			);
		}
		return inner.trim();
	}
	if (token.includes("`")) {
		throw new Error(
			`Task ${taskId}: unmatched inline-code delimiter in Files: "${token}"`,
		);
	}
	return token;
}
function parseFilePaths(raw, taskId) {
	const trimmed = raw.trim();
	if (!trimmed) {
		throw new Error(
			`Task ${taskId}: Files field is empty (must include at least one path)`,
		);
	}

	const paths = trimmed
		.split(",")
		.map((entry) => unwrapFilesInlineCode(entry.trim(), taskId));

	for (const path of paths) {
		if (!path) {
			throw new Error(`Task ${taskId}: empty path entry in Files field`);
		}
		if (path.startsWith("/")) {
			throw new Error(
				`Task ${taskId}: absolute path not allowed in Files: "${path}"`,
			);
		}
		if (path.split("/").includes("..")) {
			throw new Error(
				`Task ${taskId}: path traversal not allowed in Files: "${path}"`,
			);
		}
		if (path.includes("\\")) {
			throw new Error(
				`Task ${taskId}: backslash separator not allowed in Files: "${path}"`,
			);
		}
		if (/[*?[\]]/.test(path)) {
			throw new Error(
				`Task ${taskId}: wildcards not allowed in Files: "${path}"`,
			);
		}
		if (path.endsWith("/")) {
			throw new Error(
				`Task ${taskId}: directory-only entry not allowed in Files: "${path}"`,
			);
		}
		if (path.split("/").some((component) => component === "")) {
			throw new Error(
				`Task ${taskId}: empty path component in Files: "${path}"`,
			);
		}
		if (path.split("/").some((component) => component === ".")) {
			throw new Error(
				`Task ${taskId}: dot path component not allowed in Files: "${path}"`,
			);
		}
	}

	const seen = new Set();
	for (const path of paths) {
		if (seen.has(path)) {
			throw new Error(`Task ${taskId}: duplicate path in Files: "${path}"`);
		}
		seen.add(path);
	}

	return paths;
}
export function validateProjectFileEntries(tasks, projectPath) {
	const root = resolve(projectPath);
	for (const task of tasks) {
		for (const relativePath of task.requiredPaths ?? []) {
			const candidate = resolve(root, relativePath);
			const containment = relative(root, candidate);
			if (
				containment === ".." ||
				containment.startsWith(`..${sep}`) ||
				isAbsolute(containment)
			) {
				const error = new Error(
					`Task ${task.id}: Files path escapes project root: "${relativePath}"`,
				);
				error.code = "queue_contract_invalid";
				throw error;
			}
			const components = relative(root, candidate).split(sep);
			let prefix = root;
			for (const component of components.slice(0, -1)) {
				prefix = join(prefix, component);
				try {
					if (lstatSync(prefix).isSymbolicLink()) {
						const error = new Error(
							`Task ${task.id}: Files entry must not traverse a symlink directory: "${relativePath}"`,
						);
						error.code = "queue_contract_invalid";
						throw error;
					}
				} catch (error) {
					if (error?.code === "ENOENT") break;
					throw error;
				}
			}
			try {
				const stat = lstatSync(candidate);
				if (stat.isDirectory() || stat.isSymbolicLink()) {
					const error = new Error(
						`Task ${task.id}: Files entry must name a regular file, not a directory or symlink: "${relativePath}"`,
					);
					error.code = "queue_contract_invalid";
					throw error;
				}
			} catch (error) {
				if (error?.code === "ENOENT") continue;
				throw error;
			}
		}
	}
}
export {
	hasTaskField,
	parseBlockedByField,
	parseExecutorField,
	parseExternalBlockersField,
	parseFilePaths,
	parseRequiredCapabilityField,
	parseRequiredCapabilityJustificationField,
	parseTimeoutField,
	parseTypeField,
};
