/**
 * Differential acceptance for test-runner checks that were already red on the
 * unmodified tree.
 *
 * The pre-provider dry run captures each such check's per-test results. After
 * the provider, a failing run of the same check is accepted only when the task
 * made things strictly no worse and its own tests pass: every test it targets
 * passes, no test fails that did not fail at baseline, no test timed out or
 * was killed, and no baseline test disappeared or became skipped. Everything
 * else keeps today's strict exit-0
 * judgement, and this module can only turn a strict failure into an
 * acceptance, never the reverse.
 */

import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
	classifyFailedCheck,
	redactCredentialTokens,
} from "./check-environment.mjs";
import {
	NODE_TEST_REPORTER_URL,
	parseNodeTestReport,
	parsePytestJunit,
	readReportFile,
} from "./test-report-parse.mjs";
import { reportingCommand, testRunnerOf } from "./test-runner-argv.mjs";

/** Most test ids listed per set in a recorded verdict. */
export const RECORDED_IDS = 20;
/** Longest recorded test id, in characters. */
export const RECORDED_ID_CHARS = 160;

const NOT_RUN = new Set(["skipped", "todo"]);

/**
 * Compare a candidate run with its baseline.
 *
 * @param {object} options
 * @param {Map<string, {status: string, file: string|null, abnormal: boolean}>} options.baseline
 * @param {Map<string, {status: string, file: string|null, abnormal: boolean}>} options.after
 * @param {string[]} options.declaredFiles The task's declared repo-relative paths.
 * @returns {{accepted: boolean, reason: string|null, newFailures: string[],
 *   targeted: {total: number, passed: number}}}
 */
