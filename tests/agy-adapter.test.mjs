import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	captureDiff,
	executeAgy,
	executeAgyAsync,
} from "../src/switchyard/adapter/agy.mjs";
import { PROVIDER_EXECUTION_TIMEOUT_MS } from "../src/switchyard/adapter/constants.mjs";
import { validateInvocationDescriptor } from "../src/switchyard/roster/index.mjs";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function hasDocker() {
	try {
		execSync("docker --version", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const dockerAvailable = hasDocker();
const testRoot = mkdtempSync(join(tmpdir(), "switchyard-agy-adapter-"));
const containerName = `switchyard-agy-adapter-${Date.now()}`;

// getWorkspaceExecution (provider-lifecycle.mjs) now requires an
// executionBackend with no default -- the removed DEFAULT_EXECUTION_BACKEND
// used to fill this in for real-container integration tests. This fixture
// reproduces that Docker-exec transport for the real container this file
// spins up in before().
const dockerExecutionBackend = {
	execArgv(workspaceId, { cwd = "/project", argv } = {}) {
		return {
			command: "docker",
			args: ["exec", "-i", "-w", cwd, workspaceId, ...argv],
		};
	},
};

const AGY_MODEL = "Gemini 3.6 Flash (Medium)";
const AGY_PROMPT = "apply a small change";
const AGY_DESCRIPTOR = validateInvocationDescriptor(
	{
		target_id: "agy-target",
		model_ref: AGY_MODEL,
		selector: AGY_MODEL,
		effort: null,
		variant: null,
		invocation_args: [],
	},
	"agy",
);

// Fake `agy` that ENFORCES the adapter's invocation shape: it exits non-zero
// unless --new-project, --mode accept-edits, --dangerously-skip-permissions,
// --add-dir /project, --print-timeout 9m, --model <value>, and --print
// <prompt> are all present
// and correctly paired (each flag immediately followed by its own value, and
// --print <prompt> anchored as the final args) — so a dropped or misordered
// flag turns this test red instead of passing silently, the argv-blind-stub
// gap Task 19 tracks. agy's prompt arrives as a --print flag value, not
// stdin (unlike claude/codex), so — unlike the codex stub — this one never
// drains stdin.
const AGY_STUB = `#!/bin/sh
case " $* " in
  *" --new-project "*) ;;
  *) echo "stub: executeAgy did not pass --new-project; args: $*" >&2; exit 3 ;;
esac
case " $* " in
  *" --mode accept-edits "*) ;;
  *) echo "stub: executeAgy did not pass --mode accept-edits; args: $*" >&2; exit 3 ;;
esac
case " $* " in
  *" --dangerously-skip-permissions "*) ;;
  *) echo "stub: executeAgy did not pass --dangerously-skip-permissions; args: $*" >&2; exit 3 ;;
esac
case " $* " in
  *" --add-dir /project "*) ;;
  *) echo "stub: executeAgy did not pass --add-dir /project; args: $*" >&2; exit 3 ;;
esac
case " $* " in
  *" --print-timeout 9m "*) ;;
  *) echo "stub: executeAgy did not pass --print-timeout 9m; args: $*" >&2; exit 3 ;;
esac
case " $* " in
  *" --model ${AGY_MODEL} "*) ;;
  *) echo "stub: executeAgy did not pass --model ${AGY_MODEL}; args: $*" >&2; exit 3 ;;
esac
case " $* " in
  *" ${AGY_PROMPT}"*) ;;
  *) echo "stub: executeAgy did not pass ${AGY_PROMPT} in the guarded prompt; args: $*" >&2; exit 3 ;;
esac
echo updated >> test.txt
echo agy
`;

describe("agy adapter container execution", () => {
	before(() => {
		if (!dockerAvailable) return;

		writeFileSync(join(testRoot, "test.txt"), "base\n", "utf8");
		execSync("git init", { cwd: testRoot, stdio: "pipe" });
		execSync('git config user.email "test@test.com"', {
			cwd: testRoot,
			stdio: "pipe",
		});
		execSync('git config user.name "Test"', { cwd: testRoot, stdio: "pipe" });
		execSync("git add test.txt", { cwd: testRoot, stdio: "pipe" });
		execSync('git commit -m "base"', { cwd: testRoot, stdio: "pipe" });

		execSync(
			`docker run -d --name ${containerName} --entrypoint sh -v ${testRoot}:/project -w /project alpine/git -c "sleep infinity"`,
			{ stdio: "pipe" },
		);

		// Write the arg-checking stub on the host and copy it in (docker cp, not
		// the /project mount) so the multi-line `case` script survives intact
		// rather than fighting nested printf/quote escaping. captureDiff now
		// stages untracked files, so the stub copy the bind mount leaves in
		// /project also shows in the diff — harmless here: the assertion only
		// requires the tracked test.txt edit to be present.
		const stubPath = join(testRoot, "agy-stub.sh");
		writeFileSync(stubPath, AGY_STUB, { mode: 0o755 });
		execSync(`docker cp ${stubPath} ${containerName}:/usr/local/bin/agy`, {
			stdio: "pipe",
		});
		execSync(`docker exec ${containerName} chmod +x /usr/local/bin/agy`, {
			stdio: "pipe",
		});
	});

	after(() => {
		if (dockerAvailable) {
			try {
				execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
			} catch {
				// ignore cleanup errors
			}
		}
		rmSync(testRoot, { recursive: true, force: true });
	});

	it("passes --new-project --mode accept-edits --dangerously-skip-permissions --model and --print <prompt>, and captures the applied diff", {
		skip: !dockerAvailable,
	}, () => {
		// The stub exits non-zero unless the required flags, model arg, and
		// prompt are all present and correctly paired, so a green result here is
		// itself the assertion that executeAgy sends them.
		const result = executeAgy(AGY_PROMPT, containerName, {
			model: AGY_MODEL,
			resolvedTargetId: AGY_DESCRIPTOR.target_id,
			descriptorHarness: "agy",
			invocationDescriptor: AGY_DESCRIPTOR,
			descriptorIdentity: AGY_DESCRIPTOR.descriptor_identity,
			executionBackend: dockerExecutionBackend,
		});
		strictEqual(result.success, true, result.error);

		const diff = captureDiff(containerName, {
			executionBackend: dockerExecutionBackend,
		});
		ok(typeof diff === "string" && diff.includes("updated"));
		ok(diff.includes("diff --git"));
	});
});

it("rejects unsupported invocation argv before Docker", () => {
	const malformed = {
		...AGY_DESCRIPTOR,
		invocation_args: ["--effort", "high"],
	};
	const result = executeAgy(AGY_PROMPT, "unused-container", {
		model: AGY_MODEL,
		resolvedTargetId: AGY_DESCRIPTOR.target_id,
		descriptorHarness: "agy",
		invocationDescriptor: malformed,
		descriptorIdentity: AGY_DESCRIPTOR.descriptor_identity,
	});
	strictEqual(result.success, false);
});

describe("agy adapter host-side timeout", () => {
	it("keeps the host-side kill timeout longer than agy's own --print-timeout flag", () => {
		// Regression: the host-side execFileSync timeout was 300000ms (5min)
		// while executeAgy passes `--print-timeout 9m` (540000ms) to the CLI
		// itself. A valid run between 5 and 9 minutes was force-killed by the
		// host before agy's own timeout could fire — the host timeout is
		// meant as a backstop for a hung process, not the primary limit.
		const adapterPath = join(PROJECT_ROOT, "src/switchyard/adapter/agy.mjs");
		const source = readFileSync(adapterPath, "utf8");

		const printTimeoutMatch = source.match(
			/--print-timeout["'\s,]+["'](\d+)m["']/,
		);
		ok(
			printTimeoutMatch,
			"expected to find the --print-timeout CLI flag value",
		);
		const printTimeoutMs = Number(printTimeoutMatch[1]) * 60 * 1000;

		// The host-side timeout defaults to the shared
		// PROVIDER_EXECUTION_TIMEOUT_MS constant (see adapter/constants.mjs),
		// but is overridable per task (options.timeoutMs, e.g. a task's
		// `Timeout:` field) — so the literal passed to execFileSync is the
		// `timeoutMs` local, not the constant directly. What must still hold
		// is the DEFAULT: `timeoutMs = PROVIDER_EXECUTION_TIMEOUT_MS` in the
		// options destructuring, and `timeout: timeoutMs` at the call site.
		ok(
			/timeoutMs\s*=\s*PROVIDER_EXECUTION_TIMEOUT_MS/.test(source),
			"expected agy.mjs to default options.timeoutMs to PROVIDER_EXECUTION_TIMEOUT_MS",
		);
		ok(
			/timeout:\s*timeoutMs/.test(source),
			"expected agy.mjs to pass timeoutMs as the host-side execFileSync timeout",
		);
		const hostTimeoutMs = PROVIDER_EXECUTION_TIMEOUT_MS;

		ok(
			hostTimeoutMs > printTimeoutMs,
			`host timeout (${hostTimeoutMs}ms) must exceed agy's own --print-timeout (${printTimeoutMs}ms)`,
		);
	});
});

function fakeChild() {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = { end() {} };
	child.signals = [];
	child.kill = (signal) => {
		child.signals.push(signal);
		if (signal === "SIGKILL")
			queueMicrotask(() => child.emit("close", null, signal));
		return true;
	};
	return child;
}

describe("agy adapter workspace path resolution", () => {
	it("honors caller-provided workspace path in synchronous execution", () => {
		const alternateWorkspace = "/Users/switchyard/.switchyard/project";
		const calls = [];
		const fakeBackend = {
			execArgv(workspaceId, options) {
				calls.push({ workspaceId, ...options });
				return {
					command: process.execPath,
					args: ["-e", "process.stdout.write('sync ok'); process.exit(0);"],
				};
			},
		};

		const result = executeAgy(AGY_PROMPT, "test-container", {
			model: AGY_MODEL,
			cwd: alternateWorkspace,
			resolvedTargetId: AGY_DESCRIPTOR.target_id,
			descriptorHarness: "agy",
			invocationDescriptor: AGY_DESCRIPTOR,
			descriptorIdentity: AGY_DESCRIPTOR.descriptor_identity,
			executionBackend: fakeBackend,
		});

		strictEqual(result.success, true);
		strictEqual(calls.length, 1);
		strictEqual(calls[0].workspaceId, "test-container");
		strictEqual(calls[0].cwd, alternateWorkspace);

		const addDirIndex = calls[0].argv.indexOf("--add-dir");
		ok(addDirIndex !== -1, "expected --add-dir in agy argv");
		strictEqual(calls[0].argv[addDirIndex + 1], alternateWorkspace);
		strictEqual(
			calls[0].cwd,
			calls[0].argv[addDirIndex + 1],
			"caller-provided workspace path must match both --add-dir and execution backend cwd",
		);
	});

	it("honors caller-provided workspace path in asynchronous execution", async () => {
		const alternateWorkspace = "/custom/agy/workspace";
		const calls = [];
		const fakeBackend = {
			execArgv(workspaceId, options) {
				calls.push({ workspaceId, ...options });
				return {
					command: "fake-agy",
					args: ["arg"],
				};
			},
		};

		const child = fakeChild();
		const spawnFn = () => {
			queueMicrotask(() => {
				child.stdout.emit("data", "async ok\n");
				child.emit("close", 0, null);
			});
			return child;
		};

		const result = await executeAgyAsync(AGY_PROMPT, "test-container", {
			model: AGY_MODEL,
			cwd: alternateWorkspace,
			resolvedTargetId: AGY_DESCRIPTOR.target_id,
			descriptorHarness: "agy",
			invocationDescriptor: AGY_DESCRIPTOR,
			descriptorIdentity: AGY_DESCRIPTOR.descriptor_identity,
			executionBackend: fakeBackend,
			spawnFn,
		});

		strictEqual(result.success, true);
		strictEqual(calls.length, 1);
		strictEqual(calls[0].workspaceId, "test-container");
		strictEqual(calls[0].cwd, alternateWorkspace);

		const addDirIndex = calls[0].argv.indexOf("--add-dir");
		ok(addDirIndex !== -1, "expected --add-dir in agy argv");
		strictEqual(calls[0].argv[addDirIndex + 1], alternateWorkspace);
		strictEqual(
			calls[0].cwd,
			calls[0].argv[addDirIndex + 1],
			"caller-provided workspace path must match both --add-dir and execution backend cwd in async execution",
		);
	});
});
