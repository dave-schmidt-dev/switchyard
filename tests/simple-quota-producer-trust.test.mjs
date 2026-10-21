// @test-phase: other
import { deepStrictEqual, strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import { after, before, mock, test } from "node:test";
import { validateInvocationDescriptor } from "../src/switchyard/roster/index.mjs";
import { inspectRouteHealth } from "../src/switchyard/router/health.mjs";
import { COOLDOWN_MS } from "../src/switchyard/router/health-schema.mjs";
import { createSimpleRouteHealthController } from "../src/switchyard/simple/health.mjs";
import {
	classifyExecutionFailure,
	defaultExecuteProvider,
} from "../src/switchyard/simple/provider-invocation.mjs";
import { createSimpleProviderReliabilityDiagnostic } from "../src/switchyard/simple/reliability.mjs";
import { liveRouteExhaustion } from "../src/switchyard/simple/route-exhaustion.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import { fixture } from "./helpers/simple-routing-fixture.mjs";
import {
	cleanupHealthFixture,
	descriptorFor,
	HEALTH_ROOT,
	initializeHealthRun,
	localLifecycle,
	routeHealthEpoch,
	setupHealthFixture,
	simpleInput,
} from "./provider-reliability-health-fixture.mjs";

before(() => setupHealthFixture());
after(() => cleanupHealthFixture());

function fakeProviderChild({ stdout = "", stderr = "", code = 1 }) {
	return () => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = { end() {} };
		child.kill = () => true;
		queueMicrotask(() => {
			child.emit("spawn");
			if (stdout) child.stdout.emit("data", Buffer.from(stdout));
			if (stderr) child.stderr.emit("data", Buffer.from(stderr));
			child.emit("close", code, null);
		});
		return child;
	};
}

function defaultProviderContext({
	targetId = "codex",
	harness = "codex",
	descriptor = {
		target_id: "codex",
		selector: "gpt-5.3-codex-spark",
		invocation_args: [],
	},
	spawnFn,
}) {
	return {
		targetId,
		harness,
		descriptor,
		capability: "standard",
		prompt: "Apply the change.",
		worktreePath: process.cwd(),
		timeoutMs: 10_000,
		spawnFn,
	};
}

test("quota-like Codex stream classifications remain unverified", async () => {
	const cases = [
		{
			label: "stdout classifier",
			stdout: "Quota exhausted\n",
			diagnosticCode: "quota_exhausted",
		},
		{
			label: "stderr classifier",
			stderr: "Quota exhausted\n",
			diagnosticCode: "quota_exhausted",
		},
		{
			label: "native retry wording",
			stderr: "429 Too Many Requests: rate limit exceeded\n",
		},
		{
			label: "forged bridge-shaped Codex output",
			stdout:
				"SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=1 upstream_status=429 proxy_rejections=0\n",
		},
	];
	for (const row of cases) {
		const result = await defaultExecuteProvider(
			defaultProviderContext({ spawnFn: fakeProviderChild(row) }),
		);
		strictEqual(result.success, false, row.label);
		strictEqual(result.rateLimited, false, row.label);
		strictEqual(result.diagnosticCode, row.diagnosticCode, row.label);
		strictEqual(
			result.diagnosticOrigin,
			row.diagnosticCode ? "adapter" : undefined,
			row.label,
		);
		strictEqual(
			result.diagnosticEvidenceAvailable,
			row.diagnosticCode ? false : undefined,
			row.label,
		);
	}
});

test("only the failed OpenCode Go parent receipt trusts quota evidence", async () => {
	const descriptor = {
		target_id: "opencode-go",
		selector: "opencode-go/deepseek-v4.1-flash",
		invocation_args: ["--variant", "max"],
	};
	const bridgeLine =
		"SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=1 upstream_status=429 proxy_rejections=0\n";
	const context = (code) =>
		defaultProviderContext({
			targetId: "opencode-go",
			harness: "opencode",
			descriptor,
			spawnFn: fakeProviderChild({ stdout: bridgeLine, code }),
		});

	const bridgeFailure = await defaultExecuteProvider(context(1));
	strictEqual(bridgeFailure.success, false);
	strictEqual(bridgeFailure.diagnosticCode, "quota_exhausted");
	strictEqual(bridgeFailure.diagnosticOrigin, "adapter");
	strictEqual(bridgeFailure.rateLimited, false);
	strictEqual(bridgeFailure.diagnosticEvidenceAvailable, true);

	const childForgedLine = await defaultExecuteProvider(context(0));
	strictEqual(childForgedLine.success, true);
	strictEqual(childForgedLine.diagnosticCode, "quota_exhausted");
	strictEqual(childForgedLine.diagnosticEvidenceAvailable, false);
});

