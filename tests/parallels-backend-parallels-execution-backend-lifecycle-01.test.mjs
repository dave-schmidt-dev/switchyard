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

describe("Parallels execution backend lifecycle", () => {
	it("refuses a wait interval that would hang a teardown instead of pacing it", () => {
		// Every one of these values ends up as an argument to `sleepFn`, whose
		// default is a blocking `Atomics.wait`. A NaN or a negative there is not a
		// mistuned poll, it is a teardown that never returns and emits nothing, so
		// the knob is refused where the caller can still see which one it named.
		for (const knob of [
			"aquaTimeoutMs",
			"clipboardSettleMs",
			"workspaceVerifyTimeoutMs",
			"stopSettleTimeoutMs",
			"prlctlRetryBackoffMs",
		]) {
			for (const value of [
				Number.NaN,
				-1,
				1.5,
				"1000",
				Number.POSITIVE_INFINITY,
			]) {
				throws(
					() => new ParallelsExecutionBackend({ aquaUid: 501, [knob]: value }),
					new RegExp(`^Error: ${knob} must be an integer of at least 0ms$`),
				);
			}
			// A zero budget is a real answer for a timeout: do not wait at all.
			ok(new ParallelsExecutionBackend({ aquaUid: 501, [knob]: 0 }));
		}
		throws(
			() => new ParallelsExecutionBackend({ deleteSettlementNowFn: null }),
			/deleteSettlementNowFn must be a function/,
		);
		for (const knob of [
			"aquaPollMs",
			"clipboardPollMs",
			"workspaceVerifyPollMs",
			"stopSettlePollMs",
		]) {
			// A zero poll is not "no wait", it is a busy loop against prlctl.
			for (const value of [Number.NaN, -1, 0]) {
				throws(
					() => new ParallelsExecutionBackend({ aquaUid: 501, [knob]: value }),
					new RegExp(`^Error: ${knob} must be an integer of at least 1ms$`),
				);
			}
			ok(new ParallelsExecutionBackend({ aquaUid: 501, [knob]: 1 }));
		}
	});

	it("builds an Aqua execution prefix with cwd and no Docker flags", () => {
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		const execution = backend.execArgv("{vm-uuid}", {
			cwd: "/project/subdir",
			argv: ["true"],
		});
		strictEqual(execution.command, "prlctl");
		deepStrictEqual(execution.args.slice(0, 14), [
			"exec",
			"{vm-uuid}",
			"--use-advanced-terminal",
			"launchctl",
			"asuser",
			"501",
			"sudo",
			"-u",
			"switchyard",
			"/usr/bin/env",
			"HOME=/Users/switchyard",
			"USER=switchyard",
			"LOGNAME=switchyard",
			"/bin/bash",
		]);
		strictEqual(execution.args[2], "--use-advanced-terminal");
		ok(!execution.args.includes("-i"));
		const script = decodeGuestScript(execution.args);
		ok(script.startsWith("cd '/Users/switchyard/.switchyard/project/subdir'"));
		ok(script.endsWith("&& exec 'true'"));
	});

	it("routes only approved API-key models through fixed BWS consumers", () => {
		const backend = new ParallelsExecutionBackend({ aquaUid: 503 });
		const request = {
			model: "opencode-go/mimo-v2.5",
			invocationArgs: [],
			prompt: "synthetic prompt only",
			idleSeconds: 60,
		};
		const go = backend.ephemeralOpenCodeKeyExecution(WORK_UUID, request);
		strictEqual(
			go.command,
			"/Users/dave/Documents/Projects/bws/bws-secret-exec.py",
		);
		deepStrictEqual(go.args, ["switchyard-opencode-go-dispatch", "--"]);
		deepStrictEqual(JSON.parse(go.input), {
			...request,
			workspaceId: WORK_UUID.slice(1, -1),
		});
		deepStrictEqual(go.cleanupContext, { workspaceId: WORK_UUID });
		const mistral = backend.ephemeralOpenCodeKeyExecution(WORK_UUID, {
			...request,
			model: "mistral/mistral-medium-latest",
		});
		deepStrictEqual(mistral.args, [
			"switchyard-opencode-mistral-dispatch",
			"--",
		]);
		strictEqual(
			backend.ephemeralOpenCodeKeyExecution(WORK_UUID, {
				...request,
				model: "opencode-zen/gpt-5",
			}),
			null,
		);
		throws(
			() => backend.ephemeralOpenCodeKeyExecution("not-a-vm", request),
			/VM UUID/,
		);
	});

	it("records only opted-in provider commands and removes the marker on exit", () => {
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		const workspaceId = `marker-test-${randomUUID()}`;
		const cleanupContext = markerContext("provider", { workspaceId });
		const markerPath = backend.providerPidPath(workspaceId, cleanupContext);
		const controlScript = decodeGuestScript(
			backend.execArgv(workspaceId, { cwd: "/", argv: ["true"] }).args,
		);
		ok(!controlScript.includes(markerPath));

		const execution = backend.execArgv(workspaceId, {
			cwd: "/",
			recordPid: true,
			cleanupContext,
			argv: [
				"/bin/bash",
				"-c",
				'for _ in {1..100}; do test -s "$1" && break; sleep 0.01; done; test "$(head -n 1 "$1")" = "$$" || exit 9; IFS= read -r value; printf "out:%s\\n" "$value"; printf "err:%s\\n" "$value" >&2; exit 7',
				"provider-test",
				markerPath,
			],
		});
		const providerScript = decodeGuestScript(execution.args);
		const result = spawnSync("/bin/bash", ["-c", providerScript], {
			input: "payload\n",
			encoding: "utf8",
		});
		try {
			strictEqual(result.status, 7);
			strictEqual(result.stdout, "out:payload\n");
			strictEqual(result.stderr, "err:payload\n");
			strictEqual(existsSync(markerPath), false);
			const evidenceText = readFileSync(
				execution.terminalEvidence.path,
				"utf8",
			);
			ok(Buffer.byteLength(evidenceText, "utf8") <= 1024);
			const evidence = JSON.parse(evidenceText);
			deepStrictEqual(Object.keys(evidence).sort(), [
				"exitCode",
				"kind",
				"schemaVersion",
				"status",
				"token",
			]);
			strictEqual(evidence.exitCode, 7);
			strictEqual(evidence.token, execution.terminalEvidence.token);
			for (const forbidden of [
				"output",
				"prompt",
				"command",
				"environment",
				"env",
				"credential",
				"credentials",
			]) {
				strictEqual(
					Object.hasOwn(evidence, forbidden),
					false,
					`terminal evidence must not contain ${forbidden}`,
				);
			}
		} finally {
			rmSync(execution.terminalEvidence.path, { force: true });
		}
	});

	it("binds a fresh content-free terminal evidence token to each legacy provider attempt", () => {
		const backend = workspaceBackend(() => "");
		const context = markerContext("provider");
		const execution = backend.execArgv(WORK_UUID, {
			argv: ["/usr/local/bin/codex", "exec"],
			recordPid: true,
			cleanupContext: context,
		});
		const script = decodeGuestScript(execution.args);
		const evidencePath = backend.providerTerminalEvidencePath(
			WORK_UUID,
			context,
		);
		ok(execution.terminalEvidence?.token);
		ok(script.includes(`rm -f -- '${evidencePath}'`));
		ok(script.includes(execution.terminalEvidence.token));
		ok(script.includes('"kind":"switchyard_provider_terminal"'));
		ok(!script.includes("prompt"));
		ok(!script.includes("OPENAI_API_KEY"));
	});

	it("accepts only exact token-bound terminal evidence and leaves malformed evidence uncertain", () => {
		const context = markerContext("provider");
		const calls = [];
		const backend = workspaceBackend((args) => {
			calls.push(args);
			return JSON.stringify({
				schemaVersion: 1,
				kind: "switchyard_provider_terminal",
				token: "11111111-1111-4111-8111-111111111111",
				status: "stopped",
				exitCode: 0,
			});
		});
		const path = backend.providerTerminalEvidencePath(WORK_UUID, context);
		strictEqual(
			backend.readProviderTerminalEvidence(WORK_UUID, context, {
				token: "11111111-1111-4111-8111-111111111111",
			}).status,
			"confirmed",
		);
		strictEqual(calls.length, 1);
		strictEqual(
			backend.readProviderTerminalEvidence(WORK_UUID, context, {
				token: "other-token",
			}).status,
			"uncertain",
		);
		ok(path.startsWith("/tmp/switchyard-provider-provider-"));
	});
});
