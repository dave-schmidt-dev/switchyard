/** Daily scheduling, local notifications and bounded child-process execution. */
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CANARY_DAILY_ENV = "SWITCHYARD_CANARY_DAILY";
const CANARY_STATE_DIR_ENV = "SWITCHYARD_CANARY_STATE_DIR";
export const CANARY_DEADLINE_ENV = "SWITCHYARD_CANARY_DEADLINE_MS";
export const CANARY_SANDBOX_EXEC_ENV = "SWITCHYARD_CANARY_SANDBOX_EXEC";
const CANARY_STATE_FILE_NAME = "canary-state.json";
export const DEFAULT_CANARY_DEADLINE_MS = 300_000;

export function supervisedSpawn(command, args, options = {}) {
	const program = `
 const {spawn}=require("node:child_process");
 const {command,args,timeout,maxBuffer,forwardOutput,progressLabel}=JSON.parse(process.argv[1]);
 const child=spawn(command,args,{detached:true,stdio:["ignore","pipe","pipe"]});
 let stdout="",stderr="",failure=null,progress=null;
 const kill=()=>{try{process.kill(-child.pid,"SIGKILL")}catch{}};
 const stop=code=>{failure={code};clearInterval(progress);kill()};
 const timer=setTimeout(()=>stop("ETIMEDOUT"),timeout);
 process.on("SIGTERM",()=>stop("EINTR"));process.on("SIGINT",()=>stop("EINTR"));
 process.on("SIGHUP",()=>stop("EINTR"));process.once("exit",kill);
 if(progressLabel)progress=setInterval(()=>process.stderr.write(progressLabel+"\\n"),5000);
 const collect=(chunk,type)=>{if(forwardOutput)process.stderr.write(chunk);if(type==="stdout")stdout+=chunk;else stderr+=chunk;
 if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>maxBuffer)stop("ENOBUFS")};
 child.stdout.on("data",data=>collect(data,"stdout"));
 child.stderr.on("data",data=>collect(data,"stderr"));
 child.on("error",error=>{failure={code:error.code};clearInterval(progress)});
 child.on("close",(status,signal)=>{clearTimeout(timer);clearInterval(progress);kill();process.removeListener("exit",kill);
 process.stdout.write(JSON.stringify({status,signal,stdout:stdout.slice(-maxBuffer),stderr:stderr.slice(-maxBuffer),error:failure}))});
 `;
	const config = JSON.stringify({
		command,
		args,
		timeout: options.timeout ?? 5000,
		maxBuffer: options.maxBuffer ?? 262144,
		forwardOutput: options.forwardOutput === true,
		progressLabel:
			typeof options.progressLabel === "string" ? options.progressLabel : null,
	});
	const result = spawnSync(process.execPath, ["-e", program, config], {
		cwd: options.cwd,
		env: options.env,
		encoding: "utf8",
		stdio:
			options.forwardOutput === true || options.progressLabel
				? ["ignore", "pipe", "inherit"]
				: undefined,
		timeout: (options.timeout ?? 5000) + 2000,
		killSignal: "SIGKILL",
		maxBuffer: 2097152,
	});
	if (result.status !== 0) return result;
	try {
		return JSON.parse(result.stdout);
	} catch {
		return { status: null, error: { code: "invalid_supervisor_report" } };
	}
}

