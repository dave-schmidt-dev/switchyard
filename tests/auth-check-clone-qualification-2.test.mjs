import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
	CLONE_QUALIFICATION_RECEIPT_SCHEMA_VERSION,
	formatCloneReceipt,
	parseCloneArgs,
	runCloneCheck,
	writeCloneReceipt,
} from "../src/switchyard/auth/index.mjs";

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
	it("runCloneCheck handles backend clone error gracefully and exits 1", () => {
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
			create: () => {
				throw new Error("Parallels clone failure");
			},
			destroy: () => {},
		};

		try {
			runCloneCheck(backend, [
				liveProvider("codex", { authenticated: true, live: true }),
			]);
			strictEqual(process.exitCode, 1);
			ok(
				stderr.some((line) => line.includes("Parallels clone failure")),
				"backend error must be logged to stderr",
			);
			strictEqual(stdout.length, 0);
		} finally {
			console.log = originalLog;
			console.error = originalError;
			process.exitCode = originalExitCode;
		}
	});

	it("runCloneCheck with receipt writes terminal sanitized JSON on success", () => {
		const stdout = [];
		const stderr = [];
		const originalLog = console.log;
		const originalError = console.error;
		const originalExitCode = process.exitCode;
		console.log = (...args) => stdout.push(args.join(" "));
		console.error = (...args) => stderr.push(args.join(" "));
		process.exitCode = undefined;

		const testDir = join(tmpdir(), `switchyard-receipt-test-${randomUUID()}`);
		const receiptPath = join(testDir, "clone-receipt.json");

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
			runCloneCheck(backend, providers, { receipt: receiptPath });
			strictEqual(process.exitCode, 0);

			ok(existsSync(receiptPath), "receipt file must exist");
			const raw = readFileSync(receiptPath, "utf8");
			const parsed = JSON.parse(raw);

			deepStrictEqual(parsed, {
				schemaVersion: CLONE_QUALIFICATION_RECEIPT_SCHEMA_VERSION,
				providers: [
					{ name: "codex", authenticated: true, live: true },
					{ name: "claude", authenticated: true, live: true },
				],
				errorKind: null,
			});
		} finally {
			console.log = originalLog;
			console.error = originalError;
			process.exitCode = originalExitCode;
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("runCloneCheck with receipt writes qualification failure receipt and exits 1 when a provider is dead or unauthed", () => {
		const stdout = [];
		const stderr = [];
		const originalLog = console.log;
		const originalError = console.error;
		const originalExitCode = process.exitCode;
		console.log = (...args) => stdout.push(args.join(" "));
		console.error = (...args) => stderr.push(args.join(" "));
		process.exitCode = undefined;

		const testDir = join(tmpdir(), `switchyard-receipt-test-${randomUUID()}`);
		const receiptPath = join(testDir, "clone-receipt.json");

		const backend = {
			goldenImage: "golden",
			aquaUid: "501",
			create: () => "clone-123",
			destroy: () => {},
		};
		const providers = [
			liveProvider("codex", { authenticated: true, live: true }),
			liveProvider("claude", { authenticated: true, live: false }),
		];

		try {
			runCloneCheck(backend, providers, { receipt: receiptPath });
			strictEqual(process.exitCode, 1);

			ok(existsSync(receiptPath), "receipt file must exist");
			const parsed = JSON.parse(readFileSync(receiptPath, "utf8"));

			deepStrictEqual(parsed, {
				schemaVersion: CLONE_QUALIFICATION_RECEIPT_SCHEMA_VERSION,
				providers: [
					{ name: "codex", authenticated: true, live: true },
					{ name: "claude", authenticated: true, live: false },
				],
				errorKind: "clone_qualification_failed",
			});
		} finally {
			console.log = originalLog;
			console.error = originalError;
			process.exitCode = originalExitCode;
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("runCloneCheck with receipt includes authMode for ephemeral BWS lane and marks qualification failed", () => {
		const stdout = [];
		const stderr = [];
		const originalLog = console.log;
		const originalError = console.error;
		const originalExitCode = process.exitCode;
		console.log = (...args) => stdout.push(args.join(" "));
		console.error = (...args) => stderr.push(args.join(" "));
		process.exitCode = undefined;

		const testDir = join(tmpdir(), `switchyard-receipt-test-${randomUUID()}`);
		const receiptPath = join(testDir, "clone-receipt.json");

		const backend = {
			goldenImage: "golden",
			aquaUid: "501",
			create: () => "clone-123",
			destroy: () => {},
		};
		const providers = [
			liveProvider("codex", { authenticated: true, live: true }),
			{
				name: "opencode",
				authMode: "ephemeral_api_key_dispatch",
			},
		];

		try {
			runCloneCheck(backend, providers, { receipt: receiptPath });
			strictEqual(process.exitCode, 1);

			ok(existsSync(receiptPath), "receipt file must exist");
			const parsed = JSON.parse(readFileSync(receiptPath, "utf8"));

			deepStrictEqual(parsed, {
				schemaVersion: CLONE_QUALIFICATION_RECEIPT_SCHEMA_VERSION,
				providers: [
					{ name: "codex", authenticated: true, live: true },
					{
						name: "opencode",
						authenticated: true,
						live: null,
						authMode: "ephemeral_api_key_dispatch",
					},
				],
				errorKind: "clone_qualification_failed",
			});
		} finally {
			console.log = originalLog;
			console.error = originalError;
			process.exitCode = originalExitCode;
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("runCloneCheck with receipt writes terminal receipt on backend execution failure without leaking error details", () => {
		const stdout = [];
		const stderr = [];
		const originalLog = console.log;
		const originalError = console.error;
		const originalExitCode = process.exitCode;
		console.log = (...args) => stdout.push(args.join(" "));
		console.error = (...args) => stderr.push(args.join(" "));
		process.exitCode = undefined;

		const testDir = join(tmpdir(), `switchyard-receipt-test-${randomUUID()}`);
		const receiptPath = join(testDir, "nested", "clone-receipt.json");

		const backend = {
			goldenImage: "switchyard-golden-secret-vm",
			aquaUid: "501",
			create: () => {
				throw new Error(
					"Failed to clone switchyard-golden-secret-vm at /tmp/vm.pvm",
				);
			},
			destroy: () => {},
		};

		try {
			runCloneCheck(
				backend,
				[liveProvider("codex", { authenticated: true, live: true })],
				{ receipt: receiptPath },
			);
			strictEqual(process.exitCode, 1);

			ok(
				existsSync(receiptPath),
				"receipt file must exist even on backend failure",
			);
			const raw = readFileSync(receiptPath, "utf8");
			const parsed = JSON.parse(raw);

			deepStrictEqual(parsed, {
				schemaVersion: CLONE_QUALIFICATION_RECEIPT_SCHEMA_VERSION,
				providers: [],
				errorKind: "clone_execution_failed",
			});

			ok(
				!raw.includes("switchyard-golden-secret-vm"),
				"receipt must not contain VM name",
			);
			ok(!raw.includes("/tmp/vm.pvm"), "receipt must not contain file paths");
			ok(
				!raw.includes("Failed to clone"),
				"receipt must not contain raw error message",
			);
		} finally {
			console.log = originalLog;
			console.error = originalError;
			process.exitCode = originalExitCode;
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("regression: receipt contains strictly allowlisted keys and redacts reasons, command output, credentials, and VM names", () => {
		const stdout = [];
		const stderr = [];
		const originalLog = console.log;
		const originalError = console.error;
		const originalExitCode = process.exitCode;
		console.log = (...args) => stdout.push(args.join(" "));
		console.error = (...args) => stderr.push(args.join(" "));
		process.exitCode = undefined;

		const testDir = join(tmpdir(), `switchyard-receipt-test-${randomUUID()}`);
		const receiptPath = join(testDir, "clone-receipt.json");

		const backend = {
			goldenImage: "golden-vm-name-secret",
			aquaUid: "501",
			create: () => "workspace-uuid-secret-xyz",
			destroy: () => {},
		};

		const leakingProviders = [
			{
				name: "claude",
				isAuthenticated: () => true,
				isLive: () => ({
					live: false,
					reason: "OAuth token SECRET_TOKEN_12345 expired at 2026-08-21",
					kind: "auth_expired",
					rawOutput: "prlctl exec --guest ...",
					workspaceId: "workspace-uuid-secret-xyz",
					vmName: "golden-vm-name-secret",
					credentials: "ghp_CANARY_SECRET_VALUE",
				}),
			},
		];

		try {
			runCloneCheck(backend, leakingProviders, { receipt: receiptPath });
			strictEqual(process.exitCode, 1);

			ok(existsSync(receiptPath), "receipt must exist");
			const raw = readFileSync(receiptPath, "utf8");
			const parsed = JSON.parse(raw);

			// Strict top-level schema keys check
			deepStrictEqual(Object.keys(parsed).sort(), [
				"errorKind",
				"providers",
				"schemaVersion",
			]);

			// Strict provider entry schema keys check
			strictEqual(parsed.providers.length, 1);
			deepStrictEqual(Object.keys(parsed.providers[0]).sort(), [
				"authenticated",
				"live",
				"name",
			]);

			// Value checks
			strictEqual(parsed.schemaVersion, 1);
			strictEqual(parsed.errorKind, "clone_qualification_failed");
			strictEqual(parsed.providers[0].name, "claude");
			strictEqual(parsed.providers[0].authenticated, true);
			strictEqual(parsed.providers[0].live, false);

			// Assert no sensitive substrings leaked into raw JSON
			const forbiddenSubstrings = [
				"SECRET_TOKEN_12345",
				"SECRET_VALUE",
				"prlctl",
				"workspace-uuid-secret-xyz",
				"golden-vm-name-secret",
				"OAuth token",
				"auth_expired",
				"rawOutput",
				"workspaceId",
				"vmName",
				"credentials",
				"reason",
			];

			for (const forbidden of forbiddenSubstrings) {
				ok(
					!raw.includes(forbidden),
					`receipt raw JSON must not contain '${forbidden}', got: ${raw}`,
				);
			}
		} finally {
			console.log = originalLog;
			console.error = originalError;
			process.exitCode = originalExitCode;
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("writeCloneReceipt writes atomically and leaves no temporary files", () => {
		const testDir = join(tmpdir(), `switchyard-receipt-atomic-${randomUUID()}`);
		const receiptPath = join(testDir, "sub", "receipt.json");

		try {
			const receipt = formatCloneReceipt(
				[{ name: "codex", authenticated: true, live: true }],
				null,
			);
			writeCloneReceipt(receiptPath, receipt);

			ok(existsSync(receiptPath));
			const files = readdirSync(dirname(receiptPath));
			strictEqual(files.length, 1);
			strictEqual(files[0], "receipt.json");

			const parsed = JSON.parse(readFileSync(receiptPath, "utf8"));
			deepStrictEqual(parsed, receipt);

			// Overwrite atomically
			const updatedReceipt = formatCloneReceipt(
				[{ name: "codex", authenticated: false, live: null }],
				"clone_qualification_failed",
			);
			writeCloneReceipt(receiptPath, updatedReceipt);

			const updatedParsed = JSON.parse(readFileSync(receiptPath, "utf8"));
			deepStrictEqual(updatedParsed, updatedReceipt);

			const filesAfter = readdirSync(dirname(receiptPath));
			strictEqual(filesAfter.length, 1);
			strictEqual(filesAfter[0], "receipt.json");
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("parseCloneArgs parses --receipt flag forms correctly", () => {
		deepStrictEqual(parseCloneArgs(["--clone"]), { receipt: null });
		deepStrictEqual(parseCloneArgs(["--clone", "--receipt", "/tmp/out.json"]), {
			receipt: "/tmp/out.json",
		});
		deepStrictEqual(parseCloneArgs(["--clone", "--receipt=/tmp/out.json"]), {
			receipt: "/tmp/out.json",
		});
		deepStrictEqual(parseCloneArgs(["--receipt", "/tmp/out.json", "--clone"]), {
			receipt: "/tmp/out.json",
		});
	});
});
