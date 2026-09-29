import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	enumerateQualificationTargets,
	planRepresentativeQualification,
	runRepresentativeQualification,
} from "../src/switchyard/diagnostics/provider-qualification.mjs";
import { QUALIFICATION_FILES } from "../src/switchyard/diagnostics/provider-qualification-fixture.mjs";
import { hasProvenWorkerCleanup } from "../src/switchyard/diagnostics/provider-qualification-verification.mjs";
import { getInvocationDescriptorIdentity } from "../src/switchyard/roster/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

function fixtureRoster() {
	const definitions = [
		[
			"claude-code",
			"claude",
			[
				["low", "claude-haiku-4-5-20251001", "low"],
				["standard", "claude-sonnet-5", "medium"],
				["high", "claude-opus-5-5", "high"],
			],
		],
		[
			"codex",
			"codex",
			[
				["low", "gpt-6-luna", "low"],
				["standard", "gpt-5.6-terra", "high"],
				["high", "gpt-6-sol", "xhigh"],
			],
		],
		[
			"antigravity",
			"agy",
			[
				["low", "gemini-3.8-flash-medium", null],
				["standard", "gemini-3.8-flash-high", null],
			],
		],
		[
			"cursor-pro",
			"cursor",
			[
				["low", "composer-2.5", null],
				["standard", "grok-4.7-high", null],
				["high", "grok-4.7-xhigh", null],
			],
		],
		[
			"vibe",
			"vibe",
			[
				["low", "glm-5-3-medium", null],
				["standard", "glm-5-3", null],
			],
		],
		["copilot-student", "copilot", [["low", "auto", null]]],
		[
			"opencode-go",
			"opencode",
			[
				["low", "opencode-go/deepseek-v4.1-flash", "low"],
				["standard", "opencode-go/deepseek-v4.1-flash", "max"],
			],
		],
		["antigravity-claude", "agy", [["standard", "claude-sonnet-4-6", null]]],
	];
	const roster = { schema_version: 1, models: {}, targets: {} };
	for (const [targetId, harness, slots] of definitions) {
		const target = {
			enabled: true,
			harness,
			slots: { low: [], standard: [], high: [] },
		};
		for (const [capability, selector, tuning] of slots) {
			const modelRef = `fixture/${targetId}/${capability}`;
			roster.models[modelRef] = {
				selector,
				base_model: selector,
				model_provider: "fixture",
				status: "active",
			};
			const slot = { model_ref: modelRef, priority: 1 };
			if (harness === "claude" && tuning) {
				Object.assign(slot, {
					effort: tuning,
					invocation_args: ["--effort", tuning],
				});
			} else if (harness === "codex") {
				Object.assign(slot, {
					effort: tuning,
					invocation_args: ["-c", `model_reasoning_effort=${tuning}`],
				});
			} else if (harness === "opencode") {
				Object.assign(slot, {
					variant: tuning,
					invocation_args: ["--variant", tuning],
				});
			}
			target.slots[capability].push(slot);
		}
		roster.targets[targetId] = target;
	}
	return roster;
}

function observedDescriptor(plan, roster) {
	const target = roster.targets[plan.targetId];
	const slot = target.slots[plan.capability].find(
		(item) => item.model_ref === plan.modelRef,
	);
	const descriptor = {
		target_id: plan.targetId,
		model_ref: slot.model_ref,
		selector: roster.models[slot.model_ref].selector,
		effort: slot.effort ?? null,
		variant: slot.variant ?? null,
		invocation_args: slot.invocation_args ?? [],
	};
	return {
		...descriptor,
		descriptor_identity: getInvocationDescriptorIdentity(
			descriptor,
			target.harness,
		),
	};
}

function git(projectPath, ...args) {
	return execFileSync("git", ["-C", projectPath, ...args], {
		encoding: "utf8",
	});
}

function writeAcceptedOutputs(projectPath, wrong = false) {
	writeFileSync(
		join(projectPath, "src/summary.mjs"),
		wrong
			? [
					"export function summarize(values) {",
					" if (!Array.isArray(values)) throw new TypeError('array required');",
					" const numbers = values.filter((item) => typeof item === 'number' && Number.isFinite(item));",
					" const total = numbers.reduce((sum, item) => sum + item, 0);",
					" return { count: numbers.length, total, average: numbers.length ? total : null };",
					"}",
					"",
				].join("\n")
			: [
					"export function summarize(values) {",
					" if (!Array.isArray(values)) throw new TypeError('array required');",
					" const numbers = values.filter((item) => typeof item === 'number' && Number.isFinite(item));",
					" const total = numbers.reduce((sum, item) => sum + item, 0);",
					" return { count: numbers.length, total, average: numbers.length ? total / numbers.length : null };",
					"}",
					"",
				].join("\n"),
		{ mode: 0o600 },
	);
	writeFileSync(
		join(projectPath, "tests/summary.test.mjs"),
		[
			'import assert from "node:assert/strict";',
			'import { test } from "node:test";',
			'import { summarize } from "../src/summary.mjs";',
			'test("summary counts values", () => assert.equal(summarize([1, 3]).count, 2));',
			'test("summary totals values", () => assert.equal(summarize([1, 3]).total, 4));',
			'test("summary averages values", () => assert.equal(summarize([1, 3]).average, 2));',
			"",
		].join("\n"),
		{ mode: 0o600 },
	);
}

