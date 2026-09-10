#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	computeContractSnapshot,
	writeExecutionRecord,
} from "./check-contract-gates.mjs";

export const DEFAULT_PHASES = ["test:serial", "test:other"];
export const VM_GATE_OUTCOMES = Object.freeze([
	"executed",
	"unavailable-with-proof",
	"failed",
]);
export const REQUIRED_VM_GATES_BY_PHASE = Object.freeze({
	"test:serial": Object.freeze(["inv1", "inv3"]),
});

/**
 * Validate the additive VM-gate projection carried by a phase result.
 * Unavailable is acceptable only with a non-empty proof reason; an omitted or
 * unknown state is failed so a healthy idle host cannot pass by skipping.
 */
export function aggregateVmGateOutcomes(gates = {}) {
	const entries = Object.entries(gates ?? {}).map(([name, value]) => {
		const status = value?.status;
		const reason = typeof value?.reason === "string" ? value.reason.trim() : "";
		if (
			!VM_GATE_OUTCOMES.includes(status) ||
			(status === "unavailable-with-proof" && reason.length === 0)
		) {
			return [
				name,
				{ status: "failed", reason: "missing-unavailability-proof" },
			];
		}
		return [name, { status, ...(reason ? { reason } : {}) }];
	});
	const normalized = Object.fromEntries(entries);
	const failed = entries.some(([, value]) => value.status === "failed");
	return {
		status: failed
			? "failed"
			: entries.some(([, value]) => value.status === "unavailable-with-proof")
				? "unavailable-with-proof"
				: entries.length > 0
					? "executed"
					: "failed",
		gates: normalized,
	};
}

function parseVmGateOutcomeFile(path, requiredGates) {
	let lines;
	try {
		lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
	} catch {
		return {
			status: "failed",
			gates: Object.fromEntries(
				requiredGates.map((gate) => [
					gate,
					{ status: "failed", reason: "missing-outcome-file" },
				]),
			),
		};
	}
	const gates = {};
	for (const line of lines) {
		try {
			const record = JSON.parse(line);
			if (
				record?.schemaVersion === 1 &&
				typeof record.gate === "string" &&
				requiredGates.includes(record.gate)
			) {
				gates[record.gate] = {
					status: record.status,
					...(typeof record.reason === "string"
						? { reason: record.reason }
						: {}),
				};
			}
		} catch {
			// A malformed side-channel record is represented as a missing gate;
			// the required projection below turns it into a failed outcome.
		}
	}
	for (const gate of requiredGates) {
		if (!Object.hasOwn(gates, gate)) {
			gates[gate] = { status: "failed", reason: "missing-outcome" };
		}
	}
	return aggregateVmGateOutcomes(gates);
}

export function defaultRun(
	phase,
	{ spawn = spawnSync, env = process.env } = {},
) {
	const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
	const requiredGates = REQUIRED_VM_GATES_BY_PHASE[phase] ?? null;
	const captureDir = requiredGates
		? mkdtempSync(join(tmpdir(), "switchyard-vm-gates-"))
		: null;
	const outcomePath = captureDir ? join(captureDir, "outcomes.jsonl") : null;
	try {
		const result = spawn(npmCmd, ["run", phase], {
			stdio: "inherit",
			env: requiredGates
				? { ...env, SWITCHYARD_VM_GATE_OUTCOME_FILE: outcomePath }
				: env,
		});
		if (result.error) throw result.error;
		if (requiredGates) {
			const vmGateSummary = parseVmGateOutcomeFile(outcomePath, requiredGates);
			return {
				status:
					vmGateSummary.status === "failed"
						? Math.max(1, result.status ?? 1)
						: (result.status ?? 1),
				vmGates: vmGateSummary.gates,
			};
		}
		return result.status ?? 1;
	} finally {
		if (captureDir) rmSync(captureDir, { force: true, recursive: true });
	}
}

export function runPhases({
	phases = DEFAULT_PHASES,
	run = defaultRun,
	log = console.log,
} = {}) {
	const results = [];
	for (const phase of phases) {
		const res = run(phase);
		const rawStatus =
			typeof res === "number" ? res : (res?.status ?? (res ? 0 : 1));
		const status = Number.isInteger(rawStatus) ? rawStatus : 1;
		const vmGates =
			res && typeof res === "object" && Object.hasOwn(res, "vmGates")
				? res.vmGates
				: null;
		const gateSummary = vmGates ? aggregateVmGateOutcomes(vmGates) : null;
		results.push({
			phase,
			status: gateSummary?.status === "failed" ? Math.max(1, status) : status,
			...(vmGates ? { vmGates } : {}),
		});
	}

	const gateResults = results.flatMap((result) =>
		Object.entries(result.vmGates ?? {}).map(([name, value]) => [
			`${result.phase}/${name}`,
			value,
		]),
	);
	const gateSummary =
		gateResults.length > 0
			? `; VM gates: ${gateResults
					.map(([name, value]) => `${name} (${value?.status ?? "failed"})`)
					.join(", ")}`
			: "";
	const summary = `Test phase summary: ${results
		.map((r) => `${r.phase} (exit ${r.status})`)
		.join(", ")}${gateSummary}`;
	log(summary);

	const firstNonZero = results.find((r) => r.status !== 0);
	runPhases.lastResults = results;
	return firstNonZero ? firstNonZero.status : 0;
}

if (
	process.argv[1] &&
	(fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
		(existsSync(process.argv[1]) &&
			import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href))
) {
	const snapshot = computeContractSnapshot(process.cwd());
	const status = runPhases();
	writeExecutionRecord(runPhases.lastResults ?? [], {
		root: process.cwd(),
		snapshot,
	});
	process.exit(status);
}
