import { deepStrictEqual, strictEqual } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	after,
	afterEach,
	before,
	beforeEach,
	describe,
	it,
	mock,
} from "node:test";
import { boundProviderLifecycleSnapshot } from "../src/switchyard/adapter/provider-lifecycle-progress.mjs";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import {
	createDefaultRouteHealthDecision,
	createRouteHealthTerminalBinding,
	ingestRouteHealthEvents,
	inspectRouteHealth,
} from "../src/switchyard/router/health.mjs";
import { updateScope } from "../src/switchyard/router/health-lock.mjs";
import {
	COOLDOWN_MS,
	hash,
	identityFrom,
	locations,
	MAX_ATTEMPTS,
	scopeKey,
	TRANSIENT_CODES,
	WINDOW_MS,
} from "../src/switchyard/router/health-schema.mjs";
import {
	createEvent,
	getStateRoot,
} from "../src/switchyard/run-store/index.mjs";
import { deriveFailureAccountability } from "../src/switchyard/simple/failure-accountability.mjs";
import { createSimpleRouteHealthController } from "../src/switchyard/simple/health.mjs";
import {
	classifyExecutionFailure,
	runSimpleWriter,
} from "../src/switchyard/simple/provider-invocation.mjs";
import { createSimpleProviderReliabilityDiagnostic } from "../src/switchyard/simple/reliability.mjs";
import { createSimpleRouteSelection } from "../src/switchyard/simple/route-selection.mjs";
import { tempDir } from "./helpers/tempdir.mjs";
import {
	cleanupHealthFixture,
	descriptorFor,
	HEALTH_ROOT,
	healthIdentity,
	initializeHealthRun,
	localLifecycle,
	routeHealthEpoch,
	setupHealthFixture,
	simpleInput,
	vmLifecycle,
} from "./provider-reliability-health-fixture.mjs";

const MIN = 60_000;
const SECOND = 1_000;
const provider = (causeCode, more = {}) =>
	createProviderReliabilityDiagnostic({
		causeCode,
		phase: "provider",
		...more,
	});
const withLifecycle = (exitCode, more) => ({
	...localLifecycle(exitCode),
	...more,
});

// Provider outcomes as the simple controller receives them. Every failure here
// carries a closed lifecycle receipt and a settled writer group but no adapter
// diagnostic, which is exactly what agy produces.
const OUTCOMES = {
	success: () => ({
		providerResult: { success: true, code: 0, writerLifecycle: "stopped" },
		providerLifecycle: localLifecycle(0),
	}),
	exit: () => ({
		providerResult: { success: false, code: 3, writerLifecycle: "stopped" },
		providerReliability: provider("provider_exit_nonzero", { exitCode: 3 }),
		providerLifecycle: localLifecycle(3),
	}),
	signal: () => ({
		providerResult: {
			success: false,
			code: null,
			signal: "SIGKILL",
			writerLifecycle: "stopped",
		},
		providerReliability: provider("provider_signalled", { signal: "SIGKILL" }),
		providerLifecycle: withLifecycle(null, { signal: "SIGKILL" }),
	}),
	deadline: () => ({
		providerResult: {
			success: false,
			code: null,
			timedOut: true,
			writerLifecycle: "stopped",
		},
		providerReliability: provider("provider_deadline_exceeded", {
			timedOut: true,
		}),
		providerLifecycle: withLifecycle(null, {
			terminalStatus: "terminated",
			terminationReason: "deadline",
		}),
	}),
	cancelled: () => ({
		providerResult: {
			success: false,
			code: null,
			cancelled: true,
			writerLifecycle: "stopped",
		},
		providerReliability: provider("cancelled", { cancelled: true }),
		providerLifecycle: withLifecycle(null, {
			terminalStatus: "terminated",
			terminationReason: "cancelled",
		}),
	}),
	unconfirmed: () => ({
		...OUTCOMES.exit(),
		providerResult: { success: false, code: 3, writerLifecycle: "unavailable" },
	}),
};