export function compareTestRuns({ baseline, after, declaredFiles }) {
	const declared = new Set(
		declaredFiles.map((path) => path.replace(/^\.\//u, "")),
	);
	const newFailures = [];
	const targeted = { total: 0, passed: 0 };
	let targetedRefused = false;
	for (const [id, { status, file }] of after) {
		const before = baseline.get(id);
		if (status === "failed" && before?.status !== "failed")
			newFailures.push(id);
		if (before === undefined || (file !== null && declared.has(file))) {
			targeted.total += 1;
			if (status === "passed") targeted.passed += 1;
			// A targeted test the base tree already skipped may stay skipped.
			else if (!(NOT_RUN.has(status) && NOT_RUN.has(before?.status)))
				targetedRefused = true;
		}
	}
	const result = (reason) => ({
		accepted: reason === null,
		reason,
		newFailures,
		targeted,
	});
	if (after.size < baseline.size) return result("test_count_dropped");
	if ([...after.values()].some(({ abnormal }) => abnormal))
		return result("test_ended_abnormally");
	for (const [id, { status }] of baseline) {
		const now = after.get(id);
		if (now === undefined) return result("baseline_test_missing");
		if (!NOT_RUN.has(status) && NOT_RUN.has(now.status))
			return result("baseline_test_skipped");
	}
	if (newFailures.length > 0) return result("new_failure");
	if (![...after.values()].some(({ status }) => status === "failed"))
		return result("no_failures_reported");
	if (targeted.passed === 0) return result("no_targeted_tests");
	if (targetedRefused) return result("targeted_test_not_passed");
	return result(null);
}

// Credential prefixes glued to an identifier (`test_sk-...`), which the shared
// word-boundary redactor misses. `sk-` after a letter (`task-...`) is a word.
const EMBEDDED_CREDENTIAL_RE =
	/(?:(?<![A-Za-z])sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|ghp_[A-Za-z0-9]{8,}|bws_[A-Za-z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16})/gu;

/** A test id safe to persist: control characters stripped, redacted, bounded. */
function recordedId(id) {
	const visible = id.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
	const redacted = redactCredentialTokens(visible)
		.toString("utf8")
		.replace(EMBEDDED_CREDENTIAL_RE, "[REDACTED]");
	return redacted.length > RECORDED_ID_CHARS
		? `${redacted.slice(0, RECORDED_ID_CHARS - 1)}…`
		: redacted;
}

function failedIds(tests) {
	return [...tests]
		.filter(([, { status }]) => status === "failed")
		.map(([id]) => id)
		.sort();
}

function summary(tests) {
	const failed = failedIds(tests);
	return {
		total: tests.size,
		failedCount: failed.length,
		failed: failed.slice(0, RECORDED_IDS).map(recordedId),
	};
}

function record(runner, reason, extra = {}) {
	return {
		runner,
		verdict: reason === null ? "accepted" : "refused",
		reason,
		...extra,
	};
}

// The runtime directory as created by the host. Check code can write inside it
// and so could swap it for a link; a report is read only while it is unchanged.
function directoryIdentity(path) {
	try {
		const stat = lstatSync(path);
		return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
	} catch {
		return null;
	}
}

function parseReport(plan) {
	const { runner, reportPath, checkoutRoots, runtime, runtimeIdentity } = plan;
	if (directoryIdentity(runtime) !== runtimeIdentity) return null;
	const text = readReportFile(reportPath);
	if (text === null || directoryIdentity(runtime) !== runtimeIdentity)
		return null;
	try {
		return runner === "pytest"
			? parsePytestJunit(text)
			: parseNodeTestReport(text, checkoutRoots);
	} catch {
		return null;
	}
}

// A run's report is usable only when the runner finished on its own with the
// exit code it uses for failing tests (both pytest and node use 1).
const failedNormally = (result) =>
	result?.success !== true &&
	result?.code === 1 &&
	result?.timedOut !== true &&
	result?.silenceTimedOut !== true &&
	!result?.signal;

// A dependency or environment failure after the provider keeps its strict
// result and its own failure code.
const environmentFailure = (result) =>
	typeof result?.diagnosticCode === "string" ||
	classifyFailedCheck(result, { preProvider: false }) !== null;

/**
 * Per-session differential state: the baseline per check command, captured on
 * the base tree, and the judgement of each later candidate run.
 *
 * @param {object} options
 * @param {string[]} options.declaredFiles The task's declared repo-relative paths.
 */
export function createDifferentialChecks({ declaredFiles }) {
	const baselines = new Map();
	let reports = 0;
	return {
		/**
		 * How to run `command` now. Returns null to run it unchanged with no
		 * differential judgement (not a test runner, or no red baseline), or a
		 * plan whose `shellCommand` (null to run it unchanged) goes to /bin/sh.
		 */
		plan({ command, execution, baseRun, testBaseline, runtime, checkout }) {
			if (execution?.kind !== "shell") return null;
			if (baseRun) {
				if (!testBaseline) return null;
				const runner = testRunnerOf(command);
				if (!runner) return null;
				return prepared("baseline", runner, runtime, checkout);
			}
			const baseline = baselines.get(command);
			if (!baseline) return null;
			if (!baseline.tests)
				return {
					phase: "unavailable",
					runner: baseline.runner,
					reason: baseline.reason,
					shellCommand: null,
				};
			return prepared(
				"after",
				testRunnerOf(command),
				runtime,
				checkout,
				baseline,
			);
		},
		/** Record a baseline run, or judge a candidate run; returns the run's result. */
		judge(plan, command, result) {
			if (plan.phase === "baseline") {
				if (result?.success === true) return result;
				const tests =
					plan.shellCommand && failedNormally(result)
						? parseReport(plan)
						: null;
				baselines.set(
					command,
					tests
						? { runner: plan.runner, tests }
						: {
								runner: plan.runner,
								reason: plan.reason ?? "baseline_unavailable",
							},
				);
				return result;
			}
			if (result?.success === true) return result;
			if (plan.phase === "unavailable")
				return { ...result, differential: record(plan.runner, plan.reason) };
			const strict = (reason, extra = {}) => ({
				...result,
				differential: record(plan.runner, reason, {
					baseline: summary(plan.baseline.tests),
					...extra,
				}),
			});
			if (environmentFailure(result)) return strict("environment_failure");
			if (!plan.shellCommand) return strict(plan.reason);
			if (!failedNormally(result)) return strict("exit_status_unusable");
			const after = parseReport(plan);
			if (!after) return strict("report_unavailable");
			const verdict = compareTestRuns({
				baseline: plan.baseline.tests,
				after,
				declaredFiles,
			});
			const outcome = strict(verdict.reason, {
				after: {
					...summary(after),
					newFailures: verdict.newFailures
						.sort()
						.slice(0, RECORDED_IDS)
						.map(recordedId),
				},
				targeted: verdict.targeted,
			});
			return verdict.accepted ? { ...outcome, success: true } : outcome;
		},
	};

	function prepared(phase, runner, runtime, checkout, baseline = null) {
		if (!runner.eligible)
			return {
				phase,
				runner: runner.runner,
				reason: runner.reason,
				shellCommand: null,
			};
		const runtimeIdentity = directoryIdentity(runtime);
		if (runtimeIdentity === null)
			return {
				phase,
				runner: runner.runner,
				reason:
					phase === "baseline" ? "baseline_unavailable" : "report_unavailable",
				baseline,
				shellCommand: null,
			};
		reports += 1;
		const extension = runner.runner === "pytest" ? "xml" : "jsonl";
		const reportPath = join(runtime, `sy-test-report-${reports}.${extension}`);
		let checkoutRoots = [checkout];
		try {
			checkoutRoots = [...new Set([checkout, realpathSync(checkout)])];
		} catch {}
		return {
			phase,
			runner: runner.runner,
			reason: null,
			baseline,
			reportPath,
			runtime,
			runtimeIdentity,
			checkoutRoots,
			shellCommand: reportingCommand(runner, {
				reportPath,
				reporter: NODE_TEST_REPORTER_URL,
			}),
		};
	}
}
