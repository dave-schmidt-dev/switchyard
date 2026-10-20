/**
 * Pure `switchyard doctor` evaluators.
 *
 * Each function turns already-gathered probe data into one check result:
 * `{ id, status, summary, fixes }`. Nothing here touches the filesystem,
 * spawns a process or reads the clock, so every verdict is unit-testable
 * with injected probe answers.
 *
 * Status rule: `fail` means a probe could not run or a pinned identity is
 * broken (a sandbox tool, a provider CLI, a bridge or runtime hash, unreadable
 * state). `warn` means one route is, or soon will be, unavailable until the
 * owner acts (qualification expiry, a repair hold, a stranded attempt, a CLI
 * that dropped a flag its lane passes, a LaunchAgent that is missing or
 * stale).
 */

import { cliContractPreflightDetail } from "../cli-contract/canary.mjs";

export const STATUS = Object.freeze({ OK: "ok", WARN: "warn", FAIL: "fail" });
const RANK = { ok: 0, warn: 1, fail: 2 };
const DAY_MS = 24 * 60 * 60 * 1000;
/** Qualifications expiring within this window are reported. */
const QUALIFICATION_WARN_DAYS = 9;
/** The canary runs daily; a state older than this means it stopped. */
const CANARY_STALE_MS = 2 * DAY_MS;
const REAPER_LABEL = "com.zerodelta.switchyard.reaper";
const REAPER_UNINSTALL = `launchctl bootout gui/$(id -u)/${REAPER_LABEL}; rm -f ~/Library/LaunchAgents/${REAPER_LABEL}.plist ~/Library/Application\\ Support/switchyard/switchyard-reaper.sh`;
export const SANDBOX_TOOLS = Object.freeze(["node", "npm", "uv"]);
const TOOL_FORMULA = { node: "node", npm: "node", uv: "uv" };
const DISPATCH = "switchyard-dispatch";

function result(id, status, summary, fixes = []) {
	return { id, status, summary, fixes };
}
function worst(statuses) {
	return statuses.reduce(
		(acc, status) => (RANK[status] > RANK[acc] ? status : acc),
		STATUS.OK,
	);
}
const days = (ms) => (ms / DAY_MS).toFixed(1);

/** Overall status for a report: the worst of its checks. */
export function overallStatus(checks) {
	return worst(checks.map((check) => check.status));
}

/**
 * node, npm and uv as the quick-check sandbox resolves them.
 * @param {{error?: string, tools?: Record<string, string|null>}} probe
 */
export function checkSandboxToolchain(probe) {
	const id = "sandbox-toolchain";
	if (probe?.error)
		return result(
			id,
			STATUS.FAIL,
			`sandbox profile unavailable (${probe.error})`,
			["brew install node uv"],
		);
	const missing = SANDBOX_TOOLS.filter((tool) => !probe?.tools?.[tool]);
	if (missing.length > 0)
		return result(
			id,
			STATUS.FAIL,
			`${missing.join(", ")} not found inside the check sandbox`,
			[
				`brew install ${[...new Set(missing.map((t) => TOOL_FORMULA[t]))].join(" ")}`,
			],
		);
	return result(
		id,
		STATUS.OK,
		SANDBOX_TOOLS.map((tool) => `${tool}=${probe.tools[tool]}`).join(" "),
	);
}

/**
 * Doctor severity for each canary status. A dropped flag or an inconclusive
 * run leaves the CLI's routes unavailable until the owner acts; a CLI that is
 * missing or cannot answer `--version` or `--help` is a failed probe.
 */
const CANARY_SEVERITY = Object.freeze({
	ok: STATUS.OK,
	flags_missing: STATUS.WARN,
	unavailable: STATUS.WARN,
	not_installed: STATUS.FAIL,
	version_unreadable: STATUS.FAIL,
	help_unreadable: STATUS.FAIL,
});