let base;
let serial = 0;
const clock = (offsetMs) => mock.timers.setTime(base + offsetMs);
const nextId = () => {
	serial += 1;
	return serial;
};
const rootFor = (name) => join(HEALTH_ROOT, `${name}-${nextId()}`);
const codex = () => descriptorFor("codex");
const inspect = (root, descriptor = codex()) =>
	inspectRouteHealth(healthIdentity(root, descriptor, routeHealthEpoch()));

function ledger(root, descriptor = codex()) {
	const identity = identityFrom({
		targetId: descriptor.target_id,
		descriptorIdentity: descriptor.descriptor_identity,
	});
	const path = locations(root, scopeKey(identity)).observations;
	if (!existsSync(path)) return { failures: 0, generation: null, seen: 0 };
	const observations = JSON.parse(readFileSync(path, "utf8"));
	const [generation] = Object.values(observations.generations);
	const attempts = generation?.attempts ?? [];
	return {
		failures: attempts.filter(({ code }) => TRANSIENT_CODES.has(code)).length,
		generation,
		attempts,
		seen: observations.seenAttemptIds.length,
	};
}

async function dispatch(root, kind, { descriptor = codex(), ...options } = {}) {
	const run = await initializeHealthRun(`task-${nextId()}`);
	const controller = createSimpleRouteHealthController({
		healthStateRoot: root,
		runId: run.runId,
		taskId: run.taskId,
		...options,
	});
	const prepared = await controller.prepare(simpleInput(descriptor));
	if (!prepared.allowed) return { prepared };
	const started = await controller.start();
	if (!started.allowed) return { prepared, started };
	const terminal = await controller.terminal(
		typeof kind === "string" ? OUTCOMES[kind]() : kind,
	);
	return { prepared, started, terminal, controller };
}

async function fail(root, kind, offsetMs, options) {
	clock(offsetMs);
	return dispatch(root, kind, options);
}

const decisionFor = (root, healthMode = "enforce", descriptor = codex()) =>
	createSimpleRouteHealthController({
		healthStateRoot: root,
		healthMode,
	}).decision({
		provider: descriptor.target_id,
		requiredCapability: "standard",
	});

// Terminal-binding input for a settled, lifecycle-closed provider failure.
const failed = (providerReliability, exitCode) => ({
	providerReliability,
	providerLifecycle: localLifecycle(exitCode),
	providerWriterLifecycle: "stopped",
	exitCode: exitCode ?? undefined,
});
const bindingFor = (overrides = {}, descriptor = codex()) =>
	createRouteHealthTerminalBinding({
		targetId: descriptor.target_id,
		descriptorIdentity: descriptor.descriptor_identity,
		invocationDescriptor: descriptor,
		descriptorHarness: "codex",
		publicConfigurationEpoch: routeHealthEpoch(),
		repairEpoch: 0,
		runId: "run",
		taskId: "task",
		attempt: "provider-1",
		healthLane: "simple-direct",
		providerExecutionSucceeded: false,
		...overrides,
	});

// The default mode and root are under test, so no caller override may leak in.
const ENV_KEYS = [
	"SWITCHYARD_ROUTE_HEALTH_MODE",
	"SWITCHYARD_ROUTE_HEALTH_STATE_ROOT",
];
const savedEnv = new Map();
before(() => {
	setupHealthFixture();
	for (const key of ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
		delete process.env[key];
	}
});
after(() => {
	for (const [key, value] of savedEnv)
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	cleanupHealthFixture();
});
beforeEach(() => {
	base = Date.now();
	mock.timers.enable({ apis: ["Date"], now: base });
});
afterEach(() => mock.timers.reset());

