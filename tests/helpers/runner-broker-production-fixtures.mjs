import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getInvocationDescriptorIdentity } from "../../src/switchyard/roster/index.mjs";
import { runQueueAsync as runQueueAsyncImpl } from "../../src/switchyard/runner/index.mjs";

const __dirname = fileURLToPath(new URL("..", import.meta.url));

const FIXTURE_PATH = resolve(__dirname, "fixtures", "roster.fixture.json");

const BOUNDED_QUOTA_EVIDENCE = {
	stdoutBytes: 64,
	stderrBytes: 0,
	stdoutDigest: `sha256:${"b".repeat(64)}`,
	stderrDigest: `sha256:${"c".repeat(64)}`,
	diagnosticKind: "usage_exhausted",
};

const REVIEW_SUCCESS = Object.freeze({
	success: true,
	reviewResult: Object.freeze({ verdict: "clean" }),
});

const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;

function writeDispatchQualifiedRosterFixture() {
	const roster = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
	const testedAt = new Date().toISOString();
	for (const [targetId, target] of Object.entries(roster.targets)) {
		if (!target.enabled) continue;
		for (const slots of Object.values(target.slots ?? {})) {
			for (const slot of slots ?? []) {
				if (slot.manual_only) continue;
				const model = roster.models[slot.model_ref];
				if (model?.status !== "active") continue;
				const core = {
					target_id: targetId,
					model_ref: slot.model_ref,
					selector: model.selector,
					effort: slot.effort ?? null,
					variant: slot.variant ?? null,
					invocation_args: slot.invocation_args ?? [],
				};
				const descriptorIdentity = getInvocationDescriptorIdentity(
					core,
					target.harness,
				);
				target.qualifications ??= {};
				target.qualifications[descriptorIdentity] = {
					...core,
					descriptor_identity: descriptorIdentity,
					status: "dispatch_qualified",
					tested_at: testedAt,
					credential_profile: target.credential_profile,
				};
			}
		}
	}
	const fixturePath = join(
		tmpdir(),
		`switchyard-runner-broker-qualified-roster-${process.pid}-${randomUUID()}.json`,
	);
	writeFileSync(fixturePath, JSON.stringify(roster), "utf8");
	return fixturePath;
}

function descriptor(target, model) {
	const core = {
		target_id: target,
		model_ref: model,
		selector: model,
		effort: null,
		variant: null,
		invocation_args: [],
	};
	return {
		...core,
		descriptor_identity: getInvocationDescriptorIdentity(core, "claude"),
	};
}

function withTaskBaseLifecycle(backend) {
	const bases = new Map();
	const captureTaskBase = (_workspaceId, { taskId }) => {
		const base = {
			ref: `refs/switchyard/task-base/broker-fixture/${taskId}`,
			tree: "b".repeat(40),
		};
		bases.set(taskId, base);
		return base;
	};
	const validateTaskBase = (_workspaceId, base) => {
		if (![...bases.values()].some((candidate) => candidate.ref === base.ref)) {
			throw new Error("missing fixture task base");
		}
		return base;
	};
	const releaseTaskBase = (_workspaceId, base) => {
		for (const [taskId, candidate] of bases) {
			if (candidate.ref === base.ref) bases.delete(taskId);
		}
	};
	return {
		...backend,
		readiness: backend.readiness ?? (() => ({ inventoryCount: 0 })),
		captureTaskBase,
		captureTaskBaseAsync: async (...args) => captureTaskBase(...args),
		validateTaskBase,
		validateTaskBaseAsync: async (...args) => validateTaskBase(...args),
		releaseTaskBase,
		releaseTaskBaseAsync: async (...args) => releaseTaskBase(...args),
	};
}

function runQueueAsync(options) {
	const dependencies = options.dependencies ?? {};
	const originalFactory = dependencies.backendFactory;
	return runQueueAsyncImpl({
		...options,
		dependencies: {
			...dependencies,
			backendFactory: (factoryOptions) =>
				withTaskBaseLifecycle(
					originalFactory?.(factoryOptions) ?? {
						executionBackend: {},
						create: () =>
							options.workingContainerName ?? "broker-fixture-worker",
						destroy: () => {},
						seed: () => {},
						commit: () => {},
						reset: () => {},
					},
				),
		},
	});
}

export {
	__dirname,
	BOUNDED_QUOTA_EVIDENCE,
	descriptor,
	FIXTURE_PATH,
	previousRosterPath,
	REVIEW_SUCCESS,
	runQueueAsync,
	withTaskBaseLifecycle,
	writeDispatchQualifiedRosterFixture,
};