function canaryLine(row) {
	const severity = CANARY_SEVERITY[row.status] ?? STATUS.FAIL;
	const reason =
		row.status === "ok"
			? `${row.cli} ${row.version}`
			: row.status === "unavailable"
				? `${row.cli} check inconclusive (${row.detail ?? "unknown"})`
				: cliContractPreflightDetail(row).condition;
	return { severity, line: `${severity.padEnd(4)}  ${reason}` };
}

/**
 * Each adapter's CLI against its launch contract, from the CLI canary
 * (`runCliCanary`, the check behind `npm run cli:canary` and launch
 * admission). `details` holds one line per adapter.
 * @param {object[]|{error: string}} rows - The canary's per-row results.
 */
export function checkProviderClis(rows) {
	const id = "provider-clis";
	if (!Array.isArray(rows))
		return result(
			id,
			STATUS.FAIL,
			`CLI canary did not run (${rows?.error ?? "no result"})`,
			["npm run cli:canary"],
		);
	if (rows.length === 0)
		return result(id, STATUS.FAIL, "CLI canary checked no adapters");
	const lines = rows.map(canaryLine);
	const status = worst(lines.map((entry) => entry.severity));
	const failing = rows.filter(
		(row) => row.status !== "ok" && row.status !== "unavailable",
	);
	const inconclusive = rows.filter((row) => row.status === "unavailable");
	const fixes = [
		...(failing.length > 0
			? [cliContractPreflightDetail(failing[0]).remedy]
			: []),
		...(inconclusive.length > 0
			? [
					`npm run cli:canary -- --only ${inconclusive.map((row) => row.cli).join(",")}`,
				]
			: []),
	];
	const summary =
		status === STATUS.OK
			? `${rows.length} CLIs pass the launch contract`
			: [
					failing.length > 0
						? `${failing.length}/${rows.length} CLIs fail the launch contract`
						: null,
					inconclusive.length > 0
						? `${inconclusive.length}/${rows.length} inconclusive`
						: null,
				]
					.filter(Boolean)
					.join("; ");
	return {
		...result(id, status, summary, fixes),
		details: lines.map((entry) => entry.line),
	};
}

const CONSUMER =
	/"(switchyard-[a-z0-9-]+)":\s*Consumer\(\s*executable=Path\("([^"]+)"\),\s*executable_sha256=(?:"([0-9a-f]{64})"|None)/gu;

/**
 * The Switchyard consumers in the bws broker registry source. Only the
 * consumer name, executable path and content pin are read; secret
 * references in the same file are never matched or reported.
 * @param {string} text
 * @returns {{consumer: string, executable: string, sha256: string|null}[]}
 */
export function parseBrokerConsumers(text) {
	return [...String(text).matchAll(CONSUMER)].map((match) => ({
		consumer: match[1],
		executable: match[2],
		sha256: match[3] ?? null,
	}));
}

/**
 * Bridge bytes against the broker's content pins.
 * @param {{brokerPresent: boolean, registryPath?: string|null,
 *   consumers?: {consumer: string, executable: string, sha256: string|null}[],
 *   hashes?: Record<string, string|null>}} probe
 */
export function checkBridgePins(probe) {
	const id = "bridge-pins";
	if (!probe?.brokerPresent)
		return result(id, STATUS.FAIL, "bws-secret-exec broker not found");
	const consumers = probe.consumers ?? [];
	if (!probe.registryPath || consumers.length === 0)
		return result(
			id,
			STATUS.FAIL,
			"broker registry has no Switchyard consumers",
		);
	const failures = [];
	const unpinned = [];
	for (const entry of consumers) {
		const live = probe.hashes?.[entry.executable] ?? null;
		if (live === null) failures.push(`${entry.consumer}: executable missing`);
		else if (entry.sha256 === null) unpinned.push(entry.consumer);
		else if (live !== entry.sha256)
			failures.push(
				`${entry.consumer}: live ${live.slice(0, 12)} != pin ${entry.sha256.slice(0, 12)}`,
			);
	}
	const fixes = [];
	if (failures.some((line) => line.includes("!= pin")))
		fixes.push(
			`owner: re-pin the changed bridge in ${probe.registryPath} after review (bws-secret-exec refuses it until then)`,
		);
	if (failures.some((line) => line.endsWith(": executable missing")))
		fixes.push(
			`owner: remove retired consumers from ${probe.registryPath}, or restore their executables`,
		);
	if (failures.length > 0)
		return result(id, STATUS.FAIL, failures.join("; "), fixes);
	if (unpinned.length > 0)
		return result(
			id,
			STATUS.WARN,
			`content pin disabled for ${unpinned.join(", ")}`,
		);
	return result(
		id,
		STATUS.OK,
		`${consumers.length} consumers match their pins`,
	);
}

