import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
	AGY_LOGIN_UNAVAILABLE,
	authWalkthroughExitCode,
	CLAUDE_LOGIN_HINT,
	CLONE_QUALIFICATION_RECEIPT_SCHEMA_VERSION,
	COPILOT_LOGIN_COMMAND,
	ensureProvidersAuthenticated,
	formatCloneReceipt,
	PROVIDERS,
	parseCloneArgs,
	qualifyCloneAuth,
	reportProviderStatus,
	runCheck,
	runCloneCheck,
	withBootedGoldenImage,
	withDisposableClone,
	writeCloneReceipt,
} from "../src/switchyard/auth/index.mjs";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import { sourceText } from "./helpers/source-text.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const TEST_BOOT_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function fixtureHostProbe(pid) {
	const startTicks = String(pid * 10 + 1);
	return {
		state: "present",
		pid,
		bootSessionUuid: TEST_BOOT_UUID,
		startTicks,
		identity: `switchyard-host-process-v1:${TEST_BOOT_UUID}:${pid}:${startTicks}`,
	};
}

const AUTH_TEST_RUN_STORE_ROOT = join(
	tmpdir(),
	`switchyard-auth-run-store-${process.pid}-${randomUUID()}`,
);
process.env.SWITCHYARD_RUN_STORE_ROOT = AUTH_TEST_RUN_STORE_ROOT;

function fakeProvider(name, { authenticatedSequence }) {
	let call = 0;
	let runLoginCalls = 0;
	return {
		name,
		isAuthenticated: () => {
			const result =
				authenticatedSequence[Math.min(call, authenticatedSequence.length - 1)];
			call += 1;
			return result;
		},
		runLogin: () => {
			runLoginCalls += 1;
		},
		getRunLoginCalls: () => runLoginCalls,
	};
}

function liveProvider(name, { authenticated, live, kind = null }) {
	let runLoginCalls = 0;
	let liveCalls = 0;
	return {
		name,
		isAuthenticated: () => authenticated,
		isLive: () => {
			liveCalls += 1;
			return { live, reason: live ? null : "provider did not answer", kind };
		},
		runLogin: () => {
			runLoginCalls += 1;
		},
		getRunLoginCalls: () => runLoginCalls,
		getLiveCalls: () => liveCalls,
	};
}

