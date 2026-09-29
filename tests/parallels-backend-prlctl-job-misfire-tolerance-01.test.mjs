import {
	deepStrictEqual,
	equal,
	match,
	notStrictEqual,
	ok,
	strictEqual,
	throws,
} from "node:assert/strict";

import { execFileSync, spawnSync } from "node:child_process";

import { createHash, randomUUID } from "node:crypto";

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";

import { join } from "node:path";

import { describe, it } from "node:test";

import {
	describeExecError,
	PrlctlCallError,
	prlctlFailureMetadata,
	WorkerBootStageError,
	workerBootStageDiagnosticCode,
} from "../src/switchyard/adapter/exec-error.mjs";

import { seedProjectWithBackend } from "../src/switchyard/lifecycle/index.mjs";

import {
	BULK_TRANSFER_HELPER,
	buildParallelsWorkingName,
	describeBulkTransferFailure,
	MAX_AQUA_EXEC_ARGV_BYTES,
	PARALLELS_WORKING_PREFIX,
	ParallelsHostReadinessError,
	parseParallelsWorkingName,
	probeHostProcessIdentity,
	ParallelsExecutionBackend as RealParallelsExecutionBackend,
	validateLinkedCloneMeasurement,
} from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";

import { tempDir } from "./helpers/tempdir.mjs";

const GOLDEN_UUID = "{11111111-1111-4111-8111-111111111111}";

const WORK_UUID = "{22222222-2222-4222-8222-222222222222}";

const CLIPBOARD_LABEL = "gui/501/com.parallels.copypaste";

const TEST_BOOT_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const TEST_RUN_STORE_ROOT = tempDir("switchyard-ownership-store-");

process.env.SWITCHYARD_RUN_STORE_ROOT = TEST_RUN_STORE_ROOT;

function fixtureBirth(pid, ticks = String(pid * 10 + 1)) {
	return `switchyard-host-process-v1:${TEST_BOOT_UUID}:${pid}:${ticks}`;
}

function fixtureHostProbe(pid) {
	return {
		state: "present",
		pid,
		bootSessionUuid: TEST_BOOT_UUID,
		startTicks: String(pid * 10 + 1),
		identity: fixtureBirth(pid),
	};
}

function probeChild(value, overrides = {}) {
	return {
		status: 0,
		signal: null,
		stdout: JSON.stringify(value),
		stderr: "ignored fixture stderr",
		...overrides,
	};
}

class ParallelsExecutionBackend extends RealParallelsExecutionBackend {
	constructor(options = {}) {
		super({ hostProcessIdentityProbe: fixtureHostProbe, ...options });
	}
}

function ownedOptions(runId, creatorPid = process.pid, overrides = {}) {
	return {
		runId,
		creatorPid,
		ownershipContext: {
			resourceRoot: join(TEST_RUN_STORE_ROOT, "runs", runId, "resources"),
			runId,
			taskId: "backend-fixture",
			attemptId: "attempt-1",
			projectRoot: "/private/tmp/switchyard-fixture-project",
			purpose: "backend-test",
			creatorPid,
			processStartIdentity: fixtureBirth(creatorPid),
			...overrides,
		},
	};
}

function registerOwnedEntry(backend, entry, overrides = {}) {
	const parsed = parseParallelsWorkingName(entry.name);
	const options = ownedOptions(parsed.runId, parsed.creatorPid, overrides);
	backend.writeVmOwnership(entry.uuid, entry.name, options.ownershipContext);
	backend.hostProcessIdentityProbe = (pid) =>
		backend.pidIsAlive(pid)
			? fixtureHostProbe(pid)
			: {
					state: "absent",
					pid,
					bootSessionUuid: TEST_BOOT_UUID,
					identity: null,
				};
	return options.ownershipContext;
}

function markerContext(operation = "provider", overrides = {}) {
	return {
		runId: "marker-run",
		taskId: "1.4",
		attemptId: "attempt-1",
		descriptorIdentity: "descriptor-1",
		workspaceId: WORK_UUID,
		processStartIdentity: "fixture-birth:marker-run",
		operation,
		...overrides,
	};
}

