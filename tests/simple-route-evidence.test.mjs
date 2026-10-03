import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	__resetRosterCacheForTests,
	resolveTargetId,
} from "../src/switchyard/roster/index.mjs";
import { route } from "../src/switchyard/router/index.mjs";
import {
	readRun,
	updateRunWithRetry,
} from "../src/switchyard/run-store/index.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { routeDiagnosticPatch } from "../src/switchyard/simple/route-evidence.mjs";
import {
	FIXTURE_PATH,
	withDispatchQualifiedDescriptors,
} from "./helpers/router-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const root = tempDir("route-evidence-");
const envKeys = ["SWITCHYARD_ROSTER_PATH", "SWITCHYARD_RUN_STORE_ROOT"];
const previous = envKeys.map((key) => process.env[key]);
before(() => {
	const path = join(root, "roster.json");
	writeFileSync(
		path,
		JSON.stringify(
			withDispatchQualifiedDescriptors(
				JSON.parse(readFileSync(FIXTURE_PATH, "utf8")),
			),
		),
	);
	process.env.SWITCHYARD_ROSTER_PATH = path;
	process.env.SWITCHYARD_RUN_STORE_ROOT = join(root, "runs");
	__resetRosterCacheForTests();
});
after(() => {
	envKeys.forEach((key, index) => {
		if (previous[index] === undefined) delete process.env[key];
		else process.env[key] = previous[index];
	});
	__resetRosterCacheForTests();
});
const snapshotRead = (providers, mtime = 123) => ({
	snapshot: { providers },
	snapshotStatus: "fresh",
	snapshotMtime: mtime,
	snapshotAgeMsAtRoute: 17,
});
const provider = (name, pace, percent = 80) => ({
	name,
	ok: true,
	windows: [{ percent_left: percent, pace_delta: pace }],
	privateData: "DO_NOT_PERSIST",
});
const select = (snapshot, extra = {}) =>
	route({
		requiredCapability: "standard",
		availableProviders: ["codex", "antigravity"],
		snapshotRead: snapshot,
		hasInvocationDescriptor: () => true,
		modelForCapability: () => "fixture",
		...extra,
	});

test("actual observed pass records candidate pace keys and closed exclusions without snapshot content", () => {
	const measured = select(
		snapshotRead([provider("codex", -2), provider("antigravity", 5)]),
	);
	strictEqual(measured.routeEvidence.selectedTargetId, "antigravity");
	strictEqual(measured.routeEvidence.selectionReason, "priority_fill");
	strictEqual(measured.routeEvidence.snapshotMtime, 123);
	deepStrictEqual(
		measured.routeEvidence.candidates.find((c) => c.targetId === "antigravity"),
		{
			targetId: "antigravity",
			priority: 1,
			paceStatus: "measured",
			paceKey: 5,
		},
	);
	const excluded = select(
		snapshotRead([provider("codex", Infinity), provider("antigravity", NaN)]),
		{ exclude: ["antigravity"] },
	);
	deepStrictEqual(excluded.routeEvidence.candidates[0], {
		targetId: "codex",
		priority: null,
		paceStatus: "unknown",
		paceKey: null,
	});
	deepStrictEqual(excluded.routeEvidence.excluded, [
		{ targetId: "antigravity", reason: "explicitly_excluded" },
	]);
	ok(!JSON.stringify(measured.routeEvidence).includes("DO_NOT_PERSIST"));
});

test("unavailable no-eligible closes provider error text and blind health is evaluated once per candidate", () => {
	const none = select(
		snapshotRead([
			{ ...provider("codex", 1), ok: false, error: "DO_NOT_PERSIST" },
		]),
	);
	strictEqual(none.routeEvidence.selectedTargetId, null);
	strictEqual(
		none.routeEvidence.selectionReason,
		"no_eligible_upstream_unavailable",
	);
	deepStrictEqual(none.routeEvidence.excluded, [
		{ targetId: "codex", reason: "provider_unavailable" },
	]);
	ok(!JSON.stringify(none.routeEvidence).includes("DO_NOT_PERSIST"));
	const calls = new Map();
	const blind = select(
		{
			snapshot: null,
			snapshotStatus: "missing",
			snapshotMtime: null,
			snapshotAgeMsAtRoute: null,
		},
		{
			healthDecision: ({ resolvedTargetId }) => {
				calls.set(resolvedTargetId, (calls.get(resolvedTargetId) ?? 0) + 1);
				return {
					suppress: resolvedTargetId === "antigravity",
					state: "DO_NOT_PERSIST",
				};
			},
		},
	);
	strictEqual(blind.routeEvidence.selectedTargetId, "codex");
	strictEqual(blind.routeEvidence.selectionReason, "blind_fallback");
	deepStrictEqual([...calls.values()], [1, 1]);
	deepStrictEqual(blind.routeEvidence.candidates, [
		{ targetId: "codex", priority: null, paceStatus: "unknown", paceKey: null },
	]);
	ok(
		blind.routeEvidence.excluded.some(
			(entry) =>
				entry.targetId === "antigravity" &&
				entry.reason === "route_health_suppressed",
		),
	);
});

