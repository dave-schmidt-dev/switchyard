import {
	deepStrictEqual,
	equal,
	ok,
	strictEqual,
	throws,
} from "node:assert/strict";

import { execFileSync } from "node:child_process";

import { rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { describe, it } from "node:test";

import {
	PrlctlCallError,
	workerBootStageDiagnosticCode,
} from "../src/switchyard/adapter/exec-error.mjs";

import { seedProjectWithBackend } from "../src/switchyard/lifecycle/index.mjs";

import {
	buildParallelsWorkingName,
	PARALLELS_WORKING_PREFIX,
	parseParallelsWorkingName,
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

describe("Parallels execution backend lifecycle", () => {
	it("makes the baseline-commit script itself repeat-safe, not just its JS caller", () => {
		// execGuest retries a prlctl job misfire by default, and a misfire means
		// prlctl lost the RESULT of a command the guest may well have completed --
		// so this script has to survive running a second time. `git init` and
		// `git add` are no-ops on that second pass; an unguarded
		// `commit --allow-empty` is not, and stacks a second baseline.
		//
		// The literal script text is executed against a real repository rather
		// than asserted as a substring, because what is under test is shell
		// semantics: a guard that binds to the wrong side of the `&&` chain reads
		// perfectly and still commits twice. Both project shapes are covered --
		// an empty one is the case `--allow-empty` exists for, and a populated one
		// is the case that actually stages content.
		let script = null;
		seedProjectWithBackend(
			{
				pushTar: () => ({ bytes: 1 }),
				execArgv: (_workspaceId, options) => {
					script = options.argv[2];
					return { command: process.execPath, args: ["-e", ""] };
				},
			},
			"vm-uuid",
			process.cwd(),
		);
		ok(script, "the seed script must reach the execution seam");

		for (const populated of [false, true]) {
			const guestDir = tempDir("switchyard-seed-repeat-");
			try {
				if (populated) writeFileSync(join(guestDir, "README.txt"), "seeded\n");
				const log = () =>
					execFileSync("git", ["-C", guestDir, "log", "--oneline"], {
						encoding: "utf8",
					}).trim();

				execFileSync("/bin/bash", ["-lc", script], { cwd: guestDir });
				const first = log();
				strictEqual(
					first.split("\n").length,
					1,
					`the first run must create exactly one baseline commit (populated=${populated})`,
				);

				// The retried run: same script, same guest, HEAD already exists.
				execFileSync("/bin/bash", ["-lc", script], { cwd: guestDir });
				// Comparing the whole log, not just its length, also catches a
				// retry that replaced the baseline rather than appending to it.
				strictEqual(
					log(),
					first,
					`a retried run must not stack a second baseline commit or move HEAD (populated=${populated})`,
				);
			} finally {
				rmSync(guestDir, { recursive: true, force: true });
			}
		}
	});

	it("uses the reserved run-and-pid grammar and rejects malformed ownership", () => {
		const name = buildParallelsWorkingName("run-with-hyphens", 4321);
		strictEqual(name, `${PARALLELS_WORKING_PREFIX}run-with-hyphens-4321`);
		deepStrictEqual(parseParallelsWorkingName(name), {
			name,
			runId: "run-with-hyphens",
			creatorPid: 4321,
		});
		equal(parseParallelsWorkingName("switchyard-work-foreign"), null);
		equal(parseParallelsWorkingName("switchyard-work-run-0"), null);
		throws(
			() => buildParallelsWorkingName("unsafe/run", 4321),
			/safe identifier/,
		);
	});

	it("requires positive linked-clone measurements", () => {
		deepStrictEqual(
			validateLinkedCloneMeasurement({ diskBytes: 10, cloneToBootMs: 12 }),
			{ diskBytes: 10, cloneToBootMs: 12 },
		);
		throws(
			() => validateLinkedCloneMeasurement({ diskBytes: 0, cloneToBootMs: 12 }),
			/positive disk/,
		);
	});

	it("boots an unmanaged golden image only through the guarded golden path", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") {
					return listed([
						{ uuid: GOLDEN_UUID, status: "stopped", name: "macOS" },
					]);
				}
				return "ready";
			},
		});

		deepStrictEqual(backend.bootGoldenImage("macOS"), {
			uuid: GOLDEN_UUID,
			name: "macOS",
			status: "running",
		});
		ok(calls.some((args) => args[0] === "start" && args[1] === GOLDEN_UUID));
	});

	it("prepares the logical workspace for the non-admin provider", () => {
		const calls = [];
		let cloneName = null;
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			goldenImage: "macOS",
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "clone") {
					cloneName = args[3];
					return "";
				}
				if (args[0] === "list" && args[1] === "-a") {
					return listed([
						{ uuid: GOLDEN_UUID, status: "stopped", name: "macOS" },
						...(cloneName
							? [{ uuid: WORK_UUID, status: "running", name: cloneName }]
							: []),
					]);
				}
				// A guest with the clipboard agent already gone: launchctl cannot
				// print the label and pgrep matches nothing. `launchctl print
				// gui/501` (Aqua readiness) still succeeds — only the copypaste
				// label is absent.
				if (args.includes(CLIPBOARD_LABEL) || args.includes("/usr/bin/pgrep")) {
					throw new Error("could not find service");
				}
				if (args.includes("/usr/bin/stat")) return WORKSPACE_READY;
				return "ready";
			},
		});
		backend.create("macOS", {
			...ownedOptions("workspace-setup"),
			runId: "workspace-setup",
			creatorPid: process.pid,
			linked: false,
			providerUser: "switchyard",
			clipboardSettleMs: 0,
		});
		ok(
			calls.some(
				(args) =>
					args.includes("/bin/mkdir") &&
					args.some((value) => value.includes("/.switchyard/project")),
			),
		);
		ok(
			calls.some(
				(args) =>
					args.includes("/usr/sbin/chown") && args.includes("switchyard"),
			),
		);
		ok(
			calls.some((args) => args.includes("/bin/chmod") && args.includes("700")),
		);
	});

	it("classifies clone hardening and workspace preparation failures before rollback", () => {
		for (const testCase of [
			{
				stage: "_hardenClone",
				expectedCode: "clone_hardening_failed",
			},
			{
				stage: "_prepareWorkspace",
				expectedCode: "workspace_prepare_failed",
			},
		]) {
			let cloneName = null;
			let rollbackCount = 0;
			const backend = new ParallelsExecutionBackend({
				aquaUid: 501,
				prlctlFn: (args) => {
					if (args[0] === "clone") cloneName = args[3];
					if (args[0] === "list" && args[1] === "-a") {
						return listed([
							{ uuid: GOLDEN_UUID, status: "stopped", name: "macOS" },
							...(cloneName
								? [{ uuid: WORK_UUID, status: "running", name: cloneName }]
								: []),
						]);
					}
					return "ready";
				},
			});
			backend.boot = () => {};
			backend._hardenClone = () => {};
			backend._prepareWorkspace = () => {};
			backend[testCase.stage] = () => {
				throw new Error("sensitive stage detail /host/path provider output");
			};
			backend.rollback = () => {
				rollbackCount += 1;
				return true;
			};

			throws(
				() =>
					backend.create("macOS", {
						...ownedOptions(`stage-${testCase.expectedCode}`),
						runId: `stage-${testCase.expectedCode}`,
						creatorPid: process.pid,
						linked: false,
					}),
				(error) =>
					workerBootStageDiagnosticCode(error) === testCase.expectedCode,
			);
			strictEqual(rollbackCount, 1, `${testCase.stage} failure must roll back`);
		}
	});

	it("never retries a misfired clone: the working name is deterministic and a retry would collide with itself", () => {
		let cloneCalls = 0;
		let rollbackCount = 0;
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			prlctlFn: (args) => {
				if (args[0] === "clone") {
					cloneCalls += 1;
					throw lostExitCode();
				}
				return "";
			},
		});
		backend.rollback = () => {
			rollbackCount += 1;
			return true;
		};

		throws(
			() =>
				backend.create("macOS", {
					...ownedOptions("clone-misfire"),
					runId: "clone-misfire",
					creatorPid: process.pid,
					linked: false,
				}),
			(error) => {
				ok(error instanceof PrlctlCallError);
				strictEqual(error.diagnosticCode, "prlctl_job_misfire");
				strictEqual(error.cleanupUncertain, true);
				return true;
			},
		);
		strictEqual(
			cloneCalls,
			1,
			"a clone misfire must surface, not retry into a name collision",
		);
		strictEqual(
			rollbackCount,
			0,
			"unknown allocation must not be reclaimed by name",
		);
	});

	it("accepts a workspace whose guest state is correct despite a lost exit code", () => {
		const execs = [];
		// Pinned to one attempt so this exercises the repair-pass decision and
		// nothing else. `_call` now retries a job misfire internally, and at the
		// prlctl stub a retry and a repair pass look identical — leaving the
		// default in place would make this assert on both layers at once and
		// fail for a reason it does not test. The retry itself is covered by
		// "absorbs a job misfire" below.
		const backend = workspaceBackend(
			(args) => {
				execs.push(args);
				if (args.includes("/usr/bin/stat")) return WORKSPACE_READY;
				// The silent command prlctl could not read a result for.
				if (args.includes("/bin/chmod")) throw lostExitCode();
				return "";
			},
			{ prlctlRetryAttempts: 1 },
		);

		backend._prepareWorkspace(WORK_UUID, "switchyard");

		strictEqual(
			execs.filter((args) => args.includes("/bin/chmod")).length,
			1,
			"verified-correct state must not trigger a repair pass",
		);
	});
});
