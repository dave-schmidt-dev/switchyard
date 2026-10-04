import { ok, strictEqual } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { killOrphanedProcesses } from "../src/switchyard/adapter/orphan-kill.mjs";
import { createMutationIntent } from "../src/switchyard/lifecycle/mutation-protocol.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

describe("mutation protocol", () => {
	it("binds scoped orphan completion to the retained attempt identity", () => {
		const storeRoot = tempDir("switchyard-orphan-");
		const previousRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = storeRoot;
		const containerName = `container-scoped-${randomUUID()}`;
		const runId = `run-scoped-${randomUUID()}`;
		let backendCalls = 0;
		const cleanup = (attemptId) =>
			killOrphanedProcesses(containerName, {
				cleanupContext: { runId, attemptId },
				executionBackend: {
					cleanupProviderProcess() {
						backendCalls += 1;
					},
				},
			});
		try {
			strictEqual(cleanup("attempt-one").cleanupFailed, false);
			strictEqual(cleanup("attempt-one").cleanupFailed, false);
			strictEqual(cleanup("attempt-two").cleanupFailed, false);
			strictEqual(backendCalls, 2);
			strictEqual(
				readdirSync(
					join(storeRoot, "runs", runId, "mutations", "orphan-termination"),
				).filter((name) => name.endsWith(".json")).length,
				2,
			);
		} finally {
			if (previousRoot === undefined)
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRoot;
			rmSync(storeRoot, { recursive: true, force: true });
		}
	});

	it("reconciles a crashed scoped attempt without reissuing cleanup", () => {
		const storeRoot = tempDir("switchyard-orphan-");
		const previousRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = storeRoot;
		const containerName = `container-scoped-crash-${randomUUID()}`;
		const runId = `run-scoped-crash-${randomUUID()}`;
		const attemptId = "attempt-crashed";
		const resource = `container-${createHash("sha256")
			.update(`${runId}:${attemptId}:${containerName}`, "utf8")
			.digest("hex")
			.slice(0, 32)}`;
		const intent = createMutationIntent({
			operation: "orphan_termination",
			resource,
			policy: { maxAttempts: 1, idempotency: "conditional", reconcile: true },
		});
		const sidecarDirectory = join(
			storeRoot,
			"runs",
			runId,
			"mutations",
			"orphan-termination",
		);
		mkdirSync(sidecarDirectory, { recursive: true });
		writeFileSync(
			join(sidecarDirectory, `${intent.operationId}.json`),
			JSON.stringify({ ...intent, state: "commanded", attempt: 1 }),
		);
		let backendCalls = 0;
		let reconcileCalls = 0;
		try {
			const result = killOrphanedProcesses(containerName, {
				cleanupContext: { runId, attemptId },
				executionBackend: {
					cleanupProviderProcess() {
						backendCalls += 1;
					},
				},
				reconcile: () => {
					reconcileCalls += 1;
					return { status: "confirmed", ownership: "confirmed" };
				},
			});
			strictEqual(result.cleanupFailed, false);
			strictEqual(reconcileCalls, 1);
			strictEqual(backendCalls, 0);
		} finally {
			if (previousRoot === undefined)
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRoot;
			rmSync(storeRoot, { recursive: true, force: true });
		}
	});

	it("keeps unrelated run-scoped cleanup available when legacy sidecars are full", () => {
		const storeRoot = tempDir("switchyard-orphan-");
		const previousRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = storeRoot;
		const globalDirectory = join(storeRoot, "mutations", "orphan-termination");
		mkdirSync(globalDirectory, { recursive: true });
		for (let index = 0; index < 64; index += 1) {
			const record = createMutationIntent({
				operation: "orphan_termination",
				resource: `container-global-${index}`,
				operationId: `global-${index}`,
				policy: { maxAttempts: 1, idempotency: "conditional", reconcile: true },
			});
			writeFileSync(
				join(globalDirectory, `${record.operationId}.json`),
				JSON.stringify({
					...record,
					state: "uncertain",
					outcome: "ambiguous",
					attempt: 1,
				}),
			);
		}
		let backendCalls = 0;
		try {
			const result = killOrphanedProcesses(
				`container-scoped-new-${randomUUID()}`,
				{
					cleanupContext: {
						runId: `run-independent-${randomUUID()}`,
						attemptId: "attempt-independent",
					},
					executionBackend: {
						cleanupProviderProcess() {
							backendCalls += 1;
						},
					},
				},
			);
			strictEqual(result.cleanupFailed, false);
			strictEqual(backendCalls, 1);
		} finally {
			if (previousRoot === undefined)
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRoot;
			rmSync(storeRoot, { recursive: true, force: true });
		}
	});

	it("keeps no-context compatibility cleanup independent of sidecars", () => {
		const storeRoot = tempDir("switchyard-orphan-");
		const previousRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = storeRoot;
		const globalDirectory = join(storeRoot, "mutations", "orphan-termination");
		mkdirSync(globalDirectory, { recursive: true });
		for (let index = 0; index < 64; index += 1)
			writeFileSync(join(globalDirectory, `legacy-${index}.json`), "malformed");
		let backendCalls = 0;
		try {
			const result = killOrphanedProcesses(`container-legacy-${randomUUID()}`, {
				executionBackend: {
					cleanupProviderProcess() {
						backendCalls += 1;
					},
				},
			});
			strictEqual(result.cleanupFailed, false);
			strictEqual(backendCalls, 1);
			strictEqual(readdirSync(globalDirectory).length, 64);
		} finally {
			if (previousRoot === undefined)
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRoot;
			rmSync(storeRoot, { recursive: true, force: true });
		}
	});

	it("forwards cleanup identity at every synchronous production adapter call site", () => {
		for (const adapter of [
			"agy",
			"claude",
			"codex",
			"copilot",
			"cursor",
			"opencode",
			"vibe",
		]) {
			const source = readFileSync(
				new URL(`../src/switchyard/adapter/${adapter}.mjs`, import.meta.url),
				"utf8",
			);
			ok(
				source.includes("cleanupContext: options.cleanupContext"),
				`${adapter} must forward cleanupContext`,
			);
		}
	});
});
