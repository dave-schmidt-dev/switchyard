import {
	deepStrictEqual,
	equal,
	ok,
	strictEqual,
	throws,
} from "node:assert/strict";
import { describe, it } from "node:test";
import {
	provisionAllCredentialsWithBackend,
	provisionCredentialsWithBackend,
	seedProjectWithBackend,
} from "../src/switchyard/lifecycle/index.mjs";
import {
	buildParallelsWorkingName,
	PARALLELS_WORKING_PREFIX,
	ParallelsExecutionBackend,
	parseParallelsWorkingName,
	validateLinkedCloneMeasurement,
} from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";

const GOLDEN_UUID = "{11111111-1111-4111-8111-111111111111}";
const WORK_UUID = "{22222222-2222-4222-8222-222222222222}";

function listed(entries) {
	return [
		"uuid\tstatus\tname",
		...entries.map((entry) => `${entry.uuid}\t${entry.status}\t${entry.name}`),
	].join("\n");
}

describe("Parallels execution backend lifecycle", () => {
	it("builds an Aqua execution prefix with cwd and no Docker flags", () => {
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		const execution = backend.execArgv("{vm-uuid}", { cwd: "/project/subdir" });
		strictEqual(execution.command, "prlctl");
		deepStrictEqual(execution.args.slice(0, 9), [
			"exec",
			"{vm-uuid}",
			"launchctl",
			"asuser",
			"501",
			"sudo",
			"-u",
			"switchyard",
			"/bin/bash",
		]);
		ok(!execution.args.includes("-i"));
		ok(
			execution.args.some((value) =>
				value.includes("/.switchyard/project/subdir"),
			),
		);
		strictEqual(execution.args.at(-1), "--");
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
		deepStrictEqual(calls[0].slice(-3), [
			"/bin/bash",
			"-lc",
			"'if test -e /tmp/x; then echo yes; fi'",
		]);
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

	it("keeps VM credential bytes in memory and fails closed by provider", () => {
		const calls = [];
		const backend = {
			provisionCredentials(workspaceId, options) {
				calls.push({ workspaceId, options });
				return { provider: options.provider, files: options.credentials };
			},
		};
		const credential = Buffer.from("opaque-credential-bytes");
		deepStrictEqual(
			provisionCredentialsWithBackend(backend, "vm-uuid", {
				provider: "opencode",
				readCredentialTar: () => credential,
			}),
			{
				provider: "opencode",
				files: [{ file: ".local/share/opencode/auth.json", tar: credential }],
			},
		);
		strictEqual(calls[0].options.credentials[0].tar, credential);
		// cursor-agent is the measured no: it kept reporting `Not logged in` in
		// the guest with three candidate stores in place, so it must fail here
		// rather than at exec inside a provisioned-looking VM.
		throws(
			() =>
				provisionCredentialsWithBackend(backend, "vm-uuid", {
					provider: "cursor-agent",
					readCredentialTar: () => credential,
				}),
			/not tar-provisionable/,
		);
	});

	it("reads both of claude's credential files from the vault", () => {
		const read = [];
		const backend = {
			provisionCredentials: (_workspaceId, options) => options,
		};
		const result = provisionCredentialsWithBackend(backend, "vm-uuid", {
			provider: "claude",
			readCredentialTar: (_agent, src) => {
				read.push(src);
				return Buffer.from(src);
			},
		});
		deepStrictEqual(read, [
			"/root/.claude/.credentials.json",
			"/root/.claude.json",
		]);
		deepStrictEqual(
			result.credentials.map((entry) => entry.file),
			[".claude/.credentials.json", ".claude.json"],
		);
	});

	it("provisions every tar-provisionable provider and reports the skips", () => {
		const provisioned = [];
		const skips = [];
		const backend = {
			provisionCredentials(_workspaceId, options) {
				provisioned.push(options.provider);
				return { provider: options.provider, files: options.credentials };
			},
		};
		// A vault that was never logged in to for one provider must not stop the
		// others: the VM lane seeds before routing, so one absent store would
		// otherwise leave four working providers unauthenticated too.
		const report = provisionAllCredentialsWithBackend(backend, "vm-uuid", {
			onSkip: (skip) => skips.push(skip),
			readCredentialTar: (_agent, src) => {
				if (src.startsWith("/root/.copilot/"))
					throw new Error(
						"credential source is absent from the standing vault",
					);
				return Buffer.from(src);
			},
		});
		deepStrictEqual(provisioned, ["claude", "codex", "agy", "opencode"]);
		// claude contributes two files, the other three one each.
		strictEqual(report.provisioned, 5);
		deepStrictEqual(
			report.skipped.map((skip) => skip.provider),
			["copilot"],
		);
		deepStrictEqual(skips, report.skipped);
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
			pushes[0].guestArgs.some((value) =>
				value.includes("/Users/switchyard/.claude"),
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
		const chmods = prlctlCalls.filter((args) => args.includes("/bin/chmod"));
		strictEqual(chmods.length, 2);
		for (const chmod of chmods) ok(chmod.includes("600"));
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

	it("seeds a backend through pushTar and its execution prefix", () => {
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
		deepStrictEqual(calls[1].options, { cwd: "/project" });
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
});