const WORKSPACE_READY = "switchyard:700\nswitchyard:700\n";

const WORKSPACE_UNAPPLIED = "switchyard:755\nswitchyard:755\n";

function causedBy(error, original) {
	for (let current = error, depth = 0; current && depth < 16; depth += 1) {
		if (current === original) return true;
		current = current.cause;
	}
	return false;
}

function lostExitCode() {
	const error = new Error(
		"Command failed: prlctl exec\nPrlJob_GetRetCode: Invalid argument. An invalid argument was passed.",
	);
	error.status = 255;
	error.stderr = "PrlJob_GetRetCode: Invalid argument.";
	error.stdout = "";
	return error;
}

function workspaceBackend(respond, options = {}) {
	return new ParallelsExecutionBackend({
		hostProcessIdentityProbe: fixtureHostProbe,
		aquaUid: 501,
		sleepFn: () => {},
		workspaceVerifyPollMs: 1,
		prlctlFn: (args) => respond(args),
		...options,
	});
}

function decodeGuestScript(args) {
	const match = /^'eval "\$\(printf %s ([A-Za-z0-9+/=]+) \| .*\)"'$/.exec(
		args.at(-1),
	);
	ok(match, `no base64 payload in ${args.at(-1)}`);
	return Buffer.from(match[1], "base64").toString("utf8");
}

function listed(entries) {
	return [
		"uuid\tstatus\tname",
		...entries.map((entry) => `${entry.uuid}\t${entry.status}\t${entry.name}`),
	].join("\n");
}