/**
 * Qualification expiry per active roster slot.
 * @param {{error?: string, slots?: {targetId: string, capability: string,
 *   expiresAt: number|null}[]}} probe `expiresAt` is null for a slot that
 *   was never dispatch-qualified.
 * @param {number} nowMs
 */
export function checkQualificationExpiry(probe, nowMs) {
	const id = "qualification-expiry";
	if (probe?.error)
		return result(id, STATUS.FAIL, `roster unreadable (${probe.error})`);
	const slots = probe?.slots ?? [];
	const never = slots.filter((slot) => slot.expiresAt === null);
	const dated = slots
		.filter((slot) => slot.expiresAt !== null)
		.sort((a, b) => a.expiresAt - b.expiresAt);
	const expired = dated.filter((slot) => slot.expiresAt <= nowMs);
	const soon = dated.filter(
		(slot) =>
			slot.expiresAt > nowMs &&
			slot.expiresAt - nowMs <= QUALIFICATION_WARN_DAYS * DAY_MS,
	);
	const attention = [...expired, ...soon, ...never];
	if (attention.length === 0)
		return result(
			id,
			STATUS.OK,
			slots.length === 0
				? "no active roster slots"
				: `${slots.length} slots; soonest expiry in ${days(dated[0].expiresAt - nowMs)} d`,
		);
	const parts = [];
	if (expired.length) parts.push(`${expired.length} expired`);
	if (soon.length)
		parts.push(`${soon.length} expire within ${QUALIFICATION_WARN_DAYS} d`);
	if (never.length) parts.push(`${never.length} never qualified`);
	const first = attention[0];
	const when =
		first.expiresAt === null
			? "never qualified"
			: first.expiresAt <= nowMs
				? `expired ${days(nowMs - first.expiresAt)} d ago`
				: `in ${days(first.expiresAt - nowMs)} d`;
	return result(
		id,
		STATUS.WARN,
		`${parts.join(", ")} of ${slots.length} slots; soonest ${first.targetId}/${first.capability} ${when}`,
		attention.map(
			(slot) =>
				`node scripts/provider-qualification.mjs --target ${slot.targetId} --capability ${slot.capability}  (plan only; --execute runs a paid qualification)`,
		),
	);
}

const REPAIR_KIND = { auth_expired: "auth_repaired" };

/**
 * Active route-health repair holds, each with the attestation command that
 * releases it after the owner repairs the cause.
 * @param {{error?: string, root: string, controls?: object[]}} probe
 */
export function checkRepairHolds(probe) {
	const id = "repair-holds";
	if (probe?.error)
		return result(
			id,
			STATUS.FAIL,
			`route-health state unreadable (${probe.error})`,
		);
	const held = (probe?.controls ?? []).filter(
		(control) => Array.isArray(control?.holds) && control.holds.length > 0,
	);
	if (held.length === 0) return result(id, STATUS.OK, "no repair holds");
	const fixes = [];
	const labels = [];
	for (const control of held) {
		const newest = control.holds.reduce((a, b) => (b.at > a.at ? b : a));
		const attested = (control.attestations ?? []).some(
			(attestation) =>
				attestation.publicConfigurationEpoch ===
					newest.publicConfigurationEpoch &&
				attestation.repairEpoch === control.repairEpoch &&
				attestation.at > newest.at,
		);
		labels.push(
			`${control.targetId} ${String(control.descriptorIdentity)
				.replace(/^sha256:/u, "")
				.slice(
					0,
					8,
				)} ${newest.code}${attested ? " (attested, awaiting trial)" : ""}`,
		);
		if (!attested)
			fixes.push(
				`after repairing ${newest.code}: ${DISPATCH} health attest-repair --target ${control.targetId} --descriptor ${control.descriptorIdentity} --public-configuration-epoch ${newest.publicConfigurationEpoch} --repair-kind ${REPAIR_KIND[newest.code] ?? "configuration_repaired"} --health-state-root ${probe.root}`,
			);
	}
	return result(
		id,
		STATUS.WARN,
		`${held.length} held: ${labels.join(", ")}`,
		fixes,
	);
}

