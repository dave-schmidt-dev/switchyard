import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	credentialInput,
	guestArgs,
	guestJobPaths,
	reconcileGuestResult,
	takeCredential,
} from "../ops/opencode-api-key-bridge.mjs";

const WORKSPACE_ID = "123e4567-e89b-42d3-a456-426614174000";
const REQUEST = {
	workspaceId: WORKSPACE_ID,
	model: "opencode-go/deepseek-flash",
	invocationArgs: ["--variant", "low"],
	prompt: "write the marker",
	idleSeconds: 60,
};

describe("OpenCode API-key bridge", () => {
	it("binds the Go credential to the expected guest environment only", () => {
		const environment = {
			OPENCODE_GO_API_KEY: "sentinel-go-key",
			UNRELATED: "leave-me",
		};
		deepStrictEqual(takeCredential(REQUEST.model, environment), {
			secret: "sentinel-go-key",
			guestEnv: "OPENCODE_API_KEY",
		});
		strictEqual(environment.OPENCODE_GO_API_KEY, undefined);
		strictEqual(environment.UNRELATED, "leave-me");
	});

	it("rejects credentials that cannot be one bounded stdin line", () => {
		for (const value of ["", "line\nbreak", "carriage\rreturn", "nul\0byte"]) {
			throws(() => credentialInput(value), /credential/);
		}
		throws(() => credentialInput("x".repeat(64 * 1024 + 1)), /bounded/);
		strictEqual(credentialInput("sentinel-key"), "sentinel-key\n");
	});

	it("keeps the credential out of argv and generated guest shell", () => {
		const secret = "sentinel-must-never-enter-argv";
		const args = guestArgs(REQUEST, "OPENCODE_API_KEY");
		ok(args.every((value) => !value.includes(secret)));
		const joined = args.join(" ");
		const encoded = joined.match(/printf %s ([A-Za-z0-9+/=]+) \|/)?.[1];
		ok(encoded);
		const guestScript = Buffer.from(encoded, "base64").toString("utf8");
		match(guestScript, /IFS= read -r key/);
		match(guestScript, /set \+x/);
		match(guestScript, /export OPENCODE_API_KEY/);
		match(guestScript, /umask 077/);
		match(guestScript, /status_tmp/);
		match(guestScript, /mv -f/);
		ok(!guestScript.includes("curl"));
		ok(!guestScript.includes("pfctl"));
		strictEqual(credentialInput(secret), `${secret}\n`);
	});

	it("derives bounded deterministic reconciliation paths from the VM UUID", () => {
		const paths = guestJobPaths(WORKSPACE_ID);
		deepStrictEqual(Object.keys(paths), [
			"marker",
			"stdout",
			"stderr",
			"status",
			"statusTemp",
		]);
		for (const path of Object.values(paths)) {
			match(
				path,
				/^\/tmp\/switchyard-(?:provider|opencode-bridge)-[a-f0-9]{32}/,
			);
			ok(!path.includes(REQUEST.prompt));
		}
	});

	it("recovers the original provider result without executing the provider again", async () => {
		const paths = guestJobPaths(WORKSPACE_ID);
		const calls = [];
		let statusReads = 0;
		const result = await reconcileGuestResult(
			REQUEST,
			{
				code: 255,
				signal: null,
				stdout: Buffer.alloc(0),
				stderr: Buffer.from("PrlJob_GetResult: Invalid argument"),
			},
			{
				runControlFn: async (args) => {
					calls.push(args);
					const path = args.at(-1);
					if (args[2] === "/usr/bin/test") {
						return {
							code: 0,
							stdout: Buffer.alloc(0),
							stderr: Buffer.alloc(0),
						};
					}
					if (args[2] === "/bin/rm") {
						return {
							code: 0,
							stdout: Buffer.alloc(0),
							stderr: Buffer.alloc(0),
						};
					}
					if (path === paths.status) {
						statusReads += 1;
						return statusReads === 1
							? { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
							: {
									code: 0,
									stdout: Buffer.from("0\n"),
									stderr: Buffer.alloc(0),
								};
					}
					if (path === paths.stdout) {
						return {
							code: 0,
							stdout: Buffer.from("provider-result\n"),
							stderr: Buffer.alloc(0),
						};
					}
					if (path === paths.stderr) {
						return {
							code: 0,
							stdout: Buffer.from("provider-status\n"),
							stderr: Buffer.alloc(0),
						};
					}
					throw new Error(`unexpected control command: ${args.join(" ")}`);
				},
				waitFn: async () => {},
				maxAttempts: 3,
				lostResultProbeAttempts: 2,
			},
		);

		strictEqual(result.code, 0);
		strictEqual(result.stdout.toString("utf8"), "provider-result\n");
		strictEqual(result.stderr.toString("utf8"), "provider-status\n");
		strictEqual(statusReads, 2);
		ok(calls.every((args) => !args.includes("opencode")));
		ok(calls.some((args) => args[2] === "/bin/rm"));
	});

	it("contains no listener or packet-filter credential transport", () => {
		const source = readFileSync(
			new URL("../ops/opencode-api-key-bridge.mjs", import.meta.url),
			"utf8",
		);
		ok(!source.includes('from "node:http"'));
		ok(!source.includes("TRANSFER_HOST"));
		ok(!source.includes("/sbin/pfctl"));
	});
});
