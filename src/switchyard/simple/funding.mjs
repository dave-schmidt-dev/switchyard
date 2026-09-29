import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSnapshotAtRoute } from "../router/index.mjs";

function rosterPath() {
	return (
		process.env.SWITCHYARD_ROSTER_PATH ||
		join(homedir(), ".agent", "roster.json")
	);
}
const SIMPLE_INCLUDED_USAGE_FLOOR = 5;
const SIMPLE_INCLUDED_USAGE_WINDOWS = Object.freeze([
	"five_hour",
	"weekly",
	"monthly",
]);
export function simpleRouteFundingFailure(target, options = {}) {
	if (
		target?.enabled !== true ||
		!["subscription", "quota"].includes(target.funding?.included?.mode)
	) {
		return "paid_overage_not_allowed";
	}
	if (target.funding?.overage?.enabled === false) return null;
	if (
		options.targetId !== "opencode-go" ||
		target.funding?.included?.mode !== "subscription"
	) {
		return "paid_overage_not_allowed";
	}

	const snapshotRead = options.snapshotRead ?? readSnapshotAtRoute(Date.now());
	if (
		snapshotRead?.snapshotStatus !== "fresh" ||
		!Array.isArray(snapshotRead.snapshot?.providers)
	) {
		return "included_usage_unverified";
	}
	const matchingProviders = snapshotRead.snapshot.providers.filter(
		(provider) =>
			typeof target.snapshot_name === "string" &&
			provider?.name === target.snapshot_name,
	);
	if (matchingProviders.length !== 1 || matchingProviders[0]?.ok !== true) {
		return "included_usage_unverified";
	}

	const providerWindows = matchingProviders[0].windows;
	if (!Array.isArray(providerWindows)) return "included_usage_unverified";
	const requiredWindows = new Map();
	for (const window of providerWindows) {
		if (!window || typeof window !== "object") {
			return "included_usage_unverified";
		}
		if (!SIMPLE_INCLUDED_USAGE_WINDOWS.includes(window.id)) continue;
		if (requiredWindows.has(window.id)) return "included_usage_unverified";
		requiredWindows.set(window.id, window);
	}
	for (const id of SIMPLE_INCLUDED_USAGE_WINDOWS) {
		const window = requiredWindows.get(id);
		if (
			!window ||
			typeof window.percent_left !== "number" ||
			!Number.isFinite(window.percent_left) ||
			window.percent_left < SIMPLE_INCLUDED_USAGE_FLOOR ||
			window.percent_left > 100
		) {
			return "included_usage_unverified";
		}
	}
	return null;
}
export function simpleRouteIsFunded(target, options = {}) {
	return simpleRouteFundingFailure(target, options) === null;
}
function assertFundedRoute(targetId) {
	let roster;
	try {
		roster = JSON.parse(readFileSync(rosterPath(), "utf8"));
	} catch {
		throw Object.assign(new Error("roster_unavailable"), {
			code: "roster_unavailable",
		});
	}
	const target = roster?.targets?.[targetId];
	const failure = simpleRouteFundingFailure(target, { targetId });
	if (failure) {
		throw Object.assign(new Error(failure), {
			code: failure,
		});
	}
}

export { assertFundedRoute };
