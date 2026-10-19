/**
 * File-read probes for `switchyard doctor`: roster qualification expiry,
 * route-health repair holds and stranded pending routing attempts.
 *
 * These only read JSON state, never spawn and never take a lock, so the
 * quick subset at `simple` start can run them on every dispatch. A reader
 * reports a missing root as empty and anything unreadable as `{ error }`.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfiguredDispatchDescriptor } from "../roster/qualification.mjs";
import {
	loadRosterData,
	QUALIFICATION_STATUS,
	ROSTER_CAPABILITY_CLASSES,
	STALE_MAX_AGE_SECONDS,
} from "../roster/schema.mjs";
import { getStateRoot, readRun } from "../run-store/index.mjs";
import {
	RUN_TERMINAL_STATES,
	writerQuiescent,
} from "../simple/routing-recovery.mjs";

const MAX_STATE_BYTES = 1024 * 1024;
function readJson(path) {
	const text = readFileSync(path, "utf8");
	if (text.length > MAX_STATE_BYTES) throw new Error("state_file_too_large");
	return JSON.parse(text);
}
const errorCode = (error) => error?.code ?? error?.message ?? String(error);

function qualifiedAt(record) {
	if (record?.status !== QUALIFICATION_STATUS.DISPATCH_QUALIFIED) return null;
	const at = Date.parse(
		record.tested_at ?? record.qualified_at ?? record.observed_at ?? "",
	);
	return Number.isFinite(at) ? at : null;
}

/**
 * Every active slot on an enabled roster target with its newest
 * dispatch-qualified receipt's expiry (`STALE_MAX_AGE_SECONDS` after it).
 * @param {{roster?: object}} [options] Injected roster data; else the live roster.
 * @returns {{slots: {targetId: string, capability: string, expiresAt: number|null}[]}|{error: string}}
 */
export function readQualificationSlots({ roster } = {}) {
	let data;
	try {
		data = roster ?? loadRosterData();
	} catch (error) {
		return { error: errorCode(error).split("\n")[0] };
	}
	const models = data.models ?? {};
	const slots = [];
	for (const [targetId, target] of Object.entries(data.targets ?? {}).sort(
		([a], [b]) => a.localeCompare(b),
	)) {
		if (target?.enabled !== true) continue;
		const records = Object.entries(target.qualifications ?? {});
		for (const capability of ROSTER_CAPABILITY_CLASSES) {
			const list = target.slots?.[capability];
			for (const slot of Array.isArray(list) ? list : []) {
				if (slot?.manual_only || models[slot?.model_ref]?.status !== "active")
					continue;
				const identity = resolveConfiguredDispatchDescriptor(
					targetId,
					target,
					models,
					slot,
				)?.descriptor_identity;
				const times = records
					.filter(
						([key, record]) =>
							identity &&
							(key === identity || record?.descriptor_identity === identity),
					)
					.map(([, record]) => qualifiedAt(record))
					.filter((at) => at !== null);
				slots.push({
					targetId,
					capability,
					expiresAt: times.length
						? Math.max(...times) + STALE_MAX_AGE_SECONDS * 1000
						: null,
				});
			}
		}
	}
	return { slots };
}

/** The route-health root the simple lane uses. */
function routeHealthRoot(env = process.env) {
	return (
		env.SWITCHYARD_ROUTE_HEALTH_STATE_ROOT ||
		join(getStateRoot(), "route-health")
	);
}

/**
 * Route-health control records, one per target descriptor.
 * @param {{root?: string}} [options]
 * @returns {{root: string, controls: object[]}|{root: string, error: string}}
 */
export function readRepairHolds({ root = routeHealthRoot() } = {}) {
	const dir = join(root, "control");
	if (!existsSync(dir)) return { root, controls: [] };
	try {
		const controls = readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.sort()
			.map((name) => readJson(join(dir, name)));
		return { root, controls };
	} catch (error) {
		return { root, error: errorCode(error) };
	}
}

/**
 * Pending routing attempts with what their run record says about them.
 * `live` marks an attempt whose run is still executing; `closable` marks one
 * close-pending accepts (terminal run, quiescent writer).
 * @param {{stateRoot?: string, project?: string, routingRunId?: string,
 *   readRunRecord?: (runId: string) => Promise<object>,
 *   probePid?: (pid: number, signal: number) => void}} [options]
 *   `project` limits the scan to that canonical project's routing runs and
 *   `routingRunId` to one of them.
 */
export async function readStrandedPending({
	stateRoot = join(getStateRoot(), "routing-runs"),
	project,
	routingRunId,
	readRunRecord = readRun,
	probePid,
} = {}) {
	if (!existsSync(stateRoot)) return { pending: [] };
	const prefix = project
		? `${createHash("sha256").update(project).digest("hex")}-${routingRunId ?? ""}`
		: "";
	let names;
	try {
		names = readdirSync(stateRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		return { error: errorCode(error) };
	}
	const pending = [];
	for (const name of names) {
		let state;
		try {
			state = readJson(join(stateRoot, name, "state.json"));
		} catch {
			continue;
		}
		const attempt = state?.pendingAttempt;
		if (!attempt) continue;
		const record = await readRunRecord(attempt.runId).catch(() => null);
		const terminal = Boolean(record && RUN_TERMINAL_STATES.has(record.state));
		const quiescent = record
			? writerQuiescent(record, probePid ? { probePid } : {})
			: false;
		pending.push({
			project: state.canonicalProjectPath,
			routingRunId: state.routingRunId,
			taskId: attempt.taskId,
			targetId: attempt.targetId,
			runState: record?.state ?? null,
			live: Boolean(record) && !terminal && !quiescent,
			closable: terminal && quiescent,
			projectExists: existsSync(state.canonicalProjectPath ?? ""),
		});
	}
	return { pending };
}
