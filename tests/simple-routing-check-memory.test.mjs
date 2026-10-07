import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import {
	knownBrokenCheck,
	rememberBrokenCheck,
} from "../src/switchyard/simple/routing-check-memory.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import {
	MAX_BROKEN_CHECKS,
	openRoutingRun,
	readRoutingRunState,
} from "../src/switchyard/simple/routing-state.mjs";
import { fixture } from "./helpers/simple-routing-fixture.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const identity = (command) =>
	createHash("sha256").update(command).digest("hex");
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u;
const entryFor = (command, overrides = {}) => ({
	checkIdentity: identity(command),
	causeCode: "check_environment_failed",
	signature: "exec_denied",
	outputPath: `/var/tmp/${identity(command).slice(0, 8)}.log`,
	at: "2026-01-01T00:00:00.000Z",
	...overrides,
});
const stateFixture = () => ({
	project: realpathSync(tempDir("routing-project-")),
	stateRoot: realpathSync(tempDir("routing-state-")),
});

test("environment-broken dry-run check is remembered and later invocations stop before allocating", async () => {
	const command = "true";
	const providerReliability = createProviderReliabilityDiagnostic({
		causeCode: "check_environment_failed",
		phase: "baseline",
		checkIdentity: identity(command),
	});
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			result: {
				failurePhase: "baseline",
				failureReason: "check_environment_failed",
				errorKind: "environment_failure",
				providerReliability,
			},
			record: {
				failureDetails: {
					failureReason: "check_environment_failed",
					checkIndex: 1,
					checkIdentity: identity(command),
					checkEnvironmentSignature: "exec_denied",
					outputPath: "/var/tmp/check-evidence-1.log",
				},
			},
		},
	});
	const first = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(first.direction, "stop");
	strictEqual(first.stopReason, "check_environment_failed");
	deepStrictEqual(f.calls, ["antigravity-claude"]);
	strictEqual(first.attempts.length, 1);
	strictEqual(first.attempts[0].terminal, "skipped");
	deepStrictEqual(first.failedTargetIds, []);
	const state = readRoutingRunState(f.options.projectPath, "run-1", {
		stateRoot: f.deps.stateRoot,
	});
	strictEqual(state.brokenChecks.length, 1);
	const [entry] = state.brokenChecks;
	strictEqual(entry.checkIdentity, identity(command));
	strictEqual(entry.causeCode, "check_environment_failed");
	strictEqual(entry.signature, "exec_denied");
	strictEqual(entry.outputPath, "/var/tmp/check-evidence-1.log");
	strictEqual(ISO.test(entry.at), true);
	// A second invocation with the same routing run id allocates nothing.
	const second = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(second.direction, "stop");
	strictEqual(second.stopReason, "check_known_broken");
	deepStrictEqual(f.calls, ["antigravity-claude"]);
	strictEqual(second.attempts.length, 1);
	deepStrictEqual(second.brokenCheck, entry);
	deepStrictEqual(second.failedTargetIds, []);
	// The memory is run-scoped: a different routing run id starts over.
	f.options.routingRunId = "run-2";
	const isolated = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(isolated.stopReason, "check_environment_failed");
	deepStrictEqual(f.calls, ["antigravity-claude", "antigravity-claude"]);
});

test("genuine check failure continues to the next provider and writes no memory", async () => {
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			result: {
				failurePhase: "checks",
				failureReason: "check_failed",
				errorKind: "check_failed",
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "acceptance_check_failed",
					phase: "check",
				}),
			},
		},
	});
	const outcome = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(outcome.direction, "complete");
	deepStrictEqual(f.calls, ["antigravity-claude", "codex"]);
	const state = readRoutingRunState(f.options.projectPath, "run-1", {
		stateRoot: f.deps.stateRoot,
	});
	strictEqual(state.attempts.length, 2);
	deepStrictEqual(state.brokenChecks ?? [], []);
});

test("post-provider environment classification stops without writing memory", async () => {
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			result: {
				failurePhase: "checks",
				failureReason: "check_environment_failed",
				errorKind: "environment_failure",
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "check_environment_failed",
					phase: "check",
				}),
			},
			record: {
				failureDetails: {
					checkIdentity: identity("true"),
					checkEnvironmentSignature: "sandbox_denial",
				},
			},
		},
	});
	const outcome = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(outcome.direction, "stop");
	strictEqual(outcome.stopReason, "check_environment_failed");
	deepStrictEqual(f.calls, ["antigravity-claude"]);
	deepStrictEqual(
		readRoutingRunState(f.options.projectPath, "run-1", {
			stateRoot: f.deps.stateRoot,
		}).brokenChecks ?? [],
		[],
	);
});

test("a state file without brokenChecks passes validation", () => {
	const { project, stateRoot } = stateFixture();
	const h = openRoutingRun(project, "run-1", { stateRoot });
	const path = join(h.runDir, "state.json");
	h.release();
	// A fresh state file keeps the exact pre-brokenChecks key set.
	const fresh = JSON.parse(readFileSync(path));
	strictEqual("brokenChecks" in fresh, false);
	delete fresh.brokenChecks;
	writeFileSync(path, JSON.stringify(fresh));
	const reloaded = readRoutingRunState(project, "run-1", { stateRoot });
	strictEqual(reloaded.schemaVersion, 1);
	strictEqual(reloaded.brokenChecks, undefined);
	strictEqual(knownBrokenCheck(reloaded, ["true"]), null);
});

