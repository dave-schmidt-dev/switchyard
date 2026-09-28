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

describe("withBootedGoldenImage golden-image posture (INV-1, INV-3)", () => {
	const makeBackend = (overrides = {}) => {
		const calls = [];
		return {
			calls,
			goldenImage: "switchyard-golden-test",
			aquaUid: "501",
			bootGoldenImage: () => {
				calls.push("boot");
				return { uuid: "golden-uuid" };
			},
			stopGoldenImage: (uuid) => {
				calls.push(`stop:${uuid}`);
			},
			describePostureViolations: (uuid) => {
				calls.push(`posture:${uuid}`);
				return [];
			},
			...overrides,
		};
	};

	// Task 44, narrowed 2026-09-13. This is the residual case, NOT the escape:
	// a body that blocks the event loop with no login child to die of the
	// signal, which is what a login that traps its own interrupt looks like
	// (Task 46). Exit 0 is the honest outcome there and not a false green --
	// the signal is queued behind the blocked call and discarded when the
	// normal path removes the listeners. What it guarantees is the one thing
	// that still holds: node does not take the default disposition and go away
	// with the guest running. The escape itself is in-band and covered by "an
	// interrupted login ends the walkthrough" below. Driven as a real child
	// process because signal delivery cannot be faked in-process.
	it("stops the golden image when a signal cannot reach a login child", async () => {
		const scratch = tempDir("switchyard-auth-sigint-");
		try {
			const stopMarker = join(scratch, "stopped");
			const readyMarker = join(scratch, "ready");
			const scriptPath = join(scratch, "interrupt.mjs");
			const moduleUrl = new URL(
				"../src/switchyard/auth/index.mjs",
				import.meta.url,
			).href;
			writeFileSync(
				scriptPath,
				`import { writeFileSync } from "node:fs";
import { withBootedGoldenImage } from ${JSON.stringify(moduleUrl)};
const backend = {
	goldenImage: "switchyard-golden-test",
	aquaUid: "501",
	bootGoldenImage: () => ({ uuid: "golden-uuid" }),
	stopGoldenImage: (uuid) => writeFileSync(${JSON.stringify(stopMarker)}, uuid),
	describePostureViolations: () => [],
};
withBootedGoldenImage(backend, () => {
	writeFileSync(${JSON.stringify(readyMarker)}, "ready");
	// Blocks the event loop the way execFileSync(stdio: "inherit") does while
	// an interactive login holds the terminal, so the signal is delivered the
	// same way it is in the real hang.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
	return "finished";
});
`,
				"utf8",
			);
			const child = spawn(process.execPath, [scriptPath], {
				stdio: ["ignore", "ignore", "pipe"],
			});
			const exit = new Promise((resolveExit) => {
				child.on("exit", (code, signal) => resolveExit({ code, signal }));
			});
			const deadline = Date.now() + 15000;
			while (!existsSync(readyMarker) && Date.now() < deadline) {
				await new Promise((tick) => setTimeout(tick, 20));
			}
			ok(existsSync(readyMarker), "child never entered the walkthrough body");
			child.kill("SIGINT");
			// node:test has no default timeout, so an unbounded await here would
			// hang the whole suite on a regression instead of failing it.
			const { code, signal } = await Promise.race([
				exit,
				new Promise((_, rejectExit) =>
					setTimeout(
						() => rejectExit(new Error("interrupted child never exited")),
						15000,
					).unref(),
				),
			]);
			ok(
				existsSync(stopMarker),
				"an interrupted walkthrough must still stop the golden image",
			);
			strictEqual(readFileSync(stopMarker, "utf8"), "golden-uuid");
			// Without the handlers node takes the default disposition and dies
			// on the spot with the guest still running: the child reports
			// signal SIGINT and never reaches its stop.
			strictEqual(signal, null, "node must not die on the default disposition");
			strictEqual(code, 0);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("checks the posture when the body succeeds, and returns the body's value", () => {
		const backend = makeBackend();
		const value = withBootedGoldenImage(backend, (uuid) => `ran:${uuid}`);
		strictEqual(value, "ran:golden-uuid");
		deepStrictEqual(backend.calls, [
			"boot",
			"posture:golden-uuid",
			"stop:golden-uuid",
		]);
	});

	it("checks the posture while the guest is still running, before it is stopped", () => {
		const backend = makeBackend();
		withBootedGoldenImage(backend, () => null);
		ok(
			backend.calls.indexOf("posture:golden-uuid") <
				backend.calls.indexOf("stop:golden-uuid"),
			`the posture check must run before the stop: ${backend.calls.join(", ")}`,
		);
	});

	it("checks the posture even when the body throws", () => {
		const backend = makeBackend();
		throws(
			() =>
				withBootedGoldenImage(backend, () => {
					throw new Error("body blew up");
				}),
			/body blew up/,
		);
		ok(
			backend.calls.includes("posture:golden-uuid"),
			`a thrown body must not skip the posture check: ${backend.calls.join(", ")}`,
		);
		ok(backend.calls.includes("stop:golden-uuid"), "the image must still stop");
	});

	it("fails when the posture is violated on exit", () => {
		const backend = makeBackend({
			describePostureViolations: () => [
				"host-defined sharing is on",
				"clipboard is still available: gui/501/com.parallels.copypaste is still loaded",
			],
		});
		throws(
			() => withBootedGoldenImage(backend, () => "fine"),
			(error) =>
				/violated its posture on exit/.test(error.message) &&
				/host-defined sharing is on/.test(error.message) &&
				/clipboard is still available/.test(error.message),
		);
		ok(
			backend.calls.includes("stop:golden-uuid"),
			"a posture violation must not strand the image running",
		);
	});

	it("reports BOTH causes when the body failed and the posture is violated", () => {
		// Neither may mask the other: one of two real problems would go
		// unreported, and which one you saw would depend on ordering.
		const backend = makeBackend({
			describePostureViolations: () => ["host shared folders are attached"],
		});
		throws(
			() =>
				withBootedGoldenImage(backend, () => {
					throw new Error("the auth probe itself failed");
				}),
			(error) => {
				ok(
					/the auth probe itself failed/.test(error.message),
					`body error is missing: ${error.message}`,
				);
				ok(
					/posture check ALSO failed/.test(error.message),
					`posture error is missing: ${error.message}`,
				);
				ok(
					/host shared folders are attached/.test(error.message),
					`the specific violation is missing: ${error.message}`,
				);
				strictEqual(error.cause?.message, "the auth probe itself failed");
				return true;
			},
		);
	});

	it("fails, rather than passes, when the posture check itself cannot run", () => {
		// An unverifiable posture proves nothing. Reading it as clean is the
		// same false green this check exists to close.
		const backend = makeBackend({
			describePostureViolations: () => {
				throw new Error("prlctl exec timed out");
			},
		});
		throws(
			() => withBootedGoldenImage(backend, () => "fine"),
			/posture could not be verified on exit.*prlctl exec timed out/s,
		);
		ok(backend.calls.includes("stop:golden-uuid"), "the image must still stop");
	});

	it("stops the image even when stopping is all that is left to fail", () => {
		const errors = [];
		const realError = console.error;
		console.error = (...args) => errors.push(args.join(" "));
		try {
			const backend = makeBackend({
				stopGoldenImage: () => {
					throw new Error("stop failed");
				},
			});
			strictEqual(
				withBootedGoldenImage(backend, () => "value"),
				"value",
			);
		} finally {
			console.error = realError;
		}
		ok(
			errors.some((line) => line.includes("failed to stop the golden image")),
			`a stop failure must be reported: ${JSON.stringify(errors)}`,
		);
	});
});

describe("an interrupted login ends the walkthrough", () => {
	// Review finding, 2026-09-13. Registering the SIGINT handler took away the
	// operator's escape without replacing it: a signal arriving while a login's
	// execFileSync holds the event loop is queued, then discarded when the
	// normal path removes the listeners, so Ctrl+C killed one login and the
	// walkthrough immediately started the next provider's. The signal-aware
	// wrapper now returns a conventional signal-derived status in-band.
	const fakeBackend = (command, args) => ({
		goldenImage: "switchyard-golden-test",
		aquaUid: "501",
		execArgv: () => ({ command, args }),
	});
	const codex = PROVIDERS.find((provider) => provider.name === "codex");

	it("rethrows a signal-derived wrapper exit status", () => {
		ok(codex, "codex must still be a real provider with a login");
		let thrown = null;
		try {
			codex.runLogin("workspace-1", fakeBackend("sh", ["-c", "exit 130"]));
		} catch (error) {
			thrown = error;
		}
		ok(thrown, "a signal-derived wrapper status must not be swallowed");
		strictEqual(thrown.code, "WALKTHROUGH_INTERRUPTED");
		strictEqual(thrown.signal, "SIGINT");
	});

	it("kills a login transport whose guest child traps SIGINT", async () => {
		const authSource = sourceText("src/switchyard/auth/index.mjs");
		strictEqual(
			authSource.includes("set -m"),
			false,
			"the interactive child must remain in the terminal foreground process group",
		);
		const scratch = tempDir("switchyard-auth-trapping-login-");
		const ready = join(scratch, "ready");
		const login = join(scratch, "login.mjs");
		const driver = join(scratch, "driver.mjs");
		const stopReport = join(scratch, "golden-stop-count");
		const loginPidReport = join(scratch, "login-pid");
		try {
			writeFileSync(
				login,
				`import { readSync, writeFileSync } from "node:fs";
process.on("SIGINT", () => {});
const input = Buffer.alloc(1);
if (readSync(0, input, 0, 1, null) !== 1 || input.toString() !== "x") process.exit(2);
writeFileSync(${JSON.stringify(loginPidReport)}, String(process.pid));
writeFileSync(${JSON.stringify(ready)}, "ready");
setInterval(() => {}, 1000);\n`,
			);
			writeFileSync(
				driver,
				`process.on("SIGINT", () => {});
import { writeFileSync } from "node:fs";
import { PROVIDERS, withBootedGoldenImage } from ${JSON.stringify(new URL("../src/switchyard/auth/index.mjs", import.meta.url).href)};
const provider = PROVIDERS.find((entry) => entry.name === "codex");
let stopCalls = 0;
const backend = {
  goldenImage: "golden-image",
  aquaUid: "501",
  bootGoldenImage: () => ({ uuid: "golden-uuid" }),
  stopGoldenImage: () => {
    stopCalls += 1;
    writeFileSync(${JSON.stringify(stopReport)}, String(stopCalls));
  },
  execArgv: () => ({ command: process.execPath, args: [${JSON.stringify(login)}] }),
};
try {
  withBootedGoldenImage(backend, (workspaceId) => provider.runLogin(workspaceId, backend));
} catch (error) {
  if (error?.code === "WALKTHROUGH_INTERRUPTED") process.exit(130);
  throw error;
}\n`,
			);
			const child = spawn(process.execPath, [driver], {
				detached: true,
				stdio: ["pipe", "ignore", "pipe"],
			});
			child.stdin.end("x");
			const exited = new Promise((resolveExit) =>
				child.once("exit", (code, signal) => resolveExit({ code, signal })),
			);
			const readyDeadline = Date.now() + 5000;
			while (!existsSync(ready) && Date.now() < readyDeadline)
				await new Promise((resolveReady) => setTimeout(resolveReady, 20));
			ok(existsSync(ready), "trapping login child never started");
			process.kill(-child.pid, "SIGINT");
			const result = await Promise.race([
				exited,
				new Promise((_, reject) =>
					setTimeout(
						() => reject(new Error("trapping login did not exit")),
						5000,
					),
				),
			]);
			strictEqual(result.signal, null);
			strictEqual(result.code, 130);
			const loginPid = Number(readFileSync(loginPidReport, "utf8"));
			let transportAlive = true;
			const transportDeadline = Date.now() + 1000;
			while (transportAlive && Date.now() < transportDeadline) {
				try {
					process.kill(loginPid, 0);
					await new Promise((resolveTransport) =>
						setTimeout(resolveTransport, 10),
					);
				} catch (error) {
					if (error?.code !== "ESRCH") throw error;
					transportAlive = false;
				}
			}
			strictEqual(transportAlive, false, "the exact login transport must exit");
			strictEqual(
				readFileSync(stopReport, "utf8"),
				"1",
				"interrupted walkthrough stops the golden image exactly once",
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("still swallows an ordinary failed login", () => {
		// The control case, and the older contract this must not break: a
		// declined prompt or a nonzero exit is decided by the re-check, not by
		// a throw.
		codex.runLogin("workspace-1", fakeBackend("sh", ["-c", "exit 1"]));
	});

	it("keeps the interrupt marker when the posture check ALSO fails", () => {
		// External review finding, 2026-09-13. withBootedGoldenImage wraps both
		// causes in a new Error so neither is lost, and main() reads `code` off
		// what it catches without walking `cause` -- so without carrying the
		// marker onto the wrapper, interrupting a walkthrough that also left
		// the posture violated exits 1, indistinguishable from a provider that
		// simply failed to authenticate.
		const stops = [];
		const backend = {
			goldenImage: "switchyard-golden-test",
			aquaUid: "501",
			bootGoldenImage: () => ({ uuid: "golden-uuid" }),
			stopGoldenImage: (uuid) => stops.push(uuid),
			describePostureViolations: () => ["aqua uid drifted"],
		};
		const interrupted = new Error("walkthrough interrupted by SIGINT");
		interrupted.code = "WALKTHROUGH_INTERRUPTED";
		interrupted.signal = "SIGINT";
		let thrown = null;
		try {
			withBootedGoldenImage(backend, () => {
				throw interrupted;
			});
		} catch (error) {
			thrown = error;
		}
		ok(thrown, "both causes must still surface as a throw");
		match(thrown.message, /posture check ALSO failed/);
		strictEqual(thrown.code, "WALKTHROUGH_INTERRUPTED");
		strictEqual(thrown.signal, "SIGINT");
		deepStrictEqual(stops, ["golden-uuid"]);
	});

	it("stops walking the remaining providers", () => {
		// The exception to "one provider's problem can't stop the rest": an
		// operator who interrupted this login wants out, not a prompt for the
		// next provider.
		let laterProviderChecked = false;
		const interrupted = new Error("walkthrough interrupted by SIGINT");
		interrupted.code = "WALKTHROUGH_INTERRUPTED";
		interrupted.signal = "SIGINT";
		const providers = [
			{
				name: "first",
				isAuthenticated: () => false,
				runLogin: () => {
					throw interrupted;
				},
			},
			{
				name: "second",
				isAuthenticated: () => {
					laterProviderChecked = true;
					return true;
				},
				runLogin: () => {},
			},
		];
		throws(
			() => ensureProvidersAuthenticated(providers),
			(error) => error.code === "WALKTHROUGH_INTERRUPTED",
		);
		strictEqual(
			laterProviderChecked,
			false,
			"an interrupt must not fall through to the next provider's login",
		);
	});
});
