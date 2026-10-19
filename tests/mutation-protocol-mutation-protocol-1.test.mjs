// @test-phase: other
import {
	deepStrictEqual,
	notStrictEqual,
	ok,
	strictEqual,
	throws,
} from "node:assert";
import { describe, it } from "node:test";
import {
	createMutationIntent,
	createMutationPolicy,
	executeMutation,
	executeMutationSync,
	mutationBackoffDelay,
	validateMutationRecord,
} from "../src/switchyard/lifecycle/mutation-protocol.mjs";

describe("mutation protocol", () => {
	it("creates stable intent identities and rejects unbounded policies", () => {
		const first = createMutationIntent({
			operation: "lock_release",
			resource: "run-1",
		});
		const second = createMutationIntent({
			operation: "lock_release",
			resource: "run-1",
		});
		strictEqual(first.operationId, second.operationId);
		strictEqual(first.state, "intent");
		ok(validateMutationRecord(first));
		strictEqual(
			mutationBackoffDelay(
				1,
				createMutationPolicy({ backoffBaseMs: 10, backoffMaxMs: 30 }),
			),
			10,
		);
		strictEqual(
			mutationBackoffDelay(
				3,
				createMutationPolicy({ backoffBaseMs: 10, backoffMaxMs: 30 }),
			),
			30,
		);
		for (const value of [0, 4]) {
			try {
				createMutationPolicy({ maxAttempts: value });
				ok(false);
			} catch {
				ok(true);
			}
		}
	});

	it("requires an observed postcondition and preserves the operation id", async () => {
		const states = [];
		let commandCalls = 0;
		const result = await executeMutation({
			operation: "lock_release",
			resource: "project-a",
			command: async ({ operationId, attempt }) => {
				commandCalls += 1;
				strictEqual(typeof operationId, "string");
				strictEqual(attempt, 1);
				return { acknowledged: true };
			},
			observe: async (value) => ({
				status: value.acknowledged ? "confirmed" : "ambiguous",
				ownership: "confirmed",
			}),
			persist: async (state) =>
				states.push({ state: state.state, operationId: state.operationId }),
		});
		strictEqual(result.state, "completed");
		strictEqual(result.outcome, "confirmed");
		strictEqual(commandCalls, 1);
		strictEqual(states.at(-1).state, "completed");
		strictEqual(states.at(-1).operationId, result.operationId);
	});

	it("does not retry ambiguous ownership and records explicit uncertainty", async () => {
		let commandCalls = 0;
		const events = [];
		const result = await executeMutation({
			operation: "lock_release",
			resource: "project-a",
			policy: { maxAttempts: 3 },
			command: async () => {
				commandCalls += 1;
				throw new Error("lost response");
			},
			observe: async () => ({ status: "ambiguous", ownership: "unknown" }),
			onStatus: (event) => events.push(event.event),
		});
		strictEqual(result.state, "uncertain");
		strictEqual(result.outcome, "ambiguous");
		strictEqual(commandCalls, 1);
		ok(events.includes("mutation_postcondition_uncertain"));
		ok(events.includes("mutation_uncertain"));
	});

	it("does not retry a mutation whose adapter cannot prove idempotency", async () => {
		let commandCalls = 0;
		const result = await executeMutation({
			operation: "provider_cleanup",
			resource: "attempt-unknown-idempotency",
			policy: { maxAttempts: 3, idempotency: "unknown" },
			command: async () => {
				commandCalls += 1;
				throw new Error("transient");
			},
			observe: async () => ({ status: "failed", ownership: "confirmed" }),
		});
		strictEqual(commandCalls, 1);
		strictEqual(result.state, "failed");
	});

	it("replays a durable completion without executing the command", async () => {
		const intent = createMutationIntent({
			operation: "provider_cleanup",
			resource: "attempt-1",
		});
		const complete = {
			...intent,
			state: "completed",
			outcome: "confirmed",
			attempt: 1,
		};
		let called = false;
		const result = await executeMutation({
			resume: complete,
			command: async () => {
				called = true;
			},
			observe: async () => ({ status: "confirmed", ownership: "confirmed" }),
		});
		deepStrictEqual(result, complete);
		strictEqual(called, false);
	});

	it("reconciles a commanded resume before issuing another command", async () => {
		const intent = createMutationIntent({
			operation: "provider_cleanup",
			resource: "attempt-reconcile",
		});
		const commanded = { ...intent, state: "commanded", attempt: 1 };
		let commandCalls = 0;
		let reconcileCalls = 0;
		const result = await executeMutation({
			resume: commanded,
			policy: { maxAttempts: 3, reconcile: true },
			command: async () => {
				commandCalls += 1;
				return { shouldNotRun: true };
			},
			observe: async () => {
				throw new Error(
					"normal observation must not run during reconciliation",
				);
			},
			reconcile: async (context) => {
				reconcileCalls += 1;
				strictEqual(context.resumed, true);
				return { status: "confirmed", ownership: "confirmed" };
			},
		});
		strictEqual(commandCalls, 0);
		strictEqual(reconcileCalls, 1);
		strictEqual(result.state, "completed");
		strictEqual(result.reconciled, true);
	});

	it("reconciles an observed crash fixture without replaying the command", async () => {
		const intent = createMutationIntent({
			operation: "provider_cleanup",
			resource: "attempt-observed-crash",
		});
		const observed = {
			...intent,
			state: "observed",
			outcome: "confirmed",
			attempt: 1,
		};
		let commandCalls = 0;
		let reconcileCalls = 0;
		const result = await executeMutation({
			operation: observed.operation,
			resource: observed.resource,
			operationId: observed.operationId,
			resume: observed,
			command: async () => {
				commandCalls += 1;
			},
			observe: async () => ({ status: "confirmed", ownership: "confirmed" }),
			reconcile: async ({ resumed, operationId, attempt }) => {
				reconcileCalls += 1;
				strictEqual(resumed, true);
				strictEqual(operationId, observed.operationId);
				strictEqual(attempt, 1);
				return { status: "confirmed", ownership: "confirmed" };
			},
		});
		strictEqual(commandCalls, 0);
		strictEqual(reconcileCalls, 1);
		strictEqual(result.state, "completed");
		strictEqual(result.reconciled, true);
		strictEqual(result.operationId, observed.operationId);
	});

	it("stops a resumed mutation when reconciliation is ambiguous", async () => {
		const intent = createMutationIntent({
			operation: "orphan_termination",
			resource: "container-reconcile",
		});
		const commanded = { ...intent, state: "commanded", attempt: 1 };
		let commandCalls = 0;
		const result = await executeMutation({
			resume: commanded,
			policy: { maxAttempts: 3, reconcile: true },
			command: async () => {
				commandCalls += 1;
			},
			observe: async () => ({ status: "confirmed", ownership: "confirmed" }),
			reconcile: async () => ({ status: "ambiguous", ownership: "unknown" }),
		});
		strictEqual(commandCalls, 0);
		strictEqual(result.state, "uncertain");
		strictEqual(result.outcome, "ambiguous");
		strictEqual(result.reconciled, true);
	});

	it("fails closed for a resumed record when reconciliation is disabled", async () => {
		const intent = createMutationIntent({
			operation: "lock_release",
			resource: "project-no-reconcile",
		});
		const commanded = { ...intent, state: "commanded", attempt: 1 };
		let commandCalls = 0;
		const result = await executeMutation({
			resume: commanded,
			policy: { reconcile: false },
			command: async () => {
				commandCalls += 1;
			},
			observe: async () => ({ status: "confirmed", ownership: "confirmed" }),
		});
		strictEqual(commandCalls, 0);
		strictEqual(result.state, "uncertain");
		strictEqual(result.outcome, "ambiguous");
	});

	it("keeps command and observation within independent bounds", async () => {
		const started = Date.now();
		const result = await executeMutation({
			operation: "orphan_termination",
			resource: "container-a",
			policy: {
				maxAttempts: 1,
				commandTimeoutMs: 10,
				observationTimeoutMs: 10,
			},
			command: () => new Promise(() => {}),
			observe: () => new Promise(() => {}),
		});
		// Well under the 5 s default bounds, so the injected 10 ms bounds were
		// used, and loose enough that a loaded host's timer delay cannot fail it.
		ok(
			Date.now() - started < 4_000,
			"bounded calls must not hang the protocol",
		);
		strictEqual(result.state, "uncertain");
	});

	it("durably completes the synchronous adapter path", () => {
		const records = [];
		const result = executeMutationSync({
			operation: "orphan_termination",
			resource: "container-sync",
			command: () => ({ acknowledged: true }),
			observe: (value) =>
				value?.acknowledged
					? { status: "confirmed", ownership: "confirmed" }
					: { status: "ambiguous", ownership: "unknown" },
			persist: (record) => records.push(record),
		});
		strictEqual(result.state, "completed");
		strictEqual(records.at(-1).state, "completed");
		strictEqual(records.at(-1).operationId, result.operationId);
		strictEqual(Object.hasOwn(records.at(-1), "commandResult"), false);
	});

	it("never completes a synchronous mutation whose postcondition is unconfirmed", () => {
		for (const [observation, state] of [
			[{ status: "failed", ownership: "confirmed" }, "failed"],
			[{ status: "ambiguous", ownership: "unknown" }, "uncertain"],
			[{ status: "unknown", ownership: "unknown" }, "uncertain"],
			[false, "uncertain"],
		]) {
			const result = executeMutationSync({
				operation: "lock_release",
				resource: "unconfirmed-sync",
				policy: { maxAttempts: 1, backoffBaseMs: 0, backoffMaxMs: 0 },
				command: () => ({ acknowledged: true }),
				observe: () => observation,
			});
			strictEqual(result.state, state, JSON.stringify(observation));
			notStrictEqual(result.outcome, "confirmed");
		}
	});

	it("binds synchronous resume to operation identity before replay", () => {
		const requested = createMutationIntent({
			operation: "provider_cleanup",
			resource: "attempt-requested",
		});
		const mismatched = {
			...createMutationIntent({
				operation: "provider_cleanup",
				resource: requested.resource,
				operationId: "operation-other",
			}),
			state: "completed",
			outcome: "confirmed",
			attempt: 1,
		};
		let commandCalls = 0;
		throws(
			() =>
				executeMutationSync({
					operation: requested.operation,
					resource: requested.resource,
					operationId: requested.operationId,
					resume: mismatched,
					command: () => {
						commandCalls += 1;
					},
					observe: () => ({ status: "confirmed", ownership: "confirmed" }),
				}),
			(error) => error?.code === "mutation_identity_mismatch",
		);
		strictEqual(commandCalls, 0);
	});
});
