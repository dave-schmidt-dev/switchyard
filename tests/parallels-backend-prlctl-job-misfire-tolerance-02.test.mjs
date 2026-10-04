import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";

import { join } from "node:path";

import { describe, it } from "node:test";

import {
	PrlctlCallError,
	prlctlFailureMetadata,
	WorkerBootStageError,
	workerBootStageDiagnosticCode,
} from "../src/switchyard/adapter/exec-error.mjs";

import {
	parseParallelsWorkingName,
	ParallelsExecutionBackend as RealParallelsExecutionBackend,
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

	it("distinguishes strict snapshot parse rejection from a bounded still-present result", () => {
		for (const fixture of [
			"malformed",
			"empty-output",
			"conflicting-identity",
			"still-present",
		]) {
			let deletes = 0;
			let snapshotProbes = 0;
			let clock = 0;
			const sleeps = [];
			const statuses = [];
			const snapshotId = "{9f6e0d53-0000-4000-8000-000000000000}";
			const backend = workspaceBackend(
				(args) => {
					if (args[0] === "list") {
						return listed([
							{
								uuid: GOLDEN_UUID,
								status: "stopped",
								name:
									fixture === "conflicting-identity" && deletes
										? "other-golden"
										: "golden-fixture",
							},
						]);
					}
					if (args[0] === "snapshot-delete") {
						deletes += 1;
						throw lostExitCode();
					}
					if (args[0] === "snapshot-list") {
						snapshotProbes += 1;
						if (fixture === "still-present") {
							return JSON.stringify({ snapshots: [{ id: snapshotId }] });
						}
						return fixture === "empty-output" ? "" : "{}";
					}
					throw new Error(`unexpected call: ${args.join(" ")}`);
				},
				{
					enableLostMutationReconciliation: true,
					lostMutationReconciliationTimeoutMs: 500,
					lostMutationNowFn: () => clock,
					sleepFn: (ms) => {
						sleeps.push(ms);
						clock += ms;
					},
					onStatus: (event) => statuses.push(event),
				},
			);

			throws(
				() => backend.deleteSnapshots("golden-fixture", [snapshotId]),
				(error) => error instanceof PrlctlCallError,
			);
			strictEqual(deletes, 1, `${fixture}: deletion must not replay`);
			strictEqual(
				snapshotProbes,
				fixture === "conflicting-identity"
					? 0
					: fixture === "still-present"
						? 2
						: 1,
				`${fixture}: probe count must identify the rejection boundary`,
			);
			deepStrictEqual(
				sleeps,
				fixture === "still-present" ? [250, 250] : [],
				`${fixture}: malformed evidence must reject immediately`,
			);
			strictEqual(statuses.at(-1)?.event, "unavailable");
		}
	});

	it("does not start snapshot-list when the exact VM inventory consumes the budget", () => {
		let deletes = 0;
		let snapshotProbes = 0;
		const statuses = [];
		const clock = [0, 0, 0, 100];
		let clockIndex = 0;
		const snapshotId = "{9f6e0d53-0000-4000-8000-000000000000}";
		const backend = workspaceBackend(
			(args) => {
				if (args[0] === "list") {
					return listed([
						{ uuid: GOLDEN_UUID, status: "stopped", name: "golden-fixture" },
					]);
				}
				if (args[0] === "snapshot-delete") {
					deletes += 1;
					throw lostExitCode();
				}
				if (args[0] === "snapshot-list") {
					snapshotProbes += 1;
					return JSON.stringify({ snapshots: [] });
				}
				throw new Error(`unexpected call: ${args.join(" ")}`);
			},
			{
				enableLostMutationReconciliation: true,
				lostMutationReconciliationTimeoutMs: 50,
				lostMutationNowFn: () =>
					clock[Math.min(clockIndex++, clock.length - 1)],
				onStatus: (event) => statuses.push(event),
			},
		);

		throws(
			() => backend.deleteSnapshots("golden-fixture", [snapshotId]),
			(error) => error instanceof PrlctlCallError,
		);
		strictEqual(deletes, 1);
		strictEqual(snapshotProbes, 0);
		strictEqual(statuses.at(-1)?.event, "unavailable");
	});

	it("keeps snapshot deletion on the legacy retry path until reconciliation is enabled", () => {
		let deletes = 0;
		const backend = workspaceBackend((args) => {
			if (args[0] !== "snapshot-delete")
				throw new Error(`unexpected call: ${args.join(" ")}`);
			deletes += 1;
			if (deletes === 1) throw lostExitCode();
			return "";
		});
		backend.deleteSnapshots("golden-fixture", [
			"{9f6e0d53-0000-4000-8000-000000000000}",
		]);
		strictEqual(deletes, 2);
	});

	it("keeps paid provider execution off the retrying route entirely", () => {
		// The structural half of the contract. Adapters run a provider through
		// the execArgv descriptor, which only builds argv -- it never calls
		// prlctl, so a paid task cannot reach _call's retry at all. That is why
		// the route above can default to retrying without risking a repeat.
		let calls = 0;
		const backend = workspaceBackend(() => {
			calls += 1;
			throw lostExitCode();
		});

		const execution = backend.execArgv(WORK_UUID, {
			argv: ["/usr/local/bin/codex", "exec"],
		});
		strictEqual(execution.command, "prlctl");
		const payload = /printf %s ([A-Za-z0-9+/=]+)/.exec(
			execution.args.join(" "),
		);
		ok(payload, "the descriptor must carry an encoded guest payload");
		ok(
			Buffer.from(payload[1], "base64")
				.toString()
				.includes("/usr/local/bin/codex"),
			"the provider command must be carried, not executed",
		);
		strictEqual(calls, 0, "building a descriptor must not invoke prlctl");
	});

	it("classifies a not-yet-booted guest separately and does not retry it", () => {
		// A distinct, informative condition on a different timescale: 48 of the
		// first 100 calls after `prlctl start` returned this. The readiness
		// pollers own the wait; retrying here would mask an unbootable guest.
		let calls = 0;
		const notReady = new Error(
			"Unable to open new session in this virtual machine. Make sure your virtual machine has finished boot",
		);
		notReady.status = 255;
		const backend = workspaceBackend(() => {
			calls += 1;
			throw notReady;
		});

		throws(
			() => backend._call(["exec", WORK_UUID, "/usr/bin/true"]),
			(error) => {
				strictEqual(error.diagnosticCode, "prlctl_session_not_ready");
				return true;
			},
		);
		strictEqual(calls, 1, "readiness is polled, not retried inside a call");
	});

	it("records that the harness itself killed the child on a timeout", () => {
		const timedOut = new Error("spawnSync prlctl ETIMEDOUT");
		timedOut.code = "ETIMEDOUT";
		timedOut.killed = true;
		timedOut.signal = "SIGTERM";
		const backend = workspaceBackend(() => {
			throw timedOut;
		});

		throws(
			() => backend._call(["exec", WORK_UUID, "/sbin/mount"]),
			(error) => {
				strictEqual(error.diagnosticCode, "prlctl_call_timed_out");
				strictEqual(error.killed, true);
				strictEqual(error.signal, "SIGTERM");
				return true;
			},
		);
	});

	it("keeps the guest's own message readable on an ordinary failure", () => {
		const denied = new Error("Command failed: prlctl exec");
		denied.status = 1;
		denied.stderr = "chmod: /Users/switchyard: Read-only file system";
		const backend = workspaceBackend(() => {
			throw denied;
		});

		throws(
			() => backend._call(["exec", WORK_UUID, "/bin/chmod"]),
			(error) => {
				strictEqual(error.diagnosticCode, "prlctl_call_failed");
				ok(
					/Read-only file system/.test(error.message),
					`diagnosable text was lost: ${error.message}`,
				);
				return true;
			},
		);
	});

	it("records a persisted subcommand only from the closed allowlist, never echoing argv", () => {
		// The literal this file passes to `_call` is safe to persist; a value
		// `_call` merely happened to be invoked with is not the same guarantee,
		// so an unrecognized args[0] must come through as null rather than
		// whatever string was actually there.
		const backend = workspaceBackend(() => {
			throw lostExitCode();
		});

		throws(
			() => backend._call(["exec", WORK_UUID, "/bin/true"], { retry: false }),
			(error) => {
				strictEqual(error.subcommand, "exec");
				return true;
			},
		);
		throws(
			() => backend._call(["not-a-real-prlctl-subcommand"], { retry: false }),
			(error) => {
				strictEqual(error.subcommand, null);
				return true;
			},
		);
	});

	it("drops a signal outside the persistable set instead of forwarding it verbatim", () => {
		// Mirrors adapter/exec-error.mjs's PERSISTED_SIGNALS allowlist. SIGSEGV is
		// real (README's prlctl process-lifetime note) but is not one of the six
		// this module will carry into a run record.
		const segfault = new Error("Command failed: prlctl");
		segfault.status = null;
		segfault.signal = "SIGSEGV";
		const backend = workspaceBackend(() => {
			throw segfault;
		});

		throws(
			() => backend._call(["exec", WORK_UUID, "/bin/true"], { retry: false }),
			(error) => {
				strictEqual(error.signal, null);
				return true;
			},
		);
	});

	it("surfaces the misfire code through a wrapping boot-stage error", () => {
		// What the run record actually reads. "workspace_prepare_failed" says
		// which stage died; the misfire code says why, and only the why
		// distinguishes a transient host fault from a real provisioning problem.
		const misfire = new PrlctlCallError({
			diagnosticCode: "prlctl_job_misfire",
			subcommand: "exec",
			attempts: 4,
			exitCode: 255,
		});
		const staged = new WorkerBootStageError(
			"workspace_prepare_failed",
			misfire,
		);

		deepStrictEqual(prlctlFailureMetadata(staged), {
			diagnosticCode: "prlctl_job_misfire",
			exitCode: 255,
		});
		strictEqual(
			workerBootStageDiagnosticCode(staged),
			"workspace_prepare_failed",
			"the stage code must remain available alongside the cause",
		);
	});
});