function utcDayKey(date = new Date()) {
	return date.toISOString().slice(0, 10);
}
function canaryStateDir({ env = process.env, home } = {}) {
	const override = env?.[CANARY_STATE_DIR_ENV];
	if (typeof override === "string" && override.length > 0)
		return resolve(override);
	const resolvedHome = home ?? homedir();
	const suffix = "Library/Application Support/switchyard/sandbox-canary-state";
	return join(resolvedHome, suffix);
}
export function resolveDeadlineMs(
	value,
	fallback = DEFAULT_CANARY_DEADLINE_MS,
) {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function readCanaryState(stateFile) {
	try {
		const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { state: null, error: "state_malformed" };
		}
		return { state: parsed, error: null };
	} catch (err) {
		if (err?.code === "ENOENT") return { state: null, error: null };
		const error =
			err instanceof SyntaxError ? "state_malformed" : "state_unreadable";
		return { state: null, error };
	}
}
let stateWriteCounter = 0;
function writeCanaryState(stateFile, state) {
	mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
	stateWriteCounter += 1;
	const temporary = `${stateFile}.tmp-${process.pid}-${stateWriteCounter}`;
	try {
		writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
			mode: 0o600,
		});
		renameSync(temporary, stateFile);
	} finally {
		rmSync(temporary, { force: true });
	}
	return stateFile;
}
function dailyCanaryPlan({ state, now = new Date(), force = false } = {}) {
	const day = utcDayKey(now);
	if (force) return { run: true, day, reason: "forced" };
	if (state && state.lastRunDay === day) {
		return { run: false, day, reason: "already_ran_today" };
	}
	return { run: true, day, reason: state ? "new_day" : "first_run" };
}
function canaryTransitionNotification({ state, evaluation } = {}) {
	if (!evaluation || typeof evaluation.status !== "string") return null;
	const previousStatus = state?.lastStatus ?? null;
	const notifiedStatus = state?.lastNotifiedStatus ?? null;
	if (evaluation.status === "failed") {
		if (previousStatus === "failed" && notifiedStatus === "failed") return null;
		const failing = (evaluation.results ?? [])
			.filter((result) => result?.status === "failed")
			.map((result) => result.name)
			.slice(0, 4)
			.join(", ");
		const detail = evaluation.reason ?? (failing || "unknown");
		return {
			kind: "failure",
			title: "Switchyard sandbox canary failed",
			message: `sandbox canary failed: ${detail}`.slice(0, 200),
		};
	}
	if (evaluation.status === "passed" && notifiedStatus === "failed") {
		return {
			kind: "recovery",
			title: "Switchyard sandbox canary recovered",
			message: `sandbox canary recovered: ${
				evaluation.passedCount ?? 0
			} probes passed`.slice(0, 200),
		};
	}
	return null;
}
function buildCanaryState({
	previous = null,
	evaluation,
	now = new Date(),
	notification = null,
	notificationSent = false,
} = {}) {
	const status =
		typeof evaluation?.status === "string" ? evaluation.status : "failed";
	const previousFailures = Number.isInteger(previous?.consecutiveFailures)
		? previous.consecutiveFailures
		: 0;
	let lastNotifiedStatus = previous?.lastNotifiedStatus ?? null;
	let lastNotificationKind = previous?.lastNotificationKind ?? null;
	if (notificationSent === true && notification !== null) {
		lastNotifiedStatus = status;
		lastNotificationKind = notification.kind;
	}
	return {
		version: 1,
		lastRunAt: now.toISOString(),
		lastRunDay: utcDayKey(now),
		lastStatus: status,
		lastReason: evaluation?.reason ?? null,
		passedCount: evaluation?.passedCount ?? 0,
		failedCount: evaluation?.failedCount ?? 0,
		skippedCount: evaluation?.skippedCount ?? 0,
		consecutiveFailures: status === "failed" ? previousFailures + 1 : 0,
		lastNotifiedStatus,
		lastNotificationKind,
	};
}
function findExecutable(name, { env = process.env, exists = existsSync } = {}) {
	for (const directory of String(env?.PATH ?? "").split(":")) {
		if (!directory) continue;
		const candidate = join(directory, name);
		if (exists(candidate)) return candidate;
	}
	return null;
}
export function notifyLocal({
	title,
	message,
	spawn = supervisedSpawn,
	platform = process.platform,
	env = process.env,
	timeoutMs = 5000,
	exists = existsSync,
} = {}) {
	if (platform !== "darwin") {
		return { sent: false, tool: null, error: "unsupported_platform" };
	}
	const boundTitle = String(title ?? "").slice(0, 80);
	const boundMessage = String(message ?? "").slice(0, 200);
	const notifier = findExecutable("terminal-notifier", { env, exists });
	let tool = notifier;
	let args;
	if (notifier) {
		args = ["-title", boundTitle, "-message", boundMessage];
	} else {
		tool = "/usr/bin/osascript";
		if (!exists(tool)) {
			return { sent: false, tool, error: "notification_tool_missing" };
		}
		const messageJson = JSON.stringify(boundMessage);
		const titleJson = JSON.stringify(boundTitle);
		const line = `display notification ${messageJson} with title ${titleJson}`;
		args = ["-e", line];
	}
	try {
		const result = spawn(tool, args, {
			timeout: timeoutMs,
			killSignal: "SIGKILL",
			encoding: "utf8",
			stdio: "ignore",
		});
		if (result?.error) {
			return { sent: false, tool, error: result.error.code ?? "notify_failed" };
		}
		if (result?.status !== 0) {
			return { sent: false, tool, error: `notify_exit_${result?.status}` };
		}
		return { sent: true, tool, error: null };
	} catch (err) {
		return { sent: false, tool, error: err?.message ?? "notify_threw" };
	}
}
function trimLog(path, limit = 65536) {
	if (!existsSync(path)) return;
	const content = readFileSync(path);
	if (content.length <= limit) return;
	let start = content.length - limit;
	// Keep an intact first retained record; discard only a cut record's suffix.
	if (content[start - 1] !== 10) {
		const newline = content.indexOf(10, start);
		start = newline < 0 ? content.length : newline + 1;
	}
	writeFileSync(path, content.subarray(start));
}
export function runCanaryCli({
	argv = process.argv.slice(2),
	env = process.env,
	now = () => new Date(),
	runCanary,
	stateDir,
	log = console.log,
	error = console.error,
	notify = notifyLocal,
	platform = process.platform,
	spawn = supervisedSpawn,
} = {}) {
	const force = argv.includes("--force");
	const daily = env?.[CANARY_DAILY_ENV] === "1";
	const run = runCanary;
	const safeRun = () => {
		try {
			return run();
		} catch (err) {
			const reason = `canary_crashed: ${err?.message ?? "unknown error"}`;
			error(reason);
			return {
				status: "failed",
				exitCode: 1,
				reason,
				passedCount: 0,
				failedCount: 1,
				skippedCount: 0,
				results: [],
			};
		}
	};
	if (!daily) {
		const outcome = safeRun();
		return {
			mode: "strict",
			skipped: false,
			stateFile: null,
			state: null,
			outcome,
			exitCode: outcome?.exitCode ?? 1,
		};
	}
	const resolvedStateDir = stateDir ?? canaryStateDir({ env });
	const stateFile = join(resolvedStateDir, CANARY_STATE_FILE_NAME);
	const historyFile = join(resolvedStateDir, "outcomes.log");
	mkdirSync(resolvedStateDir, { recursive: true, mode: 0o700 });
	for (const name of ["out", "err"])
		trimLog(
			join(
				env.HOME ?? homedir(),
				"Library/Logs",
				`switchyard-sandbox-canary.launchd.${name}.log`,
			),
		);
	trimLog(historyFile);
	const { state, error: readError } = readCanaryState(stateFile);
	if (readError) {
		error(`warning: ${readError} at ${stateFile}; treating as first run`);
	}
	const plan = dailyCanaryPlan({ state, now: now(), force });
	if (!plan.run) {
		log(`sandbox canary already ran for ${plan.day}; skipping (daily dedupe)`);
		return {
			mode: "daily",
			day: plan.day,
			skipped: true,
			skipReason: plan.reason,
			stateFile,
			state,
			outcome: null,
			exitCode: 0,
		};
	}
	const outcome = safeRun();
	const notification = canaryTransitionNotification({
		state,
		evaluation: outcome,
	});
	let notificationSent = false;
	if (notification) {
		log(`sending local ${notification.kind} notification...`);
		const result = notify({
			title: notification.title,
			message: notification.message,
			env,
			platform,
			spawn,
		});
		notificationSent = result?.sent === true;
		if (!notificationSent) {
			error(
				`warning: ${notification.kind} notification not sent (${
					result?.error ?? "unknown"
				})`,
			);
		}
	}
	const nextState = buildCanaryState({
		previous: state,
		evaluation: outcome,
		now: now(),
		notification,
		notificationSent,
	});
	try {
		writeCanaryState(stateFile, nextState);
		appendFileSync(historyFile, `${JSON.stringify(nextState)}\n`, {
			mode: 0o600,
		});
		trimLog(historyFile);
	} catch (err) {
		outcome.exitCode = 1;
		error(
			`warning: could not persist canary state at ${stateFile} (${
				err?.message ?? "unknown error"
			})`,
		);
	}
	return {
		mode: "daily",
		day: plan.day,
		skipped: false,
		skipReason: null,
		notification: notification
			? { ...notification, sent: notificationSent }
			: null,
		stateFile,
		state: nextState,
		outcome,
		exitCode: outcome?.exitCode ?? 1,
	};
}
