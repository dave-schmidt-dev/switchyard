import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateInvocationDescriptor } from "../src/switchyard/roster/index.mjs";
import {
	getRunRoot,
	readEvents,
	readRun,
} from "../src/switchyard/run-store/index.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import {
	prepareSimpleProviderStart,
	probeSimpleLauncher,
} from "../src/switchyard/simple/launcher-preflight.mjs";
import {
	createBridgeRequestRecorder,
	REQUEST_END_PREFIX,
} from "../src/switchyard/simple/request-evidence.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const root = tempDir("launcher-preflight-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(root, "runs");
const clean = async () => ({ success: true, writerLifecycle: "stopped" });
const end = `${REQUEST_END_PREFIX}${JSON.stringify({ requests: 0 })}\n`;

test("fixed launcher probe is bounded, isolated, progressive and discards text", async () => {
	let progress = 0;
	for (const targetId of ["vibe", "vibe-code", "opencode-go"]) {
		const result = await probeSimpleLauncher({
			targetId,
			deadlineMs: 12_000,
			now: () => 10_000,
			onProgress: () => {
				progress += 1;
			},
			runProbe: async (command, args, options) => {
				strictEqual(command, "/usr/bin/sandbox-exec");
				deepStrictEqual(args, [
					"-p",
					"(version 1)(allow default)",
					"/usr/bin/true",
				]);
				strictEqual(options.timeoutMs + options.termGraceMs, 2_000);
				deepStrictEqual(options.env, {
					PATH: "/usr/bin:/bin",
					LANG: "C",
					LC_ALL: "C",
				});
				options.onPoll();
				return {
					success: false,
					writerLifecycle: "stopped",
					stderr: "PRIVATE provider auth_expired",
				};
			},
		});
		strictEqual(result.failureReason, "launcher_environment_unavailable");
		strictEqual(result.providerStarted, false);
		strictEqual(result.writerLifecycle, "never_started");
		strictEqual(JSON.stringify(result).includes("PRIVATE"), false);
	}
	strictEqual(progress, 9);
});

test("probe skips other launchers and refuses expired or cancelled work before child start", async () => {
	let calls = 0;
	const runProbe = async () => {
		calls += 1;
		return clean();
	};
	strictEqual(
		(await probeSimpleLauncher({ targetId: "codex", runProbe })).success,
		true,
	);
	for (const extra of [
		{ deadlineMs: 1 },
		{ deadlineMs: 20, signal: { aborted: true } },
	]) {
		strictEqual(
			(
				await probeSimpleLauncher({
					targetId: "vibe",
					now: () => 10,
					runProbe,
					...extra,
				})
			).providerStarted,
			false,
		);
	}
	strictEqual(calls, 0);
});

test("probe distinguishes clean completion, deadline/cancellation and unknown cleanup", async () => {
	for (const [answer, lifecycle, success] of [
		[{ success: true, writerLifecycle: "stopped" }, "stopped", true],
		[{ success: true, writerLifecycle: "unavailable" }, "unavailable", false],
		[
			{ success: false, writerLifecycle: "never_started" },
			"never_started",
			false,
		],
		[null, "unavailable", false],
	]) {
		const result = await probeSimpleLauncher({
			targetId: "vibe",
			deadlineMs: 10_000,
			now: () => 0,
			runProbe: async () => answer,
		});
		strictEqual(result.success, success);
		strictEqual(result.probeWriterLifecycle, lifecycle);
	}
	const throws = await probeSimpleLauncher({
		targetId: "vibe",
		deadlineMs: 10_000,
		now: () => 0,
		runProbe: async () => {
			throw Error("private");
		},
	});
	strictEqual(throws.probeWriterLifecycle, "unavailable");
	let now = 0;
	const deadline = await probeSimpleLauncher({
		targetId: "vibe",
		deadlineMs: 100,
		now: () => now,
		runProbe: async () => {
			now = 100;
			return clean();
		},
	});
	strictEqual(deadline.success, false);
	strictEqual(deadline.failureReason, "deadline_expired");
	const signal = { aborted: false };
	const cancelled = await probeSimpleLauncher({
		targetId: "vibe",
		deadlineMs: 100,
		now: () => 0,
		signal,
		runProbe: async () => {
			signal.aborted = true;
			return clean();
		},
	});
	strictEqual(cancelled.success, false);
	strictEqual(cancelled.failureReason, "provider_cancelled");
});