describe("clone qualification (qualifyCloneAuth / runCloneCheck / withDisposableClone)", () => {
	it("uses the installed project run-store root when no override is set", () => {
		const original = process.env.SWITCHYARD_RUN_STORE_ROOT;
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		let ownership;
		try {
			withDisposableClone(
				{
					goldenImage: "golden",
					aquaUid: "501",
					create: (_image, options) => {
						ownership = options.ownershipContext;
						return "auth-default-clone";
					},
					destroy: () => {},
				},
				() => {},
			);
		} finally {
			if (original === undefined) delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = original;
		}
		match(
			ownership.resourceRoot,
			/\/\.logs\/switchyard\/runs\/auth-qualification-[^/]+\/resources$/,
		);
		strictEqual(ownership.projectRoot, resolve("."));
	});

	it("propagates auth ownership through the real backend allocation path", () => {
		const resourceRoot = join(
			tmpdir(),
			`switchyard-auth-owned-${randomUUID()}`,
		);
		let cloneName = null;
		let written = null;
		const backend = new ParallelsExecutionBackend({
			goldenImage: "golden",
			aquaUid: 501,
			requireLinkedCloneMeasurement: false,
			hostProcessIdentityProbe: fixtureHostProbe,
			prlctlFn: (args) => {
				if (args[0] === "clone") cloneName = args[3];
				if (args[0] === "list") {
					return [
						"uuid\tstatus\tname",
						"{11111111-1111-4111-8111-111111111111}\tstopped\tgolden",
						...(cloneName
							? [
									`{22222222-2222-4222-8222-222222222222}\trunning\t${cloneName}`,
								]
							: []),
					].join("\n");
				}
				return "";
			},
		});
		backend.boot = () => {};
		backend._hardenClone = () => {};
		backend._prepareWorkspace = () => {};
		backend.stopAndDelete = (entry) => ({ ...entry, forced: false });
		const originalWrite = backend.writeVmOwnership.bind(backend);
		backend.writeVmOwnership = (uuid, name, ownership) => {
			written = originalWrite(uuid, name, ownership);
			return written;
		};
		withDisposableClone(backend, () => {}, {
			ownershipContext: {
				resourceRoot,
				runId: "replaced-by-auth",
				taskId: "auth-qualification",
				attemptId: "qualification",
				projectRoot: "/private/tmp/switchyard",
				creatorPid: process.pid,
				processStartIdentity: null,
			},
		});
		strictEqual(written.purpose, "auth-qualification");
		ok(written.runId.startsWith("auth-qualification-"));
		strictEqual(written.projectRoot, "/private/tmp/switchyard");
		rmSync(resourceRoot, { recursive: true, force: true });
	});

	it("withDisposableClone creates managed clone and destroys it in finally block", () => {
		const calls = [];
		const backend = {
			goldenImage: "golden-vm",
			aquaUid: "501",
			providerUser: "switchyard",
			create: (goldenImage, options) => {
				calls.push({ type: "create", goldenImage, options });
				return "clone-uuid-1";
			},
			destroy: (uuid) => {
				calls.push({ type: "destroy", uuid });
			},
		};

		const result = withDisposableClone(backend, (uuid) => {
			strictEqual(uuid, "clone-uuid-1");
			return "success";
		});

		strictEqual(result, "success");
		strictEqual(calls.length, 2);
		strictEqual(calls[0].type, "create");
		strictEqual(calls[0].goldenImage, "golden-vm");
		strictEqual(calls[0].options.linked, false);
		strictEqual(calls[0].options.aquaUid, "501");
		strictEqual(calls[0].options.providerUser, "switchyard");
		strictEqual(
			calls[0].options.ownershipContext.purpose,
			"auth-qualification",
			"qualification clones carry a distinct ownership purpose",
		);
		ok(
			calls[0].options.runId.startsWith("auth-qualification-"),
			"runId must have auth-qualification prefix",
		);
		strictEqual(calls[1].type, "destroy");
		strictEqual(calls[1].uuid, "clone-uuid-1");
	});

	it("withDisposableClone fails fast when goldenImage or aquaUid is missing", () => {
		throws(
			() => withDisposableClone({ aquaUid: "501" }, () => {}),
			/SWITCHYARD_PARALLELS_GOLDEN_IMAGE must be set/,
		);
		throws(
			() => withDisposableClone({ goldenImage: "golden" }, () => {}),
			/SWITCHYARD_PARALLELS_AQUA_UID must be set/,
		);
		throws(
			() =>
				withDisposableClone(
					{ goldenImage: "golden", aquaUid: "not-a-number" },
					() => {},
				),
			/SWITCHYARD_PARALLELS_AQUA_UID must be set/,
		);
	});

	it("withDisposableClone destroys clone even when callback throws", () => {
		const destroyed = [];
		const backend = {
			goldenImage: "golden-vm",
			aquaUid: "501",
			create: () => "clone-uuid-err",
			destroy: (uuid) => destroyed.push(uuid),
		};

		throws(
			() =>
				withDisposableClone(backend, () => {
					throw new Error("probe exploded");
				}),
			/probe exploded/,
		);

		strictEqual(destroyed.length, 1);
		strictEqual(destroyed[0], "clone-uuid-err");
	});

	it("withDisposableClone handles destroy failure gracefully and logs to stderr", () => {
		const stderr = [];
		const originalError = console.error;
		console.error = (...args) => stderr.push(args.join(" "));

		const backend = {
			goldenImage: "golden-vm",
			aquaUid: "501",
			create: () => "clone-uuid-destroy-err",
			destroy: () => {
				throw new Error("prlctl delete failed");
			},
		};

		try {
			throws(
				() =>
					withDisposableClone(backend, () => {
						throw new Error("inner failure");
					}),
				/inner failure/,
			);
			ok(
				stderr.some((line) =>
					line.includes("failed to destroy disposable full clone"),
				),
				"destroy failure must be logged as a warning to stderr",
			);
		} finally {
			console.error = originalError;
		}
	});

	it("qualifyCloneAuth creates disposable clone, checks OAuth providers live, leaves BWS unprobed, and destroys clone", () => {
		const created = [];
		const destroyed = [];
		const checkedWorkspaces = [];
		const liveWorkspaces = [];

		const backend = {
			goldenImage: "switchyard-golden-6",
			aquaUid: "503",
			providerUser: "switchyard",
			create: (image, opts) => {
				created.push({ image, opts });
				return "disposable-clone-uuid";
			},
			destroy: (uuid) => {
				destroyed.push(uuid);
			},
		};

		const providers = [
			{
				name: "codex",
				isAuthenticated: (workspaceId, execBackend) => {
					checkedWorkspaces.push({
						name: "codex",
						workspaceId,
						execBackend,
					});
					return true;
				},
				isLive: (workspaceId, execBackend) => {
					liveWorkspaces.push({ name: "codex", workspaceId, execBackend });
					return { live: true, reason: null, kind: null };
				},
			},
			{
				name: "claude",
				isAuthenticated: (workspaceId, execBackend) => {
					checkedWorkspaces.push({
						name: "claude",
						workspaceId,
						execBackend,
					});
					return true;
				},
				isLive: (workspaceId, execBackend) => {
					liveWorkspaces.push({ name: "claude", workspaceId, execBackend });
					return {
						live: false,
						reason: "session expired",
						kind: "auth_expired",
					};
				},
			},
			{
				name: "opencode",
				authMode: "ephemeral_api_key_dispatch",
			},
		];

		const results = qualifyCloneAuth(backend, providers);

		strictEqual(created.length, 1);
		strictEqual(destroyed.length, 1);
		strictEqual(destroyed[0], "disposable-clone-uuid");

		// Both OAuth providers were checked inside the disposable clone workspace
		strictEqual(checkedWorkspaces.length, 2);
		strictEqual(checkedWorkspaces[0].workspaceId, "disposable-clone-uuid");
		strictEqual(checkedWorkspaces[1].workspaceId, "disposable-clone-uuid");
		strictEqual(liveWorkspaces.length, 2);
		strictEqual(liveWorkspaces[0].workspaceId, "disposable-clone-uuid");
		strictEqual(liveWorkspaces[1].workspaceId, "disposable-clone-uuid");

		deepStrictEqual(results, [
			{ name: "codex", authenticated: true, live: true, reason: null },
			{
				name: "claude",
				authenticated: true,
				live: false,
				reason: "session expired",
			},
			{
				name: "opencode",
				authenticated: true,
				live: null,
				reason: null,
				authMode: "ephemeral_api_key_dispatch",
			},
		]);
	});

	it("runCloneCheck emits progress to stderr, terminal summary to stdout, and exits 0 when all OAuth providers pass", () => {
		const stdout = [];
		const stderr = [];
		const originalLog = console.log;
		const originalError = console.error;
		const originalExitCode = process.exitCode;
		console.log = (...args) => stdout.push(args.join(" "));
		console.error = (...args) => stderr.push(args.join(" "));
		process.exitCode = undefined;

		const backend = {
			goldenImage: "golden",
			aquaUid: "501",
			create: () => "clone-123",
			destroy: () => {},
		};
		const providers = [
			liveProvider("codex", { authenticated: true, live: true }),
			liveProvider("claude", { authenticated: true, live: true }),
		];

		try {
			runCloneCheck(backend, providers);
			strictEqual(process.exitCode, 0);

			// Progress only to stderr
			ok(
				stderr.some((line) => line.includes("Creating disposable full clone")),
				"stderr must contain clone creation progress",
			);
			ok(
				stderr.some((line) => line.includes("Destroying disposable clone")),
				"stderr must contain clone destruction progress",
			);

			// Stdout must NOT contain progress
			ok(
				!stdout.some((line) => line.includes("Creating disposable full clone")),
				"stdout must not contain progress logs",
			);

			// Stdout must contain qualification header and terminal summary
			ok(
				stdout.some((line) => line.includes("Clone auth qualification")),
				"stdout must contain clone qualification header",
			);
			ok(
				stdout.some((line) => line.includes("codex: authenticated (live)")),
				"stdout must show codex live",
			);
			ok(
				stdout.some((line) => line.includes("claude: authenticated (live)")),
				"stdout must show claude live",
			);
		} finally {
			console.log = originalLog;
			console.error = originalError;
			process.exitCode = originalExitCode;
		}
	});

	it("runCloneCheck fails closed when an unprobed BWS lane or dead OAuth provider is present", () => {
		const stdout = [];
		const stderr = [];
		const originalLog = console.log;
		const originalError = console.error;
		const originalExitCode = process.exitCode;
		console.log = (...args) => stdout.push(args.join(" "));
		console.error = (...args) => stderr.push(args.join(" "));
		process.exitCode = undefined;

		const backend = {
			goldenImage: "golden",
			aquaUid: "501",
			create: () => "clone-123",
			destroy: () => {},
		};
		const providers = [
			liveProvider("codex", { authenticated: true, live: true }),
			liveProvider("claude", { authenticated: true, live: false }),
			{
				name: "opencode",
				authMode: "ephemeral_api_key_dispatch",
			},
		];

		try {
			runCloneCheck(backend, providers);
			strictEqual(process.exitCode, 1);

			ok(
				stdout.some((line) =>
					line.includes(
						"claude: AUTHENTICATED BUT NOT LIVE — provider did not answer",
					),
				),
				"stdout must report dead claude",
			);
			ok(
				stdout.some((line) =>
					line.includes(
						"opencode: BWS runtime dispatch (no OAuth login; live status unprobed)",
					),
				),
				"stdout must report opencode unprobed",
			);
		} finally {
			console.log = originalLog;
			console.error = originalError;
			process.exitCode = originalExitCode;
		}
	});
});
