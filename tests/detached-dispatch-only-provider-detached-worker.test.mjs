import { ok, strictEqual } from "node:assert";
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import { getInvocationDescriptorIdentity } from "../src/switchyard/roster/index.mjs";
import {
	attachCleanupFailure,
	cleanupDiagnostic,
	commandAvailable,
	compactDiagnostic,
	PARALLELS_AQUA_UID,
	PARALLELS_GOLDEN_IMAGE,
	pollStatus,
	ROSTER_FIXTURE_PATH,
	runDispatch,
	SWITCHYARD_SKIP_LIVE_VM_TESTS,
} from "./helpers/detached-dispatch-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const PARALLELS_PROVIDER_USER =
	process.env.SWITCHYARD_PARALLELS_PROVIDER_USER || "switchyard";
let parallelsConfigurationFault = null;
function assertParallelsConfigured() {
	if (parallelsConfigurationFault) {
		throw new Error(parallelsConfigurationFault);
	}
}
function parallelsGoldenImagePrerequisiteReason() {
	if (!commandAvailable("prlctl")) return "Parallels prlctl is unavailable";
	// Parallels is installed but the operator has not said which VM to clone.
	// That is a configuration fault, not an absent dependency, so it FAILS the gate
	// instead of skipping it. The previous `|| "macOS"` fallback pointed at the
	// unhardened Task 1.1 base VM, which is present and stopped on this host: with
	// the variable unset the gate would have cloned and asserted against a VM that
	// was never hardened. Production already refuses to guess (README.md: "no
	// default -- guessing at which VM to clone is not a safe default").
	if (!PARALLELS_GOLDEN_IMAGE) {
		parallelsConfigurationFault =
			"SWITCHYARD_PARALLELS_GOLDEN_IMAGE must be set to run the VM gate";
		return null;
	}
	let output;
	try {
		output = execFileSync("prlctl", ["list", "-a", "-o", "uuid,status,name"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return "Parallels VM inventory is unavailable";
	}
	const golden = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.split(/\s+/))
		.find(
			(fields) =>
				fields.length >= 3 &&
				fields.slice(2).join(" ") === PARALLELS_GOLDEN_IMAGE,
		);
	if (!golden) return `golden image ${PARALLELS_GOLDEN_IMAGE} is unavailable`;
	if (!/^stopped$/i.test(golden[1])) {
		return `golden image ${PARALLELS_GOLDEN_IMAGE} is not stopped`;
	}
	// An unset or malformed Aqua uid is a configuration fault, not an absent
	// dependency, so it FAILS the gate instead of skipping it. Returning a skip
	// reason here made the gate report green having proven nothing: it passes
	// locally only because ~/.zshrc exports the variable, so any non-interactive
	// shell, CI runner, or launchd context silently lost the INV-1 assertions.
	if (!PARALLELS_AQUA_UID) {
		parallelsConfigurationFault =
			"SWITCHYARD_PARALLELS_AQUA_UID must be set to run the VM gate";
		return null;
	}
	if (!/^\d+$/.test(PARALLELS_AQUA_UID) || Number(PARALLELS_AQUA_UID) <= 0) {
		parallelsConfigurationFault = `SWITCHYARD_PARALLELS_AQUA_UID must be a positive integer uid, got ${JSON.stringify(PARALLELS_AQUA_UID.slice(0, 32))}`;
		return null;
	}
	try {
		if (new ParallelsExecutionBackend().listManaged().length > 0) {
			return "a Switchyard working VM is active";
		}
	} catch {
		return "Parallels VM inventory is unavailable";
	}
	return null;
}
const PARALLELS_PREREQUISITE_REASON = SWITCHYARD_SKIP_LIVE_VM_TESTS
	? "fixture-only: SWITCHYARD_SKIP_LIVE_VM_TESTS=1"
	: parallelsGoldenImagePrerequisiteReason();
function parallelsBackendEnv() {
	// Only export what is actually set. Handing the worker an empty
	// SWITCHYARD_PARALLELS_GOLDEN_IMAGE would recreate the fallback this file
	// just removed, one process down, where it reads as configured-but-blank.
	return Object.fromEntries(
		[
			["SWITCHYARD_PARALLELS_GOLDEN_IMAGE", PARALLELS_GOLDEN_IMAGE],
			["SWITCHYARD_PARALLELS_AQUA_UID", PARALLELS_AQUA_UID],
			["SWITCHYARD_PARALLELS_PROVIDER_USER", PARALLELS_PROVIDER_USER],
		].filter(([, value]) => value !== ""),
	);
}
function writeDispatchQualifiedRoster(path, targetId) {
	const roster = JSON.parse(readFileSync(ROSTER_FIXTURE_PATH, "utf8"));
	const target = roster.targets[targetId];
	const slot = target.slots.standard[0];
	const model = roster.models[slot.model_ref];
	const core = {
		target_id: targetId,
		model_ref: slot.model_ref,
		selector: model.selector,
		effort: slot.effort ?? null,
		variant: slot.variant ?? null,
		invocation_args: slot.invocation_args ?? [],
	};
	const identity = getInvocationDescriptorIdentity(core, target.harness);
	const now = new Date().toISOString();
	target.qualifications[identity] = {
		...core,
		descriptor_identity: identity,
		status: "dispatch_qualified",
		tested_at: now,
		credential_profile: target.credential_profile,
		promotion_receipt: {
			...core,
			descriptor_identity: identity,
			status: "promoted",
			atomic: true,
			receipt_id: `detached-test-${targetId}`,
			committed_at: now,
		},
	};
	writeFileSync(path, JSON.stringify(roster), "utf8");
}
let dir;
let tasksFile;
let projectDir;
let stateRoot;
let detachedCleanupPending;
let detachedCleanupRunId;
function makeStateRootEnv() {
	return { SWITCHYARD_RUN_STORE_ROOT: stateRoot };
}
beforeEach(async () => {
	dir = tempDir("switchyard-detached-dispatch-");
	detachedCleanupPending = false;
	detachedCleanupRunId = null;
	stateRoot = join(dir, "state-root");
	tasksFile = join(dir, "tasks.md");
	writeFileSync(
		tasksFile,
		"### Task 1.1: Test task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Quick checks:** none\n- **Description:** A test\n",
		"utf8",
	);
	projectDir = join(dir, "project");
	mkdirSync(join(projectDir, ".git"), { recursive: true });

	process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;
	process.env.SWITCHYARD_ROSTER_PATH = ROSTER_FIXTURE_PATH;
	// Real dispatch subprocesses go through the real, unmocked ledger writer —
	// redirect it so this suite never writes to the real dispatch-ledger.jsonl.
	process.env.SWITCHYARD_LEDGER_PATH = join(dir, "dispatch-ledger.jsonl");
});
afterEach(() => {
	delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	delete process.env.SWITCHYARD_ROSTER_PATH;
	delete process.env.SWITCHYARD_LEDGER_PATH;
	if (detachedCleanupPending) {
		console.error(
			`detached cleanup was not confirmed for run ${detachedCleanupRunId ?? "unknown"}; preserving fixture ${dir}`,
		);
		return;
	}
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
function boundedFailureField(value) {
	return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,96}$/u.test(value)
		? value
		: value == null
			? null
			: "<redacted>";
}
function boundedFailureDiagnostic(entry) {
	return {
		failurePhase: boundedFailureField(entry?.failurePhase),
		errorKind: boundedFailureField(entry?.errorKind),
		diagnosticCode: boundedFailureField(entry?.diagnosticCode),
	};
}
function providerFilterDiagnostic(run, events) {
	return {
		run: {
			state: boundedFailureField(run?.state),
			cleanupState: boundedFailureField(run?.cleanupState),
			lastFailure: boundedFailureDiagnostic(run?.lastFailure),
		},
		recentEvents: (events ?? []).slice(-5).map((event) => ({
			phase: boundedFailureField(event?.phase),
			event: boundedFailureField(event?.event),
			taskId: boundedFailureField(event?.taskId),
			...boundedFailureDiagnostic(event),
		})),
	};
}
async function awaitRunTerminalCleanup(
	runId,
	env,
	{
		maxWait = 300_000,
		pollInterval = 200,
		progressInterval = 5_000,
		pollStatusFn = pollStatus,
		onProgress = () => process.stderr.write("detached cleanup: polling\n"),
		sleep = (delayMs) =>
			new Promise((resolveWait) => setTimeout(resolveWait, delayMs)),
	} = {},
) {
	const start = Date.now();
	let nextProgressAt = 0;
	let lastStatus = null;
	let lastStatusResult = null;
	let pollCount = 0;
	const emitProgress = (status) => {
		const now = Date.now();
		if (now < nextProgressAt) return;
		nextProgressAt = now + Math.max(0, progressInterval);
		try {
			onProgress({
				pollCount,
				elapsedMs: now - start,
				status: cleanupDiagnostic(status),
			});
		} catch {
			// Progress is advisory and must never mask the cleanup result.
		}
	};
	while (true) {
		pollCount += 1;
		try {
			const statusResult = pollStatusFn(runId, env);
			lastStatusResult = statusResult;
			if (statusResult.status === 0) {
				let status = null;
				try {
					status = JSON.parse(statusResult.stdout.trim());
					lastStatus = status;
					if (
						(status?.state === "succeeded" || status?.state === "failed") &&
						status?.cleanupState === "complete"
					) {
						return status;
					}
				} catch {
					// A partial/corrupt observation is retained in the timeout
					// diagnostic; it can never count as completed cleanup.
				}
				emitProgress(status);
				if (
					status?.state === "recovery_required" ||
					status?.cleanupState === "failed"
				) {
					const cleanupFailure = new Error(
						`run ${runId} entered unrecoverable cleanup state: ${JSON.stringify(cleanupDiagnostic(status))}`,
					);
					cleanupFailure.code = "cleanup_recovery_required";
					throw cleanupFailure;
				}
			}
			if (statusResult.status !== 0) emitProgress(null);
		} catch (error) {
			if (error?.code === "cleanup_recovery_required") throw error;
			lastStatusResult = { status: "threw", stderr: error.message };
			emitProgress(null);
		}

		const elapsed = Date.now() - start;
		if (elapsed >= maxWait) break;
		await sleep(Math.min(pollInterval, maxWait - elapsed));
	}
	let diagnosticEvents = [];
	let diagnosticRun = null;
	try {
		const { readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		diagnosticEvents = await readEvents(runId);
		diagnosticRun = await readRun(runId);
	} catch {}
	throw new Error(
		`run ${runId} did not reach terminal state with completed cleanup within ${maxWait}ms after ${pollCount} polls; last status: ${JSON.stringify(cleanupDiagnostic(lastStatus))}; run record: ${JSON.stringify(cleanupDiagnostic(diagnosticRun))}; status exit: ${lastStatusResult?.status ?? "unknown"}; status stderr: ${compactDiagnostic(lastStatusResult?.stderr) || "<empty>"}; recent events: ${JSON.stringify(diagnosticEvents.slice(-5).map(({ phase, event, taskId }) => ({ phase, event, taskId: taskId ?? null })))}`,
	);
}
async function finishDetachedRun(runId, env, bodyError, cleanupOptions = {}) {
	let cleanupError = null;
	if (runId) {
		try {
			await awaitRunTerminalCleanup(runId, env, cleanupOptions);
			detachedCleanupPending = false;
		} catch (error) {
			cleanupError = error;
		}
	}

	if (bodyError) {
		if (cleanupError) attachCleanupFailure(bodyError, cleanupError);
		throw bodyError;
	}
	if (cleanupError) throw cleanupError;
}
describe("--only-provider on the detached worker path", () => {
	it("fixture-only skips detached provider routes", () => {
		if (SWITCHYARD_SKIP_LIVE_VM_TESTS) {
			strictEqual(
				PARALLELS_PREREQUISITE_REASON,
				"fixture-only: SWITCHYARD_SKIP_LIVE_VM_TESTS=1",
			);
		} else {
			ok(
				PARALLELS_PREREQUISITE_REASON !==
					"fixture-only: SWITCHYARD_SKIP_LIVE_VM_TESTS=1",
			);
		}
	});

	it("restricts routing to the given provider end-to-end via `launch` (not just the foreground path) (Task C.9)", {
		skip: PARALLELS_PREREQUISITE_REASON
			? `VM gate skipped: ${PARALLELS_PREREQUISITE_REASON}`
			: false,
	}, async () => {
		assertParallelsConfigured();
		// Mirrors the --exclude-provider test above, but proves the allowlist
		// (not just the denylist) works end-to-end through the real detached
		// worker path: without --only-provider, claude (90% left) outranks
		// codex (50% left) and wins routing under router/index.mjs's
		// spread-by-headroom rule; with `--only-provider codex`, codex must be
		// routed instead even though claude has more headroom.
		const onlyProjectDir = join(dir, "only-provider-project");
		mkdirSync(onlyProjectDir, { recursive: true });
		execSync("git init", { cwd: onlyProjectDir, stdio: "ignore" });
		execSync("git config user.email test@test.com", {
			cwd: onlyProjectDir,
			stdio: "ignore",
		});
		execSync("git config user.name test", {
			cwd: onlyProjectDir,
			stdio: "ignore",
		});
		execSync("git commit --allow-empty -m initial", {
			cwd: onlyProjectDir,
			stdio: "ignore",
		});

		const snapshotPath = join(dir, "snapshot-only.json");
		writeFileSync(
			snapshotPath,
			JSON.stringify({
				schema_version: 2,
				updated_at: new Date().toISOString(),
				providers: [
					{
						name: "claude",
						ok: true,
						windows: [{ percent_left: 90, pace_delta: 0 }],
					},
					{
						name: "codex",
						ok: true,
						windows: [{ percent_left: 50, pace_delta: 0 }],
					},
				],
			}),
			"utf8",
		);

		const env = {
			...makeStateRootEnv(),
			...parallelsBackendEnv(),
			SWITCHYARD_SNAPSHOT_PATH_OVERRIDE: snapshotPath,
		};
		// Automatic routing now requires an exact dispatch-qualified descriptor;
		// qualify the allowlisted Codex slot in this subprocess fixture so the
		// test exercises --only-provider rather than legacy selector evidence.
		const runtimeRosterPath = join(dir, "codex-only-dispatch-roster.json");
		writeDispatchQualifiedRoster(runtimeRosterPath, "codex");
		env.SWITCHYARD_ROSTER_PATH = runtimeRosterPath;

		let runId;
		let bodyError = null;
		try {
			const launchResult = runDispatch(
				[
					"launch",
					tasksFile,
					"--project",
					onlyProjectDir,
					"--only-provider",
					"codex",
					"--platform",
					"macos",
				],
				env,
			);
			strictEqual(
				launchResult.status,
				0,
				`launch failed: ${launchResult.stderr}`,
			);
			const envelope = JSON.parse(launchResult.stdout.trim());
			runId = envelope.runId;
			ok(
				typeof runId === "string" && runId.length > 0,
				"launch must return a run id before detached cleanup can be guarded",
			);
			detachedCleanupPending = true;
			detachedCleanupRunId = runId;

			let observedProvider = null;
			let terminalDiagnostic = null;
			const start = Date.now();
			// See the --exclude-provider test's matching comment: unverified against
			// real hardware, conservative budget for a full clone + boot.
			const maxWait = 300_000;
			while (Date.now() - start < maxWait) {
				const statusResult = pollStatus(runId, env);
				if (statusResult.status === 0) {
					const status = JSON.parse(statusResult.stdout.trim());
					if (status.activeTaskProvider) {
						observedProvider = status.activeTaskProvider;
						break;
					}
					if (status.state === "succeeded" || status.state === "failed") {
						break;
					}
				}
				await new Promise((r) => setTimeout(r, 200));
			}

			if (!observedProvider) {
				const { readEvents, readRun } = await import(
					"../src/switchyard/run-store/index.mjs"
				);
				const events = await readEvents(runId);
				const run = await readRun(runId);
				const routedEvent = events.find(
					(e) =>
						e.phase === "execution" &&
						(e.event === "task_completed" || e.event === "task_failed"),
				);
				observedProvider = routedEvent?.provider ?? null;
				terminalDiagnostic = providerFilterDiagnostic(run, events);
			}

			ok(
				observedProvider,
				`expected the task to be routed to some provider; terminal diagnostic: ${JSON.stringify(terminalDiagnostic ?? providerFilterDiagnostic(null, []))}`,
			);
			strictEqual(
				observedProvider,
				"codex",
				"claude has more headroom but is not in the --only-provider allowlist, so codex must be routed instead",
			);
			ok(
				observedProvider !== "claude",
				"a provider outside the --only-provider allowlist must never be routed",
			);
		} catch (error) {
			bodyError = error;
		} finally {
			await finishDetachedRun(runId, env, bodyError);
		}
	});
});
