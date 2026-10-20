import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { PERSISTED_SIGNALS } from "../adapter/exec-error-kinds.mjs";
import { classifyFailedCheck } from "./check-environment.mjs";
import { aggregateWriterLifecycle } from "./recovery.mjs";

/** Longest a single pre-provider check may run, however much deadline remains. */
export const DRY_RUN_CHECK_CAP_MS = 120_000;

const SETTLED_LIFECYCLES = new Set(["stopped", "never_started"]);

// Same identity as baseline.mjs: sha256 hex of the command text.
const checkIdentityOf = (command) =>
	createHash("sha256").update(command).digest("hex");

// Shells whose first argument is the script they run. A shell exits 127 for a
// missing script file; node and python exit 1 and 2, so a 127 from them means
// the interpreter itself is missing and is never exempted.
const SCRIPT_SHELLS = new Set(["sh", "bash", "zsh"]);
// A plain command: words of path-safe characters only, so no quoting, expansion,
// redirection, or command separator can hide what actually ran.
const PLAIN_COMMAND = /^[A-Za-z0-9._/@:+=,%\- ]+$/u;

/** Repo-relative form of `path` (leading `./` dropped), or null if it is not one. */
function relativeForm(path) {
	let relative = path;
	while (relative.startsWith("./")) relative = relative.slice(2);
	return !relative ||
		relative.startsWith("-") ||
		relative.startsWith("/") ||
		relative.split("/").some((segment) => segment === ".." || !segment)
		? null
		: relative;
}

/**
 * The repo-relative script a plain check command runs: argv[0] when it is a
 * relative path (`./x.sh`, `tests/x.sh`), or argv[1] when argv[0] is a shell
 * (`bash x.sh`). Null for anything else,
 * including a command with shell syntax or a leading environment assignment.
 */
function scriptRunBy(command) {
	if (!PLAIN_COMMAND.test(command)) return null;
	const [head, next] = command.trim().split(/ +/u);
	// A first word with `=` may be an environment assignment (`NAME=v`,
	// `NAME+=v`), so the command that runs comes after it.
	if (head.includes("=")) return null;
	if (SCRIPT_SHELLS.has(head))
		return next === undefined ? null : relativeForm(next);
	return head.includes("/") ? relativeForm(head) : null;
}

/**
 * A `tool_missing` failure is expected, not an environment fault, when the
 * check runs a script the task itself declares and that script does not exist
 * in the base tree yet.
 */
function runsNewDeclaredScript(command, declaredPaths, pathExistsAtBase) {
	const script = scriptRunBy(command);
	return (
		script !== null &&
		declaredPaths.some((declared) => relativeForm(declared) === script) &&
		!pathExistsAtBase(script)
	);
}

/**
 * Whether a repo-relative path exists in the checkout at `root`. Only a
 * definite absence (ENOENT or ENOTDIR) reports false, so an unreadable path
 * keeps the stop.
 *
 * @param {string} root
 * @returns {(path: string) => boolean}
 */
export const existsInCheckout = (root) => (path) => {
	try {
		lstatSync(join(root, path));
		return true;
	} catch (error) {
		return !["ENOENT", "ENOTDIR"].includes(error?.code);
	}
};

/**
 * Run the acceptance checks once against the base tree, before any provider
 * starts, to catch a check that cannot run here at all.
 *
 * Only a classified environment failure (see `classifyFailedCheck`) stops the
 * attempt. A check that fails for any other reason, or times out, is expected
 * on an unmodified tree and the run proceeds. A `tool_missing` failure of a
 * plain command that runs a declared output path absent from the base tree
 * (`bash tests/new-test.sh` before the task creates it) is such a plain
 * failure too. This is not a baseline run: it does not require a clean tree
 * and never decides acceptance.
 *
 * Statuses: `passed` (all ran; `redAtBaseline` lists, ascending, the 1-based
 * index of every check that ran to completion and failed plainly on the
 * unmodified tree, so a timeout is not recorded; empty when all passed),
 * `environment_failed` (first classified check, with `checkIndex`, `checkIdentity`, `signature`, `outputPath`, `exitCode`,
 * `signal`, any `sandboxDeniedPath` the failed check named, and — when the
 * caller resolved them — `checkExecutable` and `hostExecutable`), `cancelled`, `deadline_expired` (stopped early; the
 * engine's own deadline fences fail the run in their phase), `unconfirmed` (a
 * check left its process group unsettled; the caller's session removal rejects
 * it).
 *
 * @param {object} options
 * @param {string[]} options.checks Acceptance check commands, in order.
 * @param {Function} options.runCheck Session `runCheck` (writes check evidence on
 *   failure). Called with `testBaseline: true`, so a red test-runner check's
 *   per-test results become its differential acceptance baseline.
 * @param {string[]} [options.declaredPaths] The task's declared output paths.
 * @param {(path: string) => boolean} [options.pathExistsAtBase] Whether a
 *   repo-relative path exists in the base tree; the default reports every path
 *   present, so no failure is exempted.
 * @param {Function} [options.resolveCheckExecutables] Resolves a check command
 *   to its sandbox and host executables; null/omitted skips the comparison.
 * @param {number} options.deadlineMs Absolute deadline, ms since epoch.
 * @param {Function} [options.now]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.capMs] Per-check cap; tests inject a smaller one.
 * @param {Function} [options.onProgress] Called with `{event, checkIndex,
 *   checkIdentity, checkStatus?}`; `*_progress` events are heartbeats.
 * @returns {Promise<object>}
 */
