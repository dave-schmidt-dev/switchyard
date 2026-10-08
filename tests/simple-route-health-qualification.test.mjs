import { deepStrictEqual, strictEqual } from "node:assert";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, it, mock } from "node:test";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import { route as selectProvider } from "../src/switchyard/router/index.mjs";
import { createSimpleRouteHealthController } from "../src/switchyard/simple/health.mjs";
import { createSimpleRouteSelection } from "../src/switchyard/simple/route-selection.mjs";
import {
	cleanupHealthFixture,
	descriptorFor,
	HEALTH_ROOT,
	initializeHealthRun,
	localLifecycle,
	setupHealthFixture,
	simpleInput,
} from "./provider-reliability-health-fixture.mjs";

const MIN = 60_000;
const codex = () => descriptorFor("codex");
let base;
let serial = 0;
const clock = (offsetMs) => mock.timers.setTime(base + offsetMs);
const rootFor = (name) => {
	serial += 1;
	return join(HEALTH_ROOT, `${name}-${serial}`);
};

const failureOutcome = (kind) => {
	if (kind === "signal") {
		return {
			providerResult: {
				success: false,
				code: null,
				signal: "SIGKILL",
				writerLifecycle: "stopped",
			},
			providerReliability: createProviderReliabilityDiagnostic({
				causeCode: "provider_signalled",
				phase: "provider",
				signal: "SIGKILL",
			}),
			providerLifecycle: { ...localLifecycle(null), signal: "SIGKILL" },
		};
	}
	if (kind === "deadline") {
		return {
			providerResult: {
				success: false,
				code: null,
				timedOut: true,
				writerLifecycle: "stopped",
			},
			providerReliability: createProviderReliabilityDiagnostic({
				causeCode: "provider_deadline_exceeded",
				phase: "provider",
				timedOut: true,
			}),
			providerLifecycle: {
				...localLifecycle(null),
				terminalStatus: "terminated",
				terminationReason: "deadline",
			},
		};
	}
	return {
		providerResult: { success: false, code: 3, writerLifecycle: "stopped" },
		providerReliability: createProviderReliabilityDiagnostic({
			causeCode: "provider_exit_nonzero",
			phase: "provider",
			exitCode: 3,
		}),
		providerLifecycle: localLifecycle(3),
	};
};

async function recordFailure(root, kind, offsetMs) {
	clock(offsetMs);
	serial += 1;
	const run = await initializeHealthRun(`qualification-seed-${serial}`);
	const controller = createSimpleRouteHealthController({
		healthStateRoot: root,
		runId: run.runId,
		taskId: run.taskId,
	});
	const prepared = await controller.prepare(simpleInput(codex()));
	if (!prepared.allowed) return;
	const started = await controller.start();
	if (!started.allowed) return;
	return controller.terminal(failureOutcome(kind));
}

function decisionFor(root) {
	return createSimpleRouteHealthController({
		healthStateRoot: root,
		healthMode: "enforce",
	}).decision({ provider: "codex", requiredCapability: "standard" });
}

const savedEnv = new Map();
for (const key of [
	"SWITCHYARD_ROUTE_HEALTH_MODE",
	"SWITCHYARD_ROUTE_HEALTH_STATE_ROOT",
])
	savedEnv.set(key, process.env[key]);

before(() => {
	setupHealthFixture();
	for (const key of savedEnv.keys()) delete process.env[key];
});
after(() => {
	cleanupHealthFixture();
	for (const [key, value] of savedEnv)
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
});
beforeEach(() => {
	base = Date.now();
	mock.timers.enable({ apis: ["Date"], now: base });
});
afterEach(() => mock.timers.reset());

it("fences healthy work when a lease-free writer stop is unconfirmed", async () => {
	const root = rootFor("unconfirmed-no-lease-work");
	const run = await initializeHealthRun("healthy-work-unconfirmed");
	const controller = createSimpleRouteHealthController({
		healthStateRoot: root,
		healthMode: "enforce",
		runId: run.runId,
		taskId: run.taskId,
	});
	const prepared = await controller.prepare(simpleInput(codex()));
	strictEqual(prepared.allowed, true);
	const started = await controller.start();
	strictEqual(started.allowed, true);
	strictEqual(started.trial, false);

	const terminal = await controller.terminal({
		providerResult: {
			success: true,
			code: 0,
			writerLifecycle: "unavailable",
		},
		providerLifecycle: localLifecycle(0),
	});
	strictEqual(terminal.settled, false);
	strictEqual(terminal.reason, "provider-terminal-unverified");
	strictEqual(terminal.binding, null);

	const refused = await controller.prepare(simpleInput(codex()));
	strictEqual(refused.allowed, false);
	strictEqual(refused.reason, "provider-invocation-unsettled");
});

it("qualification route selection skips work suppression and preserves work enforcement", async () => {
	const root = rootFor("qualification-admission");
	for (const [index, kind] of ["exit", "signal", "deadline"].entries())
		await recordFailure(root, kind, index * MIN);
	clock(3 * MIN);
	strictEqual(decisionFor(root).suppress, true);

	const snapshotRead = () => ({
		snapshot: {
			schema_version: 2,
			updated_at: new Date(base).toISOString(),
			providers: [
				{
					name: "codex",
					ok: true,
					windows: [{ percent_left: 80, pace_delta: 1 }],
				},
			],
		},
		snapshotStatus: "fresh",
		snapshotMtime: base,
		snapshotAgeMsAtRoute: 0,
	});
	const select = async (origin) => {
		const routeCalls = [];
		const decisions = [];
		const run = await initializeHealthRun(`qualification-admission-${origin}`);
		const healthController = createSimpleRouteHealthController({
			healthStateRoot: root,
			healthMode: "enforce",
			origin,
			runId: run.runId,
			taskId: run.taskId,
		});
		const selection = createSimpleRouteSelection({
			options: {
				capability: "standard",
				onlyProviders: ["codex"],
				origin,
			},
			resolveIdentity: (name) => ({
				targetId: name,
				harnessKey: "codex",
			}),
			descriptorFor: () => codex(),
			routeProvider: (options) => {
				routeCalls.push(options);
				return selectProvider({
					...options,
					snapshotRead: snapshotRead(),
				});
			},
			healthController,
			now: () => base + 3 * MIN,
			stateRoot: root,
			funded: () => {},
			onDecision: async (routed) => decisions.push(routed),
		});
		return {
			selected: await selection.selectSimpleRoute(),
			routeCall: routeCalls[0],
			decision: decisions[0],
		};
	};

	const qualification = await select("qualification");
	strictEqual(qualification.selected.provider, "codex");
	strictEqual(qualification.selected.prepared.allowed, true);
	strictEqual(Object.hasOwn(qualification.routeCall, "healthDecision"), false);
	strictEqual(
		qualification.decision.routeEvidence.excluded.some(
			(entry) => entry.reason === "route_health_suppressed",
		),
		false,
	);

	const work = await select("work");
	deepStrictEqual(work.selected, { error: "route_health_blocked" });
	strictEqual(typeof work.routeCall.healthDecision, "function");
	strictEqual(
		work.routeCall.healthDecision({
			provider: "codex",
			requiredCapability: "standard",
		}).suppress,
		true,
	);
	strictEqual(
		work.decision.routeEvidence.excluded.some(
			(entry) => entry.reason === "route_health_suppressed",
		),
		true,
	);
});
