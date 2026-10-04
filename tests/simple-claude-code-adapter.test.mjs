import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SIMPLE_TARGET_ADAPTERS } from "../src/switchyard/simple/args.mjs";
import {
	buildSimpleProviderInvocation,
	providerCodeForClaudeCodeDiagnostic,
	simpleProviderCompatibility,
} from "../src/switchyard/simple/provider-invocation.mjs";
import { createSimpleRouteSelection } from "../src/switchyard/simple/route-selection.mjs";

const models = SIMPLE_TARGET_ADAPTERS.find(
	(item) => item.targetId === "claude-code",
).selectors;
const descriptor = (selector, invocation_args = ["--effort", "high"]) => ({
	target_id: "claude-code",
	selector,
	invocation_args,
});

test("Claude simple compatibility accepts approved selectors and efforts", () => {
	for (const capability of ["low", "standard", "high"])
		for (const selector of models)
			assert.equal(
				simpleProviderCompatibility({
					targetId: "claude-code",
					harness: "claude",
					descriptor: descriptor(selector),
					capability,
				}).compatible,
				true,
			);
	assert.equal(
		simpleProviderCompatibility({
			targetId: "claude-code",
			harness: "claude",
			descriptor: descriptor("other"),
			capability: "high",
		}).reason,
		"local_descriptor_model_unavailable",
	);
	assert.equal(
		simpleProviderCompatibility({
			targetId: "claude-code",
			harness: "claude",
			descriptor: descriptor(models[0], ["--effort", "bad"]),
			capability: "high",
		}).reason,
		"local_descriptor_args_unsafe",
	);
});

test("Claude invocation uses the native launcher and stdin prompt", () => {
	const invocation = buildSimpleProviderInvocation(
		"claude",
		descriptor(models[0]),
		"secret prompt",
		"/worktree",
		"claude-code",
		"high",
	);
	assert.equal(invocation.command, process.execPath);
	assert.deepEqual(invocation.args.slice(-6), [
		"--model",
		models[0],
		"--effort",
		"high",
		"--worktree",
		"/worktree",
	]);
	assert.equal(invocation.args.includes("secret prompt"), false);
});

test("Claude diagnostic lines map only approved evidence", () => {
	assert.equal(
		providerCodeForClaudeCodeDiagnostic(
			"SWITCHYARD_CLAUDE_CODE_DIAG_V1 subtype=x api_status=401 limit=0",
		),
		"auth_expired",
	);
	assert.equal(
		providerCodeForClaudeCodeDiagnostic(
			"SWITCHYARD_CLAUDE_CODE_DIAG_V1 subtype=x api_status=403 limit=0",
		),
		"auth_expired",
	);
	assert.equal(
		providerCodeForClaudeCodeDiagnostic(
			"SWITCHYARD_CLAUDE_CODE_DIAG_V1 subtype=x api_status=404 limit=0",
		),
		"model_unavailable",
	);
	assert.equal(
		providerCodeForClaudeCodeDiagnostic(
			"SWITCHYARD_CLAUDE_CODE_DIAG_V1 subtype=x api_status=500 limit=1",
		),
		"quota_exhausted",
	);
	assert.equal(
		providerCodeForClaudeCodeDiagnostic(
			"prefix\nSWITCHYARD_CLAUDE_CODE_DIAG_V1 subtype=x api_status=500 limit=0\nsuffix",
		),
		null,
	);
	assert.equal(
		providerCodeForClaudeCodeDiagnostic(
			"SWITCHYARD_CLAUDE_CODE_DIAG_V1 subtype=X api_status=401 limit=0",
		),
		null,
	);
});

function selection(onlyProviders) {
	const requested = [];
	const result = createSimpleRouteSelection({
		options: { capability: "standard", onlyProviders },
		resolveIdentity: (targetId) => {
			requested.push(targetId);
			return { targetId, harnessKey: "claude" };
		},
		descriptorFor: (targetId) =>
			targetId === "claude-code" ? descriptor(models[0]) : null,
		routeProvider: ({ availableProviders }) => {
			return { provider: availableProviders[0] };
		},
		healthController: {
			decision: () => ({}),
			prepare: async () => ({ allowed: true }),
		},
		funded: () => {},
		onDecision: async () => {},
		now: Date.now,
	});
	// Identity resolution may run more than once per target; compare the set.
	return result.selectSimpleRoute().then(() => [...new Set(requested)]);
}

test("Claude is only requested when explicitly pinned", async () => {
	assert.equal((await selection([])).includes("claude-code"), false);
	assert.deepEqual(await selection(["claude-code"]), ["claude-code"]);
});
