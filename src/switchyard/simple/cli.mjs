import { parseSimpleArgs, SIMPLE_USAGE, SimpleUsageError } from "./args.mjs";
import { runSimpleTask } from "./index.mjs";
import { recoveryUnavailable } from "./recovery.mjs";
import { runSimpleRoutingTask } from "./routing-run.mjs";
export async function handleSimple(argv, dependencies = {}) {
	const now = dependencies.now ?? Date.now;
	const startedAt = now();
	const signalProcess = dependencies.signalProcess ?? process;
	const abortController = new AbortController();
	let receivedSignal = null;
	let integrationStarted = false;
	let signalDuringIntegration = false;
	const reportStatus =
		dependencies.onStatus ??
		((event) =>
			console.error(
				`dispatch: simple task=${event.taskId} phase=${event.phase}${event.milestone ? ` milestone=${event.milestone}` : ""}${event.checkIndex ? ` check=${event.checkIndex}` : ""}`,
			));
	const onInterrupt = (signal) => {
		if (receivedSignal !== null) return;
		receivedSignal = signal;
		if (integrationStarted) {
			signalDuringIntegration = true;
			try {
				console.error(
					`dispatch: simple received ${signal} during integration; waiting for it to finish`,
				);
			} catch {}
		}
		abortController.abort(signal);
	};
	const onSigint = () => onInterrupt("SIGINT");
	const onSigterm = () => onInterrupt("SIGTERM");
	signalProcess.on("SIGINT", onSigint);
	signalProcess.on("SIGTERM", onSigterm);
	let result;
	try {
		try {
			const options = parseSimpleArgs(argv, { now });
			if (options.help) {
				console.log(SIMPLE_USAGE);
				return;
			}
			options.routingRunIdSource = argv.some(
				(arg) =>
					arg === "--routing-run-id" || arg.startsWith("--routing-run-id="),
			)
				? "flag"
				: options.routingRunId !== null
					? "environment"
					: "generated";
			const routing = await runSimpleRoutingTask(options, {
				...dependencies,
				onRoutingWarning: dependencies.writeWarning ?? console.error,
				now,
				signal: abortController.signal,
				runSimpleTask: dependencies.runSimpleTask ?? runSimpleTask,
				onStatus: (event) => {
					if (event.milestone === "integration_started")
						integrationStarted = true;
					else if (event.milestone === "integration_completed")
						integrationStarted = false;
					reportStatus(event);
				},
			});
			const deferred = ["native_required", "native_latched", "defer"].includes(
				routing.direction,
			);
			result = {
				...(routing.result ?? {
					schemaVersion: 1,
					taskId: null,
					provider: null,
					targetId: null,
					elapsedMs: Math.max(0, now() - startedAt),
					changedFiles: [],
					checks: [],
					partialWorktree: null,
					recovery: recoveryUnavailable(),
				}),
				status: deferred
					? "deferred"
					: routing.direction === "complete"
						? "succeeded"
						: "failed",
				failureReason:
					deferred && routing.direction !== "defer"
						? routing.direction
						: (routing.result?.failureReason ?? routing.stopReason),
				routingRunId: routing.routingRunId,
				routingRunIdSource: routing.routingRunIdSource,
				direction: routing.direction,
				attempts: routing.attempts,
				failedTargetIds: routing.failedTargetIds,
			};
		} catch (error) {
			result = {
				schemaVersion: 1,
				taskId: null,
				status: "failed",
				provider: null,
				targetId: null,
				elapsedMs: Math.max(0, now() - startedAt),
				changedFiles: [],
				checks: [],
				failureReason:
					error instanceof SimpleUsageError
						? "invalid_invocation"
						: "preflight_failed",
				failurePhase: "preflight",
				errorKind:
					error instanceof SimpleUsageError
						? "validation_failed"
						: "unclassified_failure",
				partialWorktree: null,
				recovery: recoveryUnavailable(),
			};
		}
		(dependencies.writeResult ?? console.log)(JSON.stringify(result));
		if (
			receivedSignal !== null &&
			!(signalDuringIntegration && result?.status !== "succeeded")
		) {
			signalProcess.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
		} else if (result.status === "deferred") {
			signalProcess.exitCode = 6;
		} else if (result.status !== "succeeded") {
			signalProcess.exitCode =
				result.failureReason === "invalid_invocation" ? 2 : 1;
		}
	} finally {
		signalProcess.removeListener("SIGINT", onSigint);
		signalProcess.removeListener("SIGTERM", onSigterm);
	}
}