describe("simple route-health enforcement", () => {
	it("enforces by default for simple dispatch, honours the shadow opt-out, and leaves the queue in shadow", () => {
		const root = rootFor("mode");
		const mode = (options, env) => {
			if (env === undefined) delete process.env.SWITCHYARD_ROUTE_HEALTH_MODE;
			else process.env.SWITCHYARD_ROUTE_HEALTH_MODE = env;
			return createSimpleRouteHealthController({
				healthStateRoot: root,
				...options,
			}).decision.mode;
		};
		strictEqual(mode({}), "enforce");
		strictEqual(mode({}, "shadow"), "shadow");
		strictEqual(mode({}, "enforce"), "enforce");
		strictEqual(mode({ healthMode: "shadow" }, "enforce"), "shadow");
		delete process.env.SWITCHYARD_ROUTE_HEALTH_MODE;
		strictEqual(
			createSimpleRouteHealthController({}).decision.healthStateRoot,
			join(getStateRoot(), "route-health"),
		);
		strictEqual(
			createDefaultRouteHealthDecision({
				healthStateRoot: root,
				qualifiedProviders: ["codex"],
			}).mode,
			"shadow",
		);
	});

	it("keeps the contract constants: a 6 h window and the 5/15/60 minute ladder", () => {
		strictEqual(WINDOW_MS, 6 * 60 * MIN);
		deepStrictEqual(COOLDOWN_MS, [5 * MIN, 15 * MIN, 60 * MIN]);
	});

	it("suppresses a target after three provider-caused failures inside the window", async () => {
		const root = rootFor("three");
		// Shadow records without rerouting, so all three failures land.
		for (const [index, kind] of ["exit", "signal", "deadline"].entries()) {
			const result = await fail(root, kind, index * MIN, {
				healthMode: "shadow",
			});
			strictEqual(result.terminal.settled, true);
		}
		strictEqual(ledger(root).failures, 3);
		clock(3 * MIN);
		const enforced = decisionFor(root);
		strictEqual(enforced.state, "cooldown");
		strictEqual(enforced.suppress, true);
		strictEqual(decisionFor(root, "shadow").suppress, false);
		const blocked = await dispatch(root, "success");
		strictEqual(blocked.prepared.allowed, false);
		strictEqual(blocked.prepared.reason, "route-health-blocked");
	});

	it("marks the first failure suspect and reroutes after the second", async () => {
		const root = rootFor("ladder");
		const first = await fail(root, "exit", 0);
		strictEqual(first.terminal.settled, true);
		strictEqual((await inspect(root)).state, "suspect");
		strictEqual((await fail(root, "exit", SECOND)).prepared.allowed, true);
		const state = await inspect(root);
		strictEqual(state.state, "cooldown");
		strictEqual(ledger(root).generation.cooldownStep, 1);
		clock(2 * SECOND);
		strictEqual(decisionFor(root).suppress, true);
	});

	it("never counts check, scope, sandbox or environment failures", async () => {
		const root = rootFor("non-provider");
		// A provider that succeeded and then failed its checks is a success to health.
		await fail(root, "success", 0);
		const run = await initializeHealthRun(["t1", "t2", "t3", "t4", "t5"]);
		const fixtures = [
			["t1", "acceptance_check_failed", "check"],
			["t2", "scope_rejected", "diff"],
			["t3", "check_environment_unavailable", "check"],
			["t4", "environment_failure", "check"],
			["t5", "baseline_check_failed", "baseline"],
		];
		for (const [taskId, causeCode, phase] of fixtures) {
			const diagnostic = createProviderReliabilityDiagnostic({
				causeCode,
				phase,
				checkIndex: phase === "check" ? 1 : undefined,
				baselineStatus: phase === "baseline" ? "failed" : undefined,
				diffRejectionCategory: phase === "diff" ? "undeclared" : undefined,
			});
			await createEvent(run.runId, {
				phase: "execution",
				event: "task_failed",
				status: "failed",
				taskId,
				attempt: `attempt-${taskId}`,
				providerReliability: diagnostic,
			});
			// Even a verified closed lifecycle cannot turn them into provider health.
			strictEqual(bindingFor(failed(diagnostic, 3)), null, causeCode);
		}
		deepStrictEqual(
			await ingestRouteHealthEvents({
				authorisedRuns: [{ runId: run.runId, runRoot: run.runRoot }],
				healthStateRoot: root,
			}),
			[],
		);
		strictEqual(ledger(root).attempts.length, 1);
		strictEqual(ledger(root).failures, 0);
		strictEqual((await inspect(root)).state, "healthy");
	});

	it("counts only lifecycle-backed provider failures", () => {
		const exit = OUTCOMES.exit();
		const probes = {
			cancelled: OUTCOMES.cancelled(),
			"group unconfirmed": OUTCOMES.unconfirmed(),
			"exit code differs from the receipt": {
				...exit,
				providerLifecycle: localLifecycle(9),
			},
			"cleanup open": {
				...exit,
				providerLifecycle: withLifecycle(3, { cleanupStatus: "failed" }),
			},
			silence: {
				...exit,
				providerReliability: provider("provider_silence_timeout"),
			},
			"launch failure": {
				...exit,
				providerReliability: provider("provider_launch_failed"),
			},
			"non-provider phase": {
				...exit,
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "provider_exit_nonzero",
					phase: "check",
					exitCode: 3,
					checkIndex: 1,
				}),
			},
		};
		for (const [label, outcome] of Object.entries(probes))
			strictEqual(
				bindingFor({
					...failed(outcome.providerReliability, outcome.providerResult.code),
					providerLifecycle: outcome.providerLifecycle,
					providerWriterLifecycle: outcome.providerResult.writerLifecycle,
				}),
				null,
				label,
			);
		strictEqual(
			bindingFor(failed(exit.providerReliability, 3))?.lifecycleVerified,
			true,
		);
		// The VM queue never mints a transient failure from a bare exit.
		strictEqual(
			bindingFor({
				...failed(provider("provider_exit_nonzero", { exitCode: 1 }), 1),
				healthLane: "queue-vm",
				providerLifecycle: vmLifecycle(1),
			}),
			null,
		);
	});

	it("recognises the lifecycle the production writer reports for real processes", async () => {
		mock.timers.reset();
		const scope = tempDir("route-health-real-");
		const real = async (script) => {
			const result = await runSimpleWriter("sh", ["-c", script], {
				cwd: scope,
				processScopePath: scope,
			});
			return {
				providerResult: result,
				providerLifecycle: boundProviderLifecycleSnapshot(
					result.providerLifecycle,
				),
				providerReliability: result.success
					? null
					: createSimpleProviderReliabilityDiagnostic({
							failureReason: classifyExecutionFailure(result),
							failurePhase: "execute",
							providerResult: result,
						}),
			};
		};
		const root = rootFor("real");
		const outcomes = [await real("exit 3"), await real("kill -KILL $$")];
		deepStrictEqual(
			outcomes.map(({ providerReliability }) => providerReliability.causeCode),
			["provider_exit_nonzero", "provider_signalled"],
		);
		for (const outcome of outcomes)
			strictEqual((await dispatch(root, outcome)).terminal.settled, true);
		strictEqual(ledger(root).failures, 2);
		strictEqual((await inspect(root)).state, "cooldown");
		const passing = rootFor("real-ok");
		await dispatch(passing, await real("exit 0"));
		deepStrictEqual(
			ledger(passing).attempts.map(({ code }) => code),
			["verified_transport_success"],
		);
	});

	it("treats an agy-style nonzero exit with a closed lifecycle and no adapter diagnostic as provider-caused", async () => {
		const diagnostic = provider("provider_exit_nonzero", { exitCode: 3 });
		const lifecycle = localLifecycle(3);
		const eligible = (provenance) =>
			deriveFailureAccountability({
				providerReliability: diagnostic,
				provenance,
			}).providerMemoryEligible;
		strictEqual(eligible({}), false);
		strictEqual(
			eligible({
				providerLifecycle: lifecycle,
				providerWriterLifecycle: "stopped",
			}),
			true,
		);
		for (const provenance of [
			{ providerLifecycle: lifecycle },
			{ providerLifecycle: lifecycle, providerWriterLifecycle: "unavailable" },
			{
				providerLifecycle: localLifecycle(9),
				providerWriterLifecycle: "stopped",
			},
			{
				providerLifecycle: withLifecycle(3, {
					cleanupStage: "index_lock_removed",
				}),
				providerWriterLifecycle: "stopped",
			},
		])
			strictEqual(eligible(provenance), false);
		// Check, scope and environment causes stay ineligible whatever the lifecycle.
		for (const code of [
			"acceptance_check_failed",
			"scope_rejected",
			"environment_failure",
		])
			strictEqual(
				deriveFailureAccountability({
					providerReliability: createProviderReliabilityDiagnostic({
						causeCode: code,
						phase: "provider",
					}),
					provenance: {
						providerLifecycle: lifecycle,
						providerWriterLifecycle: "stopped",
					},
				}).providerMemoryEligible,
				false,
			);
		// End to end on the agy target: two such exits suppress it.
		const agy = descriptorFor("antigravity");
		const root = rootFor("agy");
		await fail(root, "exit", 0, { descriptor: agy });
		await fail(root, "exit", SECOND, { descriptor: agy });
		clock(2 * SECOND);
		strictEqual(ledger(root, agy).failures, 2);
		strictEqual(decisionFor(root, "enforce", agy).suppress, true);
	});

	it("re-probes after the cooldown and a passing half-open attempt restores eligibility", async () => {
		const root = rootFor("probe-pass");
		await fail(root, "exit", 0);
		await fail(root, "exit", SECOND);
		const until = ledger(root).generation.cooldownUntil;
		strictEqual(until, base + SECOND + COOLDOWN_MS[0]);
		clock(until - base - SECOND);
		strictEqual((await dispatch(root, "success")).prepared.allowed, false);
		clock(until - base);
		const trial = await dispatch(root, "success");
		strictEqual(trial.started.trial, true);
		strictEqual(trial.terminal.settled, true);
		const state = await inspect(root);
		strictEqual(state.state, "healthy");
		strictEqual(state.claimStatus, null);
		strictEqual(ledger(root).generation.cooldownStep, 0);
		const next = await dispatch(root, "success");
		strictEqual(next.prepared.allowed, true);
		strictEqual(next.started.trial, false);
	});

	it("re-suppresses a failed half-open attempt with the next cooldown step", async () => {
		const root = rootFor("probe-fail");
		await fail(root, "exit", 0);
		await fail(root, "exit", SECOND);
		let now = SECOND;
		for (const [step, wait] of [
			[2, COOLDOWN_MS[0]],
			[3, COOLDOWN_MS[1]],
			[3, COOLDOWN_MS[2]],
		]) {
			now += wait;
			const trial = await fail(root, "signal", now);
			strictEqual(trial.started.trial, true);
			strictEqual(trial.terminal.settled, true);
			const { cooldownStep, cooldownUntil } = ledger(root).generation;
			strictEqual(cooldownStep, step);
			strictEqual(cooldownUntil, base + now + COOLDOWN_MS[step - 1]);
			strictEqual((await inspect(root)).state, "cooldown");
			clock(now + SECOND);
			strictEqual(decisionFor(root).suppress, true);
		}
	});

	it("advances the ladder when a probe fails after earlier failures left the window", async () => {
		const root = rootFor("probe-late");
		await fail(root, "exit", 0);
		await fail(root, "exit", SECOND);
		const late = WINDOW_MS + MIN;
		const trial = await fail(root, "exit", late);
		strictEqual(trial.started.trial, true);
		strictEqual(ledger(root).generation.cooldownStep, 2);
		strictEqual(
			ledger(root).generation.cooldownUntil,
			base + late + COOLDOWN_MS[1],
		);
	});

	it("counts failures inclusively over the 6 h window", async () => {
		const inside = rootFor("window-in");
		await fail(inside, "exit", 0);
		await fail(inside, "exit", WINDOW_MS);
		strictEqual((await inspect(inside)).state, "cooldown");
		const outside = rootFor("window-out");
		await fail(outside, "exit", 0);
		await fail(outside, "exit", WINDOW_MS + SECOND);
		strictEqual((await inspect(outside)).state, "suspect");
		strictEqual(decisionFor(outside).suppress, false);
	});

	it("lets a success clear earlier failures and reset the ladder", async () => {
		const root = rootFor("barrier");
		await fail(root, "exit", 0);
		await fail(root, "success", SECOND);
		await fail(root, "exit", 2 * SECOND);
		strictEqual((await inspect(root)).state, "suspect");
		await fail(root, "exit", 3 * SECOND);
		strictEqual(ledger(root).generation.cooldownStep, 1);
		clock(3 * SECOND + COOLDOWN_MS[0]);
		strictEqual((await dispatch(root, "success")).started.trial, true);
		await fail(root, "exit", 10 * MIN);
		await fail(root, "exit", 11 * MIN);
		strictEqual(ledger(root).generation.cooldownStep, 1);
	});

	it("releases an inconclusive trial without a ladder step and keeps an unconfirmed one fenced", async () => {
		const root = rootFor("inconclusive");
		await fail(root, "exit", 0);
		await fail(root, "exit", SECOND);
		const expiry = SECOND + COOLDOWN_MS[0];
		const cancelled = await fail(root, "cancelled", expiry);
		strictEqual(cancelled.started.trial, true);
		strictEqual(cancelled.terminal.settled, true);
		let state = await inspect(root);
		strictEqual(state.state, "cooldown");
		strictEqual(state.claimStatus, null);
		strictEqual(state.trialAvailable, true);
		strictEqual(ledger(root).generation.cooldownStep, 1);
		const unconfirmed = await fail(root, "unconfirmed", expiry + SECOND);
		strictEqual(unconfirmed.started.trial, true);
		strictEqual(unconfirmed.terminal.settled, false);
		state = await inspect(root);
		strictEqual(state.state, "half-open");
		strictEqual(decisionFor(root).suppress, true);
	});

	it("settles a started lease-free invocation whose terminal receipt cannot be bound", async () => {
		const root = rootFor("unbound-success");
		const run = await initializeHealthRun(`task-${nextId()}`);
		const controller = createSimpleRouteHealthController({
			healthStateRoot: root,
			runId: run.runId,
			taskId: run.taskId,
		});
		strictEqual((await controller.prepare(simpleInput(codex()))).allowed, true);
		const started = await controller.start();
		strictEqual(started.allowed, true);
		strictEqual(started.trial, false);
		const terminal = await controller.terminal({
			providerResult: { success: true, code: 0, writerLifecycle: "stopped" },
		});
		strictEqual(terminal.settled, true);
		strictEqual(terminal.reason, "provider-terminal-unverified");
		strictEqual(terminal.binding, null);
		const next = await controller.prepare(simpleInput(codex()));
		strictEqual(next.allowed, true);
		strictEqual(next.reason, undefined);
	});

	it("settles a lease-free invocation when terminal observation throws", async () => {
		const root = rootFor("observation-failure");
		const run = await initializeHealthRun(`task-${nextId()}`);
		const controller = createSimpleRouteHealthController({
			healthStateRoot: root,
			runId: run.runId,
			taskId: run.taskId,
			createRouteHealthEvent: async () => {
				throw new Error("fixture observation failure");
			},
		});
		strictEqual((await controller.prepare(simpleInput(codex()))).allowed, true);
		strictEqual((await controller.start()).allowed, true);
		const terminal = await controller.terminal(OUTCOMES.exit());
		strictEqual(terminal.settled, true);
		strictEqual(terminal.reason, "provider-health-observation-unavailable");
		strictEqual(terminal.binding?.lifecycleVerified, true);
		const next = await controller.prepare(simpleInput(codex()));
		strictEqual(next.allowed, true);
		strictEqual(next.reason, undefined);
	});

	it("settles a started invocation whose success receipt is verified", async () => {
		const root = rootFor("verified-success");
		const dispatched = await dispatch(root, OUTCOMES.success());
		strictEqual(dispatched.terminal.settled, true);
		strictEqual(dispatched.terminal.binding?.transportVerified, true);
		const next = await dispatched.controller.prepare(simpleInput(codex()));
		strictEqual(next.allowed, true);
		strictEqual(next.reason, undefined);
	});

	it("keeps an active trial lease fail-closed when its terminal receipt is unbound", async () => {
		const root = rootFor("trial-unbound");
		await fail(root, "exit", 0);
		await fail(root, "exit", SECOND);
		clock(ledger(root).generation.cooldownUntil - base);
		const trial = await dispatch(root, {
			providerResult: { success: true, code: 0, writerLifecycle: "stopped" },
		});
		strictEqual(trial.started.trial, true);
		strictEqual(trial.terminal.settled, false);
		strictEqual(trial.terminal.reason, "provider-terminal-unverified");
		const refused = await trial.controller.prepare(simpleInput(codex()));
		strictEqual(refused.allowed, false);
		strictEqual(refused.reason, "provider-invocation-unsettled");
		strictEqual((await inspect(root)).state, "half-open");
	});

	it("keeps an active trial lease fail-closed when terminal observation throws", async () => {
		const root = rootFor("trial-observation-failure");
		await fail(root, "exit", 0);
		await fail(root, "exit", SECOND);
		clock(ledger(root).generation.cooldownUntil - base);
		const trial = await dispatch(root, "exit", {
			createRouteHealthEvent: async () => {
				throw new Error("fixture observation failure");
			},
		});
		strictEqual(trial.started.trial, true);
		strictEqual(trial.terminal.settled, false);
		strictEqual(
			trial.terminal.reason,
			"provider-health-observation-unavailable",
		);
		const refused = await trial.controller.prepare(simpleInput(codex()));
		strictEqual(refused.allowed, false);
		strictEqual(refused.reason, "provider-invocation-unsettled");
		strictEqual((await inspect(root)).state, "half-open");
	});

	it("keeps an unconfirmed trial writer fenced against a second prepare", async () => {
		const root = rootFor("trial-unconfirmed");
		await fail(root, "exit", 0);
		await fail(root, "exit", SECOND);
		clock(ledger(root).generation.cooldownUntil - base);
		const trial = await dispatch(root, "unconfirmed");
		strictEqual(trial.started.trial, true);
		strictEqual(trial.terminal.settled, false);
		const refused = await trial.controller.prepare(simpleInput(codex()));
		strictEqual(refused.allowed, false);
		strictEqual(refused.reason, "provider-invocation-unsettled");
	});

	it("compacts the attempt ledger so a long success streak cannot refuse later observations", async () => {
		const root = rootFor("capacity");
		await fail(root, "success", 0);
		const descriptor = codex();
		await updateScope(
			{
				healthStateRoot: root,
				targetId: descriptor.target_id,
				descriptorIdentity: descriptor.descriptor_identity,
			},
			async ({ observations }) => {
				const [generation] = Object.values(observations.generations);
				const template = generation.attempts[0];
				for (let index = 1; index < MAX_ATTEMPTS; index += 1) {
					const id = hash(`preload-${index}`);
					generation.attempts.push({
						...template,
						id,
						attempt: `preload-${index}`,
						incidentId: id,
						at: template.at - index,
						sequence: index,
					});
					observations.seenAttemptIds.push(id);
				}
			},
		);
		strictEqual(ledger(root).seen, MAX_ATTEMPTS);
		const result = await fail(root, "exit", SECOND);
		strictEqual(result.terminal.settled, true);
		const after = ledger(root);
		strictEqual(after.seen < MAX_ATTEMPTS / 2, true);
		strictEqual(after.failures, 1);
		strictEqual((await inspect(root)).state, "suspect");
	});

	it("reports an emptied pool as route_health_blocked rather than a missing provider", async () => {
		const routed = (evidence) => ({
			provider: null,
			reason: "no_eligible_provider",
			routeEvidence: evidence,
		});
		const select = async (result) =>
			createSimpleRouteSelection({
				options: { capability: "standard", onlyProviders: ["codex"] },
				resolveIdentity: (name) => ({ targetId: name, harnessKey: name }),
				descriptorFor: () => codex(),
				routeProvider: () => result,
				healthController: { decision: () => ({}), prepare: async () => ({}) },
				now: () => base,
				funded: () => {},
				onDecision: async () => {},
			}).selectSimpleRoute();
		deepStrictEqual(
			await select(
				routed({
					excluded: [{ targetId: "codex", reason: "route_health_suppressed" }],
				}),
			),
			{ error: "route_health_blocked" },
		);
		deepStrictEqual(await select(routed({ excluded: [] })), {
			error: "no_eligible_provider",
		});
	});
});
