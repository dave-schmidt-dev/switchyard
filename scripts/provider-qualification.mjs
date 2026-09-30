#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	enumerateQualificationTargets,
	planRepresentativeQualification,
	runRepresentativeQualification,
} from "../src/switchyard/diagnostics/provider-qualification.mjs";
import {
	isProjectLockHeld,
	readRun,
} from "../src/switchyard/run-store/index.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DISPATCH = join(ROOT, "src/switchyard/dispatch/index.mjs");
const USAGE =
	"Usage: node scripts/provider-qualification.mjs [--target ID --capability low|standard|high [--descriptor sha256:...] [--lane simple|vm]] [--execute] [--deadline RFC3339]";
export function parseQualificationArgs(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			strict: true,
			allowPositionals: false,
			options: {
				target: { type: "string" },
				capability: { type: "string" },
				descriptor: { type: "string" },
				lane: { type: "string" },
				execute: { type: "boolean", default: false },
				deadline: { type: "string" },
				help: { type: "boolean", default: false },
			},
		});
	} catch {
		throw new Error("invalid_arguments");
	}
	if (parsed.values.help) return { help: true };
	const hasTarget = typeof parsed.values.target === "string";
	const hasCapability = typeof parsed.values.capability === "string";
	if (hasTarget !== hasCapability)
		throw new Error("target_and_capability_required");
	if (
		!hasTarget &&
		(parsed.values.execute ||
			parsed.values.descriptor ||
			parsed.values.deadline ||
			parsed.values.lane)
	) {
		throw new Error("target_and_capability_required");
	}
	if (parsed.values.lane && !["simple", "vm"].includes(parsed.values.lane)) {
		throw new Error("invalid_lane");
	}
	if (
		parsed.values.descriptor &&
		!/^sha256:[0-9a-f]{64}$/u.test(parsed.values.descriptor)
	) {
		throw new Error("invalid_descriptor_identity");
	}
	if (parsed.values.execute && !parsed.values.deadline) {
		throw new Error("deadline_required_for_execute");
	}
	if (parsed.values.deadline && !parsed.values.execute) {
		throw new Error("deadline_requires_execute");
	}
	let deadlineMs = null;
	if (parsed.values.deadline) {
		deadlineMs = Date.parse(parsed.values.deadline);
		if (
			!Number.isFinite(deadlineMs) ||
			deadlineMs <= Date.now() ||
			deadlineMs - Date.now() > 30 * 60_000
		) {
			throw new Error("deadline_must_be_within_30_minutes");
		}
	}
	return {
		help: false,
		targetId: parsed.values.target ?? null,
		capability: parsed.values.capability ?? null,
		descriptorIdentity: parsed.values.descriptor ?? null,
		lane: parsed.values.lane ?? null,
		execute: parsed.values.execute === true,
		deadlineMs,
	};
}
function cleanEnvironment() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (/(?:API_KEY|PASSWORD|TOKEN|SECRET|CREDENTIAL)/iu.test(key)) continue;
		env[key] = value;
	}
	return env;
}
export function spawnBounded(args, { timeoutMs, onProgress = () => {} }) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(process.execPath, args, {
			cwd: ROOT,
			env: cleanEnvironment(),
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const started = Date.now();
		let stdout = "";
		let overLimit = false;
		let closed = false;
		let terminationReason = null;
		let terminationPromise = null;
		const progress = setInterval(() => {
			onProgress({
				event: "dispatch_running",
				elapsedMs: Date.now() - started,
			});
		}, 20_000);
		progress.unref?.();
		const groupExists = () => {
			if (!Number.isSafeInteger(child.pid)) return null;
			try {
				process.kill(-child.pid, 0);
				return true;
			} catch (error) {
				return error?.code !== "ESRCH";
			}
		};
		const signalGroup = (signal) => {
			if (!Number.isSafeInteger(child.pid)) return "unknown";
			try {
				process.kill(-child.pid, signal);
				return "signaled";
			} catch (error) {
				return error?.code === "ESRCH" ? "gone" : "unknown";
			}
		};
		const terminateGroup = (reason) => {
			terminationReason ??= reason;
			terminationPromise ??= (async () => {
				const term = signalGroup("SIGTERM");
				if (term === "unknown") return false;
				let until = Date.now() + 5_000;
				while (Date.now() < until) {
					if (groupExists() === false) return true;
					await new Promise((done) => setTimeout(done, 100));
				}
				const kill = signalGroup("SIGKILL");
				if (kill === "unknown") return false;
				until = Date.now() + 5_000;
				while (Date.now() < until) {
					if (groupExists() === false) return true;
					await new Promise((done) => setTimeout(done, 100));
				}
				return groupExists() === false;
			})();
			return terminationPromise;
		};
		const timer = setTimeout(() => {
			if (!closed) void terminateGroup("deadline_expired");
		}, timeoutMs);
		timer.unref?.();
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			if (stdout.length + chunk.length > 2_000_000) {
				overLimit = true;
				void terminateGroup("dispatch_output_invalid");
				return;
			}
			stdout += chunk;
		});
		// Provider stderr may contain prompt fragments or credentials; consume but never persist or relay it.
		child.stderr.resume();
		child.once("error", () => {
			closed = true;
			clearInterval(progress);
			clearTimeout(timer);
			rejectPromise(
				Object.assign(new Error("dispatch_failed"), {
					code: "dispatch_failed",
					providerNeverStarted: !Number.isSafeInteger(child.pid),
				}),
			);
		});
		child.once("close", async (code, signal) => {
			closed = true;
			clearInterval(progress);
			clearTimeout(timer);
			if (!terminationReason && groupExists() === true) {
				await terminateGroup("dispatch_cleanup_unconfirmed");
				rejectPromise(
					Object.assign(new Error("dispatch_cleanup_unconfirmed"), {
						code: "dispatch_cleanup_unconfirmed",
					}),
				);
				return;
			}
			const cleanupConfirmed = terminationReason
				? await terminationPromise
				: groupExists() === false;
			if (!cleanupConfirmed) {
				rejectPromise(
					Object.assign(new Error("dispatch_cleanup_unconfirmed"), {
						code: "dispatch_cleanup_unconfirmed",
					}),
				);
				return;
			}
			if (terminationReason) {
				rejectPromise(
					Object.assign(new Error(terminationReason), {
						code: terminationReason,
					}),
				);
				return;
			}
			if (overLimit) {
				rejectPromise(
					Object.assign(new Error("dispatch_output_invalid"), {
						code: "dispatch_output_invalid",
					}),
				);
				return;
			}
			if (code !== 0 && !stdout.trim()) {
				rejectPromise(
					Object.assign(
						new Error(signal ? "dispatch_failed" : "vm_lane_unavailable"),
						{
							code: signal ? "dispatch_failed" : "vm_lane_unavailable",
						},
					),
				);
				return;
			}
			try {
				resolvePromise(JSON.parse(stdout.trim()));
			} catch {
				rejectPromise(
					Object.assign(new Error("dispatch_output_invalid"), {
						code: "dispatch_output_invalid",
					}),
				);
			}
		});
	});
}
export function taskMarkdown(plan) {
	const justification =
		plan.capability === "standard"
			? ""
			: "\n- **RequiredCapabilityJustification:** This synthetic one-file behavior change is used to verify the exact configured " +
				plan.capability +
				" descriptor in an isolated disposable project.";
	return [
		"# Provider qualification fixture",
		"",
		"## Pending",
		"",
		"### Task 1: Implement the series summary fixture",
		"- **Status:** pending",
		"- **Type:** implementation",
		"- **Executor:** switchyard",
		"- **Files:** src/summary.mjs, tests/summary.test.mjs",
		`- **RequiredCapability:** ${plan.capability}`,
		"- **Quick checks:** node --test tests/acceptance.test.mjs",
		"- **Description:** " +
			"Implement summarize(values) in src/summary.mjs and replace the placeholder tests in tests/summary.test.mjs. " +
			"Both files must be edited with file tools. Count and sum finite numeric values; average is total/count or null when empty. " +
			"Reject non-array input with TypeError and ignore non-number, NaN, and infinite values. Do not touch any other path. " +
			"The independent acceptance test covers normal, empty, filtered, and invalid input cases.",
		justification,
		"",
	].join("\n");
}
function taskResult(report) {
	if (Array.isArray(report?.results)) {
		return (
			report.results.find((item) => item?.taskId === "1") ??
			report.results[0] ??
			null
		);
	}
	return report;
}
export async function productionDispatch({
	plan,
	fixture,
	allowedFiles,
	deadlineAt,
	onProgress,
	spawnCommand = spawnBounded,
	readRunRecord = readRun,
	projectLockHeld = isProjectLockHeld,
}) {
	const remaining = Date.parse(deadlineAt) - Date.now();
	if (!Number.isFinite(remaining) || remaining <= 0) {
		throw Object.assign(new Error("deadline_expired"), {
			code: "deadline_expired",
			providerNeverStarted: true,
		});
	}
	if (plan.lane === "simple") {
		const args = [
			DISPATCH,
			"simple",
			fixture.promptPath,
			"--project",
			fixture.projectPath,
			"--capability",
			plan.capability,
			"--file",
			allowedFiles[0],
			"--file",
			allowedFiles[1],
			"--only-provider",
			plan.targetId,
			"--check",
			"node --test tests/acceptance.test.mjs",
			"--deadline",
			deadlineAt,
			"--json",
		];
		const providerResult = await spawnCommand(args, {
			timeoutMs: remaining,
			onProgress,
		});
		let runRecord = null;
		try {
			runRecord = await readRunRecord(providerResult.runId);
		} catch {
			// Missing route or cleanup state fails closed below.
		}
		const routeTarget = runRecord?.resolvedTargetId ?? null;
		const routeModel = runRecord?.activeTaskModel ?? null;
		return {
			providerResult,
			targetId: routeTarget,
			routeModel,
			descriptorIdentity:
				providerResult.descriptorIdentity ??
				runRecord?.descriptorIdentity ??
				null,
			invocationDescriptor:
				providerResult.invocationDescriptor ??
				providerResult.invocation_descriptor ??
				runRecord?.invocationDescriptor ??
				null,
			checkCommands: ["node --test tests/acceptance.test.mjs"],
			checks: providerResult.checks,
			changedFiles: providerResult.changedFiles,
			cleanup: providerResult.recovery?.cleanup,
		};
	}
	if (plan.lane !== "vm") {
		throw Object.assign(new Error("provider_lane_unavailable"), {
			code: "provider_lane_unavailable",
			providerNeverStarted: true,
		});
	}
	const health = await spawnCommand([DISPATCH, "backend-health", "--json"], {
		timeoutMs: Math.min(30_000, remaining),
		onProgress,
	});
	if (health?.ready !== true) {
		throw Object.assign(new Error("vm_lane_unavailable"), {
			code: "vm_lane_unavailable",
			providerNeverStarted: true,
		});
	}
	writeFileSync(fixture.taskPath, taskMarkdown(plan), {
		mode: 0o600,
		flag: "wx",
	});
	const args = [
		DISPATCH,
		"run",
		fixture.taskPath,
		"--project",
		fixture.projectPath,
		"--max-tasks",
		"1",
		"--checkpoint",
		fixture.checkpointPath,
		"--only-provider",
		plan.targetId,
		"--task-id",
		"1",
		"--qualification-attempt",
		"--json",
	];
	const report = await spawnCommand(args, { timeoutMs: remaining, onProgress });
	const providerResult = taskResult(report);
	let runRecord = null;
	if (typeof report?.runId === "string") {
		try {
			runRecord = await readRunRecord(report.runId);
		} catch {
			// Workspace removal is unverified when its durable run record is absent.
		}
	}
	let projectLockReleased = false;
	try {
		projectLockReleased = !(await projectLockHeld(fixture.projectPath));
	} catch {
		projectLockReleased = false;
	}
	const vmClean =
		providerResult?.cleanupFailed === false &&
		providerResult?.cleanupStage === "index_lock_removed" &&
		providerResult?.providerLifecycle?.writerLifecycle === "stopped" &&
		providerResult?.providerLifecycle?.terminalStatus === "exited" &&
		providerResult?.providerLifecycle?.cleanupStatus === "succeeded" &&
		providerResult?.providerLifecycle?.cleanupStage === "index_lock_removed";
	const queueWorkspaceRemoved =
		report?.cleanupState === "complete" &&
		runRecord?.cleanupState === "complete" &&
		runRecord?.worktree?.state === "removed";
	return {
		providerResult: { ...providerResult, projectLockReleased },
		targetId: providerResult?.resolvedTargetId ?? null,
		descriptorIdentity: providerResult?.descriptorIdentity ?? null,
		invocationDescriptor: providerResult?.invocationDescriptor ?? null,
		quickCheckReceipt: providerResult?.quickCheckReceipt ?? null,
		cleanup: {
			writer: { state: vmClean ? "stopped" : "unavailable" },
			worktree: { state: queueWorkspaceRemoved ? "removed" : "unavailable" },
			projectLock: { state: projectLockReleased ? "released" : "unavailable" },
		},
	};
}
async function main() {
	let options;
	try {
		options = parseQualificationArgs(process.argv.slice(2));
	} catch (error) {
		console.error(
			JSON.stringify({
				status: "invalid_request",
				reason: error.message,
				usage: USAGE,
			}),
		);
		process.exitCode = 2;
		return;
	}
	if (options.help) {
		console.log(USAGE);
		return;
	}
	const inventory = enumerateQualificationTargets();
	if (!options.targetId) {
		console.log(JSON.stringify(inventory));
		return;
	}
	const plan = planRepresentativeQualification({
		targetId: options.targetId,
		capability: options.capability,
		descriptorIdentity: options.descriptorIdentity,
		lane: options.lane,
	});
	if (!options.execute) {
		console.log(JSON.stringify(plan));
		if (plan.status !== "ready") process.exitCode = 2;
		return;
	}
	const deadlineAt = new Date(options.deadlineMs).toISOString();
	console.error("provider-qualification: explicit synthetic attempt starting");
	const result = await runRepresentativeQualification({
		targetId: options.targetId,
		capability: options.capability,
		descriptorIdentity: options.descriptorIdentity,
		lane: options.lane,
		deadlineAt,
		dispatch: (context) => productionDispatch(context),
		onProgress: (event) => {
			if (event.event === "dispatch_running") {
				console.error(
					"provider-qualification: provider dispatch running elapsedSeconds=" +
						Math.floor(event.elapsedMs / 1000),
				);
			}
		},
	});
	console.log(JSON.stringify(result));
	if (result.status !== "representative_passed") process.exitCode = 1;
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await main();
}
