import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { UsageError } from "./cli-usage.mjs";

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
	parseHealthArgs,
	parseOrphanLockRemediationArgs,
	parseRecoverArgs,
	shellQuote,
	withStateRoot,
};