test("diagnostic persistence bounds injected evidence and keeps old injected routes compatible", () => {
	deepStrictEqual(routeDiagnosticPatch({ provider: "codex" }), {});
	const evidence = {
		schemaVersion: 1,
		snapshotStatus: "DO_NOT_PERSIST",
		snapshotMtime: Infinity,
		snapshotAgeMsAtRoute: NaN,
		selectedTargetId: "codex",
		selectionReason: "DO_NOT_PERSIST",
		raw: "DO_NOT_PERSIST",
		candidates: Array.from({ length: 100 }, () => ({
			targetId: "codex",
			paceStatus: "measured",
			paceKey: Infinity,
			raw: "DO_NOT_PERSIST",
		})),
		excluded: Array.from({ length: 100 }, () => ({
			targetId: "codex",
			reason: "DO_NOT_PERSIST",
		})),
	};
	const patch = routeDiagnosticPatch({ routeEvidence: evidence });
	strictEqual(patch.routeEvidence.candidates.length, 64);
	strictEqual(patch.routeEvidence.excluded.length, 64);
	strictEqual(patch.routeEvidence.candidates[0].paceStatus, "unknown");
	strictEqual(patch.snapshotMtime, null);
	ok(!JSON.stringify(patch).includes("DO_NOT_PERSIST"));
});

function localFixture() {
	const dir = tempDir("route-evidence-local-");
	const projectPath = join(dir, "project");
	mkdirSync(projectPath);
	writeFileSync(join(projectPath, "a.txt"), "base\n");
	for (const args of [
		["init", "-q"],
		["add", "a.txt"],
		[
			"-c",
			"user.name=Tests",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-qm",
			"base",
		],
	])
		execFileSync("git", args, { cwd: projectPath });
	const promptPath = join(dir, "prompt.txt");
	writeFileSync(promptPath, "Change a.txt");
	const options = {
		projectPath,
		promptPath,
		files: ["a.txt"],
		checks: ["true"],
		capability: "standard",
		onlyProviders: ["codex", "antigravity"],
		deadlineMs: Date.now() + 60_000,
	};
	const deps = {
		tmpdir: dir,
		assertFundedRoute: () => {},
		getInvocationDescriptor: (name) => ({
			target_id: resolveTargetId(name),
			selector:
				resolveTargetId(name) === "antigravity"
					? "gemini-3.8-flash-medium"
					: "fixture-codex",
			invocation_args: [],
		}),
		createSimpleRouteHealthController: () => ({
			decision: () => ({ suppress: false }),
			prepare: async () => ({ allowed: true }),
			start: async () => ({ allowed: true }),
			terminal: async () => ({ settled: true }),
		}),
		runCheck: async () => ({ success: true, writerLifecycle: "stopped" }),
		executeProvider: async ({ worktreePath }) => {
			writeFileSync(join(worktreePath, "a.txt"), "changed\n");
			return { success: true, code: 0, writerLifecycle: "stopped" };
		},
	};
	return { options, deps };
}

test("simple durable run keeps successful, failed and no-eligible actual routing evidence", async () => {
	for (const outcome of ["success", "failure", "no-eligible", "blind"]) {
		const f = localFixture();
		f.deps.route = (input) =>
			select(
				outcome === "blind"
					? { snapshot: null, snapshotStatus: "missing" }
					: snapshotRead([
							provider("codex", 2, outcome === "no-eligible" ? 0 : 80),
						]),
				input,
			);
		if (outcome === "failure")
			f.deps.executeProvider = async () => ({
				success: false,
				code: 1,
				writerLifecycle: "stopped",
			});
		const result = await runSimpleTask(f.options, f.deps);
		const record = await readRun(result.runId);
		strictEqual(
			record.state,
			outcome === "failure" || outcome === "no-eligible"
				? "failed"
				: "succeeded",
			`${outcome}: ${result.failureReason}`,
		);
		strictEqual(
			record.routeEvidence.selectedTargetId,
			outcome === "no-eligible"
				? null
				: outcome === "blind"
					? "antigravity"
					: "codex",
		);
		strictEqual(
			record.snapshotStatus,
			outcome === "blind" ? "missing" : "fresh",
		);
		strictEqual(record.snapshotMtime, outcome === "blind" ? null : 123);
		strictEqual(
			record.routeEvidence.selectionReason,
			outcome === "no-eligible"
				? "no_eligible"
				: outcome === "blind"
					? "blind_fallback"
					: "spread",
		);
	}
});

