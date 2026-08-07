import { execFileSync } from "node:child_process";
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";
import { PROVIDER_EXECUTION_TIMEOUT_MS } from "./constants.mjs";
import { describeExecError } from "./exec-error.mjs";
import { validateAdapterInvocation } from "./invocation.mjs";
import {
	killOrphanedProcesses,
	killOrphanedProcessesAsync,
} from "./orphan-kill.mjs";
import { addProviderPromptGuardrail } from "./prompt-guardrails.mjs";
import {
	captureProviderDiffAsync,
	executeProviderInvocation,
} from "./provider-lifecycle.mjs";
import { validateIdentifier, validateModelArg } from "./shell-safety.mjs";

const OPENCODE_CMD = "opencode";
const CREDENTIALS_PATH = "/root/.local/share/opencode/auth.json";
const MIN_CREDENTIAL_BYTES = 16;

// `opencode run` starts an in-process local server (see its own `run --help`:
// `--port` "port for the local server", `--attach` "attach to a running
// opencode server") and never shuts it down, so the CLI parks in futex_wait
// after finishing the task. There is no one-shot/`--exit` flag. Because the
// lingering process holds `docker exec`'s stdout pipe as fd 1, the host never
// observes EOF and NO host-side deadline can shorten the wait — the pipe stays
// open until something inside the container kills the process. Upstream:
// anomalyco/opencode#17516 (open, no maintainer response) and #32335 (the
// non-exiting process retains 90-400 MB RSS per job).
//
// So the bound has to be enforced container-side. OPENCODE_SUPERVISOR runs
// opencode as a background child, watches its captured output for quiescence,
// and terminates it once it has gone silent for `idle` seconds. The wrapper
// then closes the pipe by exiting, which is what actually unblocks the host.
const IDLE_EXIT_CODE = 75;
const DEFAULT_IDLE_SECONDS = 60;
const MIN_IDLE_SECONDS = 5;
const MAX_IDLE_SECONDS = 3600;
const MAX_IDLE_STDERR_CHARS = 4000;
const IDLE_TERMINATION_NOTE =
	"[switchyard] opencode stopped producing output and did not exit; " +
	"terminated by the container-side idle bound and the working tree was " +
	"captured as-is (upstream anomalyco/opencode#17516).";

// Invoked as: sh -c <script> sh <idleSeconds> opencode run [args...] <prompt>
// The prompt and every provider argument arrive as positional parameters and
// are never interpolated into this text, so no caller-controlled string is ever
// parsed as shell source.
const OPENCODE_SUPERVISOR = `set -u
idle=$1
shift
cmd=$1
base=/tmp/switchyard-opencode.$$
out=$base.out
err=$base.err
: >"$out"
: >"$err"
"$@" >"$out" 2>"$err" &
pid=$!
last=0
quiet=0
elapsed=0
killed=0
while :; do
	st=$(awk '/^State:/{print $2}' "/proc/$pid/status" 2>/dev/null)
	if [ -z "$st" ] || [ "$st" = Z ]; then
		break
	fi
	osize=$(wc -c <"$out")
	size=$(( osize + $(wc -c <"$err") ))
	if [ "$size" -ne "$last" ]; then
		last=$size
		quiet=0
	else
		quiet=$(( quiet + 1 ))
	fi
	# Either stream counts as activity, but only stdout qualifies the run as
	# having produced a result. opencode writes progress to stderr and its answer
	# to stdout, so a stderr-only run that then goes silent has not finished
	# anything — it is left to the host deadline, which classifies it as a
	# timeout instead of booking it as a success.
	if [ "$osize" -gt 0 ] && [ "$quiet" -ge "$idle" ]; then
		killed=1
		break
	fi
	elapsed=$(( elapsed + 1 ))
	if [ $(( elapsed % 15 )) -eq 0 ]; then
		printf 'switchyard: opencode alive %ss, %s bytes captured, %ss idle\\n' "$elapsed" "$last" "$quiet" >&2
	fi
	sleep 1
done
if [ "$killed" -eq 1 ]; then
	kill -TERM "$pid" 2>/dev/null
	i=0
	while [ "$i" -lt 5 ]; do
		st=$(awk '/^State:/{print $2}' "/proc/$pid/status" 2>/dev/null)
		if [ -z "$st" ] || [ "$st" = Z ]; then
			break
		fi
		sleep 1
		i=$(( i + 1 ))
	done
	kill -KILL "$pid" 2>/dev/null
	wait "$pid" 2>/dev/null
	swept=0
	for p in /proc/[0-9]*; do
		q=$(basename "$p")
		if [ "$q" = "$$" ] || [ "$q" = 1 ]; then
			continue
		fi
		a0=$(tr '\\0' '\\n' <"$p/cmdline" 2>/dev/null | head -n 1)
		if [ -z "$a0" ]; then
			continue
		fi
		if [ "$(basename "$a0")" = "$cmd" ]; then
			kill -KILL "$q" 2>/dev/null
			swept=$(( swept + 1 ))
		fi
	done
	if [ "$swept" -gt 0 ]; then
		printf 'switchyard: swept %s surviving %s process(es)\\n' "$swept" "$cmd" >&2
	fi
	rc=${IDLE_EXIT_CODE}
else
	wait "$pid" 2>/dev/null
	rc=$?
fi
cat "$out"
cat "$err" >&2
rm -f "$out" "$err"
exit "$rc"
`;

