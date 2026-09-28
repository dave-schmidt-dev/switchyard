import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	handleBackendHealth,
	parseDispatchArgs,
	parseReconcileCompletionArgs,
} from "../src/switchyard/dispatch/index.mjs";
import {
	computeQueueIdentityFromFile,
	getProjectRevision,
	validateCallerInputs,
} from "../src/switchyard/runner/index.mjs";
import {
	ROSTER_FIXTURE_PATH,
	runDispatch,
} from "./helpers/dispatch-cli-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

function reconcileCompletionArgs(receiptPath) {
	return [
		"reconcile-completion",
		"--receipt",
		receiptPath,
		"--source-checkpoint",
		join(dir, "source.checkpoint.json"),
		"--successor-checkpoint",
		join(dir, "successor.checkpoint.json"),
		"--tasks",
		tasksFile,
		"--project",
		projectDir,
		"--json",
	];
}
let dir;
let tasksFile;
let projectDir;
let stateRoot;
function makeStateRootEnv() {
	return { SWITCHYARD_RUN_STORE_ROOT: stateRoot };
}
beforeEach(async () => {
	dir = tempDir("switchyard-dispatch-cli-");
	stateRoot = join(dir, "state-root");
	tasksFile = join(dir, "tasks.md");
	writeFileSync(
		tasksFile,
		"### Task 1.1: Test task\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** A test\n",
		"utf8",
	);
	projectDir = join(dir, "project");
	mkdirSync(join(projectDir, ".git"), { recursive: true });

	// Set env var so direct run-store calls in tests target the temp dir
	process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;
	process.env.SWITCHYARD_ROSTER_PATH = ROSTER_FIXTURE_PATH;
	// Real dispatch subprocesses go through the real, unmocked ledger writer —
	// redirect it so this suite never writes to the real dispatch-ledger.jsonl.
	process.env.SWITCHYARD_LEDGER_PATH = join(dir, "dispatch-ledger.jsonl");
});
afterEach(() => {
	delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	delete process.env.SWITCHYARD_ROSTER_PATH;
	delete process.env.SWITCHYARD_LEDGER_PATH;
	rmSync(dir, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});
describe("validate-inputs CLI", () => {
	it("returns one idempotent bounded JSON object without creating a checkpoint", () => {
		const args = ["validate-inputs", tasksFile, "--project", projectDir];
		const first = runDispatch(args, makeStateRootEnv());
		const second = runDispatch([...args, "--json"], makeStateRootEnv());
		strictEqual(first.status, 0, first.stderr);
		strictEqual(second.status, 0, second.stderr);
		strictEqual(first.stdout.trim().split("\n").length, 1);
		deepStrictEqual(JSON.parse(first.stdout), JSON.parse(second.stdout));
		strictEqual(JSON.parse(first.stdout).valid, true);
		ok(!existsSync(`${tasksFile}.checkpoint.json`));
	});

	it("classifies malformed validator invocation without exposing parser text", () => {
		const result = runDispatch(
			["validate-inputs", tasksFile],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 2);
		deepStrictEqual(JSON.parse(result.stdout), {
			valid: false,
			code: "invalid_invocation",
			remedy: "invocation options must follow validate-inputs usage",
		});
	});

	it("preserves the legacy-shaped queue identity", () => {
		const opts = parseDispatchArgs([tasksFile, "--project", projectDir]);
		const validated = validateCallerInputs(opts);
		const legacy = computeQueueIdentityFromFile(
			tasksFile,
			getProjectRevision(projectDir),
			validated.runOptions,
		);
		strictEqual(validated.queueIdentity, legacy.queueIdentity);
	});

	it("rejects an empty queue before durable state and only recognizes argv[0]", () => {
		writeFileSync(tasksFile, "# empty\n", "utf8");
		const rejection = runDispatch(
			["validate-inputs", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(rejection.status, 2);
		const output = JSON.parse(rejection.stdout);
		deepStrictEqual(Object.keys(output).sort(), [
			"code",
			"evaluatedTaskIds",
			"remedy",
			"selectedTaskIds",
			"valid",
		]);
		strictEqual(output.code, "queue_empty");
		ok(!existsSync(join(stateRoot, "runs")));

		const misplaced = runDispatch(
			["--json", "validate-inputs", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(misplaced.status, 2);
	});

	it("returns bounded exit-2 diagnostics for malformed graph and selection", () => {
		writeFileSync(
			tasksFile,
			"### Task 1.1: Invalid graph\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Blocked by:** 9.9\n- **Description:** private description must not escape\n",
			"utf8",
		);
		const malformed = runDispatch(
			["validate-inputs", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(malformed.status, 2, malformed.stderr);
		deepStrictEqual(Object.keys(JSON.parse(malformed.stdout)).sort(), [
			"code",
			"evaluatedTaskIds",
			"remedy",
			"selectedTaskIds",
			"valid",
		]);
		strictEqual(JSON.parse(malformed.stdout).code, "queue_contract_invalid");
		ok(!malformed.stdout.includes("private description"));
		ok(!existsSync(join(stateRoot, "runs")));

		writeFileSync(
			tasksFile,
			"### Task 1.1: Valid\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** valid\n",
			"utf8",
		);
		const selected = runDispatch(
			[
				"validate-inputs",
				tasksFile,
				"--project",
				projectDir,
				"--task-id",
				"9.9",
			],
			makeStateRootEnv(),
		);
		strictEqual(selected.status, 2, selected.stderr);
		deepStrictEqual(JSON.parse(selected.stdout), {
			valid: false,
			code: "task_selection_failed",
			taskId: "9.9",
			selectedTaskIds: ["9.9"],
			evaluatedTaskIds: [],
			remedy: "selected task is not runnable with the current checkpoint",
		});
		ok(!existsSync(join(stateRoot, "runs")));
	});

	it("filters task-specific path validation before inspecting declarations", () => {
		mkdirSync(join(projectDir, "generated"), { recursive: true });
		writeFileSync(join(projectDir, "generated", "uncommitted.mjs"), "owner\n");
		writeFileSync(
			tasksFile,
			"### Task 1.1: Excluded\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** generated/uncommitted.mjs\n- **Description:** excluded\n\n### Task 2.1: Selected\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** selected\n",
			"utf8",
		);

		const selected = runDispatch(
			[
				"validate-inputs",
				tasksFile,
				"--project",
				projectDir,
				"--task-id",
				"2.1",
			],
			makeStateRootEnv(),
		);
		strictEqual(selected.status, 0, selected.stderr);
		const envelope = JSON.parse(selected.stdout);
		deepStrictEqual(envelope.selectedTaskIds, ["2.1"]);
		deepStrictEqual(envelope.evaluatedTaskIds, ["2.1"]);

		const excluded = runDispatch(
			[
				"validate-inputs",
				tasksFile,
				"--project",
				projectDir,
				"--task-id",
				"1.1",
			],
			makeStateRootEnv(),
		);
		strictEqual(excluded.status, 2);
		strictEqual(
			JSON.parse(excluded.stdout).code,
			"declared_path_not_committed",
		);
	});

	it("keeps detailed path rejection while run and launch project repair", () => {
		mkdirSync(join(projectDir, "generated"), { recursive: true });
		writeFileSync(join(projectDir, "generated", "new.mjs"), "untracked\n");
		writeFileSync(
			tasksFile,
			"### Task 1.1: Unseeded\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** generated/new.mjs\n- **Description:** valid\n",
			"utf8",
		);

		const validated = runDispatch(
			["validate-inputs", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(validated.status, 2);
		strictEqual(
			JSON.parse(validated.stdout).code,
			"declared_path_not_committed",
		);

		for (const command of ["run", "launch"]) {
			const result = runDispatch(
				[command, tasksFile, "--project", projectDir, "--json"],
				makeStateRootEnv(),
			);
			strictEqual(result.status, 2, result.stderr);
			const envelope = JSON.parse(result.stdout);
			strictEqual(envelope.disposition.action, "repair_contract");
			strictEqual(envelope.disposition.direction, "repair_input");
			strictEqual(envelope.disposition.reasonCode, "queue_contract_invalid");
			strictEqual(envelope.preflightDetail.code, "declared_path_not_committed");
			strictEqual(envelope.runId, null);
		}

		rmSync(projectDir, { recursive: true, force: true });
		mkdirSync(join(projectDir, "src"), { recursive: true });
		const unreadablePath = join(projectDir, "src", "unreadable.mjs");
		writeFileSync(unreadablePath, "committed but unreadable\n");
		execFileSync("git", ["init", "-q"], { cwd: projectDir });
		execFileSync("git", ["add", "src/unreadable.mjs"], { cwd: projectDir });
		execFileSync(
			"git",
			[
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				"commit",
				"-qm",
				"seed",
			],
			{ cwd: projectDir },
		);
		chmodSync(unreadablePath, 0o000);
		writeFileSync(
			tasksFile,
			"### Task 1.1: Unreadable\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/unreadable.mjs\n- **Description:** valid\n",
			"utf8",
		);
		const unreadable = runDispatch(
			["validate-inputs", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(unreadable.status, 2);
		strictEqual(JSON.parse(unreadable.stdout).code, "declared_path_unreadable");

		chmodSync(unreadablePath, 0o600);
		for (const command of ["run", "launch"]) {
			const unavailable = runDispatch(
				[command, tasksFile, "--project", projectDir, "--json"],
				{ ...makeStateRootEnv(), PATH: "" },
			);
			strictEqual(unavailable.status, 1, unavailable.stderr);
			const envelope = JSON.parse(unavailable.stdout);
			strictEqual(envelope.disposition.reasonCode, "environment_incomplete");
			strictEqual(envelope.preflightDetail.code, "validation_unavailable");
			strictEqual(envelope.runId, null);
		}
	});
});
describe("backend-health CLI", () => {
	it("reports bounded read-only readiness and typed degraded evidence", async () => {
		const lines = [];
		const originalLog = console.log;
		const originalExitCode = process.exitCode;
		console.log = (line) => lines.push(line);
		try {
			await handleBackendHealth([], {
				now: () => Date.parse("2026-09-21T14:00:00.000Z"),
				executionBackend: { probeHostReadiness: () => ({ inventoryCount: 1 }) },
			});
			deepStrictEqual(JSON.parse(lines.pop()), {
				schemaVersion: 1,
				backend: "parallels",
				observedAt: "2026-09-21T14:00:00.000Z",
				ready: true,
				errorKind: null,
				diagnosticCode: null,
			});

			await handleBackendHealth([], {
				now: () => Date.parse("2026-09-21T14:00:01.000Z"),
				executionBackend: {
					probeHostReadiness: () => {
						throw Object.assign(new Error("private host detail"), {
							code: "vm_host_service_degraded",
						});
					},
				},
			});
			const degraded = JSON.parse(lines.pop());
			strictEqual(degraded.ready, false);
			strictEqual(degraded.errorKind, "environment_incomplete");
			strictEqual(degraded.diagnosticCode, "vm_host_service_degraded");
			strictEqual(
				JSON.stringify(degraded).includes("private host detail"),
				false,
			);
		} finally {
			console.log = originalLog;
			process.exitCode = originalExitCode;
		}
	});
});
describe("external completion CLI", () => {
	it("parses the bounded reconciliation command and preserves JSON mode", () => {
		const parsed = parseReconcileCompletionArgs([
			"--receipt",
			"receipt.json",
			"--source-checkpoint",
			"source.json",
			"--successor-checkpoint",
			"successor.json",
			"--tasks",
			"tasks.md",
			"--project",
			"project",
			"--json",
		]);
		strictEqual(parsed.json, true);
		strictEqual(parsed.receiptPath.endsWith("/receipt.json"), true);
		strictEqual(parsed.sourceCheckpointPath.endsWith("/source.json"), true);
		strictEqual(
			parsed.successorCheckpointPath.endsWith("/successor.json"),
			true,
		);
	});

	it("supports help without requiring a receipt", () => {
		deepStrictEqual(parseReconcileCompletionArgs(["--help"]), { help: true });
	});

	it("rejects a FIFO without opening it or hanging the CLI", () => {
		const fifo = join(dir, "receipt.fifo");
		execFileSync("mkfifo", [fifo]);
		const started = Date.now();
		const result = runDispatch(reconcileCompletionArgs(fifo), {}, 2_000);
		ok(Date.now() - started < 1_500, "receipt trust gate must be bounded");
		strictEqual(result.error, undefined, result.error?.message);
		strictEqual(result.status, 1);
		strictEqual(JSON.parse(result.stdout).reasonCode, "receipt_not_regular");
	});

	it("rejects a symlinked receipt before following its target", () => {
		const fifo = join(dir, "receipt-target.fifo");
		const symlink = join(dir, "receipt-link.json");
		execFileSync("mkfifo", [fifo]);
		symlinkSync(fifo, symlink);
		const started = Date.now();
		const result = runDispatch(reconcileCompletionArgs(symlink), {}, 2_000);
		ok(Date.now() - started < 1_500, "symlink trust gate must be bounded");
		strictEqual(result.error, undefined, result.error?.message);
		strictEqual(result.status, 1);
		strictEqual(JSON.parse(result.stdout).reasonCode, "receipt_not_regular");
	});

	it("rejects an oversized receipt without reading its content", () => {
		const oversized = join(dir, "receipt-oversized.json");
		writeFileSync(
			oversized,
			Buffer.concat([
				Buffer.from("SECRET_CANARY_OVERSIZED_RECEIPT"),
				Buffer.alloc(1024 * 1024 + 1, 0x41),
			]),
		);
		chmodSync(oversized, 0o600);
		const result = runDispatch(reconcileCompletionArgs(oversized), {}, 2_000);
		strictEqual(result.error, undefined, result.error?.message);
		strictEqual(result.status, 1);
		strictEqual(JSON.parse(result.stdout).reasonCode, "receipt_too_large");
		ok(!result.stdout.includes("SECRET_CANARY_OVERSIZED_RECEIPT"));
	});
});
