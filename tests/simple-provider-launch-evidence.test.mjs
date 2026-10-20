// @test-phase: other
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test as nodeTest } from "node:test";
import { pathToFileURL } from "node:url";
import {
	initializeRun,
	readRun,
	updateRunWithRetry,
} from "../src/switchyard/run-store/index.mjs";
import { runSimpleWriter } from "../src/switchyard/simple/provider-invocation.mjs";
import {
	createProviderLaunchEvidence,
	isProviderLaunches,
} from "../src/switchyard/simple/provider-launch-evidence.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const test = (name, body) => nodeTest(name, { timeout: 10000 }, body);
const root = tempDir("switchyard-launch-evidence-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(root, "store");
const nonce = "11111111-1111-4111-8111-111111111111";
const start = {
	source: "ps_lstart",
	stamp: "Tue Oct 20 12:00:00 2026",
	precision: "seconds",
};
const facts = { pid: 123, processGroupId: 123, processStart: start };
const binding = { descriptorIdentity: null, worktreeNonce: nonce };
function deferred() {
	let resolve, reject;
	const promise = new Promise((a, b) => {
		resolve = a;
		reject = b;
	});
	return { promise, resolve, reject };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
function fakeChild() {
	const child = new EventEmitter();
	child.pid = 123;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.input = [];
	child.stdin = {
		end(value) {
			child.input.push(value);
		},
	};
	child.signals = [];
	child.kill = (signal) => {
		child.signals.push(signal);
		if (signal === "SIGKILL")
			queueMicrotask(() => child.emit("close", null, signal));
		return true;
	};
	return child;
}

function memoryEvidence(update) {
	let record;
	const evidence = createProviderLaunchEvidence({
		runId: "run",
		taskId: "task",
		attemptId: "attempt",
		updateRun: async (_id, patch) => {
			await update?.(patch);
			record = structuredClone(patch.providerLaunches);
		},
	});
	return { evidence, read: () => record };
}

test("pre-spawn intent is durable before observation and contains no invented process facts", async () => {
	const f = memoryEvidence();
	const publish = await f.evidence.begin("execute", binding);
	strictEqual(f.read()[0].publication, "starting");
	strictEqual(f.read()[0].pid, null);
	await publish(facts);
	strictEqual(f.read()[0].publication, "observed");
	strictEqual(f.read()[0].processStart.precision, "seconds");
	strictEqual("writerStopped" in f.read()[0], false);
	strictEqual("argv" in f.read()[0], false);
});

test("failed pre-spawn intent never supplies a launch callback", async () => {
	let returned = false;
	const f = memoryEvidence(() => {
		throw Error("disk");
	});
	await rejects(
		f.evidence.begin("execute", binding).then(() => {
			returned = true;
		}),
		{ code: "run_store_write_failed" },
	);
	strictEqual(returned, false);
	strictEqual(f.read(), undefined);
});

test("repair is separately bound and rejects stale primary, duplicate and third publication", async () => {
	const f = memoryEvidence();
	const primary = await f.evidence.begin("execute", binding);
	const repair = await f.evidence.begin("repair", binding);
	await rejects(primary(facts), { code: "run_store_write_failed" });
	await repair({ ...facts, pid: 456, processGroupId: 456 });
	strictEqual(f.read().length, 2);
	strictEqual(f.read()[0].publication, "starting");
	strictEqual(f.read()[1].pid, 456);
	await rejects(repair(facts), { code: "run_store_write_failed" });
	await rejects(f.evidence.begin("repair", binding), {
		code: "run_store_write_failed",
	});
});

test("unknown identity is explicit and malformed or extra metadata fails closed", async () => {
	const f = memoryEvidence();
	await (await f.evidence.begin("execute", binding))({ pid: 123 });
	strictEqual(f.read()[0].publication, "identity_unavailable");
	for (const patch of [
		{ pid: -1 },
		{ argv: "private" },
		{ processStart: { ...start, precision: "unique" } },
		{ worktreeNonce: "wrong" },
		{ runId: [] },
		{ launchId: [nonce] },
	]) {
		const bad = structuredClone(f.read());
		Object.assign(bad[0], patch);
		strictEqual(isProviderLaunches(bad), false, JSON.stringify(patch));
	}
});

for (const synchronous of [true, false])
	test(`${synchronous ? "sync" : "async"} publication failure aborts with no prompt and waits outer settlement`, async () => {
		const child = fakeChild(),
			settled = deferred();
		let settlementStarted = false;
		const running = runSimpleWriter("fake", [], {
			input: "prompt",
			timeoutMs: 1000,
			termGraceMs: 1,
			spawnFn: () => child,
			onProviderLaunch: () => {
				if (synchronous) throw Error("disk");
				return Promise.reject(Error("disk"));
			},
			observeProcessIdentity: () => null,
			settleWriterProcesses: async () => {
				settlementStarted = true;
				await settled.promise;
				return "unavailable";
			},
		});
		child.emit("spawn");
		await new Promise((resolve) => setTimeout(resolve, 15));
		strictEqual(settlementStarted, true);
		deepStrictEqual(child.input, []);
		deepStrictEqual(child.signals, ["SIGTERM", "SIGKILL"]);
		let done = false;
		void running.then(() => {
			done = true;
		});
		await turn();
		strictEqual(done, false);
		settled.resolve();
		const result = await running;
		strictEqual(result.launchEvidenceFailed, true);
		strictEqual(result.success, false);
		strictEqual(result.writerLifecycle, "unavailable");
		strictEqual(result.cancelled, false);
		strictEqual(result.timedOut, false);
	});

for (const identity of [
	null,
	false,
	{ startedAt: 1, stamp: start.stamp, state: "S", processGroupId: 123 },
	{
		startedAt: Date.now(),
		stamp: start.stamp,
		state: "S",
		processGroupId: 999,
	},
])
	test(`missing/stale/reused group observation remains unavailable: ${JSON.stringify(identity)}`, async () => {
		const child = fakeChild();
		let published;
		const running = runSimpleWriter("fake", [], {
			input: "prompt",
			timeoutMs: 1000,
			spawnFn: () => child,
			onProviderLaunch: async (value) => {
				published = value;
			},
			observeProcessIdentity: () => identity,
			settleWriterProcesses: async () => "stopped",
		});
		child.emit("spawn");
		await turn();
		child.emit("close", 0, null);
		await running;
		strictEqual(published.pid, 123);
		strictEqual(published.processGroupId, null);
		strictEqual(published.processStart, null);
	});

test("launch observations round-trip through actual run persistence without changing lifecycle v1", async () => {
	const runId = `launch-${randomUUID()}`;
	await initializeRun({
		runId,
		tasksFilePath: "/tasks",
		projectPath: "/project",
		orderedTaskIds: ["task"],
		initialHostFingerprint: "simple",
		worktree: {
			canonicalParent: "/private/tmp",
			candidateChild: "launch",
			path: "/private/tmp/launch",
			state: "active",
			device: "1",
			inode: "2",
			nonce,
		},
	});
	const evidence = createProviderLaunchEvidence({
		runId,
		taskId: "task",
		attemptId: "attempt",
		updateRun: updateRunWithRetry,
	});
	const publish = await evidence.begin("execute", binding);
	strictEqual(
		(await readRun(runId)).providerLaunches[0].publication,
		"starting",
	);
	await publish(facts);
	const record = await readRun(runId);
	strictEqual(record.providerLaunches[0].publication, "observed");
	strictEqual(record.worktree.writerStopped, undefined);
	strictEqual(record.state, "created");
	strictEqual(record.workerStartToken, null);
	await rejects(
		updateRunWithRetry(runId, {
			providerLaunches: [{ ...record.providerLaunches[0], taskId: "foreign" }],
		}),
	);
});

test("real local supervised child has durable early facts before stdin and no live group after return", async (t) => {
	const f = memoryEvidence(),
		publish = await f.evidence.begin("execute", binding);
	const result = await runSimpleWriter(
		process.execPath,
		[
			"-e",
			"process.stdin.once('data',()=>process.exit(0));setTimeout(()=>process.exit(9),2000)",
		],
		{
			input: "prompt",
			timeoutMs: 3000,
			onProviderLaunch: async (value) => {
				await publish(value);
				strictEqual(f.read()[0].pid, value.pid);
				const independent = spawnSync(
					"ps",
					["-o", "lstart=", "-o", "pgid=", "-p", String(value.pid)],
					{
						encoding: "utf8",
						timeout: 1500,
						stdio: ["ignore", "pipe", "ignore"],
						env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
					},
				);
				if (independent.status === 0 && !independent.error) {
					strictEqual(f.read()[0].publication, "observed");
					strictEqual(value.processGroupId, value.pid);
					strictEqual(
						value.processStart.stamp,
						independent.stdout.trim().split(/\s+/u).slice(0, 5).join(" "),
					);
					strictEqual(value.processStart.precision, "seconds");
				} else {
					strictEqual(f.read()[0].publication, "identity_unavailable");
					strictEqual(value.processStart, null);
				}
				t.diagnostic(
					JSON.stringify({
						launchIdentity: f.read()[0].publication,
						source: value.processStart?.source ?? null,
						precision: value.processStart?.precision ?? null,
					}),
				);
			},
		},
	);
	strictEqual(result.success, true);
	strictEqual(result.writerLifecycle, "stopped");
	strictEqual(result.providerLifecycle.schemaVersion, 1);
	strictEqual("processGroupId" in result.providerLifecycle, false);
	if (result.processGroupId) {
		try {
			process.kill(-result.processGroupId, 0);
			throw Error("live test group");
		} catch (error) {
			strictEqual(error.code, "ESRCH");
		}
	}
});

for (const publication of ["before", "after"])
	test(`parent death ${publication} durable launch publication preserves the explicit crash window`, async () => {
		const store = join(root, `crash-${publication}`),
			runId = `crash-${publication}`,
			pidPath = join(root, `pid-${publication}`);
		const module = (path) => pathToFileURL(resolve(path)).href;
		const source = `
 import {writeFileSync} from 'node:fs';
 import {initializeRun,updateRunWithRetry} from ${JSON.stringify(module("src/switchyard/run-store/index.mjs"))};
 import {createProviderLaunchEvidence} from ${JSON.stringify(module("src/switchyard/simple/provider-launch-evidence.mjs"))};
 import {runSimpleWriter} from ${JSON.stringify(module("src/switchyard/simple/provider-invocation.mjs"))};
 await initializeRun({runId:${JSON.stringify(runId)},tasksFilePath:'/tasks',projectPath:'/project',orderedTaskIds:['task'],initialHostFingerprint:'simple',worktree:{canonicalParent:'/private/tmp',candidateChild:'launch',path:'/private/tmp/launch',state:'active',device:'1',inode:'2',nonce:${JSON.stringify(nonce)}}});
 const publish=await createProviderLaunchEvidence({runId:${JSON.stringify(runId)},taskId:'task',attemptId:'attempt',updateRun:updateRunWithRetry}).begin('execute',${JSON.stringify(binding)});
 await runSimpleWriter(process.execPath,['-e',"process.stdin.resume();process.stdin.on('end',()=>process.exit());setTimeout(()=>process.exit(),1000)"],{input:'prompt',timeoutMs:2000,onProviderLaunch:async(facts)=>{writeFileSync(${JSON.stringify(pidPath)},String(facts.pid));if(${JSON.stringify(publication)}==='after')await publish(facts);process.kill(process.pid,'SIGKILL');}});
 `;
		const fixture = spawn(
			process.execPath,
			["--input-type=module", "-e", source],
			{
				env: { ...process.env, SWITCHYARD_RUN_STORE_ROOT: store },
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 5000,
			},
		);
		let stderr = "";
		fixture.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const [code, signal] = await once(fixture, "close");
		strictEqual(code, null, stderr);
		strictEqual(signal, "SIGKILL", stderr);
		const record = JSON.parse(
			readFileSync(join(store, "runs", runId, "run.json"), "utf8"),
		);
		if (publication === "before")
			strictEqual(record.providerLaunches[0].publication, "starting");
		else
			ok(
				["observed", "identity_unavailable"].includes(
					record.providerLaunches[0].publication,
				),
			);
		strictEqual(record.worktree.writerStopped, undefined);
		const pid = Number(readFileSync(pidPath, "utf8"));
		const deadline = Date.now() + 4000;
		let gone = false;
		while (Date.now() < deadline) {
			try {
				process.kill(pid, 0);
			} catch (error) {
				if (error.code === "ESRCH") {
					gone = true;
					break;
				}
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		ok(gone, "self-limited orphan test child must disappear");
	});

test("concurrent begin and stale callbacks cannot overwrite a pending repair intent", async () => {
	const gate = deferred();
	let writingRepair = false;
	const f = memoryEvidence(async (patch) => {
		if (patch.providerLaunches.length === 2) {
			writingRepair = true;
			await gate.promise;
		}
	});
	const primary = await f.evidence.begin("execute", binding);
	const repairWriting = f.evidence.begin("repair", binding);
	await turn();
	strictEqual(writingRepair, true);
	await rejects(primary(facts), { code: "run_store_write_failed" });
	await rejects(f.evidence.begin("repair", binding), {
		code: "run_store_write_failed",
	});
	gate.resolve();
	const repair = await repairWriting;
	await repair({ pid: 456 });
	strictEqual(f.read()[0].publication, "starting");
	strictEqual(f.read()[1].pid, 456);
});

test("publication failure survives a throwing outer teardown as unavailable", async () => {
	const child = fakeChild();
	const running = runSimpleWriter("fake", [], {
		timeoutMs: 1000,
		termGraceMs: 1,
		spawnFn: () => child,
		onProviderLaunch: () => {
			throw Error("disk");
		},
		observeProcessIdentity: () => null,
		settleWriterProcesses: async () => {
			throw Error("scan");
		},
	});
	child.emit("spawn");
	const result = await running;
	strictEqual(result.launchEvidenceFailed, true);
	strictEqual(result.writerLifecycle, "unavailable");
});

test("matching detached identity persists a weak observed stamp without signalling authority", async () => {
	const child = fakeChild(),
		f = memoryEvidence(),
		publish = await f.evidence.begin("execute", binding);
	const running = runSimpleWriter("fake", [], {
		input: "prompt",
		timeoutMs: 1000,
		spawnFn: () => child,
		onProviderLaunch: publish,
		observeProcessIdentity: () => ({
			startedAt: Date.now(),
			stamp: start.stamp,
			state: "S",
			processGroupId: 123,
		}),
		settleWriterProcesses: async () => "stopped",
	});
	child.emit("spawn");
	await turn();
	strictEqual(f.read()[0].publication, "observed");
	strictEqual(f.read()[0].processStart.precision, "seconds");
	strictEqual("writerStopped" in f.read()[0], false);
	child.emit("close", 0, null);
	strictEqual((await running).success, true);
});