test("admission closes and removes only its empty unstarted recorder on health reroute", async () => {
	const order = [];
	const recorderPath = join(root, "unstarted.jsonl");
	const result = await prepareSimpleProviderStart({
		targetId: "vibe",
		deadlineMs: Date.now() + 10_000,
		runProbe: async () => {
			order.push("probe");
			return clean();
		},
		recorderPath,
		createRecorder: (path) => {
			order.push("recorder");
			return createBridgeRequestRecorder(path);
		},
		healthController: {
			start: async () => {
				order.push("health");
				return { allowed: false, reroute: true };
			},
		},
	});
	deepStrictEqual(order, ["probe", "recorder", "health"]);
	strictEqual(result.healthStart.reroute, true);
	strictEqual(existsSync(recorderPath), false);
});

test("admission preserves nonempty logs and never starts health on recorder failure", async () => {
	let starts = 0;
	const healthController = {
		start: async () => {
			starts += 1;
			return { allowed: false, reroute: true };
		},
	};
	const context = {
		targetId: "vibe",
		deadlineMs: Date.now() + 10_000,
		runProbe: clean,
		healthController,
	};
	const failed = await prepareSimpleProviderStart({
		...context,
		recorderPath: join(root, "missing", "log"),
		createRecorder: () => {
			throw Error("private");
		},
	});
	strictEqual(failed.failureReason, "request_log_open_failed");
	strictEqual(starts, 0);
	const recorderPath = join(root, "nonempty.jsonl");
	const nonempty = await prepareSimpleProviderStart({
		...context,
		recorderPath,
		createRecorder: (path) => {
			const recorder = createBridgeRequestRecorder(path);
			writeFileSync(path, "preserve\n");
			return recorder;
		},
	});
	strictEqual(nonempty.failureReason, "request_log_open_failed");
	strictEqual(readFileSync(recorderPath, "utf8"), "preserve\n");
});

function fixture(targets = ["vibe"]) {
	const projectPath = tempDir("launcher-project-");
	mkdirSync(join(projectPath, "src"));
	writeFileSync(join(projectPath, "src", "a.txt"), "base\n");
	execFileSync("git", ["init", "-q"], { cwd: projectPath });
	execFileSync("git", ["add", "-A"], { cwd: projectPath });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-qm",
			"base",
		],
		{ cwd: projectPath },
	);
	const promptPath = join(projectPath, "task.txt");
	writeFileSync(promptPath, "Change src/a.txt");
	const order = [];
	const descriptors = Object.fromEntries(
		targets.map((target) => [
			target,
			validateInvocationDescriptor(
				{
					target_id: target,
					model_ref: `fixture/${target}`,
					selector: "glm-5-3",
					effort: null,
					variant: null,
					invocation_args: [],
				},
				"vibe",
			),
		]),
	);
	const options = {
		projectPath,
		promptPath,
		capability: "standard",
		files: ["src/a.txt"],
		checks: [],
		deadlineMs: Date.now() + 240_000,
		onlyProviders: targets,
	};
	const deps = {
		tmpdir: () => root,
		route: ({ availableProviders }) => ({
			provider: availableProviders[0],
			reason: "priority_fill",
		}),
		resolveTargetIdentity: (target) => ({
			targetId: target,
			harnessKey: "vibe",
			ambiguous: false,
		}),
		getInvocationDescriptor: (target) => descriptors[target],
		assertFundedRoute: () => {},
		runLauncherProbe: async () => {
			order.push("probe");
			return clean();
		},
		createBridgeRequestRecorder: (path) => {
			order.push(
				`recorder:${path.endsWith("repair.jsonl") ? "repair" : "primary"}`,
			);
			return createBridgeRequestRecorder(path);
		},
		createSimpleRouteHealthController: () => ({
			prepare: async () => ({ allowed: true }),
			start: async () => {
				order.push("health");
				return { allowed: true, tracked: false };
			},
			terminal: async () => ({ settled: true }),
		}),
		executeProvider: async ({ worktreePath, onStderrChunk }) => {
			order.push("execute");
			writeFileSync(join(worktreePath, "src", "a.txt"), "candidate\n");
			onStderrChunk?.(Buffer.from(end));
			return { success: true, code: 0, writerLifecycle: "stopped" };
		},
		runCheck: async () => ({
			success: true,
			code: 0,
			writerLifecycle: "stopped",
		}),
		integrate: async () => ({ success: true }),
	};
	return { options, deps, order };
}