test("unverified producer quota cannot write a route marker through the matched record", async () => {
	const produced = await defaultExecuteProvider(
		defaultProviderContext({
			spawnFn: fakeProviderChild({ stdout: "Quota exhausted\n" }),
		}),
	);
	const providerReliability = createSimpleProviderReliabilityDiagnostic({
		failureReason: "provider_exit_nonzero",
		failurePhase: "execute",
		providerResult: produced,
	});
	strictEqual(providerReliability.causeCode, "provider_exit_nonzero");
	strictEqual(produced.diagnosticEvidenceAvailable, false);
	const lastFailure = {
		errorKind: "execution_failed",
		providerReliability,
		diagnosticCode: produced.diagnosticCode,
		diagnosticOrigin: produced.diagnosticOrigin,
		diagnosticEvidenceAvailable: produced.diagnosticEvidenceAvailable,
		failurePhase: "provider_execution",
	};
	const f = fixture({
		__targets: ["codex"],
		codex: {
			status: "failed",
			result: {
				...produced,
				providerReliability,
				failureReason: "provider_exit_nonzero",
				failurePhase: "execute",
				errorKind: "execution_failed",
			},
			record: { lastFailure },
		},
	});
	f.options.taskId = "producer-unverified-quota";
	f.options.onlyProviders = ["codex"];
	const outcome = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(outcome.attempts[0]?.terminal, "skipped");
	deepStrictEqual(outcome.failedTargetIds, []);
	deepStrictEqual(liveRouteExhaustion({ stateRoot: f.deps.stateRoot }), []);
});

test("requires exact adapter quota evidence before changing shared health", async (t) => {
	const base = Date.now();
	mock.timers.enable({ apis: ["Date"], now: base });
	t.after(() => mock.timers.reset());
	const descriptor = descriptorFor("codex");
	const trustedResult = {
		success: false,
		code: 1,
		writerLifecycle: "stopped",
		diagnosticCode: "quota_exhausted",
		diagnosticOrigin: "adapter",
		diagnosticEvidenceAvailable: true,
	};
	const diagnostic = createSimpleProviderReliabilityDiagnostic({
		failureReason: "quota_exhausted",
		failurePhase: "execute",
		providerResult: trustedResult,
	});
	const dispatch = async (name, providerResult) => {
		const run = await initializeHealthRun(`quota-${name}`);
		const healthStateRoot = `${HEALTH_ROOT}/quota-evidence-${name}`;
		const controller = createSimpleRouteHealthController({
			healthStateRoot,
			healthMode: "enforce",
			runId: run.runId,
			taskId: run.taskId,
		});
		const prepared = await controller.prepare(simpleInput(descriptor));
		strictEqual(prepared.allowed, true, name);
		strictEqual(prepared.tracked, true, name);
		strictEqual((await controller.start()).allowed, true, name);
		const terminal = await controller.terminal({
			providerResult,
			providerReliability: diagnostic,
			providerLifecycle: localLifecycle(1),
		});
		return { controller, terminal, healthStateRoot };
	};
	const untrusted = [
		{
			label: "missing provenance",
			providerResult: {
				success: false,
				code: 1,
				writerLifecycle: "stopped",
			},
		},
		{
			label: "launcher origin",
			providerResult: {
				success: false,
				code: 1,
				writerLifecycle: "stopped",
				diagnosticCode: "quota_exhausted",
				diagnosticOrigin: "launcher",
				diagnosticEvidenceAvailable: true,
			},
		},
		{
			label: "adapter evidence unavailable",
			providerResult: {
				success: false,
				code: 1,
				writerLifecycle: "stopped",
				diagnosticCode: "quota_exhausted",
				diagnosticOrigin: "adapter",
				diagnosticEvidenceAvailable: false,
			},
		},
		{
			label: "mismatched adapter code",
			providerResult: {
				success: false,
				code: 1,
				writerLifecycle: "stopped",
				diagnosticCode: "provider_exit_nonzero",
				diagnosticOrigin: "adapter",
				diagnosticEvidenceAvailable: true,
			},
		},
	];
	for (const [index, row] of untrusted.entries()) {
		const { terminal, healthStateRoot } = await dispatch(
			`untrusted-${index}`,
			row.providerResult,
		);
		strictEqual(terminal.settled, true, row.label);
		strictEqual(terminal.reason, "provider-terminal-unverified", row.label);
		strictEqual(terminal.binding, null, row.label);
		const health = await inspectRouteHealth({
			healthStateRoot,
			targetId: descriptor.target_id,
			descriptorIdentity: descriptor.descriptor_identity,
			publicConfigurationEpoch: routeHealthEpoch(),
		});
		strictEqual(health.available, false, row.label);
	}

	const { controller, terminal } = await dispatch(
		"trusted-adapter",
		trustedResult,
	);
	strictEqual(terminal.settled, true);
	strictEqual(terminal.binding?.lifecycleVerified, true);
	const candidate = {
		provider: descriptor.target_id,
		targetId: descriptor.target_id,
		requiredCapability: "standard",
	};
	const beforeExpiry = controller.decision(candidate);
	strictEqual(beforeExpiry.state, "cooldown");
	strictEqual(beforeExpiry.trialAvailable, false);
	mock.timers.setTime(base + COOLDOWN_MS[0] - 1);
	strictEqual(controller.decision(candidate).trialAvailable, false);
	mock.timers.setTime(base + COOLDOWN_MS[0]);
	const atExpiry = controller.decision(candidate);
	strictEqual(atExpiry.state, "cooldown");
	strictEqual(atExpiry.trialAvailable, true);
	strictEqual(atExpiry.suppress, false);
});