/**
 * Seconds of provider silence that count as "finished but not exited".
 * Overridable per run via SWITCHYARD_OPENCODE_IDLE_SECONDS; any malformed or
 * out-of-range value falls back to the default rather than failing the
 * dispatch, and the value is digits-only so it is safe as argv.
 */
function resolveIdleSeconds(env = process.env) {
	const raw = env.SWITCHYARD_OPENCODE_IDLE_SECONDS;
	if (typeof raw !== "string" || !/^\d+$/u.test(raw)) {
		return DEFAULT_IDLE_SECONDS;
	}
	const parsed = Number.parseInt(raw, 10);
	if (parsed < MIN_IDLE_SECONDS || parsed > MAX_IDLE_SECONDS) {
		return DEFAULT_IDLE_SECONDS;
	}
	return parsed;
}

/**
 * Build the `docker exec` argv for a supervised `opencode run`. Throws on any
 * argument that fails the shared shell-safety checks so both the sync and async
 * entry points reject identically.
 */
function buildSupervisedArgs(
	workingContainerName,
	invocationArgs,
	model,
	guardedPrompt,
) {
	validateIdentifier(workingContainerName, "workingContainerName");
	const args = [
		"exec",
		"-i",
		"-w",
		"/project",
		workingContainerName,
		"sh",
		"-c",
		OPENCODE_SUPERVISOR,
		"sh",
		String(resolveIdleSeconds()),
		OPENCODE_CMD,
		"run",
		// OpenCode variant argv is forwarded verbatim immediately after the
		// `run` subcommand and before the model selector.
		...invocationArgs,
	];
	if (model) {
		validateModelArg(model, "model");
		args.push("--model", model);
	}
	// `opencode run` consumes the task message as a positional argument.
	args.push(guardedPrompt);
	return args;
}

/**
 * Keep the idle-termination reason in the durable provider transcript, along
 * with whatever the provider wrote to stderr. Stderr is normally dropped on a
 * successful exit, but an idle-terminated run reports success without the
 * provider ever having said it was finished — so its own diagnostics are the
 * only evidence of what it actually did, and discarding them would leave a
 * "completed" record that cannot be explained after the fact.
 */
function annotateIdleTermination(output, stderr) {
	const parts = [];
	const body = typeof output === "string" ? output : "";
	if (body !== "") parts.push(body.endsWith("\n") ? body.slice(0, -1) : body);
	parts.push(IDLE_TERMINATION_NOTE);
	// The supervisor's own heartbeat shares fd 2 with the provider; strip it so
	// the recorded diagnostic is the provider's words only.
	const diagnostic = (typeof stderr === "string" ? stderr : "")
		.split("\n")
		.filter((line) => !line.startsWith("switchyard: "))
		.join("\n")
		.trim();
	if (diagnostic !== "") {
		const bounded =
			diagnostic.length > MAX_IDLE_STDERR_CHARS
				? `${diagnostic.slice(0, MAX_IDLE_STDERR_CHARS)}… (truncated)`
				: diagnostic;
		parts.push(`[switchyard] provider stderr at termination:\n${bounded}`);
	}
	return `${parts.join("\n")}\n`;
}