describe("prlctl job-misfire tolerance", () => {
	it("absorbs a job misfire and returns the retried result", () => {
		let calls = 0;
		const backend = workspaceBackend(() => {
			calls += 1;
			if (calls === 1) throw lostExitCode();
			return "second-attempt-output";
		});

		strictEqual(backend._call(["list", "-a"]), "second-attempt-output");
		strictEqual(calls, 2, "the misfire must cost exactly one extra call");
	});

	it("stops at the bounded attempt count instead of retrying forever, pausing on a linear backoff between attempts", () => {
		let calls = 0;
		const sleeps = [];
		const backend = workspaceBackend(
			() => {
				calls += 1;
				throw lostExitCode();
			},
			{
				prlctlRetryAttempts: 3,
				prlctlRetryBackoffMs: 250,
				sleepFn: (ms) => sleeps.push(ms),
			},
		);

		throws(
			() => backend._call(["list", "-a"]),
			(error) => {
				ok(error instanceof PrlctlCallError);
				strictEqual(error.diagnosticCode, "prlctl_job_misfire");
				strictEqual(error.attempts, 3);
				strictEqual(error.exitCode, 255, "the real exit code must survive");
				return true;
			},
		);
		strictEqual(calls, 3, "a persistent misfire must not retry unbounded");
		// Linear backoff (backoffMs * attempt), and no pause after the attempt
		// that finally gives up -- that would just be added latency on a path
		// that is already throwing.
		deepStrictEqual(sleeps, [250, 500]);
	});

	it("validates the retry-attempt count the same way it validates every other duration knob", () => {
		// A distinct validator from validateDurationMs (attempts are a count, not
		// a duration), so it earns its own boundary check: the floor is 1, not 0,
		// because "no retry" is a legitimate caller choice (see execGuest's
		// opt-out) while zero attempts would mean _call never even tries once.
		for (const value of [0, -1, 1.5, Number.NaN, "3"]) {
			throws(
				() => workspaceBackend(() => "", { prlctlRetryAttempts: value }),
				/prlctlRetryAttempts must be an integer >= 1/,
			);
		}
		ok(workspaceBackend(() => "", { prlctlRetryAttempts: 1 }));
	});

	it("retries a misfired control command run through execGuest", () => {
		// execGuest is the small-control-command route: read a marker, set a
		// mode, `rm -f`, confirm a tree is gone, ask a CLI its version. All of it
		// is safe to repeat, so a misfire is absorbed here instead of surfacing
		// as a failed boot or a healthy provider that looks dead.
		let calls = 0;
		const backend = workspaceBackend(() => {
			calls += 1;
			if (calls < 2) throw lostExitCode();
			return "ok";
		});

		strictEqual(
			String(backend.execGuest(WORK_UUID, "/bin/cat", ["/tmp/pid"])),
			"ok",
		);
		strictEqual(calls, 2, "the misfire must be absorbed, not surfaced");
	});

	it("honors an explicit retry opt-out at an execGuest call site", () => {
		// The escape hatch the route's contract promises a caller whose command
		// is not repeat-safe. It has to beat the route's own default.
		let calls = 0;
		const backend = workspaceBackend(() => {
			calls += 1;
			throw lostExitCode();
		});

		throws(
			() =>
				backend.execGuest(WORK_UUID, "/usr/local/bin/codex", ["exec"], {
					prlctlOptions: { retry: false },
				}),
			(error) => error instanceof PrlctlCallError,
		);
		strictEqual(calls, 1, "an opt-out must be attempted once only");
	});

	it("keeps start on the legacy retry path until lost-result reconciliation is explicitly enabled", () => {
		const calls = [];
		let starts = 0;
		const backend = workspaceBackend((args) => {
			calls.push(args);
			if (args[0] === "list") {
				return listed([
					{
						uuid: WORK_UUID,
						status: "stopped",
						name: buildParallelsWorkingName("legacy-start", 1234),
					},
				]);
			}
			if (args[0] === "start") {
				starts += 1;
				if (starts === 1) throw lostExitCode();
				return "";
			}
			if (args[0] === "exec") return "ready";
			throw new Error(`unexpected call: ${args.join(" ")}`);
		});

		backend.boot(WORK_UUID);
		strictEqual(starts, 2);
		strictEqual(
			calls.filter((args) => args[0] === "list").length,
			1,
			"default-off reconciliation must not add a postcondition probe",
		);
	});

	function registerOwnedVm(backend, name, runId, creatorPid = 1234) {
		backend.ownedResourcesByUuid.set(
			WORK_UUID,
			Object.freeze({
				vmUuid: WORK_UUID,
				vmName: name,
				runId,
				creatorPid,
			}),
		);
	}

	it("reconciles a lost start only from the exact owned VM and emits bounded progress", () => {
		const calls = [];
		const statuses = [];
		let starts = 0;
		const name = buildParallelsWorkingName("lost-start", 1234);
		const backend = workspaceBackend(
			(args) => {
				calls.push(args);
				if (args[0] === "list") {
					return listed([
						{ uuid: WORK_UUID, status: starts ? "running" : "stopped", name },
					]);
				}
				if (args[0] === "start") {
					starts += 1;
					throw lostExitCode();
				}
				if (args[0] === "exec") return "ready";
				throw new Error(`unexpected call: ${args.join(" ")}`);
			},
			{
				enableLostMutationReconciliation: true,
				lostMutationReconciliationTimeoutMs: 100,
				lostMutationNowFn: () => 0,
				onStatus: (event) => statuses.push(event),
			},
		);
		registerOwnedVm(backend, name, "lost-start");

		backend.boot({ uuid: WORK_UUID, name });
		strictEqual(starts, 1);
		strictEqual(calls.filter((args) => args[0] === "list").length, 2);
		deepStrictEqual(
			statuses
				.filter((event) => event.type === "lost-mutation-reconciliation")
				.map(({ event, operation }) => ({ event, operation })),
			[
				{ event: "start", operation: "start" },
				{ event: "probe", operation: "start" },
				{ event: "complete", operation: "start" },
			],
		);
		ok(statuses.every((event) => !("argv" in event) && !("output" in event)));
	});

	it("preserves the lost start cause when the strict probe budget is zero, exhausted by inventory, or rolls back", () => {
		for (const fixture of [
			"zero",
			"fractional",
			"inventory-exhausted",
			"rollback",
		]) {
			let starts = 0;
			let lists = 0;
			const name = buildParallelsWorkingName(`budget-${fixture}`, 1234);
			const clock =
				fixture === "zero"
					? [0, 0]
					: fixture === "fractional"
						? [0, 0.2]
						: fixture === "inventory-exhausted"
							? [0, 0, 0, 100]
							: [10, 10, 9];
			let clockIndex = 0;
			const backend = workspaceBackend(
				(args) => {
					if (args[0] === "list") {
						lists += 1;
						return listed([{ uuid: WORK_UUID, status: "running", name }]);
					}
					if (args[0] === "start") {
						starts += 1;
						throw lostExitCode();
					}
					throw new Error(`unexpected call: ${args.join(" ")}`);
				},
				{
					enableLostMutationReconciliation: true,
					lostMutationReconciliationTimeoutMs:
						fixture === "zero" ? 0 : fixture === "fractional" ? 1 : 50,
					lostMutationNowFn: () =>
						clock[Math.min(clockIndex++, clock.length - 1)],
				},
			);
			registerOwnedVm(backend, name, `budget-${fixture}`);

			throws(
				() => backend.boot(WORK_UUID),
				(error) => error instanceof PrlctlCallError,
			);
			strictEqual(starts, 1, `${fixture}: start must not replay`);
			strictEqual(
				lists,
				fixture === "inventory-exhausted" ? 2 : 1,
				`${fixture}: no read may start without remaining budget`,
			);
		}
	});

	it("rejects mismatched compound handles and displaced ownership without another mutation", () => {
		let starts = 0;
		let lists = 0;
		const name = buildParallelsWorkingName("owned-start", 1234);
		const backend = workspaceBackend(
			(args) => {
				if (args[0] === "list") {
					lists += 1;
					if (lists === 3) backend.ownedResourcesByUuid.delete(WORK_UUID);
					return listed([{ uuid: WORK_UUID, status: "running", name }]);
				}
				if (args[0] === "start") {
					starts += 1;
					throw lostExitCode();
				}
				throw new Error(`unexpected call: ${args.join(" ")}`);
			},
			{
				enableLostMutationReconciliation: true,
				lostMutationReconciliationTimeoutMs: 100,
				lostMutationNowFn: () => 0,
			},
		);
		registerOwnedVm(backend, name, "owned-start");

		throws(
			() => backend.boot({ uuid: WORK_UUID, name: "other-vm" }),
			/does not identify/,
		);
		strictEqual(starts, 0);
		throws(
			() => backend.boot(WORK_UUID),
			(error) => error instanceof PrlctlCallError,
		);
		strictEqual(starts, 1, "ownership displacement must not replay start");
	});

	it("reconciles lost snapshot deletion with --json and the exact golden identity", () => {
		const calls = [];
		let deletes = 0;
		const snapshotId = "{9f6e0d53-0000-4000-8000-000000000000}";
		const backend = workspaceBackend(
			(args) => {
				calls.push(args);
				if (args[0] === "list") {
					return listed([
						{ uuid: GOLDEN_UUID, status: "stopped", name: "golden-fixture" },
					]);
				}
				if (args[0] === "snapshot-delete") {
					deletes += 1;
					throw lostExitCode();
				}
				if (args[0] === "snapshot-list")
					return JSON.stringify({ snapshots: [] });
				throw new Error(`unexpected call: ${args.join(" ")}`);
			},
			{
				enableLostMutationReconciliation: true,
				lostMutationReconciliationTimeoutMs: 100,
				lostMutationNowFn: () => 0,
			},
		);

		backend.deleteSnapshots({ uuid: GOLDEN_UUID, name: "golden-fixture" }, [
			snapshotId,
		]);
		strictEqual(deletes, 1);
		deepStrictEqual(calls.at(-1), ["snapshot-list", GOLDEN_UUID, "--json"]);
	});
});
