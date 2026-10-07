/** Shared fixture factory for simple-routing-run and soft-retry tests. */
import { strictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { readRoutingRunState } from "../../src/switchyard/simple/routing-state.mjs";
import { tempDir } from "./tempdir.mjs";

/**
 * Build a self-contained routing test fixture.
 *
 * @param {object} overrides - Per-target behavior overrides. Keys are targetIds;
 *   special key __targets overrides the available provider list.
 * @returns {{ options, deps, calls, records }}
 */
export function fixture(overrides = {}) {
	const projectPath = realpathSync(tempDir("routing-project-"));
	const stateRoot = realpathSync(tempDir("routing-state-"));
	const calls = [];
	const records = new Map();
	const options = {
		projectPath,
		routingRunId: "run-1",
		capability: "standard",
		deadlineMs: Date.now() + 60_000,
		dirtyOverlay: true,
		files: ["a.txt"],
		checks: ["true"],
	};
	const deps = {
		stateRoot,
		getImplementorPriority: () => 1,
		// Target ids are their own identities, so routing never reads the host
		// roster (the check sandbox runs tests under an isolated HOME).
		resolveTargetIdentity: (provider) => ({
			targetId: provider,
			harnessKey: provider,
			ambiguous: false,
		}),
		assertFundedRoute: () => {},
		route: ({ availableProviders }) => ({
			provider: availableProviders[0] ?? null,
			reason: "no_eligible",
		}),
		readRun: async (id) => records.get(id),
	};
	deps.runSimpleTask = async (opts, context) => {
		const selected = context.route({
			availableProviders: overrides.__targets ?? [
				"antigravity-claude",
				"codex",
				"vibe",
			],
			only: opts.onlyProviders ?? [],
		});
		if (!selected.provider)
			return {
				status: "failed",
				failurePhase: "route",
				failureReason: "no_eligible_provider",
			};
		const targetId = selected.resolvedTargetId ?? selected.provider;
		calls.push(targetId);
		const pending = readRoutingRunState(projectPath, options.routingRunId, {
			stateRoot,
		}).pendingAttempt;
		strictEqual(pending.targetId, targetId);
		const behavior = overrides[targetId] ?? {};
		const status = behavior.status ?? "succeeded";
		const failed = status === "failed";
		const worktree = behavior.retained ? "retained" : "removed";
		const failureReason =
			behavior.result?.failureReason ??
			(failed ? "provider_exit_nonzero" : null);
		const failurePhase =
			behavior.result?.failurePhase ?? (failed ? "execute" : null);
		const errorKind =
			behavior.result?.errorKind ?? (failed ? "execution_failed" : null);
		const result = {
			runId: context.runId,
			taskId: context.taskId,
			attemptId: context.attemptId,
			targetId,
			status,
			failureReason,
			failurePhase,
			errorKind,
			partialWorktree: behavior.retained ? join(projectPath, "retained") : null,
			recovery: {
				schemaVersion: 1,
				result: {
					status,
					failureReason,
					failurePhase,
				},
				identity: {
					taskId: context.taskId,
					attemptId: context.attemptId,
					scope: (() => {
						const hash = (value) =>
							`sha256:${createHash("sha256").update(value).digest("hex")}`;
						const scope = {
							files: opts.files,
							checks: opts.checks.map((command, index) => ({
								index: index + 1,
								digest: hash(command),
							})),
						};
						return { ...scope, digest: hash(JSON.stringify(scope)) };
					})(),
				},
				cleanup: {
					writer: { state: "stopped" },
					projectLock: { state: "released" },
					worktree: {
						state: worktree,
						path: behavior.retained ? join(projectPath, "retained") : null,
					},
				},
			},
			...behavior.result,
		};
		records.set(context.runId, {
			runId: context.runId,
			projectPath,
			orderedTaskIds: [context.taskId],
			resolvedTargetId: targetId,
			state: status,
			cleanupState: "complete",
			// Real run records persist sanitized metadata, never the raw result.
			lastFailure:
				status === "failed"
					? {
							errorKind: result.errorKind,
							...(result.providerReliability
								? { providerReliability: result.providerReliability }
								: {}),
							reasonCode: result.errorKind,
							reason:
								"Provider execution failed before a reviewed integration.",
						}
					: null,
			worktree: { state: worktree, writerStopped: true },
			...behavior.record,
		});
		return result;
	};
	return { options, deps, calls, records };
}
