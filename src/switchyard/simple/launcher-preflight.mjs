import { lstatSync, unlinkSync } from "node:fs";
import { runProviderProcess } from "../adapter/provider-lifecycle.mjs";
import { createBridgeRequestRecorder } from "./request-evidence.mjs";

const GUARDED_TARGETS = new Set([
	"vibe",
	"vibe-code",
	"opencode-go",
	"claude-code",
]);

function interruptionReason(signal, deadlineMs, now, result) {
	return signal?.aborted || result?.cancelled
		? "provider_cancelled"
		: deadlineMs <= now()
			? "deadline_expired"
			: null;
}

function unavailable(
	probeWriterLifecycle = "never_started",
	failureReason = "launcher_environment_unavailable",
) {
	return {
		success: false,
		failureReason,
		providerStarted: false,
		writerLifecycle: "never_started",
		probeWriterLifecycle,
	};
}

/** Probe only the fixed harmless launcher capability, never provider text. */
export async function probeSimpleLauncher({
	targetId,
	deadlineMs,
	now = Date.now,
	signal,
	onProgress,
	runProbe = runProviderProcess,
}) {
	if (!GUARDED_TARGETS.has(targetId))
		return { success: true, probeWriterLifecycle: "never_started" };
	onProgress?.();
	const budget = Math.min(5_000, Math.max(0, deadlineMs - now()));
	if (signal?.aborted || budget <= 0)
		return unavailable(
			"never_started",
			interruptionReason(signal, deadlineMs, now),
		);
	let result;
	try {
		const grace = Math.min(250, Math.floor(budget / 2));
		result = await runProbe(
			"/usr/bin/sandbox-exec",
			["-p", "(version 1)(allow default)", "/usr/bin/true"],
			{
				timeoutMs: budget - grace,
				termGraceMs: grace,
				pollIntervalMs: Math.min(250, budget),
				maxBuffer: 1_024,
				env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
				signal,
				onPoll: onProgress,
			},
		);
	} catch {
		// A thrown runner does not prove whether it launched a child.
		return unavailable(
			"unavailable",
			interruptionReason(signal, deadlineMs, now) ??
				"launcher_environment_unavailable",
		);
	}
	onProgress?.();
	const lifecycle = ["stopped", "never_started"].includes(
		result?.writerLifecycle,
	)
		? result.writerLifecycle
		: "unavailable";
	return result?.success === true &&
		lifecycle === "stopped" &&
		!signal?.aborted &&
		deadlineMs > now()
		? { success: true, probeWriterLifecycle: lifecycle }
		: unavailable(
				lifecycle,
				interruptionReason(signal, deadlineMs, now, result) ??
					"launcher_environment_unavailable",
			);
}

/** Admission order is probe, recorder readiness, then the health start fence. */
export async function prepareSimpleProviderStart({
	targetId,
	deadlineMs,
	now,
	signal,
	onProgress,
	probe = probeSimpleLauncher,
	runProbe,
	healthController,
	recorderPath = null,
	createRecorder = createBridgeRequestRecorder,
}) {
	const admission = await probe({
		targetId,
		deadlineMs,
		now,
		signal,
		onProgress,
		...(runProbe ? { runProbe } : {}),
	});
	if (!admission.success) return admission;
	let recorder = null;
	let identity = null;
	try {
		if (recorderPath) {
			recorder = createRecorder(recorderPath);
			identity = lstatSync(recorderPath);
		}
	} catch {
		recorder?.close();
		return {
			...unavailable(admission.probeWriterLifecycle),
			failureReason: "request_log_open_failed",
		};
	}
	let discarded = false;
	const discardUnstarted = () => {
		if (!recorder || discarded) return true;
		const closed = recorder.close();
		try {
			const current = lstatSync(recorderPath);
			if (
				closed.count !== 0 ||
				![null, "request_event_end_missing"].includes(closed.error) ||
				!identity?.isFile() ||
				!current.isFile() ||
				current.nlink !== 1 ||
				current.size !== 0 ||
				current.dev !== identity.dev ||
				current.ino !== identity.ino
			)
				return false;
			unlinkSync(recorderPath);
			discarded = true;
			return true;
		} catch {
			return false;
		}
	};
	const recorderInterruption = interruptionReason(
		signal,
		deadlineMs,
		now ?? Date.now,
	);
	if (recorderInterruption) {
		const clean = discardUnstarted();
		return {
			...unavailable(admission.probeWriterLifecycle, recorderInterruption),
			cleanupUnavailable: !clean,
		};
	}
	let healthStart;
	try {
		healthStart = await healthController.start({ deferProviderStart: true });
	} catch (error) {
		try {
			await healthController.cancelUnstarted?.();
		} finally {
			discardUnstarted();
		}
		throw error;
	}
	if (!healthStart.allowed && !discardUnstarted())
		return {
			...unavailable(admission.probeWriterLifecycle),
			failureReason: "request_log_open_failed",
		};
	const cancelUnstarted = async () => {
		let released = false;
		try {
			released =
				(await healthController.cancelUnstarted?.(healthStart))?.released !==
				false;
		} catch {
			/* Unconfirmed claim release is retained, never provider blame. */
		}
		return discardUnstarted() && released;
	};
	const interruption = signal?.aborted
		? "provider_cancelled"
		: deadlineMs <= (now ?? Date.now)()
			? "deadline_expired"
			: null;
	if (interruption) {
		const clean = await cancelUnstarted();
		return {
			...unavailable(admission.probeWriterLifecycle),
			failureReason: interruption,
			cleanupUnavailable: !clean,
		};
	}
	return {
		success: true,
		probeWriterLifecycle: admission.probeWriterLifecycle,
		healthStart,
		recorder,
		cancelUnstarted,
		startPrepared: () =>
			healthController.startPrepared?.(healthStart) ?? healthStart,
	};
}