function hash(value) {
	return createHash("sha256").update(value).digest("hex");
}

function mockDispatcher(roster, { wrong = false, cleanup = true } = {}) {
	return async ({ plan, fixture }) => {
		writeAcceptedOutputs(fixture.projectPath, wrong);
		const diff = git(fixture.projectPath, "diff", "HEAD", "--binary");
		git(fixture.projectPath, "add", "-A");
		const candidateTree = git(fixture.projectPath, "write-tree").trim();
		const cleanupReceipt = cleanup
			? {
					writer: { state: "stopped" },
					worktree: { state: "removed" },
					projectLock: { state: "released" },
				}
			: {
					writer: { state: "unknown" },
					worktree: { state: "retained" },
					projectLock: { state: "unknown" },
				};
		const descriptor = observedDescriptor(plan, roster);
		const changedFiles = [...QUALIFICATION_FILES].sort();
		if (plan.lane === "simple") {
			return {
				providerResult: {
					status: "succeeded",
					targetId: plan.targetId,
					descriptorIdentity: descriptor.descriptor_identity,
					invocationDescriptor: descriptor,
					checks: [{ index: 1, status: "passed" }],
					changedFiles,
				},
				targetId: plan.targetId,
				descriptorIdentity: descriptor.descriptor_identity,
				invocationDescriptor: descriptor,
				checkCommands: ["node --test tests/acceptance.test.mjs"],
				changedFiles,
				cleanup: cleanupReceipt,
			};
		}
		git(fixture.projectPath, "add", "-A");
		const fixedChecks = [["node", "--test", "tests/acceptance.test.mjs"]];
		const quickCheckReceipt = {
			version: 1,
			taskId: "1",
			attempt: 1,
			baseTree: git(fixture.projectPath, "rev-parse", "HEAD^{tree}").trim(),
			diffSha256: hash(diff.endsWith("\n") ? diff : `${diff}\n`),
			candidateTree,
			commandSetSha256: hash(
				JSON.stringify({ setup: null, checks: fixedChecks }),
			),
			setup: null,
			checks: fixedChecks.map((argv, index) => ({
				index,
				commandSha256: hash(JSON.stringify(argv)),
				exitCode: 0,
				signal: null,
				timedOut: false,
				groupCleanup: "complete",
			})),
			status: "passed",
			cleanup: { status: "complete" },
		};
		return {
			providerResult: {
				success: true,
				result: "success",
				resolvedTargetId: plan.targetId,
				descriptorIdentity: descriptor.descriptor_identity,
				invocationDescriptor: descriptor,
				quickCheckReceipt,
			},
			targetId: plan.targetId,
			descriptorIdentity: descriptor.descriptor_identity,
			invocationDescriptor: descriptor,
			quickCheckReceipt,
			changedFiles,
			cleanup: cleanupReceipt,
		};
	};
}

test("offline inventory preserves all seven harnesses, eight targets, and 17 slots", () => {
	const roster = fixtureRoster();
	roster.targets.disabled = {
		enabled: false,
		harness: "cursor",
		slots: { low: [{ model_ref: "fixture/disabled", priority: 1 }] },
	};
	roster.models["fixture/disabled"] = {
		selector: "disabled-model",
		base_model: "disabled-model",
		model_provider: "fixture",
		status: "active",
	};
	const inventory = enumerateQualificationTargets(roster);
	assert.equal(inventory.enabledTargetCount, 8);
	assert.equal(inventory.configuredSlotCount, 17);
	assert.equal(
		new Set(inventory.enabledTargets.map((item) => item.harness)).size,
		7,
	);
	assert.equal(
		inventory.slots.some((item) => item.targetId === "disabled"),
		false,
	);
	assert.ok(
		inventory.slots.some(
			(item) => item.targetId === "claude-code" && item.lane === "vm",
		),
	);
	assert.ok(
		inventory.slots.some(
			(item) => item.targetId === "cursor-pro" && item.lane === "vm",
		),
	);
});