function hasNonTrivialCredential(containerName) {
	try {
		execFileSync(
			"docker",
			[
				"exec",
				containerName,
				"sh",
				"-c",
				`[ -f ${CREDENTIALS_PATH} ] && [ "$(wc -c < ${CREDENTIALS_PATH} | tr -d '[:space:]')" -ge ${MIN_CREDENTIAL_BYTES} ]`,
			],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return true;
	} catch {
		return false;
	}
}

export function isOpencodeAuthenticated(containerName = AGENT_CONTAINER_NAME) {
	try {
		execFileSync("docker", ["exec", containerName, OPENCODE_CMD, "--version"], {
			encoding: "utf8",
			stdio: "pipe",
		});
	} catch {
		return false;
	}
	return hasNonTrivialCredential(containerName);
}

export function execute(prompt, workingContainerName, options = {}) {
	const { model, timeoutMs = PROVIDER_EXECUTION_TIMEOUT_MS } = options;
	const guardedPrompt = addProviderPromptGuardrail(prompt);

	let args;
	try {
		// Validated ahead of the descriptor so an unsafe container name is still
		// reported first, as it was before the supervisor wrapper.
		validateIdentifier(workingContainerName, "workingContainerName");
		const invocationArgs = validateAdapterInvocation(options, {
			expectedHarness: "opencode",
			expectedTargetId: options.resolvedTargetId,
			expectedModel: model,
		});
		args = buildSupervisedArgs(
			workingContainerName,
			invocationArgs,
			model,
			guardedPrompt,
		);
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}

	try {
		const result = execFileSync("docker", args, {
			input: guardedPrompt,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: timeoutMs,
			maxBuffer: 128 * 1024 * 1024, // 128 MB
		});

		return { output: result, success: true };
	} catch (error) {
		// The supervisor terminated a finished-but-not-exiting provider. The work
		// is already in the working tree, so this is a success for the runner and
		// the diff still goes through the integration gate like any other.
		if (error.status === IDLE_EXIT_CODE) {
			return {
				output: annotateIdleTermination(error.stdout, error.stderr),
				success: true,
				idleTerminated: true,
			};
		}
		const timedOut = error.code === "ETIMEDOUT";
		if (timedOut) {
			killOrphanedProcesses(workingContainerName);
			// Keep error.message (carries ETIMEDOUT) so the runner classifies
			// this as execution_timed_out, not a generic failure.
			return {
				output: error.stdout || "",
				success: false,
				error: error.message,
				timedOut,
			};
		}
		// Non-timeout failure: surface the provider's own diagnostic (and, on an
		// expired session, an actionable re-auth hint) instead of Node's opaque
		// "Command failed: docker exec …" wrapper — see exec-error.mjs.
		const described = describeExecError(error, { provider: "opencode" });
		return {
			output: described.output,
			success: false,
			error: described.error,
			errorKind: described.errorKind,
			timedOut,
		};
	}
}

/** Async counterpart used by non-blocking queue workers. */
export async function executeAsync(prompt, workingContainerName, options = {}) {
	const {
		model,
		timeoutMs = PROVIDER_EXECUTION_TIMEOUT_MS,
		signal,
		onPoll,
	} = options;
	const guardedPrompt = addProviderPromptGuardrail(prompt);
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
		const invocationArgs = validateAdapterInvocation(options, {
			expectedHarness: "opencode",
			expectedTargetId: options.resolvedTargetId,
			expectedModel: model,
		});
		const args = buildSupervisedArgs(
			workingContainerName,
			invocationArgs,
			model,
			guardedPrompt,
		);
		const result = await executeProviderInvocation("docker", args, {
			...options,
			provider: "opencode",
			input: guardedPrompt,
			timeoutMs,
			signal,
			onPoll,
			idleExitCode: IDLE_EXIT_CODE,
			cleanup: () => killOrphanedProcessesAsync(workingContainerName),
		});
		if (!result.idleTerminated) return result;
		const { stderr, ...rest } = result;
		return {
			...rest,
			output: annotateIdleTermination(result.output, stderr),
		};
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}
}

export function captureDiff(workingContainerName) {
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch {
		return null;
	}
	try {
		execFileSync(
			"docker",
			["exec", "-w", "/project", workingContainerName, "git", "add", "-A"],
			{ stdio: "pipe" },
		);
		const diff = execFileSync(
			"docker",
			[
				"exec",
				"-w",
				"/project",
				workingContainerName,
				"git",
				"diff",
				"--cached",
				"HEAD",
			],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return /\S/u.test(diff) ? diff : null;
	} catch {
		return null;
	}
}

export function captureDiffAsync(workingContainerName, options = {}) {
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch {
		return Promise.resolve(null);
	}
	return captureProviderDiffAsync(workingContainerName, options);
}
