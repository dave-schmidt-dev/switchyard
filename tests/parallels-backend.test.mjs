import {
	deepStrictEqual,
	equal,
	ok,
	strictEqual,
	throws,
} from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { workerBootStageDiagnosticCode } from "../src/switchyard/adapter/exec-error.mjs";
import { seedProjectWithBackend } from "../src/switchyard/lifecycle/index.mjs";
import {
	buildParallelsWorkingName,
	MAX_AQUA_EXEC_ARGV_BYTES,
	PARALLELS_WORKING_PREFIX,
	ParallelsExecutionBackend,
	parseParallelsWorkingName,
	validateLinkedCloneMeasurement,
} from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";

const GOLDEN_UUID = "{11111111-1111-4111-8111-111111111111}";
const WORK_UUID = "{22222222-2222-4222-8222-222222222222}";
const CLIPBOARD_LABEL = "gui/501/com.parallels.copypaste";

// What the guest reports once `_prepareWorkspace` has done its job: one
// `<owner>:<mode>` line per directory, parent then root.
const WORKSPACE_READY = "switchyard:700\nswitchyard:700\n";
const WORKSPACE_UNAPPLIED = "switchyard:755\nswitchyard:755\n";

/**
 * The exact shape of the defect this suite locks out: prlctl fails on the
 * HOST while reading the guest's result, so it reports 255 for a command the
 * guest may well have run. Measured 2026-08-31 on `/bin/chmod 700`, one call
 * after `mkdir -p` and `chown` succeeded on those same paths.
 */
function lostExitCode() {
	const error = new Error(
		"Command failed: prlctl exec\nPrlJob_GetRetCode: Invalid argument. An invalid argument was passed.",
	);
	error.status = 255;
	error.stderr = "PrlJob_GetRetCode: Invalid argument.";
	error.stdout = "";
	return error;
}

/**
 * A backend wired for workspace-preparation units: no real sleeping, and a
 * prlctl stub that answers only what this stage asks.
 * @param {(args: string[]) => string} respond
 * @returns {ParallelsExecutionBackend}
 */
function workspaceBackend(respond, options = {}) {
	return new ParallelsExecutionBackend({
		aquaUid: 501,
		sleepFn: () => {},
		workspaceVerifyPollMs: 1,
		prlctlFn: (args) => respond(args),
		...options,
	});
}

