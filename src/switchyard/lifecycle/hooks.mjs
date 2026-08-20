// Project-declared workspace lifecycle hooks. Hooks execute only inside the
// disposable workspace, never on the host. Commands are argv arrays so a
// project declaration is not interpreted by a host shell.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LIFECYCLE_HOOKS_FILE = "switchyard.hooks.json";
const LIFECYCLE_HOOK_PHASES = Object.freeze([
	"after_create",
	"before_run",
	"after_run",
	"before_remove",
]);
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;

function fail(message) {
	throw new Error(`workspace lifecycle hooks: ${message}`);
}

function validateHook(phase, value, timeoutMs) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail(`${phase} must be an object`);
	}
	if (
		!Array.isArray(value.argv) ||
		value.argv.length === 0 ||
		value.argv.some((arg) => typeof arg !== "string" || arg.length === 0)
	) {
		fail(`${phase}.argv must be a non-empty string array`);
	}
	if (value.argv[0].includes("/"))
		fail(`${phase}.argv[0] must be a PATH command name`);
	const onFailure = value.on_failure ?? "fail";
	if (onFailure !== "fail" && onFailure !== "ignore") {
		fail(`${phase}.on_failure must be fail or ignore`);
	}
	return Object.freeze({
		argv: Object.freeze([...value.argv]),
		onFailure,
		timeoutMs,
	});
}

/** Read the committed project declaration, returning no hooks when absent. */
export function loadWorkspaceLifecycleHooks(projectPath) {
	let raw;
	try {
		raw = readFileSync(join(projectPath, LIFECYCLE_HOOKS_FILE), "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return Object.freeze({ hooks: new Map() });
		throw error;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		fail(`${LIFECYCLE_HOOKS_FILE} is not valid JSON`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		fail(`${LIFECYCLE_HOOKS_FILE} must be an object`);
	}
	const timeoutMs = parsed.timeout_ms ?? 5 * 60 * 1_000;
	if (
		!Number.isInteger(timeoutMs) ||
		timeoutMs < MIN_TIMEOUT_MS ||
		timeoutMs > MAX_TIMEOUT_MS
	) {
		fail(
			`timeout_ms must be an integer from ${MIN_TIMEOUT_MS} through ${MAX_TIMEOUT_MS}`,
		);
	}
	const hooks = new Map();
	for (const phase of LIFECYCLE_HOOK_PHASES) {
		if (parsed[phase] !== undefined)
			hooks.set(phase, validateHook(phase, parsed[phase], timeoutMs));
	}
	for (const key of Object.keys(parsed)) {
		if (key !== "timeout_ms" && !LIFECYCLE_HOOK_PHASES.includes(key))
			fail(`unsupported key ${key}`);
	}
	return Object.freeze({ hooks });
}

function execute(executionBackend, workspaceId, argv, timeoutMs) {
	const execution = executionBackend.execArgv(workspaceId, {
		cwd: "/project",
		argv,
		recordPid: false,
	});
	const result = spawnSync(execution.command, execution.args, {
		encoding: "utf8",
		stdio: "pipe",
		timeout: timeoutMs,
	});
	if (result.error || result.status !== 0) {
		fail(`hook exited ${result.status ?? result.signal ?? "unknown"}`);
	}
}

/** Run one phase, returning false only for a declared ignored failure. */
export function runWorkspaceLifecycleHook(
	executionBackend,
	workspaceId,
	declaration,
	phase,
	{ onStatus } = {},
) {
	const hook = declaration?.hooks?.get(phase);
	if (!hook) return true;
	onStatus?.({
		phase: "lifecycle_hook",
		event: "started",
		status: `Running ${phase} hook`,
	});
	try {
		execute(executionBackend, workspaceId, hook.argv, hook.timeoutMs);
		if (phase === "after_create") {
			execute(
				executionBackend,
				workspaceId,
				["git", "diff", "--quiet"],
				hook.timeoutMs,
			);
			const clean = executionBackend.execArgv(workspaceId, {
				cwd: "/project",
				argv: ["git", "status", "--porcelain"],
				recordPid: false,
			});
			const status = spawnSync(clean.command, clean.args, {
				encoding: "utf8",
				stdio: "pipe",
				timeout: hook.timeoutMs,
			});
			if (status.status !== 0 || status.stdout.trim() !== "")
				fail("after_create left tracked or unignored artifacts");
		}
		onStatus?.({
			phase: "lifecycle_hook",
			event: "completed",
			status: `${phase} hook completed`,
		});
		return true;
	} catch (error) {
		if (hook.onFailure === "ignore") {
			onStatus?.({
				phase: "lifecycle_hook",
				event: "ignored_failure",
				status: `${phase} hook failed and was ignored`,
			});
			return false;
		}
		throw error;
	}
}
