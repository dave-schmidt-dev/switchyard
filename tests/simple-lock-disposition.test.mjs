import { deepStrictEqual, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LockError } from "../src/switchyard/run-store/index.mjs";
import { handleSimple } from "../src/switchyard/simple/cli.mjs";
import { readRoutingRunState } from "../src/switchyard/simple/routing-state.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

test("simple CLI reports lock holder disposition without provider calls or automatic recovery", async () => {
	const root = realpathSync(tempDir("simple-lock-disposition-"));
	const project = join(root, "project");
	const stateRoot = join(root, "state with 'quote");
	mkdirSync(project);
	strictEqual(spawnSync("git", ["init", "-q", project]).status, 0);
	writeFileSync(
		join(project, "prompt.txt"),
		"RequiredCapability: standard\nEdit a.txt",
	);
	writeFileSync(join(project, "a.txt"), "base");
	const previous = process.env.SWITCHYARD_RUN_STORE_ROOT;
	process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;
	const now = 1_000_000;
	try {
		const cases = [
			{ name: "dead", pid: "dead", action: "recover", direction: "recover" },
			{ name: "live", pid: "live", action: "defer", direction: "defer" },
			{ name: "unknown", pid: "unknown", action: "stop", direction: "stop" },
			{
				name: "grace",
				workerPid: null,
				createdAt: now,
				action: "defer",
				direction: "defer",
			},
			{
				name: "expired",
				workerPid: null,
				createdAt: now - 300_001,
				action: "recover",
				direction: "recover",
			},
			{
				name: "terminal",
				state: "succeeded",
				cleanupState: "complete",
				pid: "dead",
				action: "stop",
				direction: "stop",
			},
			{ name: "missing", missing: true, action: "stop", direction: "stop" },
			{
				name: "mismatch",
				projectPath: "/wrong",
				pid: "dead",
				action: "stop",
				direction: "stop",
			},
			{
				name: "malformed",
				holderId: "bad;id",
				pid: "dead",
				action: "stop",
				direction: "stop",
			},
			{
				name: "claim",
				code: "PROJECT_LOCK_RECOVERY_IN_PROGRESS",
				pid: "dead",
				action: "stop",
				direction: "stop",
			},
		];
		for (const item of cases) {
			let result;
			let acquisitions = 0;
			let holderReads = 0;
			const terminalPatches = [];
			const signalProcess = new EventEmitter();
			const holderRunId = item.holderId ?? "holder-run";
			const forbidden = () => {
				throw new Error("must not route, launch, release, or recover");
			};
			await handleSimple(
				[
					join(project, "prompt.txt"),
					"--project",
					project,
					"--capability",
					"standard",
					"--file",
					"a.txt",
					"--check",
					"true",
					"--deadline",
					new Date(now + 60_000).toISOString(),
					"--routing-run-id",
					`lock-${item.name}`,
					"--task-id",
					`lock-disposition-${item.name}`,
				],
				{
					stateRoot,
					now: () => now,
					signalProcess,
					onStatus: () => {},
					initializeRun: async () => {},
					updateRunWithRetry: async (_id, patch) => {
						terminalPatches.push(patch);
					},
					createEvent: async () => {},
					acquireProjectLock: async () => {
						acquisitions += 1;
						throw new LockError("bounded fixture conflict", {
							code: item.code ?? "PROJECT_LOCK_HELD",
							holderRunId,
						});
					},
					releaseProjectLock: forbidden,
					executeProvider: forbidden,
					route: forbidden,
					readRun: async (id) => {
						holderReads += 1;
						strictEqual(id, "holder-run");
						if (item.missing) throw new Error("missing fixture");
						return {
							runId: id,
							projectPath: item.projectPath ?? project,
							state: item.state ?? "running",
							cleanupState: item.cleanupState ?? "pending",
							workerPid: Object.hasOwn(item, "workerPid")
								? item.workerPid
								: 123,
							createdAt: new Date(item.createdAt ?? 0).toISOString(),
						};
					},
					probePid: () => item.pid ?? "unknown",
					writeResult: (value) => {
						result = JSON.parse(value);
					},
				},
			);
			strictEqual(result.direction, item.direction, item.name);
			strictEqual(result.disposition.action, item.action, item.name);
			strictEqual(
				result.status,
				item.action === "defer" ? "deferred" : "failed",
			);
			strictEqual(signalProcess.exitCode, item.action === "defer" ? 6 : 1);
			strictEqual(acquisitions, 1);
			strictEqual(
				holderReads,
				["malformed", "claim"].includes(item.name) ? 0 : 1,
			);
			deepStrictEqual(result.attempts, []);
			deepStrictEqual(result.failedTargetIds, []);
			strictEqual(
				terminalPatches.some(
					(patch) =>
						Object.hasOwn(patch, "lockConflict") ||
						Object.hasOwn(patch, "disposition"),
				),
				false,
			);
			const routing = readRoutingRunState(project, `lock-${item.name}`, {
				stateRoot,
			});
			strictEqual(routing.pendingAttempt, null);
			deepStrictEqual(routing.failedTargetIds, []);
			if (item.action === "recover") {
				strictEqual(
					result.disposition.recoveryCommand,
					`switchyard-dispatch recover --run holder-run --state-root '${stateRoot.replaceAll("'", "'\"'\"'")}'`,
				);
			} else strictEqual(result.disposition.recoveryCommand, null);
			if (item.action === "defer")
				strictEqual(result.disposition.blockingRunId, "holder-run");
		}
	} finally {
		if (previous === undefined) delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		else process.env.SWITCHYARD_RUN_STORE_ROOT = previous;
	}
});