/**
 * Pending routing attempts whose run is over or unconfirmed. An attempt
 * whose run is live is in flight, not stranded, and is not reported.
 * @param {{error?: string, pending?: {project: string, routingRunId: string,
 *   taskId: string, runState: string|null, live: boolean, closable: boolean,
 *   projectExists?: boolean}[]}} probe `runState` is null when the run record
 *   is missing.
 */
export function checkStrandedPending(probe) {
	const id = "stranded-pending";
	if (probe?.error)
		return result(id, STATUS.FAIL, `routing state unreadable (${probe.error})`);
	const stranded = (probe?.pending ?? []).filter((entry) => !entry.live);
	// A run whose project was deleted blocks nothing and no command reaches it.
	const inert = stranded.filter((entry) => entry.projectExists === false);
	const actionable = stranded.filter((entry) => entry.projectExists !== false);
	const note = inert.length ? `; ${inert.length} inert (project deleted)` : "";
	if (actionable.length === 0)
		return result(id, STATUS.OK, `no stranded pending attempts${note}`);
	const closable = actionable.filter((entry) => entry.closable).length;
	return result(
		id,
		STATUS.WARN,
		`${actionable.length} stranded (${closable} closable, ${actionable.length - closable} need inspection)${note}`,
		actionable.map((entry) =>
			entry.closable
				? `${DISPATCH} routing-run close-pending --project ${entry.project} --routing-run-id ${entry.routingRunId} --task-id ${entry.taskId}`
				: `${DISPATCH} routing-run inspect --project ${entry.project} --routing-run-id ${entry.routingRunId}`,
		),
	);
}

/**
 * Sandbox-canary LaunchAgent install state, plus the retired VM reaper, which
 * must be gone: its copied script outlives the repo files it came from.
 * @param {{canary: {plist: boolean, loaded: boolean, state?: object|null},
 *   reaper: {plist: boolean, loaded: boolean}}} probe
 * @param {number} nowMs
 */
export function checkLaunchAgents(probe, nowMs) {
	const id = "launch-agents";
	const problems = [];
	const fixes = [];
	const canary = probe?.canary ?? {};
	const reaper = probe?.reaper ?? {};
	if (!canary.plist || !canary.loaded) {
		problems.push(`canary ${canary.plist ? "not loaded" : "not installed"}`);
		fixes.push(
			"SWITCHYARD_CANARY_REV=$(git rev-parse HEAD) npm run canary:install",
		);
	} else {
		const ranAt = Date.parse(canary.state?.lastRunAt ?? "");
		if (!Number.isFinite(ranAt) || nowMs - ranAt > CANARY_STALE_MS)
			problems.push("canary has not run in 2 days");
		else if (canary.state?.lastStatus !== "passed")
			problems.push(`canary last ${canary.state?.lastStatus ?? "unknown"}`);
		if (problems.length)
			fixes.push(
				"read ~/Library/Logs/switchyard-sandbox-canary.launchd.err.log",
			);
	}
	if (reaper.plist || reaper.loaded) {
		problems.push("retired VM reaper LaunchAgent still installed");
		fixes.push(REAPER_UNINSTALL);
	}
	if (problems.length === 0)
		return result(id, STATUS.OK, "canary installed, loaded and current");
	return result(id, STATUS.WARN, problems.join("; "), fixes);
}