/**
 * Recover the script the guest will actually run. `prlctl exec` cannot carry a
 * byte above 0x7F, so the transport ships a base64 payload; a test that reads
 * the argv without decoding is asserting on the envelope, not the command.
 * @param {string[]} args prlctl argument vector
 * @returns {string}
 */
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
		const markerPath = backend.providerPidPath(workspaceId);
		const controlScript = decodeGuestScript(
			backend.execArgv(workspaceId, { cwd: "/", argv: ["true"] }).args,
		);
		ok(!controlScript.includes(markerPath));

		const providerScript = decodeGuestScript(
			backend.execArgv(workspaceId, {
				cwd: "/",
				recordPid: true,
				argv: [
					"/bin/bash",
					"-c",
					'for _ in {1..100}; do test -s "$1" && break; sleep 0.01; done; test "$(cat "$1")" = "$$" || exit 9; IFS= read -r value; printf "out:%s\\n" "$value"; printf "err:%s\\n" "$value" >&2; exit 7',
					"provider-test",
					markerPath,
				],
			}).args,
		);
		const result = spawnSync("/bin/bash", ["-c", providerScript], {
			input: "payload\n",
			encoding: "utf8",
		});
		strictEqual(result.status, 7);
		strictEqual(result.stdout, "out:payload\n");
		strictEqual(result.stderr, "err:payload\n");
		strictEqual(existsSync(markerPath), false);
	});

	it("emits completed VM cleanup stages and preserves the last stage on failure", () => {
		const events = [];
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		backend.getGuestPid = () => 4242;
		backend.execGuest = () => {};
		const cleaned = backend.cleanupProviderProcess(
			"prlctl",
			["exec", WORK_UUID],
			{ onStatus: (event) => events.push(event) },
		);
		strictEqual(cleaned.cleanupStage, "index_lock_removed");
		deepStrictEqual(
			events.map((event) => event.event),
			[
				"provider_cleanup_started",
				"provider_pid_observed",
				"provider_tree_gone",
				"provider_pid_marker_removed",
				"provider_index_lock_removed",
				"provider_cleanup_complete",
			],
		);

		backend.execGuest = (_workspaceId, command, args) => {
			if (
				command === "/bin/rm" &&
				args.includes(backend.providerPidPath(WORK_UUID))
			) {
				throw new Error("marker removal failed");
			}
		};
		throws(
			() => backend.cleanupProviderProcess("prlctl", ["exec", WORK_UUID]),
			(error) => error.cleanupStage === "tree_terminated",
		);
	});

	it("carries the stage and exit status on provider_cleanup_failed (Task 6.3)", () => {
		// The recorded Antigravity failure emitted provider_cleanup_started and
		// provider_pid_observed, then provider_cleanup_failed with nothing but
		// a fixed status string. Two causes produce that ordering and need
		// different fixes — the guest kill script ran and found survivors, or
		// the guest exec never ran — so the event has to name which.
		const events = [];
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		backend.getGuestPid = () => 4242;
		backend.execGuest = () => {
			// What execFileSync throws when the kill script completes and its
			// closing `[ -z "$survivors" ]` fails.
			throw Object.assign(new Error("survivors after SIGKILL"), {
				status: 1,
				signal: null,
			});
		};
		throws(() =>
			backend.cleanupProviderProcess("prlctl", ["exec", WORK_UUID], {
				onStatus: (event) => events.push(event),
			}),
		);
		const failure = events.find(
			(event) => event.event === "provider_cleanup_failed",
		);
		ok(failure, "provider_cleanup_failed must still be emitted");
		strictEqual(
			failure.cleanupStage,
			"pid_observed",
			"the last stage reached is the whole fault localization",
		);
		strictEqual(failure.exitCode, 1);
		ok(
			!("stderr" in failure) && !("output" in failure),
			"INV-2: no provider text may ride out on the cleanup event",
		);
	});

	// `prlctl exec` joins its argument vector with spaces and the guest applies
	// exactly one round of shell parsing to the result. Proven live 2026-08-14:
	// a supervised `opencode run` was truncated to its first word, `set`, which
	// dumped the environment and exited 0 — a provider that never ran, reported
	// as a successful execution with an empty diff.
	//
	// So the property under test is not "the arguments are present" but "the
	// arguments survive the joining and re-parse byte for byte". Emulate that
	// trip locally: join the transport argv, hand it to a real `/bin/sh`, and
	// assert the command vector comes back out unchanged.
	it("round-trips a command vector through prlctl's join-and-reparse", () => {
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		const argv = [
			"sh",
			"-c",
			"set -u\nprintf '%s\\n' \"$@\"\n",
			"sh",
			"a prompt with spaces",
			"it's got a single quote",
			"and\na newline",
			"$(touch /tmp/pwned)",
			"x".repeat(4096),
		];
		const { args } = backend.execArgv("{vm-uuid}", { argv });
		// Emulate the whole trip, not just the tail: prlctl joins *every*
		// argument into one string, so an unquoted newline anywhere terminates
		// the guest's command line and turns the remainder into separate
		// commands. Parsing only one slice would not observe that.
		const envelope = execFileSync(
			"/bin/sh",
			["-c", `printf '%s\\0' ${args.join(" ")}`],
			{ encoding: "utf8", maxBuffer: 1024 * 1024 },
		)
			.split("\0")
			.slice(0, -1);
		// One command, one word per transport argument.
		strictEqual(envelope.length, args.length);
		// The provider account's environment is established as argv, before bash
		// starts, so `-l` reads the right profile and providers do not fall back
		// to a read-only `/` for their caches.
		deepStrictEqual(envelope.slice(0, 13), [
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
		]);
		// And the decoded payload parses to the command vector byte for byte.
		const script = decodeGuestScript(args);
		const launch = script.slice(
			script.indexOf(" && exec '") + " && exec ".length,
		);
		const recovered = execFileSync(
			"/bin/sh",
			["-c", `printf '%s\\0' ${launch}`],
			{ encoding: "utf8", maxBuffer: 1024 * 1024 },
		)
			.split("\0")
			.slice(0, -1);
		deepStrictEqual(recovered, argv);
	});

	// `prlctl exec` cannot carry a byte above 0x7F. Proven live 2026-08-14
	// against switchyard-debug-1: an em dash, a curly quote, an accented name,
	// CJK and an emoji each corrupted the command line the guest rebuilt, which
	// surfaced as `unexpected EOF while looking for matching '` rather than as
	// mangled text. One em dash in a comment inside the opencode supervisor was
	// enough to stop the provider from starting at all.
	it("keeps every transport byte inside ASCII", () => {
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		const argv = [
			"opencode",
			"run",
			"Rewrite café — 日本 🙂 and don't drop the ’curly’ quotes",
		];
		const { args } = backend.execArgv("{vm-uuid}", { argv });
		for (const entry of args) {
			// One UTF-8 byte per code unit is true only when every byte is ASCII.
			ok(
				Buffer.byteLength(entry, "utf8") === entry.length,
				`non-ASCII byte reached prlctl argv: ${JSON.stringify(entry)}`,
			);
		}
		ok(decodeGuestScript(args).endsWith(`'${argv[2].replace(/'/g, "'\\''")}'`));
	});

	it("refuses a transport with no command vector", () => {
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		throws(() => backend.execArgv("{vm-uuid}", {}), /non-empty argv/);
		throws(() => backend.execArgv("{vm-uuid}", { argv: [] }), /non-empty argv/);
		throws(
			() => backend.execArgv("{vm-uuid}", { argv: ["ok", 7] }),
			/must be strings/,
		);
	});

	it("quotes bash scripts before passing them through prlctl", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			prlctlFn: (args) => {
				calls.push(args);
				return "";
			},
		});
		backend.execGuest("{vm-uuid}", "/bin/bash", [
			"-lc",
			"if test -e /tmp/x; then echo yes; fi",
		]);
		strictEqual(calls[0].at(-2), "-lc");
		strictEqual(
			decodeGuestScript(calls[0]),
			"cd '/Users/switchyard/.switchyard/project' && exec '/bin/bash' '-lc' " +
				"'if test -e /tmp/x; then echo yes; fi'",
		);
	});

	// The README's prlctl process-lifetime rule has two halves. The first is
	// "do not provoke it": prlctl 26.4.1 segfaults when a signal reaches it
	// after its parent has exited, jumping to address 0 through `_sigtramp`
	// while blocked in QWaitCondition::wait inside ParallelsVirtualizationSDK
	// (measured 2026-08-14 17:33:00, pid 10735). That half is a discipline, not
	// a mechanism. This is the second half, which is testable: when it does
	// happen, no path may book the crashed transport as success.
	it("never books a signal-killed prlctl as success", () => {
		const signalDeath = () => {
			// The shape execFileSync raises for a child killed by a signal.
			const error = new Error("Command failed: prlctl");
			error.status = null;
			error.signal = "SIGSEGV";
			throw error;
		};
		const calls = [];
		// `list` keeps working so the failure lands where it matters. A crash
		// that takes out handle resolution proves nothing about the paths that
		// catch and escalate.
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			// This VM never stops, so waiting out the settle window would only
			// add real seconds to the assertion being made about escalation.
			stopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				calls.push(args[0]);
				if (args[0] === "list")
					return listed([
						{
							uuid: WORK_UUID,
							status: "running",
							// Destroy refuses a VM outside the reserved name, so an
							// unmanaged name would pass this test for the wrong reason.
							name: buildParallelsWorkingName("crashed-run", process.pid),
						},
					]);
				return signalDeath();
			},
		});
		throws(
			() => backend.execGuest(WORK_UUID, "/bin/bash", ["-lc", "true"]),
			/Command failed: prlctl/,
			"a segfaulted prlctl exec returned instead of throwing",
		);
		// destroy escalates stop -> stop --kill -> delete. Every one of those
		// dies the same way here, so the escalation must run out and surface
		// rather than report a VM it never destroyed.
		throws(
			() => backend.destroy(WORK_UUID),
			/Command failed: prlctl/,
			"destroy reported success against a prlctl that never ran",
		);
		ok(
			calls.filter((verb) => verb === "stop").length >= 2,
			`destroy did not exhaust its escalation before failing: ${calls.join(",")}`,
		);
	});

	it("deletes after a failed stop only when an exact stopped state is reprobed", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "stop") {
					if (args[2] === "--kill") throw new Error("stop returned 255");
					throw new Error("stop returned 255");
				}
				if (args[0] === "list")
					return listed([
						{
							uuid: WORK_UUID,
							status: "stopped",
							name: buildParallelsWorkingName("stopped", process.pid),
						},
					]);
				if (args[0] === "delete") return "";
				return "";
			},
		});

		deepStrictEqual(backend.destroy(WORK_UUID), {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("stopped", process.pid),
			forced: true,
		});
		deepStrictEqual(
			calls.map((args) => args[0]),
			["list", "stop", "stop", "list", "delete"],
		);
	});

	it("preserves a failed stop and never deletes while the exact VM is running", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list")
					return listed([
						{
							uuid: WORK_UUID,
							status: "running",
							name: buildParallelsWorkingName("running", process.pid),
						},
					]);
				throw new Error(`${args[0]} returned 255`);
			},
		});

		throws(() => backend.destroy(WORK_UUID), /returned 255/);
		ok(!calls.some((args) => args[0] === "delete"));
		deepStrictEqual(
			calls.map((args) => args[0]),
			["list", "stop", "stop", "list"],
		);
	});

	it("reprobes after delete fallback before retrying deletion", () => {
		const calls = [];
		let deleteAttempts = 0;
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list")
					return listed([
						{
							uuid: WORK_UUID,
							status: "stopped",
							name: buildParallelsWorkingName("delete-fallback", process.pid),
						},
					]);
				if (args[0] === "delete" && deleteAttempts++ === 0)
					throw new Error("delete returned 255");
				return "";
			},
		});

		deepStrictEqual(backend.destroy(WORK_UUID), {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("delete-fallback", process.pid),
			forced: true,
		});
		deepStrictEqual(
			calls.map((args) => args[0]),
			["list", "stop", "delete", "stop", "list", "delete"],
		);
	});

	it("preserves delete failure when fallback stop does not leave the exact VM stopped", () => {
		const calls = [];
		const deleteFailure = new Error("delete returned 255");
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list")
					return listed([
						{
							uuid: WORK_UUID,
							status: "running",
							name: buildParallelsWorkingName("delete-running", process.pid),
						},
					]);
				if (args[0] === "delete") throw deleteFailure;
				return "";
			},
		});

		throws(
			() => backend.destroy(WORK_UUID),
			(error) => error === deleteFailure,
		);
		ok(!calls.slice(3).some((args) => args[0] === "delete"));
		deepStrictEqual(
			calls.map((args) => args[0]),
			["list", "stop", "delete", "stop", "list"],
		);
	});

	it("does not reprobe stale graceful-stop failure when kill succeeds", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "stop" && args[2] !== "--kill")
					throw new Error("graceful stop returned 255");
				return "";
			},
		});

		deepStrictEqual(
			backend.stopAndDelete({
				uuid: WORK_UUID,
				name: "kill-success",
				status: "running",
			}),
			{ uuid: WORK_UUID, name: "kill-success", forced: true },
		);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "stop", "delete"],
		);
	});

	it("treats an absent exact VM after failed delete as already deleted", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "delete") throw new Error("delete returned 255");
				if (args[0] === "list") return listed([]);
				return "";
			},
		});

		deepStrictEqual(
			backend.stopAndDelete({
				uuid: WORK_UUID,
				name: "absent",
				status: "running",
			}),
			{ uuid: WORK_UUID, name: "absent", forced: true },
		);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "delete", "stop", "list"],
		);
	});

	it("preserves delete failure when exact-state probing fails", () => {
		const calls = [];
		const deleteFailure = new Error("delete returned 255");
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") throw new Error("list unavailable");
				if (args[0] === "delete") throw deleteFailure;
				return "";
			},
		});

		throws(
			() =>
				backend.stopAndDelete({
					uuid: WORK_UUID,
					name: "probe-failure",
					status: "running",
				}),
			(error) => error === deleteFailure,
		);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "delete", "stop", "list"],
		);
	});

	it("treats an absent exact VM after retry-delete failure as already deleted", () => {
		const calls = [];
		let deleteAttempts = 0;
		let listAttempts = 0;
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "delete") {
					deleteAttempts += 1;
					throw new Error(`delete attempt ${deleteAttempts} returned 255`);
				}
				if (args[0] === "list") {
					listAttempts += 1;
					return listAttempts === 1
						? listed([
								{
									uuid: WORK_UUID,
									status: "stopped",
									name: "retry-present",
								},
							])
						: listed([]);
				}
				return "";
			},
		});

		deepStrictEqual(
			backend.stopAndDelete({
				uuid: WORK_UUID,
				name: "retry-present",
				status: "running",
			}),
			{ uuid: WORK_UUID, name: "retry-present", forced: true },
		);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "delete", "stop", "list", "delete", "list"],
		);
	});

	it("reprobes a forced VM after delete failure without issuing a second kill", () => {
		const calls = [];
		let deleteAttempts = 0;
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list")
					return listed([
						{
							uuid: WORK_UUID,
							status: "stopped",
							name: buildParallelsWorkingName("forced-stopped", process.pid),
						},
					]);
				if (args[0] === "delete" && deleteAttempts++ === 0)
					throw new Error("delete returned 255");
				return "";
			},
		});

		deepStrictEqual(
			backend.stopAndDelete(
				{
					uuid: WORK_UUID,
					name: "forced-stopped",
					status: "running",
				},
				{ forceOnly: true },
			),
			{ uuid: WORK_UUID, name: "forced-stopped", forced: true },
		);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "delete", "list", "delete"],
		);
	});

	it("preserves forced delete failure while the exact VM remains running", () => {
		const calls = [];
		const deleteFailure = new Error("delete returned 255");
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list")
					return listed([
						{
							uuid: WORK_UUID,
							status: "running",
							name: buildParallelsWorkingName("forced-running", process.pid),
						},
					]);
				if (args[0] === "delete") throw deleteFailure;
				return "";
			},
		});

		throws(
			() =>
				backend.stopAndDelete(
					{
						uuid: WORK_UUID,
						name: "forced-running",
						status: "running",
					},
					{ forceOnly: true },
				),
			(error) => error === deleteFailure,
		);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "delete", "list"],
		);
	});

	it("waits out the shutdown settle window instead of racing its own stop", () => {
		// The sequence measured on the INV-1 gate 2026-08-31: the stop reported
		// success, the delete issued straight after it was refused because
		// Parallels still had the VM running, and the VM reported stopped a
		// moment later. Sampling that state once decides the race by coin flip
		// and leaks the VM on the losing side.
		const calls = [];
		const sleeps = [];
		let listAttempts = 0;
		let deleteAttempts = 0;
		const backend = new ParallelsExecutionBackend({
			sleepFn: (ms) => sleeps.push(ms),
			stopSettlePollMs: 1,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") {
					listAttempts += 1;
					return listed([
						{
							uuid: WORK_UUID,
							status: listAttempts < 3 ? "running" : "stopped",
							name: "settling",
						},
					]);
				}
				if (args[0] === "delete" && deleteAttempts++ === 0) {
					const error = new Error("Command failed: prlctl delete");
					error.status = 255;
					error.stderr =
						"Failed to remove the VM: Unable to perform the action because the virtual machine is busy. The virtual machine is currently running. Please try again later.";
					throw error;
				}
				return "";
			},
		});

		deepStrictEqual(
			backend.stopAndDelete({
				uuid: WORK_UUID,
				name: "settling",
				status: "running",
			}),
			{ uuid: WORK_UUID, name: "settling", forced: true },
		);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "delete", "stop", "list", "list", "list", "delete"],
		);
		strictEqual(sleeps.length, 2);
	});

	it("preserves the delete failure when the VM never settles", () => {
		const calls = [];
		const deleteFailure = new Error("delete returned 255");
		let now = 0;
		const backend = new ParallelsExecutionBackend({
			nowFn: () => now,
			sleepFn: (ms) => {
				now += ms;
			},
			stopSettleTimeoutMs: 3_000,
			stopSettlePollMs: 1_000,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list")
					return listed([
						{ uuid: WORK_UUID, status: "running", name: "stuck" },
					]);
				if (args[0] === "delete") throw deleteFailure;
				return "";
			},
		});

		throws(
			() =>
				backend.stopAndDelete({
					uuid: WORK_UUID,
					name: "stuck",
					status: "running",
				}),
			(error) => error === deleteFailure,
		);
		// It waited the full window before giving up, and never deleted a VM it
		// had just observed running.
		strictEqual(calls.filter((args) => args[0] === "list").length, 4);
		strictEqual(calls.filter((args) => args[0] === "delete").length, 1);
	});

	it("uses the bulk transfer hook without sending tar bytes to prlctl", () => {
		const transfers = [];
		const prlctlCalls = [];
		const backend = new ParallelsExecutionBackend({
			transferHost: "10.211.55.2",
			bulkTransferFn: (descriptor) => {
				transfers.push(descriptor);
				return descriptor.direction === "pull"
					? Buffer.from("pulled-tar")
					: { audited: true };
			},
			prlctlFn: (args) => prlctlCalls.push(args),
		});
		strictEqual(backend.transferListenHost, "10.211.55.2");
		const pushed = Buffer.from("large-enough-for-the-hook");
		const receipt = backend.pushTar("{vm-uuid}", pushed, "/project");
		const pulled = backend.pullTar("{vm-uuid}", "/project/archive.tar");
		deepStrictEqual(receipt, {
			bytes: pushed.length,
			sha256: receipt.sha256,
			audited: true,
		});
		deepStrictEqual(pulled, Buffer.from("pulled-tar"));
		strictEqual(transfers.length, 2);
		deepStrictEqual(transfers[0].tar, pushed);
		ok(transfers[0].guestArgs.some((value) => value.includes("TRANSFER_URL")));
		ok(!transfers[0].pfArgs.some((value) => value.includes(pushed.toString())));
		deepStrictEqual(prlctlCalls.at(-1), [
			"exec",
			"{vm-uuid}",
			"/usr/sbin/chown",
			"-R",
			"switchyard",
			"/Users/switchyard/.switchyard/project",
		]);
	});

	it("writes each measured credential file to its own home-relative path", () => {
		const prlctlCalls = [];
		const pushes = [];
		const backend = new ParallelsExecutionBackend({
			aquaUid: 503,
			providerUser: "switchyard",
			bulkTransferFn: (descriptor) => {
				pushes.push(descriptor);
				return { audited: true };
			},
			prlctlFn: (args) => prlctlCalls.push(args),
		});
		const receipt = backend.provisionCredentials("{vm-uuid}", {
			provider: "claude",
			credentials: [
				{ file: ".claude/.credentials.json", tar: Buffer.from("cred-a") },
				{ file: ".claude.json", tar: Buffer.from("cred-b") },
			],
			aquaUid: 503,
		});
		deepStrictEqual(
			receipt.files.map((entry) => entry.path),
			[
				"/Users/switchyard/.claude/.credentials.json",
				"/Users/switchyard/.claude.json",
			],
		);
		strictEqual(pushes.length, 2);
		// Every hop runs through the Aqua session, because that is the identity
		// whose Keychain and home the provider actually reads at exec time.
		for (const push of pushes) {
			ok(push.guestArgs.includes("asuser"));
			ok(push.guestArgs.includes("503"));
		}
		ok(
			decodeGuestScript(pushes[0].guestArgs).includes(
				"/Users/switchyard/.claude",
			),
		);
		const chowns = prlctlCalls.filter((args) =>
			args.includes("/usr/sbin/chown"),
		);
		// Named targets, never `-R`: the second file lives at the root of the
		// provider's home, so a recursive chown there would sweep the seeded
		// workspace and everything else the account owns.
		strictEqual(chowns.length, 2);
		for (const chown of chowns) ok(!chown.includes("-R"));
		deepStrictEqual(chowns[1].at(-1), "/Users/switchyard/.claude.json");
		const chmods = prlctlCalls
			.map((args) => (args.at(-2) === "-lc" ? decodeGuestScript(args) : ""))
			.filter((script) => script.includes("'/bin/chmod'"));
		strictEqual(chmods.length, 2);
		for (const chmod of chmods) ok(chmod.includes("'600'"));
	});

	it("refuses a partial or unexpected credential set", () => {
		const backend = new ParallelsExecutionBackend({
			aquaUid: 503,
			bulkTransferFn: () => ({ audited: true }),
			prlctlFn: () => "",
		});
		// Measured in the guest: claude reports `"loggedIn": false` with either
		// file alone, so a half-provisioned home looks provisioned and is not.
		throws(
			() =>
				backend.provisionCredentials("{vm-uuid}", {
					provider: "claude",
					credentials: [{ file: ".claude.json", tar: Buffer.from("cred") }],
				}),
			/missing credential file for claude: \.claude\/\.credentials\.json/,
		);
		throws(
			() =>
				backend.provisionCredentials("{vm-uuid}", {
					provider: "codex",
					credentials: [{ file: "../../etc/passwd", tar: Buffer.from("cred") }],
				}),
			/unexpected credential file for codex/,
		);
		throws(
			() =>
				backend.provisionCredentials("{vm-uuid}", {
					provider: "cursor-agent",
					credentials: [
						{ file: ".cursor/cli-config.json", tar: Buffer.from("cred") },
					],
				}),
			/not tar-provisionable/,
		);
	});

	it("seeds a backend through pushTar and its execution seam", () => {
		const calls = [];
		const backend = {
			pushTar(workspaceId, tar, destination) {
				calls.push({ workspaceId, bytes: tar.length, destination });
				return { bytes: tar.length };
			},
			execArgv(workspaceId, options) {
				calls.push({ workspaceId, options });
				return { command: process.execPath, args: ["-e", ""] };
			},
		};
		const receipt = seedProjectWithBackend(backend, "vm-uuid", process.cwd());
		ok(receipt.bytes > 0);
		strictEqual(calls[0].destination, "/project");
		strictEqual(calls[1].options.cwd, "/project");
		// The baseline commit is handed to the backend as a command vector, not
		// appended to a prefix the backend never sees and so cannot quote.
		deepStrictEqual(calls[1].options.argv.slice(0, 2), ["/bin/bash", "-lc"]);
		ok(calls[1].options.argv[2].startsWith("git init -q"));
		ok(calls[1].options.argv[2].includes("commit --allow-empty -qm baseline"));
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

	it("accepts a workspace whose guest state is correct despite a lost exit code", () => {
		const execs = [];
		const backend = workspaceBackend((args) => {
			execs.push(args);
			if (args.includes("/usr/bin/stat")) return WORKSPACE_READY;
			// The silent command prlctl could not read a result for.
			if (args.includes("/bin/chmod")) throw lostExitCode();
			return "";
		});

		backend._prepareWorkspace(WORK_UUID, "switchyard");

		strictEqual(
			execs.filter((args) => args.includes("/bin/chmod")).length,
			1,
			"verified-correct state must not trigger a repair pass",
		);
	});

	it("repairs the workspace when the first layout pass did not apply", () => {
		let chmodCalls = 0;
		const backend = workspaceBackend((args) => {
			if (args.includes("/bin/chmod")) {
				chmodCalls += 1;
				if (chmodCalls === 1) throw lostExitCode();
				return "";
			}
			if (args.includes("/usr/bin/stat")) {
				return chmodCalls >= 2 ? WORKSPACE_READY : WORKSPACE_UNAPPLIED;
			}
			return "";
		});

		backend._prepareWorkspace(WORK_UUID, "switchyard");

		strictEqual(chmodCalls, 2, "a real mismatch must be repaired once");
	});

	it("fails workspace preparation when the guest state stays wrong", () => {
		let cloneName = null;
		const backend = workspaceBackend((args) => {
			if (args[0] === "clone") cloneName = args[3];
			if (args[0] === "list" && args[1] === "-a") {
				return listed([
					{ uuid: GOLDEN_UUID, status: "stopped", name: "macOS" },
					...(cloneName
						? [{ uuid: WORK_UUID, status: "running", name: cloneName }]
						: []),
				]);
			}
			// chmod never takes, and the guest says so every time.
			if (args.includes("/usr/bin/stat")) return WORKSPACE_UNAPPLIED;
			return "ready";
		});
		backend.boot = () => {};
		backend._hardenClone = () => {};
		backend.rollback = () => true;

		throws(
			() =>
				backend.create("macOS", {
					runId: "workspace-unapplied",
					creatorPid: process.pid,
					linked: false,
				}),
			(error) =>
				workerBootStageDiagnosticCode(error) === "workspace_prepare_failed",
		);
	});

	it("retries a verification probe that produces no output", () => {
		let statCalls = 0;
		const backend = workspaceBackend((args) => {
			if (args.includes("/usr/bin/stat")) {
				statCalls += 1;
				// An empty result is the probe failing, not a wrong workspace.
				if (statCalls === 1) return "";
				if (statCalls === 2) throw lostExitCode();
				return WORKSPACE_READY;
			}
			return "";
		});

		backend._prepareWorkspace(WORK_UUID, "switchyard");

		strictEqual(statCalls, 3, "the probe must be retried, not believed");
	});

	it("reports the layout failure, not the probe failure, when the guest is unreachable", () => {
		const backend = workspaceBackend(
			(args) => {
				if (args.includes("/bin/chmod")) {
					throw new Error("chmod: /Users/switchyard: Read-only file system");
				}
				if (args.includes("/usr/bin/stat")) throw lostExitCode();
				return "";
			},
			{ workspaceVerifyTimeoutMs: 0 },
		);

		throws(
			() => backend._prepareWorkspace(WORK_UUID, "switchyard"),
			/Read-only file system/,
		);
	});

	// INV-1 is asserted when the golden image is built but consumed at dispatch.
	// A Guest Tools refresh inside the golden on 2026-08-21 restored the
	// package-owned clipboard LaunchAgent the build had renamed away, and every
	// clone taken afterwards leaked the host pasteboard with nothing on the
	// create path to notice. These two tests lock the enforcement in place.
	it("disarms the guest clipboard agent on every clone before the provider user enters", () => {
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
				if (args.includes(CLIPBOARD_LABEL) || args.includes("/usr/bin/pgrep")) {
					throw new Error("could not find service");
				}
				if (args.includes("/usr/bin/stat")) return WORKSPACE_READY;
				return "ready";
			},
		});

		backend.create("macOS", {
			runId: "clipboard-harden",
			creatorPid: process.pid,
			linked: false,
			providerUser: "switchyard",
			clipboardSettleMs: 0,
		});

		const guest = calls.filter((args) => args[0] === "exec");
		for (const verb of ["bootout", "disable"]) {
			ok(
				guest.some(
					(args) =>
						args.includes("/bin/launchctl") &&
						args.includes(verb) &&
						args.includes(CLIPBOARD_LABEL),
				),
				`create() must ${verb} ${CLIPBOARD_LABEL}`,
			);
		}
		ok(
			guest.some(
				(args) =>
					args.includes("/usr/bin/pkill") && args.includes("prlcopypaste"),
			),
			"create() must kill a running clipboard agent",
		);
		// Proving it, not just asking for it.
		ok(
			guest.some(
				(args) =>
					args.includes("/bin/launchctl") &&
					args.includes("print") &&
					args.includes(CLIPBOARD_LABEL),
			),
			"create() must verify the clipboard label is gone",
		);
		// Ordering is the point: enforcement lands before the workspace the
		// provider user is dropped into.
		const disarmAt = guest.findIndex((args) => args.includes("bootout"));
		const workspaceAt = guest.findIndex((args) => args.includes("/bin/mkdir"));
		ok(
			disarmAt >= 0 && workspaceAt > disarmAt,
			"clipboard teardown must precede workspace preparation",
		);
	});

	it("fails the clone when the clipboard agent survives the teardown", () => {
		let cloneName = null;
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			goldenImage: "macOS",
			prlctlFn: (args) => {
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
				// The label keeps printing: prltoolsd supervises the agent and
				// launchctl cannot hold it down. Dispatch must stop, not proceed
				// into a guest that still reaches the host pasteboard.
				return "ready";
			},
		});

		throws(
			() =>
				backend.create("macOS", {
					runId: "clipboard-survives",
					creatorPid: process.pid,
					linked: false,
					providerUser: "switchyard",
					clipboardSettleMs: 0,
				}),
			(error) =>
				workerBootStageDiagnosticCode(error) === "clone_hardening_failed",
		);
	});

	it("refuses to harden a clone without an Aqua uid rather than skipping the teardown", () => {
		const backend = new ParallelsExecutionBackend({
			prlctlFn: () => "ready",
		});
		// Silently skipping enforcement on a missing uid would rebuild the exact
		// "env unset -> silent green" shape this change removes.
		throws(
			() => backend._hardenClone(WORK_UUID, {}),
			/aquaUid must be a positive numeric uid/,
		);
	});

	it("keeps watching for the clipboard agent across the whole settle window", () => {
		// The window exists because prltoolsd supervises the agent and brings it
		// back a few seconds after boot. Sampling once right after the teardown
		// reads clean and misses the respawn, so this runs the real 8s default on a
		// fake clock: the agent reappears on the third poll and the clone must still
		// fail. Collapsing the loop to a single check makes this test stop throwing.
		let printCount = 0;
		let now = 0;
		let slept = 0;
		let cloneName = null;
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			goldenImage: "macOS",
			nowFn: () => now,
			sleepFn: (ms) => {
				slept += 1;
				now += ms;
			},
			prlctlFn: (args) => {
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
				if (args.includes("print") && args.includes(CLIPBOARD_LABEL)) {
					printCount += 1;
					// Gone, gone, then supervised back into existence.
					if (printCount >= 3) return "ready";
					throw new Error("could not find service");
				}
				if (args.includes(CLIPBOARD_LABEL) || args.includes("/usr/bin/pgrep")) {
					throw new Error("could not find service");
				}
				return "ready";
			},
		});

		throws(
			() =>
				backend.create("macOS", {
					runId: "clipboard-respawn",
					creatorPid: process.pid,
					linked: false,
					providerUser: "switchyard",
				}),
			(error) =>
				workerBootStageDiagnosticCode(error) === "clone_hardening_failed",
		);
		strictEqual(
			printCount,
			3,
			"the settle window must re-sample instead of checking once",
		);
		ok(
			slept >= 2 && now > 0,
			"the settle window must advance the clock between samples",
		);
	});

	it("reclaims only dead owned VMs and force-stops a running one", () => {
		const calls = [];
		const entries = [
			{
				uuid: WORK_UUID,
				status: "running",
				name: buildParallelsWorkingName("dead-run", 999999),
			},
			{
				uuid: GOLDEN_UUID,
				status: "stopped",
				name: buildParallelsWorkingName("dead-stopped", 999998),
			},
			{ uuid: "foreign", status: "running", name: "developer-vm" },
		];
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") return listed(entries);
				return "ok";
			},
			pidIsAlive: () => false,
		});

		const result = backend.reclaim();
		strictEqual(result.reclaimed.length, 2);
		ok(
			calls.some(
				(args) =>
					args[0] === "stop" && args[1] === WORK_UUID && args[2] === "--kill",
			),
		);
		ok(!calls.some((args) => args[1] === "foreign"));
	});

	it("honors an exact reclaim eligibility filter before any VM mutation", () => {
		const calls = [];
		const entries = [
			{
				uuid: WORK_UUID,
				status: "running",
				name: buildParallelsWorkingName("eligible", 999999),
			},
			{
				uuid: GOLDEN_UUID,
				status: "running",
				name: buildParallelsWorkingName("foreign-run", 999998),
			},
		];
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") return listed(entries);
				return "ok";
			},
			pidIsAlive: () => false,
		});

		const result = backend.reclaim({
			eligibility: (entry) => entry.runId === "eligible",
		});
		strictEqual(result.reclaimed.length, 1);
		ok(
			calls.some(
				(args) =>
					args[0] === "stop" && args[1] === WORK_UUID && args[2] === "--kill",
			),
		);
		ok(!calls.some((args) => args[1] === GOLDEN_UUID));
	});

	it("retains a live creator-pid safety gate despite caller eligibility", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") {
					return listed([
						{
							uuid: WORK_UUID,
							status: "stopped",
							name: buildParallelsWorkingName("terminal", process.pid),
						},
					]);
				}
				return "ok";
			},
			pidIsAlive: () => true,
		});

		const result = backend.reclaim({
			eligibility: (entry) => entry.runId === "terminal",
		});
		strictEqual(result.reclaimed.length, 0);
		ok(!calls.some((args) => args[0] === "delete" && args[1] === WORK_UUID));
		strictEqual(result.skipped[0].reason, "owner-alive");
	});

	it("rolls back a clone when Aqua readiness never appears", () => {
		const calls = [];
		let now = 0;
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			aquaTimeoutMs: 10,
			aquaPollMs: 5,
			nowFn: () => now,
			sleepFn: (ms) => {
				now += ms;
			},
			measureLinkedCloneFn: () => ({ diskBytes: 1, cloneToBootMs: 1 }),
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") {
					return listed([
						{ uuid: GOLDEN_UUID, status: "stopped", name: "macOS" },
						{
							uuid: WORK_UUID,
							status: "stopped",
							name: buildParallelsWorkingName("run", 1234),
						},
					]);
				}
				if (args[0] === "exec") throw new Error("Aqua is not ready");
				return "ok";
			},
		});

		const measurement = backend.measureLinkedClone("macOS");
		throws(
			() =>
				backend.create("macOS", {
					runId: "run",
					creatorPid: 1234,
					linkedCloneMeasurement: measurement,
				}),
			/Aqua domain gui\/501 was not ready/,
		);
	});

	it("enforces prompt-size guard before macOS-lane spawn and rejects oversized payloads", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			prlctlFn: (args) => {
				calls.push(args);
				return "ok";
			},
		});

		// (a) a normal-size command passes through unchanged
		const normalArgv = ["echo", "hello world"];
		const normalResult = backend.execGuest("{vm-uuid}", "/bin/echo", [
			"hello world",
		]);
		strictEqual(normalResult, "ok");
		strictEqual(calls.length, 1);
		const { args } = backend.execArgv("{vm-uuid}", { argv: normalArgv });
		ok(Array.isArray(args));
		const normalScript = decodeGuestScript(args);
		ok(normalScript.includes("exec 'echo' 'hello world'"));

		// (b) a synthetic oversized argv throws the named error instead of reaching prlctlFn/execFn
		const oversizedPayload = "x".repeat(MAX_AQUA_EXEC_ARGV_BYTES);
		const oversizedArgv = ["echo", oversizedPayload];
		throws(
			() => backend.execGuest("{vm-uuid}", "echo", [oversizedPayload]),
			(error) => {
				strictEqual(error instanceof Error, true);
				return (
					error.message.includes(
						"guest command exceeds the macOS ARG_MAX-safe limit",
					) &&
					error.message.includes(`> ${MAX_AQUA_EXEC_ARGV_BYTES} bytes`) &&
					error.message.includes(
						"this VM lane cannot execute a payload this large",
					)
				);
			},
		);
		// prlctlFn must never have been called for the oversized command
		strictEqual(calls.length, 1);

		throws(
			() => backend.execArgv("{vm-uuid}", { argv: oversizedArgv }),
			(error) => {
				strictEqual(error instanceof Error, true);
				return (
					error.message.includes(
						"guest command exceeds the macOS ARG_MAX-safe limit",
					) &&
					error.message.includes(`> ${MAX_AQUA_EXEC_ARGV_BYTES} bytes`) &&
					error.message.includes(
						"this VM lane cannot execute a payload this large",
					)
				);
			},
		);

		// Also verify with execFn constructor parameter
		let execFnCalled = false;
		const backendWithExecFn = new ParallelsExecutionBackend({
			aquaUid: 501,
			execFn: () => {
				execFnCalled = true;
				return "ok";
			},
		});
		throws(
			() =>
				backendWithExecFn.execGuest("{vm-uuid}", "echo", [oversizedPayload]),
			/guest command exceeds the macOS ARG_MAX-safe limit/,
		);
		strictEqual(execFnCalled, false);
	});
});

