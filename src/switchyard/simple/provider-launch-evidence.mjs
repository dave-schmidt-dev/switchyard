import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const DESCRIPTOR = /^sha256:[a-f0-9]{64}$/u;
const KEYS =
	"attemptId,descriptorIdentity,launchId,observedAt,phase,pid,processGroupId,processStart,publication,runId,taskId,worktreeNonce";
const pidValid = (value) =>
	value === null || (Number.isSafeInteger(value) && value > 0);
const timeValid = (value) =>
	typeof value === "string" &&
	Number.isFinite(Date.parse(value)) &&
	new Date(value).toISOString() === value;
const startValid = (value) =>
	value === null ||
	(value &&
		Object.keys(value).sort().join() === "precision,source,stamp" &&
		value.source === "ps_lstart" &&
		value.precision === "seconds" &&
		typeof value.stamp === "string" &&
		value.stamp.length > 0 &&
		value.stamp.length <= 64 &&
		![...value.stamp].some(
			(char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127,
		));

/** Validate bounded historical launch observations; none confer signal/recovery authority. */
export function isProviderLaunches(value, run) {
	if (!Array.isArray(value) || value.length < 1 || value.length > 2)
		return false;
	return value.every((entry, index) => {
		if (!entry || Object.keys(entry).sort().join() !== KEYS) return false;
		if (
			![entry.runId, entry.taskId, entry.attemptId].every(
				(id) => typeof id === "string" && ID.test(id),
			)
		)
			return false;
		if (
			typeof entry.launchId !== "string" ||
			!UUID.test(entry.launchId) ||
			typeof entry.worktreeNonce !== "string" ||
			!UUID.test(entry.worktreeNonce)
		)
			return false;
		if (entry.phase !== (index === 0 ? "execute" : "repair")) return false;
		if (
			entry.descriptorIdentity !== null &&
			(typeof entry.descriptorIdentity !== "string" ||
				!DESCRIPTOR.test(entry.descriptorIdentity))
		)
			return false;
		if (
			!timeValid(entry.observedAt) ||
			!pidValid(entry.pid) ||
			!pidValid(entry.processGroupId) ||
			!startValid(entry.processStart)
		)
			return false;
		if (
			!["starting", "observed", "identity_unavailable"].includes(
				entry.publication,
			)
		)
			return false;
		if (
			entry.publication === "starting" &&
			(entry.pid !== null ||
				entry.processGroupId !== null ||
				entry.processStart !== null)
		)
			return false;
		if (
			entry.publication === "observed" &&
			(entry.pid === null ||
				entry.processGroupId === null ||
				entry.processStart === null)
		)
			return false;
		if (
			index &&
			(entry.launchId === value[0].launchId ||
				["runId", "taskId", "attemptId", "worktreeNonce"].some(
					(key) => entry[key] !== value[0][key],
				))
		)
			return false;
		return (
			!run ||
			(entry.runId === run.runId &&
				Array.isArray(run.orderedTaskIds) &&
				run.orderedTaskIds.includes(entry.taskId) &&
				entry.worktreeNonce === run.worktree?.nonce)
		);
	});
}

const failure = () =>
	Object.assign(new Error("provider launch evidence unavailable"), {
		code: "run_store_write_failed",
	});

/** Persist a pre-spawn intent and one exact observation for primary and repair. */
export function createProviderLaunchEvidence({
	runId,
	taskId,
	attemptId,
	updateRun,
	now = Date.now,
	makeId = randomUUID,
}) {
	let entries = [];
	let activeId = null;
	let writing = false;
	return {
		async begin(phase, { descriptorIdentity = null, worktreeNonce }) {
			if (writing) throw failure();
			activeId = null;
			const entry = {
				runId,
				taskId,
				attemptId,
				launchId: makeId(),
				phase,
				descriptorIdentity,
				worktreeNonce,
				publication: "starting",
				observedAt: new Date(now()).toISOString(),
				pid: null,
				processGroupId: null,
				processStart: null,
			};
			const next = [...entries, entry];
			if (!isProviderLaunches(next)) throw failure();
			writing = true;
			try {
				await updateRun(runId, { providerLaunches: structuredClone(next) });
			} catch {
				throw failure();
			} finally {
				writing = false;
			}
			entries = next;
			activeId = entry.launchId;
			let invoked = false;
			return async ({
				pid = null,
				processGroupId = null,
				processStart = null,
			} = {}) => {
				if (writing || invoked || activeId !== entry.launchId) throw failure();
				invoked = true;
				const observed = {
					...entry,
					pid,
					processGroupId,
					processStart,
					observedAt: new Date(now()).toISOString(),
					publication:
						pid !== null && processGroupId !== null && processStart !== null
							? "observed"
							: "identity_unavailable",
				};
				const updated = entries.map((item) =>
					item.launchId === entry.launchId ? observed : item,
				);
				if (!isProviderLaunches(updated)) throw failure();
				writing = true;
				try {
					await updateRun(runId, {
						providerLaunches: structuredClone(updated),
					});
				} catch {
					throw failure();
				} finally {
					writing = false;
				}
				entries = updated;
			};
		},
	};
}
