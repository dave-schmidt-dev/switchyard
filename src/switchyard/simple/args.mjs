import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { manifestReviewPaths } from "../integrate/index.mjs";
import { parseRfc3339 } from "../rfc3339.mjs";
import { validateCheckCommand } from "./check-validation.mjs";
import {
	MAX_CAPTURE_BYTES,
	requireWorktreeGit,
	snapshotGitControl,
	verifyGitControl,
	worktreeGit,
} from "./git-control.mjs";
import { validateRoutingRunId } from "./routing-state.mjs";
import { validateTaskIdentityId } from "./routing-task-identity.mjs";
import {
	SIMPLE_PROVIDERS,
	SIMPLE_TARGET_ADAPTERS,
} from "./target-adapters.mjs";
import { MAX_ESTIMATE_MINUTES } from "./task-sizing.mjs";
export const SIMPLE_USAGE = `Usage: switchyard-dispatch simple <prompt-file> --project <path> --capability <low|standard|high> (--file <path> [--allow-manifest <path>] [--allow-executable <path>] [--input <path>] [--dirty-overlay] [--predecessor-receipt <path>] [--only-provider <provider>] [--routing-run-id <id>] [--task-id <id>] [--baseline-check <command>] [--no-repair-checks] [--format <command>] [--integrate <apply|hold>] --check <command> | --report <path>) (--deadline <RFC3339> | --timeout <minutes>) [--estimate-minutes <minutes>] [--origin <work|qualification>] [--json]

Runs one bounded assignment in a disposable local checkout. Repeat --file and
--input and --check as needed. --input is read-only and requires --dirty-overlay.
--allow-manifest opts one declared --file that is a build/execution manifest
(package.json, lockfiles, Makefile, Dockerfile, *.sh/*.bash, CI configs) into
editing; repeat it per path. Any other manifest still fails closed.
--allow-executable lets one declared --file be created as, or changed from
100644 to, a regular executable file (100755); repeat it per path. It never
admits a symlink, and every other new executable bit still fails closed. It is
independent of --allow-manifest: a new *.sh script needs both.
--report declares one repo-relative report path that must not already exist and
is mutually exclusive with --file, --allow-manifest, --allow-executable, --check
and --dirty-overlay.
Report mode keeps only that path in the diff: any other changed path fails
closed, a missing or empty report stops with report_missing, and success returns
resultKind "report" with the report path, bytes and sha256.
report.citationCheck adds bounded advisory path:line[-end] diagnostics against
the disposable checkout. One backticked identifier before a citation in its
sentence is compared with that exact source range. Unsupported/ambiguous forms
are unverifiable; a match establishes text presence, never semantic truth, and
these diagnostics do not change report success.
--predecessor-receipt binds output of a previous run and requires --dirty-overlay.
--baseline-check repeats commands run before the provider; baseline checks never
replace acceptance checks. Acceptance-check repair is on by default: after a
failing acceptance check the provider gets one scoped correction within the
original deadline. --no-repair-checks disables it; --repair-checks is accepted
for compatibility.
--format runs one bounded command in the check sandbox after the provider
succeeds and before acceptance checks; a nonzero exit is advisory, recorded as
formatStatus, and any edits it makes are revalidated against the declared scope.
--integrate hold runs every check and the integration gate but writes nothing
to the project: the verified patch and a receipt go to the run store, the
result carries integration {mode "hold", state "held", receiptPath, patchPath},
and the project lock is released at the end of the run. Apply it later with
routing-run apply --run-id <runId>, which re-runs the gate against the
then-current HEAD and refuses with a closed reason on conflict or a stale
receipt. A held run counts as a succeeded attempt for routing. --integrate hold
cannot be combined with --report or --dirty-overlay. The default is apply.
--estimate-minutes supplies one caller-estimated provider duration (whole
minutes, 1 to 1440); it is an estimate, not a proven duration. Before any
provider work, simple refuses task_estimate_exceeds_budget when the caller estimate
cannot fit the
remaining deadline after the acceptance-check reserve and the fixed fit margin.
Existing p80 routing remains advisory, including the explicit-provider override.
Caller estimates are unverified; split tasks estimated at 20 minutes or more.
--origin marks the closed dispatch origin as work (default) or qualification.
--deadline may be at most 30 minutes ahead (--timeout takes 1 to 30 minutes).
Tasks in one project run one at a time: the project lock is keyed by the
canonical project path, not the routing run, so a second simple in that project
fails at once with PROJECT_LOCK_HELD, even under a different --routing-run-id.
--check runs through /bin/sh -lc, so shell syntax such as && and pipes works. A
check that launches a package tool (npx, npm exec --, node_modules/.bin/<tool>,
a lockfile-declared bin, or any npm/pnpm/yarn/bun command) instead runs as plain
argv with no shell, from the locked local install; it accepts only letters,
digits and . _ / @ : + = - and is otherwise refused as check_dependencies_unverified.
A plain pytest, python -m pytest or node --test check already red at baseline
may pass differentially when its complete per-test reports prove the task tests
pass with no new failures, missing tests or newly skipped tests; every other
check still requires exit 0. Results expose checkAcceptance and
toleratedBaselineFailures, with a bounded differential record per check.
Output is one JSON result; progress is written to stderr. SIGINT exits 130 and
SIGTERM exits 143. If a checkout is retained, its path is in partialWorktree
for attended recovery. An integration already in progress finishes before the
terminal result is recorded.`;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_DEADLINE_MS = 30 * 60 * 1000;
const MIN_DEADLINE_FIT_MS = 90 * 1000;
const MAX_DECLARED_FILES = 64;
const MAX_CHECKS = 16;
const MAX_PATH_CHARS = 1024;
const MAX_CHECK_CHARS = 8192;
const CAPABILITIES = new Set(["low", "standard", "high"]);
const SECRET_PATHS = [
	/(^|\/)\.env(?:\.|$)/iu,
	/(^|\/)\.npmrc$/iu,
	/(^|\/)\.netrc$/iu,
	/(^|\/)\.ssh\//iu,
	/(^|\/)(?:id_rsa|id_ed25519)/iu,
	/\.(?:pem|key)$/iu,
	/(^|\/)credentials(?:\.|$)/iu,
	/(^|\/)secrets?(?:\.|$)/iu,
	/(^|\/)\.docker\/config\.json$/iu,
];
class SimpleUsageError extends Error {
	constructor(message) {
		super(message);
		this.name = "SimpleUsageError";
	}
}
function git(projectPath, args, options = {}) {
	return spawnSync("git", args, {
		cwd: projectPath,
		encoding: options.encoding ?? "utf8",
		input: options.input,
		maxBuffer: options.maxBuffer ?? MAX_CAPTURE_BYTES,
		timeout: options.timeout,
		stdio: ["pipe", "pipe", "pipe"],
	});
}
function requireGit(projectPath, args, code, options = {}) {
	const result = git(projectPath, args, options);
	if (result.status !== 0) {
		const failureCode =
			result.error?.code === "ETIMEDOUT" ? "deadline_expired" : code;
		const error = new Error(failureCode);
		error.code = failureCode;
		throw error;
	}
	return result.stdout;
}
function normalizeDeclaredPath(projectPath, value, flagName = "--file") {
	if (typeof value !== "string" || value.trim() === "") {
		throw new SimpleUsageError(
			`${flagName} requires a non-empty relative path`,
		);
	}
	const path = value.trim();
	const components = path.split("/");
	if (
		path !== value ||
		path.length > MAX_PATH_CHARS ||
		isAbsolute(path) ||
		path.includes("\0") ||
		path.includes("\\") ||
		/[*?[\]]/u.test(path) ||
		components.some(
			(component) =>
				component === "" ||
				component === "." ||
				component === ".." ||
				component === ".git",
		) ||
		SECRET_PATHS.some((pattern) => pattern.test(path))
	) {
		throw new SimpleUsageError(`unsafe ${flagName} path: ${value}`);
	}
	const absolute = resolve(projectPath, path);
	if (
		absolute !== projectPath &&
		!absolute.startsWith(`${projectPath}${sep}`)
	) {
		throw new SimpleUsageError(`${flagName} escapes project: ${value}`);
	}
	return path;
}
function assertDeclaredPathBoundary(projectPath, path, flagName = "--file") {
	let current = projectPath;
	const components = path.split("/");
	for (let index = 0; index < components.length; index += 1) {
		current = join(current, components[index]);
		let stats;
		try {
			stats = lstatSync(current);
		} catch (error) {
			if (error?.code === "ENOENT") return;
			throw error;
		}
		const isFinal = index === components.length - 1;
		if (
			stats.isSymbolicLink() ||
			(isFinal ? !stats.isFile() : !stats.isDirectory())
		) {
			throw new SimpleUsageError(`unsafe ${flagName} boundary: ${path}`);
		}
	}
}
function parseDeadline(value, nowMs) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new SimpleUsageError(
			"--deadline <RFC3339> or --timeout <minutes> is required",
		);
	}
	if (
		!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(
			value,
		)
	) {
		throw new SimpleUsageError("--deadline must be an RFC3339 timestamp");
	}
	const parsed = parseRfc3339(value);
	if (!parsed) {
		throw new SimpleUsageError("--deadline must be an RFC3339 timestamp");
	}
	const { epochMs: deadlineMs, hasSubMillisecondRemainder } = parsed;
	if (deadlineMs <= nowMs) {
		throw new SimpleUsageError("--deadline must be in the future");
	}
	const durationMs = deadlineMs - nowMs;
	if (
		durationMs > MAX_DEADLINE_MS ||
		(durationMs === MAX_DEADLINE_MS && hasSubMillisecondRemainder)
	) {
		throw new SimpleUsageError("--deadline may be at most 30 minutes ahead");
	}
	return deadlineMs;
}
function parseTimeout(value, nowMs) {
	const minutes = Number(value);
	if (
		typeof value !== "string" ||
		!/^[1-9][0-9]*$/u.test(value) ||
		!Number.isInteger(minutes) ||
		minutes < 1 ||
		minutes > 30
	) {
		throw new SimpleUsageError(
			"--timeout must be a whole number of minutes from 1 to 30",
		);
	}
	return nowMs + minutes * 60_000;
}
function parseEstimateMinutes(value) {
	const minutes = Number(value);
	if (
		typeof value !== "string" ||
		!/^[1-9][0-9]*$/u.test(value) ||
		!Number.isInteger(minutes) ||
		minutes < 1 ||
		minutes > MAX_ESTIMATE_MINUTES
	) {
		throw new SimpleUsageError(
			`--estimate-minutes must be a whole number of minutes from 1 to ${MAX_ESTIMATE_MINUTES}`,
		);
	}
	return minutes;
}

