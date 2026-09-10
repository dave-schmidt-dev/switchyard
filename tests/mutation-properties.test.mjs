import { ok, strictEqual } from "node:assert";
import { writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import fc from "fast-check";
import {
	executeMutationSync,
	mutationBackoffDelay,
} from "../src/switchyard/lifecycle/mutation-protocol.mjs";

const PROPERTY_SEED =
	Number.parseInt(process.env.SWITCHYARD_PROPERTY_SEED ?? "1333406745", 10) >>>
	0;

function assertProperty(name, property) {
	try {
		fc.assert(property, {
			numRuns: 1000,
			seed: PROPERTY_SEED,
			endOnFailure: true,
		});
	} catch (error) {
		const output = `${error?.message ?? ""}\n${error?.cause?.message ?? ""}`;
		const path =
			error?.path ??
			error?.cause?.path ??
			output.match(/path:\s*"([^"]+)"/u)?.[1] ??
			"unknown";
		const reportedSeed = output.match(/seed:\s*(-?\d+)/u)?.[1];
		const failureSeed =
			reportedSeed === undefined
				? PROPERTY_SEED
				: Number.parseInt(reportedSeed, 10);
		const record = {
			schemaVersion: 1,
			property: name,
			seed: failureSeed,
			path,
			replay: `SWITCHYARD_PROPERTY_SEED=${failureSeed} npm run test:properties -- --test-name-pattern='${name}'`,
			candidateDigest: process.env.SWITCHYARD_CANDIDATE_DIGEST ?? "unknown",
			attribution: "candidate-versus-parent-pending",
		};
		const diagnosticFile = process.env.SWITCHYARD_PROPERTY_DIAGNOSTIC_FILE;
		if (diagnosticFile) writeFileSync(diagnosticFile, JSON.stringify(record));
		console.error(JSON.stringify(record));
		throw error;
	}
}

describe("mutation protocol properties", () => {
	it("retry budget property (1000 cases)", () => {
		assertProperty(
			"retry-budgets",
			fc.property(fc.integer({ min: 1, max: 3 }), (maxAttempts) => {
				let calls = 0;
				let sleeps = 0;
				const result = executeMutationSync({
					operation: "provider_cleanup",
					resource: "synthetic-resource",
					policy: {
						maxAttempts,
						idempotency: "idempotent",
						retryOn: ["failed"],
						backoffBaseMs: 0,
						backoffMaxMs: 0,
					},
					command: () => {
						calls += 1;
						throw new Error("synthetic failure");
					},
					observe: () => ({
						status: "failed",
						ownership: "confirmed",
						code: "synthetic_failure",
					}),
					sleepFn: () => {
						sleeps += 1;
					},
				});
				strictEqual(result.state, "failed");
				strictEqual(calls, maxAttempts);
				ok(sleeps <= Math.max(0, maxAttempts - 1));
				ok(result.attempt <= maxAttempts);
			}),
		);
	});

	it("mutation-state safety property (1000 cases)", () => {
		const observations = fc
			.record({
				status: fc.constantFrom("confirmed", "failed", "ambiguous", "unknown"),
				ownership: fc.constantFrom("confirmed", "mismatch", "unknown"),
			})
			.filter(
				({ status, ownership }) =>
					status !== "confirmed" || ownership === "confirmed",
			);
		assertProperty(
			"mutation-state-safety",
			fc.property(observations, ({ status, ownership }) => {
				const result = executeMutationSync({
					operation: "lock_release",
					resource: "synthetic-resource",
					policy: { maxAttempts: 3, backoffBaseMs: 0, backoffMaxMs: 0 },
					command: () => ({ synthetic: true }),
					observe: () => ({ status, ownership }),
				});
				ok(["completed", "failed", "uncertain"].includes(result.state));
				strictEqual(
					result.state === "completed",
					status === "confirmed" && ownership === "confirmed",
				);
				if (ownership !== "confirmed") ok(result.state !== "completed");
			}),
		);
	});

	it("bounded backoff property (1000 cases)", () => {
		assertProperty(
			"bounded-backoff",
			fc.property(
				fc.integer({ min: 1, max: 50 }),
				fc.integer({ min: 1, max: 100 }),
				(attempt, base) => {
					const delay = mutationBackoffDelay(attempt, {
						backoffBaseMs: base,
						backoffMaxMs: base * 2,
					});
					ok(delay >= 0 && delay <= base * 2);
				},
			),
		);
	});
});