export async function dryRunAcceptanceChecks({
	checks = [],
	runCheck,
	declaredPaths = [],
	pathExistsAtBase = () => true,
	resolveCheckExecutables = null,
	deadlineMs,
	now = Date.now,
	signal = null,
	onProgress = null,
	capMs = DRY_RUN_CHECK_CAP_MS,
}) {
	const cap =
		Number.isFinite(capMs) && capMs > 0 ? capMs : DRY_RUN_CHECK_CAP_MS;
	let writerLifecycle = "never_started";
	const redAtBaseline = [];
	const finish = (status, extra = {}) => ({
		status,
		writerLifecycle,
		...extra,
	});
	for (const [position, command] of checks.entries()) {
		if (signal?.aborted) return finish("cancelled");
		const remaining = deadlineMs - now();
		if (remaining <= 0) return finish("deadline_expired");
		const checkIndex = position + 1;
		const checkIdentity = checkIdentityOf(command);
		const emit = (event, extra = {}) =>
			onProgress?.({ event, checkIndex, checkIdentity, ...extra });
		emit("dry_run_check_started");
		let result;
		try {
			result = await runCheck({
				command,
				timeoutMs: Math.min(remaining, cap),
				signal,
				onProgress: () => emit("dry_run_check_progress"),
				testBaseline: true,
			});
		} catch (error) {
			if (signal?.aborted || error?.code === "cancelled")
				return finish("cancelled");
			if (error?.code === "deadline_expired") return finish("deadline_expired");
			throw error;
		}
		writerLifecycle = aggregateWriterLifecycle(
			writerLifecycle,
			result?.writerLifecycle,
		);
		emit("dry_run_check_finished", {
			checkStatus: result?.success ? "passed" : "failed",
		});
		if (signal?.aborted) return finish("cancelled");
		if (!SETTLED_LIFECYCLES.has(result?.writerLifecycle))
			return finish("unconfirmed");
		const classified = classifyFailedCheck(result, { preProvider: true });
		const signature =
			classified === "tool_missing" &&
			runsNewDeclaredScript(command, declaredPaths, pathExistsAtBase)
				? null
				: classified;
		if (signature) {
			// Task 2.8: when the failing check's command resolves differently in
			// the check sandbox and on the host, both paths travel with the
			// classification. Resolution can never change the gate result.
			let executableDetails = null;
			if (typeof resolveCheckExecutables === "function") {
				try {
					executableDetails = await resolveCheckExecutables(command);
				} catch {
					executableDetails = null;
				}
			}
			return finish("environment_failed", {
				checkIndex,
				checkIdentity,
				signature,
				outputPath:
					typeof result.outputPath === "string" ? result.outputPath : null,
				exitCode:
					Number.isSafeInteger(result.code) &&
					result.code >= 0 &&
					result.code <= 255
						? result.code
						: null,
				signal: PERSISTED_SIGNALS.has(result.signal) ? result.signal : null,
				...(typeof result.sandboxDeniedPath === "string"
					? { sandboxDeniedPath: result.sandboxDeniedPath }
					: {}),
				...(executableDetails?.checkExecutable
					? { checkExecutable: executableDetails.checkExecutable }
					: {}),
				...(executableDetails?.hostExecutable
					? { hostExecutable: executableDetails.hostExecutable }
					: {}),
			});
		}
		// A timed-out check was killed, not run to completion: a slow green check
		// at the dry-run cap must not be reported as already failing.
		if (result?.success !== true && result?.timedOut !== true)
			redAtBaseline.push(checkIndex);
	}
	return finish("passed", { redAtBaseline });
}