test("malformed broken-check memory fails closed", () => {
	const { project, stateRoot } = stateFixture();
	const h = openRoutingRun(project, "run-1", { stateRoot });
	h.commit({ brokenChecks: [entryFor("true")] });
	const path = join(h.runDir, "state.json");
	h.release();
	const state = JSON.parse(readFileSync(path));
	for (const mutate of [
		(s) => {
			s.brokenChecks = "not-an-array";
		},
		(s) => {
			s.brokenChecks = [{}];
		},
		(s) => {
			s.brokenChecks = [entryFor("true", { extra: "field" })];
		},
		(s) => {
			s.brokenChecks = [
				entryFor("true", { causeCode: "acceptance_check_failed" }),
			];
		},
		(s) => {
			s.brokenChecks = [entryFor("true", { signature: "not_a_signature" })];
		},
		(s) => {
			s.brokenChecks = [entryFor("true", { outputPath: "relative/log.txt" })];
		},
		(s) => {
			s.brokenChecks = [entryFor("true", { at: "yesterday" })];
		},
		(s) => {
			s.brokenChecks = Array.from(
				{ length: MAX_BROKEN_CHECKS + 1 },
				(_, index) => entryFor(`command-${index}`),
			);
		},
	]) {
		const next = structuredClone(state);
		mutate(next);
		writeFileSync(path, JSON.stringify(next));
		throws(() => readRoutingRunState(project, "run-1", { stateRoot }), {
			code: "routing_state_malformed",
		});
	}
});

test("broken-check memory is append-only across commits", () => {
	const { project, stateRoot } = stateFixture();
	const h = openRoutingRun(project, "run-1", { stateRoot });
	const first = entryFor("true");
	const second = entryFor("npm test");
	h.commit({ brokenChecks: [first] });
	throws(() => h.commit({ brokenChecks: [] }), {
		code: "routing_state_nonmonotonic",
	});
	const mutated = entryFor("true", { signature: "tool_missing" });
	throws(() => h.commit({ brokenChecks: [mutated] }), {
		code: "routing_state_nonmonotonic",
	});
	h.commit({ brokenChecks: [first, second] });
	h.commit({});
	h.release();
	deepStrictEqual(
		readRoutingRunState(project, "run-1", { stateRoot }).brokenChecks,
		[first, second],
	);
});

test("knownBrokenCheck matches command identities and reports the stored evidence", () => {
	const entry = entryFor("npm test");
	const state = { brokenChecks: [entry] };
	deepStrictEqual(knownBrokenCheck(state, ["true", "npm test"]), entry);
	strictEqual(knownBrokenCheck(state, ["true"]), null);
	strictEqual(knownBrokenCheck(state), null);
	strictEqual(knownBrokenCheck({}, ["npm test"]), null);
});

test("rememberBrokenCheck writes only pre-provider evidence-backed classifications", () => {
	const { project, stateRoot } = stateFixture();
	const h = openRoutingRun(project, "run-1", { stateRoot });
	const input = (overrides = {}) => ({
		result: {
			failurePhase: "baseline",
			providerReliability: createProviderReliabilityDiagnostic({
				causeCode: "check_environment_failed",
				phase: "baseline",
				checkIdentity: identity("true"),
			}),
			...overrides.result,
		},
		record: {
			failureDetails: {
				checkIdentity: identity("true"),
				checkEnvironmentSignature: "exec_denied",
				outputPath: "/var/tmp/check-evidence-1.log",
			},
			...overrides.record,
		},
		now: () => 0,
	});
	deepStrictEqual(rememberBrokenCheck(h.state, h.commit, input()), {
		checkIdentity: identity("true"),
		causeCode: "check_environment_failed",
		signature: "exec_denied",
		outputPath: "/var/tmp/check-evidence-1.log",
		at: "1970-01-01T00:00:00.000Z",
	});
	strictEqual(h.state.brokenChecks.length, 1);
	// Post-provider classifications never write memory.
	const postProvider = rememberBrokenCheck(
		h.state,
		h.commit,
		input({ result: { failurePhase: "checks" } }),
	);
	strictEqual(postProvider, null);
	// Genuine check failures never write memory.
	const genuineReliability = createProviderReliabilityDiagnostic({
		causeCode: "acceptance_check_failed",
		phase: "check",
	});
	const genuineCheck = rememberBrokenCheck(
		h.state,
		h.commit,
		input({ result: { providerReliability: genuineReliability } }),
	);
	strictEqual(genuineCheck, null);
	// Missing, unclassified or untrustworthy durable evidence never writes.
	for (const overrides of [
		{ record: { failureDetails: {} } },
		{
			record: {
				failureDetails: {
					checkIdentity: identity("true"),
					checkEnvironmentSignature: "not_a_signature",
				},
			},
		},
		{
			record: {
				failureDetails: {
					checkIdentity: "not-hex",
					checkEnvironmentSignature: "exec_denied",
				},
			},
		},
	])
		strictEqual(rememberBrokenCheck(h.state, h.commit, input(overrides)), null);
	strictEqual(h.state.brokenChecks.length, 1);
	// The memory is capped: a full list never grows past the cap.
	const existing = h.state.brokenChecks;
	h.commit({
		brokenChecks: [
			...existing,
			...Array.from(
				{ length: MAX_BROKEN_CHECKS - existing.length },
				(_, index) => entryFor(`command-${index}`),
			),
		],
	});
	strictEqual(rememberBrokenCheck(h.state, h.commit, input()), null);
	strictEqual(h.state.brokenChecks.length, MAX_BROKEN_CHECKS);
	h.release();
});