export function parseSimpleArgs(
	argv,
	{ now = Date.now, onWarning = null } = {},
) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				project: { type: "string" },
				capability: { type: "string" },
				file: { type: "string", multiple: true },
				"allow-manifest": { type: "string", multiple: true },
				"allow-executable": { type: "string", multiple: true },
				input: { type: "string", multiple: true },
				report: { type: "string" },
				"dirty-overlay": { type: "boolean", default: false },
				"predecessor-receipt": { type: "string" },
				"only-provider": { type: "string", multiple: true },
				check: { type: "string", multiple: true },
				"baseline-check": { type: "string", multiple: true },
				format: { type: "string", multiple: true },
				integrate: { type: "string" },
				"repair-checks": { type: "boolean", default: false },
				"no-repair-checks": { type: "boolean", default: false },
				deadline: { type: "string" },
				timeout: { type: "string" },
				"estimate-minutes": { type: "string" },
				origin: { type: "string" },
				"routing-run-id": { type: "string" },
				"task-id": { type: "string" },
				json: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
		});
	} catch (error) {
		throw new SimpleUsageError(error.message);
	}
	if (parsed.values.help) return { help: true };
	if (parsed.positionals.length !== 1) {
		throw new SimpleUsageError("exactly one <prompt-file> is required");
	}
	if (!parsed.values.project) {
		throw new SimpleUsageError("--project <path> is required");
	}
	const projectPath = resolve(parsed.values.project);
	if (!existsSync(projectPath) || !lstatSync(projectPath).isDirectory()) {
		throw new SimpleUsageError("--project must be an existing directory");
	}
	const canonicalProjectPath = realpathSync(projectPath);
	const repo = git(canonicalProjectPath, ["rev-parse", "--show-toplevel"]);
	if (
		repo.status !== 0 ||
		realpathSync(repo.stdout.trim()) !== canonicalProjectPath
	) {
		throw new SimpleUsageError("--project must be a Git repository root");
	}
	const promptPath = resolve(parsed.positionals[0]);
	if (!existsSync(promptPath)) {
		throw new SimpleUsageError("prompt file does not exist");
	}
	const promptStats = lstatSync(promptPath);
	if (!promptStats.isFile() || promptStats.isSymbolicLink()) {
		throw new SimpleUsageError(
			"prompt file must be a regular non-symlink file",
		);
	}
	if (promptStats.size === 0 || promptStats.size > MAX_PROMPT_BYTES) {
		throw new SimpleUsageError("prompt file must contain 1 to 262144 bytes");
	}
	const capability = String(parsed.values.capability ?? "").toLowerCase();
	if (!CAPABILITIES.has(capability)) {
		throw new SimpleUsageError("--capability must be low, standard, or high");
	}
	const onlyProviders = parsed.values["only-provider"] ?? [];
	if (
		onlyProviders.length > 1 ||
		(onlyProviders.length === 1 &&
			(!SIMPLE_PROVIDERS.includes(onlyProviders[0]) ||
				onlyProviders[0].includes(",")))
	) {
		throw new SimpleUsageError(
			"--only-provider must name exactly one supported simple provider",
		);
	}
	const reportMode = typeof parsed.values.report === "string";
	let files;
	if (reportMode) {
		if ((parsed.values.file ?? []).length > 0)
			throw new SimpleUsageError("--report is mutually exclusive with --file");
		if ((parsed.values["allow-manifest"] ?? []).length > 0)
			throw new SimpleUsageError(
				"--report is mutually exclusive with --allow-manifest",
			);
		if ((parsed.values["allow-executable"] ?? []).length > 0)
			throw new SimpleUsageError(
				"--report is mutually exclusive with --allow-executable",
			);
		if ((parsed.values.check ?? []).length > 0)
			throw new SimpleUsageError("--report is mutually exclusive with --check");
		if (parsed.values["dirty-overlay"] === true)
			throw new SimpleUsageError(
				"--report is mutually exclusive with --dirty-overlay",
			);
		const reportPath = normalizeDeclaredPath(
			canonicalProjectPath,
			parsed.values.report,
			"--report",
		);
		let reportExists = true;
		try {
			lstatSync(resolve(canonicalProjectPath, reportPath));
		} catch (error) {
			if (error?.code === "ENOENT") reportExists = false;
			else throw error;
		}
		if (reportExists)
			throw new SimpleUsageError(
				`--report path must not exist in the project: ${reportPath}`,
			);
		files = [reportPath];
	} else {
		files = (parsed.values.file ?? []).map((path) =>
			normalizeDeclaredPath(canonicalProjectPath, path),
		);
		if (
			files.length === 0 ||
			files.length > MAX_DECLARED_FILES ||
			new Set(files).size !== files.length
		) {
			throw new SimpleUsageError("at least one unique --file is required");
		}
	}
	const allowManifests = (parsed.values["allow-manifest"] ?? []).map((path) =>
		normalizeDeclaredPath(canonicalProjectPath, path, "--allow-manifest"),
	);
	if (new Set(allowManifests).size !== allowManifests.length) {
		throw new SimpleUsageError("--allow-manifest paths must be unique");
	}
	for (const path of allowManifests) {
		if (!files.includes(path)) {
			throw new SimpleUsageError(
				`--allow-manifest path must also be declared with --file: ${path}`,
			);
		}
		if (manifestReviewPaths([path]).length === 0) {
			throw new SimpleUsageError(
				`--allow-manifest path is not a build/execution manifest: ${path}`,
			);
		}
	}
	const allowExecutables = (parsed.values["allow-executable"] ?? []).map(
		(path) =>
			normalizeDeclaredPath(canonicalProjectPath, path, "--allow-executable"),
	);
	if (new Set(allowExecutables).size !== allowExecutables.length) {
		throw new SimpleUsageError("--allow-executable paths must be unique");
	}
	for (const path of allowExecutables) {
		if (!files.includes(path)) {
			throw new SimpleUsageError(
				`--allow-executable path must also be declared with --file: ${path}`,
			);
		}
		// Checked in every mode, --dirty-overlay included: an existing
		// symlink or non-regular entry never becomes an executable grant.
		assertDeclaredPathBoundary(
			canonicalProjectPath,
			path,
			"--allow-executable",
		);
	}
	const dirtyOverlay = parsed.values["dirty-overlay"] === true;
	if (!dirtyOverlay) {
		for (const path of files)
			assertDeclaredPathBoundary(canonicalProjectPath, path);
	}
	const inputs = (parsed.values.input ?? []).map((path) =>
		normalizeDeclaredPath(canonicalProjectPath, path, "--input"),
	);
	if (inputs.some((path) => files.includes(path))) {
		throw new SimpleUsageError("--file and --input scopes must not overlap");
	}
	if (
		files.length + inputs.length > MAX_DECLARED_FILES ||
		new Set(inputs).size !== inputs.length
	) {
		throw new SimpleUsageError("--input paths must be unique and bounded");
	}
	if (inputs.length > 0 && !dirtyOverlay) {
		throw new SimpleUsageError("--input requires --dirty-overlay");
	}
	if (!dirtyOverlay) {
		for (const path of inputs)
			assertDeclaredPathBoundary(canonicalProjectPath, path);
	}
	const predecessorReceiptPath = parsed.values["predecessor-receipt"]
		? resolve(parsed.values["predecessor-receipt"])
		: null;
	if (predecessorReceiptPath) {
		if (!dirtyOverlay) {
			throw new SimpleUsageError(
				"--predecessor-receipt requires --dirty-overlay",
			);
		}
		if (!existsSync(predecessorReceiptPath)) {
			throw new SimpleUsageError("predecessor receipt file does not exist");
		}
		const predStats = lstatSync(predecessorReceiptPath);
		if (!predStats.isFile() || predStats.isSymbolicLink()) {
			throw new SimpleUsageError(
				"predecessor receipt must be a regular non-symlink file",
			);
		}
	}
	const checks = parsed.values.check ?? [];
	const baselineChecks = parsed.values["baseline-check"] ?? [];
	if (
		(!reportMode && checks.length === 0) ||
		checks.length > MAX_CHECKS ||
		checks.some(
			(check) =>
				typeof check !== "string" ||
				check.trim() === "" ||
				check.length > MAX_CHECK_CHARS,
		)
	) {
		throw new SimpleUsageError("at least one non-empty --check is required");
	}
	if (
		baselineChecks.length > MAX_CHECKS ||
		baselineChecks.some(
			(check) =>
				typeof check !== "string" ||
				check.trim() === "" ||
				check.length > MAX_CHECK_CHARS,
		)
	) {
		throw new SimpleUsageError(
			"--baseline-check commands must be non-empty and bounded",
		);
	}
	const formatCommands = parsed.values.format ?? [];
	if (
		formatCommands.length > 1 ||
		formatCommands.some(
			(command) =>
				typeof command !== "string" ||
				command.trim() === "" ||
				command.length > MAX_CHECK_CHARS,
		)
	) {
		throw new SimpleUsageError(
			"--format requires one non-empty bounded command",
		);
	}
	const formatCommand =
		formatCommands.length === 1 ? formatCommands[0].trim() : null;
	const integrateMode = parsed.values.integrate ?? "apply";
	if (integrateMode !== "apply" && integrateMode !== "hold")
		throw new SimpleUsageError("--integrate must be apply or hold");
	if (integrateMode === "hold" && (reportMode || dirtyOverlay))
		throw new SimpleUsageError(
			`--integrate hold is mutually exclusive with ${reportMode ? "--report" : "--dirty-overlay"}`,
		);
	for (const check of [
		...checks,
		...baselineChecks,
		...(formatCommand === null ? [] : [formatCommand]),
	])
		validateCheckCommand(check, canonicalProjectPath);
	const routingRunId =
		parsed.values["routing-run-id"] ??
		process.env.SWITCHYARD_ROUTING_RUN_ID ??
		null;
	if (routingRunId !== null) {
		try {
			validateRoutingRunId(routingRunId);
		} catch {
			throw new SimpleUsageError("invalid routing run id");
		}
	}
	const taskId = parsed.values["task-id"] ?? null;
	if (taskId !== null) {
		try {
			validateTaskIdentityId(taskId);
		} catch {
			throw new SimpleUsageError("invalid task id");
		}
	}
	if (
		parsed.values["repair-checks"] === true &&
		parsed.values["no-repair-checks"] === true
	) {
		throw new SimpleUsageError(
			"--repair-checks and --no-repair-checks are mutually exclusive",
		);
	}
	const nowMs = now();
	const rawOrigin = parsed.values.origin;
	const origin =
		rawOrigin !== undefined ? String(rawOrigin).toLowerCase() : "work";
	if (origin !== "work" && origin !== "qualification") {
		throw new SimpleUsageError("--origin must be work or qualification");
	}
	if (
		parsed.values.deadline !== undefined &&
		parsed.values.timeout !== undefined
	) {
		throw new SimpleUsageError(
			"--deadline and --timeout are mutually exclusive",
		);
	}
	const deadlineMs =
		parsed.values.timeout !== undefined
			? parseTimeout(parsed.values.timeout, nowMs)
			: parseDeadline(parsed.values.deadline, nowMs);
	const estimateMinutes =
		parsed.values["estimate-minutes"] !== undefined
			? parseEstimateMinutes(parsed.values["estimate-minutes"])
			: null;
	if (deadlineMs - nowMs < MIN_DEADLINE_FIT_MS) {
		(onWarning ?? console.error)(
			"warning: --deadline is under 90 seconds; targets that cannot finish inside the deadline may still be routed",
		);
	}
	return {
		promptPath,
		projectPath: canonicalProjectPath,
		capability,
		onlyProviders,
		origin,
		files,
		reportMode,
		allowManifests,
		allowExecutables,
		readOnlyInputs: inputs,
		dirtyOverlay,
		predecessorReceiptPath,
		checks: checks.map((check) => check.trim()),
		baselineChecks: baselineChecks.map((check) => check.trim()),
		format: formatCommand,
		integrateMode,
		repairChecks: parsed.values["no-repair-checks"] !== true,
		deadlineMs,
		estimateMinutes,
		routingRunId,
		taskId,
	};
}
export {
	git,
	MAX_CAPTURE_BYTES,
	requireGit,
	requireWorktreeGit,
	SECRET_PATHS,
	SIMPLE_TARGET_ADAPTERS,
	SimpleUsageError,
	snapshotGitControl,
	verifyGitControl,
	worktreeGit,
};
