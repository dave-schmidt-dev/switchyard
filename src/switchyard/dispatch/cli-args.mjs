import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { UsageError } from "./cli-usage.mjs";

function parseDispatchArgs(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				project: { type: "string" },
				"max-tasks": { type: "string" },
				checkpoint: { type: "string" },
				"no-stop-on-failure": { type: "boolean", default: false },
				"exclude-provider": { type: "string", multiple: true },
				"only-provider": { type: "string", multiple: true },
				provider: { type: "string", multiple: true },
				"task-id": { type: "string", multiple: true },
				"health-enforce": { type: "boolean", default: false },
				"health-state-root": { type: "string" },
				platform: { type: "string" },
				"dirty-overlay": { type: "boolean", default: false },
				"qualification-attempt": { type: "boolean", default: false },
				json: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
		});
	} catch (error) {
		throw new UsageError(error.message);
	}

	const { values, positionals } = parsed;
	if (values.help) {
		return { help: true };
	}

	const tasksFilePath = positionals[0];
	if (!tasksFilePath) {
		throw new UsageError("missing <tasks.md> positional argument");
	}
	if (positionals.length > 1) {
		throw new UsageError(
			`unexpected extra arguments: ${positionals.slice(1).join(" ")}`,
		);
	}
	if (!values.project) {
		throw new UsageError("--project <path> is required");
	}

	const resolvedTasks = resolve(tasksFilePath);
	if (!existsSync(resolvedTasks) || !statSync(resolvedTasks).isFile()) {
		throw new UsageError(`tasks file not found: ${resolvedTasks}`);
	}

	const projectPath = resolve(values.project);
	if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
		throw new UsageError(`--project is not a directory: ${projectPath}`);
	}
	// seedProjectWithBackend archives the project's committed HEAD into each
	// workspace, so a non-repo project can't be dispatched against.
	if (!existsSync(join(projectPath, ".git"))) {
		throw new UsageError(`--project is not a git repository: ${projectPath}`);
	}

	let maxTasks = Number.POSITIVE_INFINITY;
	if (values["max-tasks"] !== undefined) {
		maxTasks = Number.parseInt(values["max-tasks"], 10);
		if (!Number.isInteger(maxTasks) || maxTasks < 1) {
			throw new UsageError(
				`--max-tasks must be a positive integer, got "${values["max-tasks"]}"`,
			);
		}
	}

	const onlyProviders = [
		...(values["only-provider"] ?? []),
		...(values.provider ?? []),
	];
	const platform = String(values.platform ?? "macos")
		.trim()
		.toLowerCase();
	if (platform !== "macos") {
		throw new UsageError(`--platform must be macos, got "${values.platform}"`);
	}
	if (
		onlyProviders.length > 0 &&
		(values["exclude-provider"] ?? []).length > 0
	) {
		throw new UsageError(
			"--only-provider/--provider and --exclude-provider are mutually exclusive",
		);
	}
	if (values["qualification-attempt"] === true) {
		if (onlyProviders.length !== 1 || (values["task-id"] ?? []).length !== 1) {
			throw new UsageError(
				"--qualification-attempt requires exactly one --only-provider and one --task-id",
			);
		}
		if (values["max-tasks"] !== undefined && maxTasks !== 1) {
			throw new UsageError(
				"--qualification-attempt requires --max-tasks 1 when supplied",
			);
		}
		maxTasks = 1;
	}

	return {
		help: false,
		tasksFilePath: resolvedTasks,
		projectPath,
		maxTasks,
		checkpointPath: values.checkpoint ? resolve(values.checkpoint) : undefined,
		stopOnFailure: !values["no-stop-on-failure"],
		excludeProviders: values["exclude-provider"] ?? [],
		onlyProviders,
		taskIds: values["task-id"] ?? [],
		platform,
		dirtyOverlay: values["dirty-overlay"] === true,
		qualificationAttempt: values["qualification-attempt"] === true,
		json: values.json,
		healthMode: values["health-enforce"] ? "enforce" : "shadow",
		healthStateRoot: values["health-state-root"]
			? resolve(values["health-state-root"])
			: undefined,
	};
}
function parseLaunchArgs(argv) {
	return parseDispatchArgs(argv);
}
function parseStatusArgs(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				help: { type: "boolean", default: false },
				json: { type: "boolean", default: false },
				"state-root": { type: "string" },
			},
		});
	} catch (error) {
		throw new UsageError(error.message);
	}

	const { values, positionals } = parsed;
	return {
		help: values.help,
		runId: positionals[0] ?? null,
		json: values.json,
		stateRoot: values["state-root"] ?? null,
	};
}
function shellQuote(value) {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
async function withStateRoot(stateRoot, operation) {
	if (!stateRoot) return operation();
	const previous = process.env.SWITCHYARD_RUN_STORE_ROOT;
	process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;
	try {
		return await operation();
	} finally {
		if (previous === undefined) {
			delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		} else {
			process.env.SWITCHYARD_RUN_STORE_ROOT = previous;
		}
	}
}
function parseResultArgs(argv) {
	return parseStatusArgs(argv);
}
function parseRecoverArgs(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: false,
			options: {
				run: { type: "string" },
				"state-root": { type: "string" },
				help: { type: "boolean", default: false },
			},
		});
	} catch (error) {
		throw new UsageError(error.message);
	}

	return {
		help: parsed.values.help,
		runId: parsed.values.run ?? null,
		stateRoot: parsed.values["state-root"] ?? null,
	};
}
function parseHealthArgs(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				target: { type: "string" },
				descriptor: { type: "string" },
				"public-configuration-epoch": { type: "string" },
				"repair-epoch": { type: "string" },
				"repair-kind": { type: "string" },
				capability: { type: "string" },
				"health-state-root": { type: "string" },
				help: { type: "boolean", default: false },
			},
		});
	} catch (error) {
		throw new UsageError(error.message);
	}
	const action = parsed.positionals[0];
	if (parsed.values.help) return { help: true };
	if (!new Set(["identity", "inspect", "attest-repair"]).has(action))
		throw new UsageError("health requires identity, inspect, or attest-repair");
	if (!parsed.values.target)
		throw new UsageError("health --target is required");
	if (action === "identity") {
		const requiredCapability = parsed.values.capability;
		if (!new Set(["low", "standard", "high"]).has(requiredCapability))
			throw new UsageError(
				"health identity --capability must be low, standard, or high",
			);
		return { action, provider: parsed.values.target, requiredCapability };
	}
	for (const name of ["descriptor", "public-configuration-epoch"]) {
		if (!parsed.values[name])
			throw new UsageError(`health --${name} is required`);
	}
	const base = {
		targetId: parsed.values.target,
		descriptorIdentity: parsed.values.descriptor,
		publicConfigurationEpoch: parsed.values["public-configuration-epoch"],
		healthStateRoot: parsed.values["health-state-root"]
			? resolve(parsed.values["health-state-root"])
			: undefined,
	};
	if (action === "inspect") {
		const repairEpochText = parsed.values["repair-epoch"];
		if (!/^(0|[1-9]\d*)$/.test(repairEpochText ?? ""))
			throw new UsageError(
				"health inspect --repair-epoch must be a non-negative integer",
			);
		const repairEpoch = Number(repairEpochText);
		if (!Number.isSafeInteger(repairEpoch))
			throw new UsageError(
				"health inspect --repair-epoch must be a non-negative integer",
			);
		return { action, ...base, repairEpoch };
	}
	if (!parsed.values["repair-kind"])
		throw new UsageError("health attest-repair --repair-kind is required");
	return { action, ...base, repairKind: parsed.values["repair-kind"] };
}
function parseOrphanLockRemediationArgs(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: false,
			options: {
				"dry-run": { type: "boolean", default: false },
				confirm: { type: "boolean", default: false },
				"state-root": { type: "string" },
				help: { type: "boolean", default: false },
			},
		});
	} catch (error) {
		throw new UsageError(error.message);
	}
	const forwarded = [];
	if (parsed.values["dry-run"]) forwarded.push("--dry-run");
	if (parsed.values.confirm) forwarded.push("--confirm");
	if (parsed.values.help) forwarded.push("--help");
	return {
		argv: forwarded,
		stateRoot: parsed.values["state-root"] ?? null,
	};
}

export {
	parseDispatchArgs,
	parseHealthArgs,
	parseLaunchArgs,
	parseOrphanLockRemediationArgs,
	parseRecoverArgs,
	parseResultArgs,
	parseStatusArgs,
	shellQuote,
	withStateRoot,
};
