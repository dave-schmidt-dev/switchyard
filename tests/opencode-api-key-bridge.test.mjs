import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	credentialInput,
	guestArgs,
	guestJobPaths,
	normalizeWorkspaceId,
	reconcileGuestResult,
	runtimeConfigFor,
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

const successfulLaunch = {
	code: 0,
	signal: null,
	stdout: Buffer.alloc(0),
	stderr: Buffer.alloc(0),
};

function controlResult(code, stdout = "", stderr = "") {
	return { code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

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

	it("normalizes Parallels' braced VM UUID form at the bridge boundary", () => {
		strictEqual(normalizeWorkspaceId(WORKSPACE_ID), WORKSPACE_ID);
		strictEqual(normalizeWorkspaceId(`{${WORKSPACE_ID}}`), WORKSPACE_ID);
		throws(() => normalizeWorkspaceId("not-a-vm"), /workspaceId/);
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

	it("configures Mistral from its ephemeral environment without auth.json", () => {
		const config = runtimeConfigFor("mistral/zai-glm-5-2", "MISTRAL_API_KEY");
		deepStrictEqual(JSON.parse(config), {
			provider: {
				mistral: {
					options: { apiKey: "{env:MISTRAL_API_KEY}" },
				},
			},
		});
		strictEqual(runtimeConfigFor(REQUEST.model, "OPENCODE_API_KEY"), null);
		const args = guestArgs(
			{ ...REQUEST, model: "mistral/zai-glm-5-2", invocationArgs: [] },
			"MISTRAL_API_KEY",
		);
		const encoded = args.join(" ").match(/printf %s ([A-Za-z0-9+/=]+) \|/)?.[1];
		ok(encoded);
		const guestScript = Buffer.from(encoded, "base64").toString("utf8");
		match(guestScript, /export OPENCODE_CONFIG_CONTENT=/);
		ok(!guestScript.includes("auth.json"));
	});

	it("detaches the provider supervisor after atomically publishing its marker", () => {
		const args = guestArgs(
			{ ...REQUEST, model: "mistral/zai-glm-5-2", invocationArgs: [] },
			"MISTRAL_API_KEY",
		);
		const encoded = args.join(" ").match(/printf %s ([A-Za-z0-9+/=]+) \|/)?.[1];
		ok(encoded);
		const guestScript = Buffer.from(encoded, "base64").toString("utf8");
		match(guestScript, /\/usr\/bin\/nohup/);
		match(guestScript, /marker_tmp="\$marker\.tmp\.\$\$"/);
		match(guestScript, /mv -f -- "\$marker_tmp" "\$marker"/);
		match(guestScript, /"\$@" <\/dev\/null >\/dev\/null 2>&1 &/);
		match(guestScript, /\[ -s "\$marker" \] && exit 0/);
		match(guestScript, /set -m/);
		match(guestScript, /job_pgid=\$\(ps -o pgid= -p "\$job_pid"/);
		match(guestScript, /\[ "\$job_pgid" = "\$job_pid" \]/);
		match(guestScript, /pgid= -p "\$pid"/);
		match(guestScript, /\[ "\$job_pgid" = "\$pid" \]/);
		match(guestScript, /kill -"\$signal" -- "-\$pid"/);
		match(guestScript, /\[ "\$i" -lt 5 \]/);
		ok(!guestScript.includes('wait "$job_pid"'));
		ok(!guestScript.includes("pgrep"));
		match(guestScript, /"\$marker\.tmp\."\*/);
		match(guestScript, /rm -f -- "\$marker_tmp" "\$marker" "\$status_tmp"/);
		ok(!guestScript.includes("auth.json"));
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
					if (args[2] === "/bin/test") {
						return {
							code: 0,
							stdout: Buffer.alloc(0),
							stderr: Buffer.alloc(0),
						};
					}
					if (args[2] === "/bin/sh") {
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
		ok(calls.some((args) => args[2] === "/bin/test"));
		ok(calls.every((args) => !args.includes("opencode")));
		ok(calls.some((args) => args[2] === "/bin/sh"));
	});

	it("does not abandon an exact Parallels lost result during marker startup", async () => {
		const paths = guestJobPaths(WORKSPACE_ID);
		let statusReads = 0;
		let markerReads = 0;
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
					const path = args.at(-1);
					if (path === paths.status) {
						statusReads += 1;
						return {
							code: 1,
							stdout: Buffer.alloc(0),
							stderr: Buffer.alloc(0),
						};
					}
					if (args[2] === "/bin/test") {
						markerReads += 1;
						return {
							code: 1,
							stdout: Buffer.alloc(0),
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

		strictEqual(result.code, 255);
		strictEqual(statusReads, 3);
		strictEqual(markerReads, 3);
	});

	it("fails closed when a successful launch never publishes its marker", async () => {
		const result = await reconcileGuestResult(REQUEST, successfulLaunch, {
			runControlFn: async (args) =>
				args[2] === "/bin/cat" ? controlResult(1) : controlResult(1),
			waitFn: async () => {},
			maxAttempts: 2,
			lostResultProbeAttempts: 2,
		});
		strictEqual(result.code, 75);
		strictEqual(
			result.stderr.toString("utf8"),
			"bridge failure: marker missing\n",
		);
	});

	it("fails closed when a marker never receives terminal status", async () => {
		const result = await reconcileGuestResult(REQUEST, successfulLaunch, {
			runControlFn: async (args) =>
				args[2] === "/bin/cat" ? controlResult(1) : controlResult(0, "1\n"),
			waitFn: async () => {},
			maxAttempts: 2,
			lostResultProbeAttempts: 1,
		});
		strictEqual(result.code, 75);
		strictEqual(
			result.stderr.toString("utf8"),
			"bridge failure: status timeout\n",
		);
	});

	it("fails closed on invalid terminal status", async () => {
		const result = await reconcileGuestResult(REQUEST, successfulLaunch, {
			runControlFn: async () => controlResult(0, "not-a-status\n"),
			waitFn: async () => {},
		});
		strictEqual(result.code, 75);
		strictEqual(
			result.stderr.toString("utf8"),
			"bridge failure: status invalid\n",
		);
	});

	it("fails closed when provider output cannot be read", async () => {
		const paths = guestJobPaths(WORKSPACE_ID);
		const result = await reconcileGuestResult(REQUEST, successfulLaunch, {
			runControlFn: async (args) => {
				if (args.at(-1) === paths.status) return controlResult(0, "0\n");
				return controlResult(2, "", "read failed");
			},
			waitFn: async () => {},
		});
		strictEqual(result.code, 75);
		strictEqual(
			result.stderr.toString("utf8"),
			"bridge failure: provider output read failed\n",
		);
	});

	it("cleans marker temp paths using bounded shell expansion", async () => {
		const paths = guestJobPaths(WORKSPACE_ID);
		let cleanupCommand;
		const result = await reconcileGuestResult(REQUEST, successfulLaunch, {
			runControlFn: async (args) => {
				if (args[2] === "/bin/cat" && args.at(-1) === paths.status) {
					return controlResult(0, "0\n");
				}
				if (args[2] === "/bin/cat" && args.at(-1) === paths.stdout) {
					return controlResult(0, "provider-result\n");
				}
				if (args[2] === "/bin/cat" && args.at(-1) === paths.stderr) {
					return controlResult(0, "provider-error\n");
				}
				if (args[2] === "/bin/sh") {
					cleanupCommand = args.at(-1) ?? "";
					return controlResult(0);
				}
				throw new Error(`unexpected control command: ${args.join(" ")}`);
			},
			waitFn: async () => {},
		});
		const wildcardPath = `'${paths.marker}'.tmp.*`;
		ok(cleanupCommand);
		strictEqual(result.code, 0);
		strictEqual(cleanupCommand?.includes("rm -f --"), true);
		ok(cleanupCommand?.includes(wildcardPath));
		ok(!cleanupCommand?.includes(`${paths.marker}.tmp.*`));
	});

	it("fails closed when cleanup cannot remove the guest artifacts", async () => {
		const paths = guestJobPaths(WORKSPACE_ID);
		const result = await reconcileGuestResult(REQUEST, successfulLaunch, {
			runControlFn: async (args) => {
				if (args[2] === "/bin/cat" && args.at(-1) === paths.status) {
					return controlResult(0, "0\n");
				}
				if (args[2] === "/bin/cat") return controlResult(0, "provider\n");
				return controlResult(2, "", "cleanup failed");
			},
			waitFn: async () => {},
		});
		strictEqual(result.code, 75);
		strictEqual(
			result.stderr.toString("utf8"),
			"bridge failure: cleanup failed\n",
		);
	});

	it("preserves an original nonzero launch result on reconciliation failure", async () => {
		const launchResult = {
			code: 255,
			signal: null,
			stdout: Buffer.from("launch output"),
			stderr: Buffer.from("launch failed"),
		};
		const result = await reconcileGuestResult(REQUEST, launchResult, {
			runControlFn: async () => controlResult(0, "invalid\n"),
			waitFn: async () => {},
		});
		strictEqual(result, launchResult);
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