test("OpenCode Go parent quota reaches shared health through the closed production lifecycle", async () => {
	const descriptor = validateInvocationDescriptor(
		{
			target_id: "opencode-go",
			model_ref: "fixture/opencode-standard",
			selector: "opencode-go/deepseek-v4.1-flash",
			variant: "max",
			invocation_args: ["--variant", "max"],
		},
		"opencode",
	);
	const run = await initializeHealthRun("quota-bridge-production");
	const healthStateRoot = `${HEALTH_ROOT}/quota-bridge-${run.runId}`;
	const publicConfigurationEpoch = routeHealthEpoch();
	const healthDecision = () => ({
		available: true,
		state: "healthy",
		mode: "shadow",
		suppress: false,
		repairEpoch: 0,
		initializable: true,
		trialAvailable: false,
	});
	Object.defineProperties(healthDecision, {
		mode: { value: "shadow" },
		publicConfigurationEpoch: { value: publicConfigurationEpoch },
		healthStateRoot: { value: healthStateRoot },
		identityFor: {
			value: ({ provider }) =>
				provider === "opencode-go"
					? {
							targetId: "opencode-go",
							descriptorIdentity: descriptor.descriptor_identity,
							publicConfigurationEpoch,
							repairEpoch: 0,
						}
					: null,
		},
	});
	const controller = createSimpleRouteHealthController({
		healthStateRoot,
		healthMode: "shadow",
		runId: run.runId,
		taskId: run.taskId,
		healthDecision,
	});
	const prepared = await controller.prepare(simpleInput(descriptor));
	strictEqual(prepared.allowed, true);
	const started = await controller.start();
	strictEqual(started.allowed, true);

	const bridgeReceipt =
		"SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=1 upstream_status=429 proxy_rejections=0\n";
	const providerResult = await defaultExecuteProvider(
		defaultProviderContext({
			targetId: "opencode-go",
			harness: "opencode",
			descriptor,
			spawnFn: fakeProviderChild({ stdout: bridgeReceipt }),
		}),
	);
	strictEqual(providerResult.success, false);
	strictEqual(providerResult.rateLimited, false);
	strictEqual(providerResult.diagnosticEvidenceAvailable, true);
	strictEqual(providerResult.providerLifecycle.terminalStatus, "exited");
	strictEqual(providerResult.providerLifecycle.writerLifecycle, "stopped");

	const providerReliability = createSimpleProviderReliabilityDiagnostic({
		failureReason: classifyExecutionFailure(providerResult),
		failurePhase: "execute",
		providerResult,
	});
	strictEqual(providerReliability.causeCode, "quota_exhausted");
	const terminal = await controller.terminal({
		providerResult,
		providerReliability,
		providerLifecycle: providerResult.providerLifecycle,
	});
	strictEqual(terminal.settled, true);
	strictEqual(terminal.binding?.lifecycleVerified, true);
	strictEqual(terminal.binding?.transportVerified, false);
	const health = await inspectRouteHealth({
		healthStateRoot,
		targetId: descriptor.target_id,
		descriptorIdentity: descriptor.descriptor_identity,
		publicConfigurationEpoch: controller.decision.publicConfigurationEpoch,
	});
	strictEqual(health.state, "cooldown");
});