test("health-start reroute replaces durable target, evidence and snapshot generation together", async () => {
	const f = localFixture();
	let starts = 0;
	let routes = 0;
	const executed = [];
	f.deps.updateRunWithRetry = async (id, patch) => {
		if (patch.routeEvidence) {
			strictEqual(patch.resolvedTargetId, patch.routeEvidence.selectedTargetId);
			strictEqual(patch.snapshotMtime, patch.routeEvidence.snapshotMtime);
		}
		return updateRunWithRetry(id, patch);
	};
	f.deps.createSimpleRouteHealthController = () => ({
		decision: () => ({ suppress: false }),
		prepare: async () => ({ allowed: true }),
		start: async () =>
			++starts === 1 ? { allowed: false, reroute: true } : { allowed: true },
		terminal: async () => ({ settled: true }),
	});
	f.deps.route = (input) =>
		select(
			snapshotRead(
				[provider("antigravity", 3), provider("codex", 4)],
				++routes * 100,
			),
			input,
		);
	f.deps.executeProvider = async ({ targetId, worktreePath }) => {
		executed.push(targetId);
		writeFileSync(join(worktreePath, "a.txt"), "changed\n");
		return { success: true, code: 0, writerLifecycle: "stopped" };
	};
	const result = await runSimpleTask(f.options, f.deps);
	strictEqual(result.status, "succeeded");
	const record = await readRun(result.runId);
	deepStrictEqual(executed, ["codex"]);
	strictEqual(record.resolvedTargetId, "codex");
	strictEqual(record.routeEvidence.selectedTargetId, "codex");
	strictEqual(record.snapshotMtime, 200);
	strictEqual(record.routeEvidence.snapshotMtime, 200);
	ok(
		record.routeEvidence.excluded.some(
			(entry) =>
				entry.targetId === "antigravity" &&
				entry.reason === "adapter_unavailable",
		),
	);
	strictEqual(routes, 2);
});

test("drained providers remain excluded and Cursor bucket skips retain their bucket", () => {
	const drained = select(
		snapshotRead([provider("codex", 1, 0), provider("antigravity", 2, 0)]),
	);
	strictEqual(drained.provider, null);
	deepStrictEqual(drained.routeEvidence.excluded, [
		{ targetId: "codex", reason: "no_quota_headroom" },
		{ targetId: "antigravity", reason: "no_quota_headroom" },
	]);
	for (const bucket of ["ac", "ap"]) {
		const result = select(
			snapshotRead([
				{
					name: "cursor-pro",
					ok: true,
					windows: [
						{ id: "ac", percent_left: bucket === "ac" ? 0 : 80 },
						{ id: "ap", percent_left: bucket === "ap" ? 0 : 80 },
					],
				},
			]),
			{ availableProviders: ["cursor-pro"] },
		);
		strictEqual(result.routeEvidence.selectedTargetId, "cursor-pro");
		deepStrictEqual(result.routeEvidence.excluded, [
			{ targetId: "cursor-pro", reason: "quota_exhausted", bucket },
		]);
		deepStrictEqual(
			routeDiagnosticPatch(result).routeEvidence.excluded,
			result.routeEvidence.excluded,
		);
	}
});

test("pinned incompatible adapter persists a closed decision without inventing a snapshot", async () => {
	const f = localFixture();
	f.options.onlyProviders = ["antigravity"];
	f.deps.getInvocationDescriptor = () => ({
		target_id: "antigravity",
		selector: "incompatible",
		invocation_args: [],
	});
	f.deps.route = () => {
		throw new Error("adapter rejection must precede router");
	};
	const result = await runSimpleTask(f.options, f.deps);
	strictEqual(result.failureReason, "local_descriptor_model_unavailable");
	const record = await readRun(result.runId);
	strictEqual(record.routeEvidence.snapshotStatus, "not_checked");
	strictEqual(record.snapshotMtime, null);
	strictEqual(record.routeEvidence.selectedTargetId, null);
	strictEqual(
		record.routeEvidence.selectionReason,
		"local_descriptor_model_unavailable",
	);
	deepStrictEqual(record.routeEvidence.excluded, [
		{ targetId: "antigravity", reason: "local_descriptor_model_unavailable" },
	]);
});

test("route evidence durability failure is classified and stops before provider launch", async () => {
	for (const failAt of [1, 3]) {
		const f = localFixture();
		let evidenceWrites = 0;
		let starts = 0;
		let launches = 0;
		f.deps.route = (input) =>
			select(
				snapshotRead([provider("antigravity", 3), provider("codex", 4)]),
				input,
			);
		f.deps.createSimpleRouteHealthController = () => ({
			decision: () => ({ suppress: false }),
			prepare: async () => ({ allowed: true }),
			start: async () =>
				++starts === 1 ? { allowed: false, reroute: true } : { allowed: true },
			terminal: async () => ({ settled: true }),
		});
		f.deps.updateRunWithRetry = async (id, patch) => {
			if (patch.routeEvidence && ++evidenceWrites === failAt)
				throw Object.assign(new Error("injected write failure"), {
					code: failAt === 3 ? "EACCES" : undefined,
				});
			return updateRunWithRetry(id, patch);
		};
		f.deps.executeProvider = async () => {
			launches += 1;
			throw new Error("must never launch");
		};
		const result = await runSimpleTask(f.options, f.deps);
		strictEqual(result.status, "failed");
		strictEqual(result.failureReason, "run_store_write_failed");
		strictEqual(
			result.errorKind,
			failAt === 3 ? "permission_denied" : "run_store_write_failed",
		);
		strictEqual(result.failurePhase, "route");
		strictEqual(launches, 0);
		const record = await readRun(result.runId);
		strictEqual(record.state, "failed");
		strictEqual(record.lastFailure.errorKind, result.errorKind);
	}
});