describe("linked-clone snapshot sidecar (INV-3 cross-process reclamation)", () => {
	const GOLDEN = "switchyard-golden-test";
	// Predates the sidecar convention. Must survive every path below.
	const FOREIGN_SNAPSHOT = "{51f4e833-0000-4000-8000-000000000000}";
	const CLONE_SNAPSHOT = "{9f6e0d53-0000-4000-8000-000000000000}";

	function snapshotJson(ids) {
		return JSON.stringify(
			Object.fromEntries(ids.map((id) => [id, { name: "snap" }])),
		);
	}

	function makeSidecarRoot() {
		return mkdtempSync(join(tmpdir(), "switchyard-sidecar-"));
	}

	/**
	 * A backend whose golden image reports `snapshots` and whose clone lands as
	 * `cloneName`. Records every prlctl argv for assertion.
	 */
	function makeCloningBackend(
		sidecarRoot,
		cloneName,
		{ runId = "run-1" } = {},
	) {
		const calls = [];
		let snapshots = [FOREIGN_SNAPSHOT];
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			creatorPid: process.pid,
			goldenImage: GOLDEN,
			snapshotSidecarRoot: sidecarRoot,
			runId,
			requireLinkedCloneMeasurement: false,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "snapshot-list") return snapshotJson(snapshots);
				if (args[0] === "clone") {
					// The clone is what creates the parent snapshot.
					snapshots = [FOREIGN_SNAPSHOT, CLONE_SNAPSHOT];
					return "";
				}
				if (args[0] === "snapshot-delete") {
					snapshots = snapshots.filter((id) => id !== args[3]);
					return "";
				}
				if (args[0] === "list") {
					return listed([
						{ uuid: WORK_UUID, status: "running", name: cloneName },
					]);
				}
				return "";
			},
		});
		return { backend, calls, snapshotsNow: () => snapshots };
	}

	it("writes a sidecar at clone time carrying image, snapshots, run id, and creator pid", () => {
		const root = makeSidecarRoot();
		const name = buildParallelsWorkingName("live", process.pid);
		const { backend } = makeCloningBackend(root, name);

		backend.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});

		const record = JSON.parse(
			readFileSync(backend.snapshotSidecarPath(WORK_UUID), "utf8"),
		);
		strictEqual(record.goldenImage, GOLDEN);
		deepStrictEqual(record.snapshotIds, [CLONE_SNAPSHOT]);
		strictEqual(record.runId, "run-1");
		strictEqual(record.creatorPid, process.pid);
		strictEqual(record.vmUuid, WORK_UUID);
		ok(Number.isFinite(record.recordedAt));
		rmSync(root, { recursive: true, force: true });
	});

	it("removes both the snapshots and the sidecar on destroy", () => {
		const root = makeSidecarRoot();
		const name = buildParallelsWorkingName("live", process.pid);
		const { backend, snapshotsNow } = makeCloningBackend(root, name);
		backend.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});
		const sidecarPath = backend.snapshotSidecarPath(WORK_UUID);
		ok(existsSync(sidecarPath));

		backend.destroy(WORK_UUID);

		ok(!snapshotsNow().includes(CLONE_SNAPSHOT), "clone snapshot must be gone");
		ok(
			snapshotsNow().includes(FOREIGN_SNAPSHOT),
			"a snapshot no sidecar names must survive destroy",
		);
		ok(!existsSync(sidecarPath), "sidecar must be removed after cleanup");
		rmSync(root, { recursive: true, force: true });
	});

	it("reclaims a dead owner's snapshots from a fresh backend with an empty map", () => {
		// The whole point: reclaim() runs in a different process from create(),
		// so the in-process map is always empty here. Before the sidecar, this
		// path deleted the VM and left its parent snapshot on the golden
		// forever — one such orphan sat on switchyard-golden-6 for 13 days.
		const root = makeSidecarRoot();
		const deadName = buildParallelsWorkingName("dead", 999_999);
		const { backend: writer } = makeCloningBackend(root, deadName);
		writer.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});

		const { backend: fresh, snapshotsNow } = makeCloningBackend(root, deadName);
		strictEqual(fresh.linkedSnapshotsByUuid.size, 0);

		const result = fresh.reclaim();

		strictEqual(result.reclaimed.length, 1);
		deepStrictEqual(result.reclaimedSnapshots, [
			{
				name: deadName,
				goldenImage: GOLDEN,
				snapshotIds: [CLONE_SNAPSHOT],
			},
		]);
		ok(!snapshotsNow().includes(CLONE_SNAPSHOT));
		ok(!existsSync(fresh.snapshotSidecarPath(WORK_UUID)));
		rmSync(root, { recursive: true, force: true });
	});

	it("never passes a snapshot absent from every sidecar to a delete call", () => {
		// The absolute rule: reclaim deletes only ids it read from a sidecar,
		// never one discovered by listing. switchyard-golden-26-5 predates the
		// convention and must survive.
		const root = makeSidecarRoot();
		const deadName = buildParallelsWorkingName("dead", 999_999);
		const { backend, calls, snapshotsNow } = makeCloningBackend(root, deadName);
		// No sidecar written at all, yet the golden carries a snapshot.

		const result = backend.reclaim();

		strictEqual(result.reclaimed.length, 1, "the VM itself is still reclaimed");
		deepStrictEqual(result.reclaimedSnapshots, []);
		deepStrictEqual(result.skippedSnapshots, [
			{ name: deadName, uuid: WORK_UUID, reason: "no-snapshot-sidecar" },
		]);
		// A reclaimed VM must never also appear in `skipped`: that list answers
		// "which VMs were left alone", and this one was not.
		deepStrictEqual(result.skipped, []);
		ok(
			!calls.some((args) => args[0] === "snapshot-delete"),
			`no snapshot may be deleted: ${JSON.stringify(calls)}`,
		);
		ok(snapshotsNow().includes(FOREIGN_SNAPSHOT));
		rmSync(root, { recursive: true, force: true });
	});

	it("does not touch a live owner's clone or its snapshots", () => {
		const root = makeSidecarRoot();
		const liveName = buildParallelsWorkingName("live", process.pid);
		const { backend, calls, snapshotsNow } = makeCloningBackend(root, liveName);
		backend.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});

		const result = backend.reclaim();

		strictEqual(result.reclaimed.length, 0);
		deepStrictEqual(result.reclaimedSnapshots, []);
		strictEqual(result.skipped[0]?.reason, "owner-alive");
		ok(!calls.some((args) => args[0] === "snapshot-delete"));
		deepStrictEqual(
			snapshotsNow(),
			[FOREIGN_SNAPSHOT],
			"the golden's snapshot list must be untouched",
		);
		ok(
			existsSync(backend.snapshotSidecarPath(WORK_UUID)),
			"a live owner's sidecar must survive another process's reclaim",
		);
		rmSync(root, { recursive: true, force: true });
	});

	it("skips a corrupt or unreadable sidecar without throwing and without deleting", () => {
		const root = makeSidecarRoot();
		const deadName = buildParallelsWorkingName("dead", 999_999);
		const { backend, calls, snapshotsNow } = makeCloningBackend(root, deadName);
		mkdirSync(backend.snapshotSidecarDir(), { recursive: true });
		writeFileSync(
			backend.snapshotSidecarPath(WORK_UUID),
			"{not json at all",
			"utf8",
		);

		const result = backend.reclaim();

		strictEqual(result.errors.length, 0, JSON.stringify(result.errors));
		deepStrictEqual(result.reclaimedSnapshots, []);
		ok(!calls.some((args) => args[0] === "snapshot-delete"));
		ok(snapshotsNow().includes(FOREIGN_SNAPSHOT));

		// A structurally valid file missing the fields a delete decision needs
		// is the same case, and must not be trusted into a delete either.
		writeFileSync(
			backend.snapshotSidecarPath(WORK_UUID),
			JSON.stringify({ goldenImage: GOLDEN, snapshotIds: [null] }),
			"utf8",
		);
		strictEqual(backend.readSnapshotSidecar(WORK_UUID), null);
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps a uuid from escaping the sidecar directory", () => {
		const root = makeSidecarRoot();
		const { backend } = makeCloningBackend(root, "x");
		const path = backend.snapshotSidecarPath("../../etc/{passwd}");
		ok(
			path.startsWith(backend.snapshotSidecarDir()),
			`sidecar path escaped its directory: ${path}`,
		);
		ok(!path.includes(".."));
		rmSync(root, { recursive: true, force: true });
	});

	it("stays inert when no durable root is injected", () => {
		// A backend with nowhere to write must not throw; destroy() still cleans
		// up from the in-process map, which is the pre-sidecar behavior.
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			prlctlFn: () => "",
		});
		strictEqual(backend.snapshotSidecarDir(), null);
		strictEqual(backend.snapshotSidecarPath(WORK_UUID), null);
		strictEqual(backend.readSnapshotSidecar(WORK_UUID), null);
		backend.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});
		backend.deleteSnapshotSidecar(WORK_UUID);
	});
});