function useHalfOpenHealth(f) {
	const descriptor = f.deps.getInvocationDescriptor("vibe");
	const epoch = `sha256:${"a".repeat(64)}`;
	const healthStateRoot = join(root, `health-${Math.random()}`);
	const decision = () => ({
		available: true,
		mode: "enforce",
		state: "half-open",
		suppress: false,
		repairEpoch: 0,
		trialAvailable: true,
	});
	Object.defineProperties(decision, {
		mode: { value: "enforce" },
		publicConfigurationEpoch: { value: epoch },
		identityFor: {
			value: () => ({
				targetId: "vibe",
				descriptorIdentity: descriptor.descriptor_identity,
				publicConfigurationEpoch: epoch,
			}),
		},
	});
	delete f.deps.createSimpleRouteHealthController;
	f.deps.healthDecision = decision;
	f.deps.healthStateRoot = healthStateRoot;
	f.deps.healthMode = "enforce";
	return healthStateRoot;
}

test("integrated failed probe consumes no trial, recorder or provider and persists frozen-compatible taxonomy", async () => {
	const f = fixture();
	const healthRoot = useHalfOpenHealth(f);
	f.deps.runLauncherProbe = async () => {
		f.order.push("probe");
		return {
			success: false,
			code: 71,
			writerLifecycle: "stopped",
			stderr: "PRIVATE auth_expired",
		};
	};
	const result = await runSimpleTask(f.options, f.deps);
	deepStrictEqual(f.order, ["probe"]);
	strictEqual(existsSync(healthRoot), false);
	strictEqual(result.failureReason, "launcher_environment_unavailable");
	strictEqual(result.providerStarted, false);
	strictEqual(result.recovery.cleanup.writer.state, "never_started");
	strictEqual(result.recovery.cleanup.worktree.state, "removed");
	const run = await readRun(result.runId);
	strictEqual(
		run.lastFailure.providerReliability.causeCode,
		"environment_failure",
	);
	strictEqual(run.lastFailure.providerReliability.phase, "preflight");
	strictEqual(run.lastFailure.diagnosticCode, undefined);
	strictEqual(JSON.stringify(run).includes("PRIVATE"), false);
	const frozenRoot =
		process.env.SWITCHYARD_COMPATIBILITY_ROOT ?? tempDir("launcher-frozen-");
	if (!process.env.SWITCHYARD_COMPATIBILITY_ROOT) {
		const archive = join(frozenRoot, "baseline.tar");
		execFileSync(
			"git",
			[
				"archive",
				"5c77335c8bec3f1ff6dddcc4521a3de893de7310",
				"src",
				"package.json",
				"--output",
				archive,
			],
			{ cwd: fileURLToPath(new URL("..", import.meta.url)) },
		);
		execFileSync("tar", ["-xf", archive, "-C", frozenRoot]);
	}
	const frozenSanitizer = await import(
		pathToFileURL(join(frozenRoot, "src/switchyard/adapter/exec-error.mjs"))
	);
	strictEqual(
		run.failureDetails.failureReason,
		"launcher_environment_unavailable",
	);
	deepStrictEqual(
		frozenSanitizer.sanitizeFailureMetadata({
			result: "execution_failed",
			...run.lastFailure,
		}),
		run.lastFailure,
	);
	const frozenReader = await import(
		pathToFileURL(join(frozenRoot, "src/switchyard/run-store/run-records.mjs"))
	);
	deepStrictEqual(
		(await frozenReader.readRun(result.runId)).lastFailure,
		run.lastFailure,
	);
	const events = await readEvents(result.runId);
	strictEqual(
		events.some((event) => event.milestone === "provider_started"),
		false,
	);
});