test("synthetic qualification verifies the exact descriptor and contained behavior across every slot", async () => {
	const roster = fixtureRoster();
	const inventory = enumerateQualificationTargets(roster);
	for (const slot of inventory.slots) {
		const plan = planRepresentativeQualification({
			targetId: slot.targetId,
			capability: slot.capability,
			rosterData: roster,
		});
		assert.equal(plan.status, "ready", `${slot.targetId}/${slot.capability}`);
		const result = await runRepresentativeQualification({
			targetId: slot.targetId,
			capability: slot.capability,
			rosterData: roster,
			dispatch: mockDispatcher(roster),
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		});
		assert.equal(
			result.status,
			"representative_passed",
			`${slot.targetId}/${slot.capability}: ${JSON.stringify(result)}`,
		);
		assert.equal(
			result.verification.descriptorIdentity,
			plan.descriptorIdentity,
		);
		assert.equal(result.verification.cleanupVerified, true);
		assert.equal(result.promotion, "none");
	}
});

test("behavior failure and unconfirmed cleanup fail closed and retain owned scratch", async () => {
	const roster = fixtureRoster();
	const first = enumerateQualificationTargets(roster).slots[0];
	const behaviorFailure = await runRepresentativeQualification({
		targetId: first.targetId,
		capability: first.capability,
		rosterData: roster,
		dispatch: mockDispatcher(roster, { wrong: true }),
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
	});
	assert.equal(
		behaviorFailure.status,
		"failed",
		JSON.stringify(behaviorFailure),
	);
	assert.ok(
		behaviorFailure.verification.failures.includes(
			"contained_acceptance_or_cleanup_failed",
		),
	);
	const mismatchedDescriptor = async (input) => {
		const receipt = await mockDispatcher(roster)(input);
		receipt.descriptorIdentity = "unobserved-descriptor";
		return receipt;
	};
	const precheckFailure = await runRepresentativeQualification({
		targetId: first.targetId,
		capability: first.capability,
		rosterData: roster,
		dispatch: mismatchedDescriptor,
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
	});
	assert.equal(precheckFailure.status, "failed");
	assert.equal(precheckFailure.reason, "descriptor_mismatch");
	assert.equal(precheckFailure.verification.containedChecksStarted, false);
	assert.equal(precheckFailure.verification.cleanupVerified, false);
	assert.equal(precheckFailure.scratchCleanupVerified, true);
	assert.equal("scratchPath" in precheckFailure, false);

	const ownedRoot = tempDir("provider-qualification-negative-");
	const noCleanup = await runRepresentativeQualification({
		targetId: first.targetId,
		capability: first.capability,
		rosterData: roster,
		dispatch: mockDispatcher(roster, { cleanup: false }),
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		tmpdirPath: ownedRoot,
	});
	assert.equal(noCleanup.status, "failed");
	assert.equal(noCleanup.reason, "scratch_cleanup_unconfirmed");
	assert.equal(
		readFileSync(
			join(noCleanup.scratchPath, "fixture-project/src/summary.mjs"),
			"utf8",
		).includes("export function summarize"),
		true,
	);
	assert.equal(noCleanup.verification.cleanupVerified, false);
});

test("VM cleanup stage cannot override unknown or contradictory writer liveness", () => {
	const lifecycle = {
		writerLifecycle: "stopped",
		terminalStatus: "exited",
		cleanupStatus: "succeeded",
		cleanupStage: "index_lock_removed",
	};
	const baseResult = {
		cleanupFailed: false,
		cleanupStage: "index_lock_removed",
		projectLockReleased: true,
		providerLifecycle: lifecycle,
	};
	assert.equal(hasProvenWorkerCleanup({ providerResult: baseResult }), false);
	assert.equal(
		hasProvenWorkerCleanup({
			providerResult: baseResult,
			cleanup: {
				writer: { state: "stopped" },
				workspace: { state: "removed" },
				projectLock: { state: "released" },
			},
		}),
		true,
	);
	assert.equal(
		hasProvenWorkerCleanup({
			providerResult: baseResult,
			cleanup: {
				writer: { state: "stopped" },
				projectLock: { state: "released" },
			},
		}),
		false,
	);
	assert.equal(
		hasProvenWorkerCleanup({
			providerResult: {
				...baseResult,
				providerLifecycle: { ...lifecycle, writerLifecycle: "unavailable" },
			},
		}),
		false,
	);
	assert.equal(
		hasProvenWorkerCleanup({
			providerResult: {
				...baseResult,
				providerLifecycle: { ...lifecycle, terminalStatus: "running" },
			},
		}),
		false,
	);
	assert.equal(
		hasProvenWorkerCleanup({
			providerResult: baseResult,
			cleanup: {
				writer: { state: "unknown" },
				worktree: { state: "removed" },
				projectLock: { state: "released" },
			},
		}),
		false,
	);
});
