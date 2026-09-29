import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
	captureDirtyOverlay,
	ignoredPath,
	readDirtyOverlayReceipt,
	validateDirtyOverlayReceipt,
	writeDirtyOverlayReceipt,
} from "../lifecycle/index.mjs";
import { getStateRoot, readRun } from "../run-store/index.mjs";
import { classifyRunLiveness } from "../run-store/run-liveness.mjs";
import {
	computeQueueIdentityFromFile,
	getCheckpointPath,
	getProjectRevision,
	normalizeRunOptions,
} from "../runner/index.mjs";
import { shellQuote } from "./cli-args.mjs";
import { UsageError } from "./cli-usage.mjs";
import { projectDisposition } from "./disposition.mjs";
import {
	recoveryCommandFor,
	remediationCommandFor,
} from "./status-envelope.mjs";

const RENEWAL_TIMEOUT_MS = 30_000;
function renewDispatchReceipts(checkpointPath, report) {
	if (!checkpointPath) return;
	const cli = resolve(homedir(), ".agent", "bin", "roster");
	if (!existsSync(cli)) return;
	const renewal = spawnSync(cli, ["renew", checkpointPath], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: RENEWAL_TIMEOUT_MS,
	});
	if (renewal.status !== 0) {
		const detail = (renewal.stderr || renewal.stdout || "")
			.trim()
			.split("\n")
			.pop();
		report(
			`dispatch: receipt renewal skipped (${detail || "roster renew failed"})`,
		);
		return;
	}
	for (const line of (renewal.stdout || "").trim().split("\n")) {
		if (line.startsWith("renewed")) report(`dispatch: ${line}`);
	}
}
function captureHostFingerprint(projectPath) {
	let head = "";
	let dirty = "unknown";
	try {
		const headResult = spawnSync("git", ["rev-parse", "HEAD"], {
			cwd: projectPath,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (headResult.status === 0) {
			head = headResult.stdout.trim();
		}
		const statusArgs = ["status", "--porcelain", "--untracked-files=all"];
		const relativeStateRoot = relative(
			resolve(projectPath),
			resolve(getStateRoot()),
		);
		if (
			relativeStateRoot &&
			!isAbsolute(relativeStateRoot) &&
			!relativeStateRoot.startsWith(`..${sep}`)
		) {
			statusArgs.push("--", ".", `:(exclude)${relativeStateRoot}/**`);
		}
		const statusResult = spawnSync("git", statusArgs, {
			cwd: projectPath,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (statusResult.status === 0) {
			dirty = statusResult.stdout.trim().length > 0 ? "dirty" : "clean";
		}
	} catch {
		// git unavailable — fingerprint degrades to no-git sentinel
	}
	return `git:${head || "no-head"}:${dirty}`;
}
function prepareRunIdentity(opts) {
	const checkpointPath =
		opts.checkpointPath ?? getCheckpointPath(opts.tasksFilePath);
	const runOptions = normalizeRunOptions({
		maxTasks: opts.maxTasks,
		checkpointPath,
		stopOnFailure: opts.stopOnFailure,
		onlyProviders: opts.onlyProviders,
		excludeProviders: opts.excludeProviders,
		taskIds: opts.taskIds,
		platform: opts.platform,
		dirtyOverlay: opts.dirtyOverlay,
		qualificationAttempt: opts.qualificationAttempt,
		dirtyOverlayReceiptPath: opts.dirtyOverlayReceiptPath,
		dirtyOverlayReceiptHash: opts.dirtyOverlayReceiptPath
			? readDirtyOverlayReceipt(opts.dirtyOverlayReceiptPath).receiptHash
			: null,
	});
	const projectRevision = getProjectRevision(opts.projectPath);
	const { queueIdentity } = computeQueueIdentityFromFile(
		opts.tasksFilePath,
		projectRevision,
		runOptions,
	);
	return { checkpointPath, projectRevision, runOptions, queueIdentity };
}
function relativeWithin(projectPath, path) {
	const root = realpathSafe(resolve(projectPath));
	const target = resolve(path);
	const parent = realpathSafe(dirname(target));
	const resolved = join(parent, basename(target));
	if (resolved === root) return ".";
	if (!resolved.startsWith(`${root}${sep}`)) return null;
	return relative(root, resolved);
}
function realpathSafe(path) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
function prepareDispatchDirtyOverlay(opts, tasks) {
	if (opts.dirtyOverlay !== true) return;
	const checkpointPath =
		opts.checkpointPath ?? getCheckpointPath(opts.tasksFilePath);
	const receiptPath =
		opts.dirtyOverlayReceiptPath ?? `${checkpointPath}.dirty-overlay.json`;
	// A single undeclared task is enough to reach provider allocation inside a
	// workspace seeded with overlay bytes it never scoped, so every task in the
	// queue declares its own paths — an aggregate that happens to be non-empty
	// because some other task declared is not sufficient.
	const undeclared = tasks.find(
		(task) => (task.requiredPaths ?? []).length === 0,
	);
	if (undeclared)
		throw new UsageError(
			`dirty overlay requires exact declared task paths: task ${undeclared.id} declares none`,
		);
	const paths = [...new Set(tasks.flatMap((task) => task.requiredPaths ?? []))];
	if (paths.length === 0)
		throw new UsageError("dirty overlay requires exact declared task paths");
	// The checkpoint and receipt are written during the run. Left unignored
	// inside the project they become untracked strays that the capture's own
	// scope check refuses, so a launch that succeeded would fail every task on
	// revalidation. Refuse here, before either file exists.
	for (const path of [checkpointPath, receiptPath]) {
		const relativePath = relativeWithin(opts.projectPath, path);
		if (relativePath !== null && !ignoredPath(opts.projectPath, relativePath))
			throw new UsageError(
				`dirty overlay checkpoint and receipt must live outside the project or be ignored by it: ${relativePath}`,
			);
	}
	if (existsSync(receiptPath)) {
		let receipt;
		try {
			receipt = readDirtyOverlayReceipt(receiptPath);
		} catch (error) {
			throw new UsageError(`dirty overlay receipt rejected: ${error.message}`);
		}
		// Publication is create-only, so a receipt left over from an earlier
		// capture is reused as-is. Revalidate here: `launch` would otherwise mint
		// identity from a stale hash, exit 0, and hand the detached worker a
		// receipt it rejects — a successful launch followed by a failed run.
		const validated = validateDirtyOverlayReceipt(
			opts.projectPath,
			receipt,
			paths,
		);
		if (!validated.ok)
			throw new UsageError(
				`dirty overlay receipt rejected: ${validated.reason}; remove ${receiptPath} to recapture`,
			);
	} else {
		const receipt = captureDirtyOverlay(opts.projectPath, paths);
		writeDirtyOverlayReceipt(receiptPath, receipt);
	}
	opts.dirtyOverlayReceiptPath = receiptPath;
}
function resolveBootstrapPath() {
	return fileURLToPath(new URL("./worker-bootstrap.mjs", import.meta.url));
}
function launchCommands(runId, stateRoot) {
	return {
		statusCommand: `switchyard-dispatch status ${runId} --state-root ${shellQuote(stateRoot)}`,
		resultCommand: `switchyard-dispatch result ${runId} --state-root ${shellQuote(stateRoot)}`,
	};
}
async function buildLaunchFailureEnvelope(context) {
	const {
		runId = null,
		stateRoot = null,
		preInitialization = null,
		preflightDetail = null,
	} = context;
	let run = null;
	if (runId !== null) {
		try {
			run = await readRun(runId);
		} catch {
			// Commands and durable identity are emitted only after this read proves
			// the target actually resolves in the selected state root.
		}
	}
	const durable = run !== null && stateRoot !== null;
	const recoveryTarget =
		preInitialization?.type === "lock_conflict"
			? preInitialization.holderRunId
			: runId;
	const disposition = projectDisposition({
		...(preInitialization ? { preInitialization } : { run }),
		...(durable && recoveryTarget
			? { recoveryCommand: recoveryCommandFor(recoveryTarget) }
			: {}),
		...(durable ? { remediationCommand: remediationCommandFor() } : {}),
		...(run ? { liveness: classifyRunLiveness(run) } : {}),
	});
	return {
		schemaVersion: run?.schemaVersion ?? 2,
		runId: durable ? runId : null,
		state: run?.state ?? "failed",
		queueIdentity: run?.queueIdentity ?? null,
		...(preflightDetail ? { preflightDetail } : {}),
		stateRoot: durable ? stateRoot : null,
		...(durable
			? launchCommands(runId, stateRoot)
			: { statusCommand: null, resultCommand: null }),
		disposition,
	};
}

export {
	buildLaunchFailureEnvelope,
	captureHostFingerprint,
	launchCommands,
	prepareDispatchDirtyOverlay,
	prepareRunIdentity,
	relativeWithin,
	renewDispatchReceipts,
	resolveBootstrapPath,
};