test("unconfirmed probe child retains owned artifacts while provider remains never started", async () => {
	const f = fixture();
	const healthRoot = useHalfOpenHealth(f);
	f.deps.runLauncherProbe = async () => ({
		success: false,
		writerLifecycle: "unavailable",
	});
	const result = await runSimpleTask(f.options, f.deps);
	strictEqual(result.providerStarted, false);
	strictEqual(result.writerLifecycle, "never_started");
	strictEqual(result.recovery.cleanup.writer.state, "unavailable");
	strictEqual(result.recovery.cleanup.worktree.state, "retained");
	ok(existsSync(result.partialWorktree));
	strictEqual(f.order.length, 0);
	strictEqual(existsSync(healthRoot), false);
});

test("integrated recorder readiness failure leaves health trial unconsumed", async () => {
	const f = fixture();
	const healthRoot = useHalfOpenHealth(f);
	f.deps.createBridgeRequestRecorder = () => {
		f.order.push("recorder");
		throw Error("private");
	};
	const result = await runSimpleTask(f.options, f.deps);
	strictEqual(result.failureReason, "request_log_open_failed");
	deepStrictEqual(f.order, ["probe", "recorder"]);
	strictEqual(existsSync(healthRoot), false);
	strictEqual(result.providerStarted, false);
});

test("integrated health reroute reprobes before starting the next provider", async () => {
	const f = fixture(["vibe", "vibe-code"]);
	let starts = 0;
	f.deps.createSimpleRouteHealthController = () => ({
		prepare: async () => ({ allowed: true }),
		start: async () => {
			f.order.push("health");
			return ++starts === 1
				? { allowed: false, reroute: true }
				: { allowed: true, tracked: false };
		},
		terminal: async () => ({ settled: true }),
	});
	const result = await runSimpleTask(f.options, f.deps);
	strictEqual(result.status, "succeeded", JSON.stringify(result));
	deepStrictEqual(f.order, [
		"probe",
		"recorder:primary",
		"health",
		"probe",
		"health",
		"execute",
	]);
	strictEqual(
		existsSync(join(getRunRoot(result.runId), "provider-requests.jsonl")),
		false,
	);
});

test("repair admission repeats probe and recorder before health while preserving started primary log", async () => {
	const f = fixture();
	f.options.checks = ["fixture check"];
	f.options.repairChecks = true;
	let checks = 0;
	f.deps.runCheck = async () => ({
		success: ++checks !== 1,
		code: checks === 1 ? 1 : 0,
		writerLifecycle: "stopped",
	});
	const result = await runSimpleTask(f.options, f.deps);
	strictEqual(result.status, "succeeded", JSON.stringify(result));
	deepStrictEqual(f.order, [
		"probe",
		"recorder:primary",
		"health",
		"execute",
		"probe",
		"recorder:repair",
		"health",
		"execute",
	]);
	for (const name of [
		"provider-requests.jsonl",
		"provider-requests-repair.jsonl",
	])
		strictEqual(
			readFileSync(join(getRunRoot(result.runId), name), "utf8"),
			`${JSON.stringify({ type: "end", requests: 0 })}\n`,
		);
});

test("probe interruptions retain exact reasons before, during and after the child", async () => {
	for (const mode of ["before", "during", "after", "throw"]) {
		for (const kind of ["cancel", "deadline"]) {
			const signal = { aborted: false };
			let clock = 0;
			let progress = 0;
			const interrupt = () => {
				if (kind === "cancel") signal.aborted = true;
				else clock = 100;
			};
			if (mode === "before") interrupt();
			const result = await probeSimpleLauncher({
				targetId: "vibe",
				deadlineMs: 100,
				now: () => clock,
				signal,
				onProgress: () => {
					if (++progress === 2 && mode === "after") interrupt();
				},
				runProbe: async () => {
					if (mode === "during" || mode === "throw") interrupt();
					if (mode === "throw") throw Error("bounded failure");
					return clean();
				},
			});
			strictEqual(
				result.failureReason,
				kind === "cancel" ? "provider_cancelled" : "deadline_expired",
			);
			strictEqual(
				result.probeWriterLifecycle,
				mode === "before"
					? "never_started"
					: mode === "throw"
						? "unavailable"
						: "stopped",
			);
		}
	}
	for (const [flag, reason] of [
		["cancelled", "provider_cancelled"],
		["timedOut", "launcher_environment_unavailable"],
	]) {
		const result = await probeSimpleLauncher({
			targetId: "vibe",
			deadlineMs: 100,
			now: () => 0,
			runProbe: async () => ({
				success: false,
				writerLifecycle: "stopped",
				[flag]: true,
			}),
		});
		strictEqual(result.failureReason, reason);
	}
});

