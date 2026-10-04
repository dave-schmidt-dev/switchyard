import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";

import { join } from "node:path";

import { describe, it } from "node:test";

import { describeExecError } from "../src/switchyard/adapter/exec-error.mjs";

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

describe("prlctl failures stay diagnosable downstream", () => {
	function childFailure(fields) {
		return Object.assign(
			new Error("Command failed: prlctl exec {vm} claude -p ..."),
			{ stdout: "", stderr: "", status: 1, ...fields },
		);
	}

	function thrownByCall(cause) {
		const backend = workspaceBackend(() => {
			throw cause;
		});
		try {
			backend.execGuest("vm-1", "claude", ["-p", "task"], { cwd: "/" });
		} catch (error) {
			return error;
		}
		throw new Error("execGuest was expected to fail");
	}

	it("keeps an expired provider session classifiable as auth_expired", () => {
		// The documented incident: the CLI printed its diagnostic to stdout and
		// exited 1. If the wrapper hides stdout, describeExecError sees an empty
		// haystack, every signature check is gated off, and the run record gets
		// "Command failed: prlctl exec ..." back -- the opaque reason that cost a
		// cross-session investigation the first time.
		const escaped = thrownByCall(
			childFailure({
				stdout:
					"Failed to authenticate: OAuth session expired and could not be refreshed\n",
			}),
		);
		const described = describeExecError(escaped, { provider: "claude" });

		strictEqual(described.errorKind, "auth_expired");
		ok(
			described.output.includes("OAuth session expired"),
			`provider stdout was dropped: ${JSON.stringify(described.output)}`,
		);
		ok(
			described.error.includes("OAuth session expired"),
			`the surfaced reason lost the provider's words: ${described.error}`,
		);
	});

	it("keeps a provider timeout routable on error.code", () => {
		// Every adapter branches on `error.code === "ETIMEDOUT"` to reach its
		// timeout path. Losing it does not fail loudly -- it misroutes a real
		// timeout into a generic execution failure.
		const escaped = thrownByCall(
			childFailure({ code: "ETIMEDOUT", killed: true, status: null }),
		);

		strictEqual(escaped.code, "ETIMEDOUT");
		strictEqual(escaped.diagnosticCode, "prlctl_call_timed_out");
	});

	it("still prefers the child's own words over Node's wrapper", () => {
		const stderrOnly = thrownByCall(
			childFailure({ stderr: "chmod: /x: Read-only file system\n" }),
		);
		ok(/Read-only file system/.test(stderrOnly.message), stderrOnly.message);

		// stdout is the fallback: a CLI picks whichever stream it likes.
		const stdoutOnly = thrownByCall(
			childFailure({ stdout: "model 'gemini-3.7' not found\n" }),
		);
		ok(/gemini-3\.7/.test(stdoutOnly.message), stdoutOnly.message);
	});

	it("still reads the child's output when execFileSync hands it back as a Buffer", () => {
		// execFileSync returns Buffers instead of strings whenever a caller
		// overrides the backend's utf8 encoding, and an injected prlctlFn is free
		// to do that. A detail reader that only accepted strings would drop the
		// text here -- silently, since a wrapped error with no detail still looks
		// like a normal, successful classification.
		const bufferOnly = thrownByCall(
			childFailure({
				stderr: Buffer.from("chmod: /x: Read-only file system\n"),
			}),
		);
		ok(/Read-only file system/.test(bufferOnly.message), bufferOnly.message);
	});

	it("does not widen what an accidental serialization would carry", () => {
		// The forwarded fields can hold provider output; they are diagnostic
		// surface for reviewed readers, not record fields. `name` is enumerable
		// (a plain assignment, as on any Error subclass) but is a fixed literal.
		const escaped = thrownByCall(childFailure({ stdout: "guest-only text\n" }));
		deepStrictEqual(Object.keys(escaped), ["name"]);
		strictEqual(JSON.stringify(escaped), '{"name":"PrlctlCallError"}');
	});
});
