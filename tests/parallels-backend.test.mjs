import {
	deepStrictEqual,
	equal,
	ok,
	strictEqual,
	throws,
} from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
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
			"/Users/dave/Documents/Projects/bws/bws-secret-exec",
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
				return "ready";
			},
		});
		backend.create("macOS", {
			runId: "workspace-setup",
			creatorPid: process.pid,
			linked: false,
			providerUser: "switchyard",
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