test("recorder callback interruption refuses health with exact reason and cleanup proof", async () => {
	for (const kind of ["cancel", "deadline"]) {
		const signal = { aborted: false };
		let clock = 0;
		let starts = 0;
		const recorderPath = join(root, `race-${kind}.jsonl`);
		const result = await prepareSimpleProviderStart({
			targetId: "vibe",
			deadlineMs: 100,
			now: () => clock,
			signal,
			runProbe: clean,
			recorderPath,
			createRecorder: (path) => {
				const recorder = createBridgeRequestRecorder(path);
				if (kind === "cancel") signal.aborted = true;
				else clock = 100;
				return recorder;
			},
			healthController: {
				start: async () => {
					starts += 1;
					return { allowed: true };
				},
			},
		});
		strictEqual(
			result.failureReason,
			kind === "cancel" ? "provider_cancelled" : "deadline_expired",
		);
		strictEqual(result.cleanupUnavailable, false);
		strictEqual(existsSync(recorderPath), false);
		strictEqual(starts, 0);
	}
});

test("unstarted repair refusal preserves executed primary evidence and independent probe cleanup", async () => {
	for (const lifecycle of ["stopped", "unavailable"]) {
		const f = fixture();
		f.options.checks = ["fixture check"];
		f.options.repairChecks = true;
		f.deps.runCheck = async () => ({
			success: false,
			code: 1,
			writerLifecycle: "stopped",
		});
		let probes = 0;
		f.deps.runLauncherProbe = async () =>
			++probes === 1 ? clean() : { success: false, writerLifecycle: lifecycle };
		const result = await runSimpleTask(f.options, f.deps);
		strictEqual(result.failureReason, "launcher_environment_unavailable");
		strictEqual(result.providerStarted, true);
		strictEqual(result.writerLifecycle, "stopped");
		strictEqual(result.providerReliability.exitCode, 1);
		strictEqual(result.recovery.cleanup.writer.state, lifecycle);
		strictEqual(f.order.filter((item) => item === "execute").length, 1);
		strictEqual(
			readFileSync(
				join(getRunRoot(result.runId), "provider-requests.jsonl"),
				"utf8",
			),
			`${JSON.stringify({ type: "end", requests: 0 })}\n`,
		);
		strictEqual(
			existsSync(
				join(getRunRoot(result.runId), "provider-requests-repair.jsonl"),
			),
			false,
		);
		const events = await readEvents(result.runId);
		strictEqual(
			events.filter((event) => event.milestone === "provider_started").length,
			1,
		);
	}
});

test("repair starting callback can refuse without claiming a second provider start", async () => {
	const f = fixture();
	const controller = new AbortController();
	f.deps.signal = controller.signal;
	f.options.checks = ["fixture check"];
	f.options.repairChecks = true;
	f.deps.runCheck = async () => ({
		success: false,
		code: 1,
		writerLifecycle: "stopped",
	});
	f.deps.onStatus = (event) => {
		if (event.phase === "repair" && event.milestone === "provider_starting")
			controller.abort();
	};
	const result = await runSimpleTask(f.options, f.deps);
	strictEqual(result.failureReason, "provider_cancelled");
	strictEqual(result.providerStarted, true);
	strictEqual(result.writerLifecycle, "stopped");
	strictEqual(f.order.filter((item) => item === "execute").length, 1);
	const events = await readEvents(result.runId);
	strictEqual(
		events.filter((event) => event.milestone === "provider_started").length,
		1,
	);
});
