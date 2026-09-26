import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	captureDiff,
	execute as executeOpencode,
	executeAsync as executeOpencodeAsync,
	OPENCODE_SUPERVISOR,
} from "../src/switchyard/adapter/opencode.mjs";
import { captureTaskStartTree } from "../src/switchyard/lifecycle/index.mjs";
import { validateInvocationDescriptor } from "../src/switchyard/roster/index.mjs";
import { dockerAvailable } from "./helpers/docker.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const testRoot = tempDir("switchyard-opencode-adapter-");
const containerName = `switchyard-opencode-adapter-${Date.now()}`;

// getWorkspaceExecution (provider-lifecycle.mjs) now requires an
// executionBackend with no default -- the removed DEFAULT_EXECUTION_BACKEND
// used to fill this in for real-container integration tests.
const dockerExecutionBackend = {
	execArgv(workspaceId, { cwd = "/project", argv } = {}) {
		return {
			command: "docker",
			args: ["exec", "-i", "-w", cwd, workspaceId, ...argv],
		};
	},
};
const PROMPT_MARKER = "switchyard-prompt-marker";
const OPENCODE_DESCRIPTOR = validateInvocationDescriptor(
	{
		target_id: "opencode-target",
		model_ref: "fake-model",
		selector: "fake-model",
		effort: null,
		variant: "thinking",
		invocation_args: ["--variant", "thinking"],
	},
	"opencode",
);

const OPENCODE_STUB = `#!/bin/sh
cat >/dev/null
case " $* " in
  *" run "*) ;;
  *) echo "stub: executeOpencode did not invoke the run subcommand; args: $*" >&2; exit 4 ;;
esac
case " $* " in
  *" --agent build "*) ;;
  *) echo "stub: executeOpencode did not pass --agent build; args: $*" >&2; exit 3 ;;
esac
case " $* " in
  *" --auto "*) ;;
  *) echo "stub: executeOpencode did not pass --auto; args: $*" >&2; exit 3 ;;
esac
case " $* " in
  *" --variant thinking "*) ;;
  *) echo "stub: executeOpencode did not forward descriptor variant; args: $*" >&2; exit 3 ;;
esac
case " $* " in
  *"${PROMPT_MARKER}"*) ;;
  *) echo "stub: executeOpencode did not forward positional prompt; args: $*" >&2; exit 5 ;;
esac
echo updated >> test.txt
echo opencode
`;

describe("opencode adapter container execution", () => {
	it("uses portable supervisor process probes", () => {
		ok(!OPENCODE_SUPERVISOR.includes("/proc"));
		ok(OPENCODE_SUPERVISOR.includes("ps -o state= -p"));
		ok(OPENCODE_SUPERVISOR.includes("Z*)"));
		ok(OPENCODE_SUPERVISOR.includes("pgrep -x"));
	});

	it("invokes ordinary opencode run with --agent build and --auto while preserving variant and model", () => {
		let captured = null;
		const backend = {
			execArgv(workspaceId, { argv } = {}) {
				captured = { workspaceId, argv };
				return {
					command: process.execPath,
					args: ["-e", 'process.stdout.write("ordinary-ran")'],
				};
			},
		};
		const descriptor = validateInvocationDescriptor(
			{
				target_id: "opencode-target",
				model_ref: "fake-model",
				selector: "fake-model",
				effort: null,
				variant: "thinking",
				invocation_args: ["--variant", "thinking"],
			},
			"opencode",
		);
		const result = executeOpencode("test prompt", "container-test-123", {
			model: descriptor.selector,
			resolvedTargetId: descriptor.target_id,
			descriptorHarness: "opencode",
			invocationDescriptor: descriptor,
			descriptorIdentity: descriptor.descriptor_identity,
			executionBackend: backend,
		});
		strictEqual(result.success, true);
		strictEqual(result.output, "ordinary-ran");
		strictEqual(captured.workspaceId, "container-test-123");
		const runIdx = captured.argv.indexOf("run");
		ok(runIdx !== -1, "must include run subcommand");
		strictEqual(captured.argv[runIdx + 1], "--agent");
		strictEqual(captured.argv[runIdx + 2], "build");
		strictEqual(captured.argv[runIdx + 3], "--auto");
		const variantIdx = captured.argv.indexOf("--variant");
		strictEqual(variantIdx, runIdx + 4);
		strictEqual(captured.argv[variantIdx + 1], "thinking");
		const modelIdx = captured.argv.indexOf("--model");
		strictEqual(modelIdx, variantIdx + 2);
		strictEqual(captured.argv[modelIdx + 1], "fake-model");
		ok(captured.argv.at(-1).includes("test prompt"));
	});

	it("hands approved API-key models to the backend's fixed bridge over stdin", () => {
		let request = null;
		const bridgeBackend = {
			ephemeralOpenCodeKeyExecution(workspaceId, candidate) {
				request = { workspaceId, ...candidate };
				return {
					command: process.execPath,
					args: [
						"-e",
						'const input = JSON.parse(require("node:fs").readFileSync(0, "utf8")); if (input.bridge !== "fixed") process.exit(9); process.stdout.write("bridge-ran")',
					],
					input: JSON.stringify({ bridge: "fixed" }),
				};
			},
		};
		const descriptor = validateInvocationDescriptor(
			{
				target_id: "opencode-go",
				model_ref: "opencode-go/mimo-v2.5",
				selector: "opencode-go/mimo-v2.5",
				effort: null,
				variant: null,
				invocation_args: [],
			},
			"opencode",
		);
		const result = executeOpencode(
			"bridge prompt",
			"22222222-2222-4222-8222-222222222222",
			{
				model: descriptor.selector,
				resolvedTargetId: descriptor.target_id,
				descriptorHarness: "opencode",
				invocationDescriptor: descriptor,
				descriptorIdentity: descriptor.descriptor_identity,
				executionBackend: bridgeBackend,
			},
		);
		strictEqual(result.success, true);
		strictEqual(result.output, "bridge-ran");
		strictEqual(request.workspaceId, "22222222-2222-4222-8222-222222222222");
		strictEqual(request.model, "opencode-go/mimo-v2.5");
		ok(request.prompt.includes("bridge prompt"));
	});

	it("accepts a Vibe-owned Mistral GLM descriptor without inheriting the opencode-go target", () => {
		let request = null;
		const bridgeBackend = {
			ephemeralOpenCodeKeyExecution(workspaceId, candidate) {
				request = { workspaceId, ...candidate };
				return {
					command: process.execPath,
					args: ["-e", 'process.stdout.write("mistral-bridge-ran")'],
					input: "",
				};
			},
		};
		const descriptor = validateInvocationDescriptor(
			{
				target_id: "vibe",
				model_ref: "mistral/zai-glm-5-2",
				selector: "mistral/zai-glm-5-2",
				effort: null,
				variant: "max",
				invocation_args: ["--variant", "max"],
			},
			"opencode",
		);

		const result = executeOpencode(
			"bridge prompt",
			"33333333-3333-4333-8333-333333333333",
			{
				model: descriptor.selector,
				resolvedTargetId: descriptor.target_id,
				descriptorHarness: "opencode",
				invocationDescriptor: descriptor,
				descriptorIdentity: descriptor.descriptor_identity,
				executionBackend: bridgeBackend,
			},
		);

		strictEqual(result.success, true);
		strictEqual(result.output, "mistral-bridge-ran");
		strictEqual(request.model, "mistral/zai-glm-5-2");
		strictEqual(request.invocationArgs.join(" "), "--variant max");
	});

	it("reconciles async exit 255 with caller cleanup context and clears confirmed evidence", async () => {
		const workspaceId = "44444444-4444-4444-8444-444444444444";
		const token = "attempt-terminal-token";
		const cleanupContext = {
			runId: "opencode-run",
			taskId: "R6",
			attemptId: "opencode-attempt-1",
			descriptorIdentity: OPENCODE_DESCRIPTOR.descriptor_identity,
			workspaceId,
			operation: "provider",
		};
		let readContext = null;
		let clearContext = null;
		const executionBackend = {
			execArgv(_workspaceId, candidate) {
				deepStrictEqual(candidate.cleanupContext, cleanupContext);
				return {
					command: "fake-opencode",
					args: [...candidate.argv],
					terminalEvidence: { token },
				};
			},
			readProviderTerminalEvidence(_workspaceId, context, evidence) {
				readContext = context;
				strictEqual(evidence.token, token);
				return { status: "confirmed", exitCode: 0 };
			},
			clearProviderTerminalEvidence(_workspaceId, context) {
				clearContext = context;
				return { status: "removed" };
			},
		};
		const result = await executeOpencodeAsync("change one file", workspaceId, {
			model: OPENCODE_DESCRIPTOR.selector,
			resolvedTargetId: OPENCODE_DESCRIPTOR.target_id,
			descriptorHarness: "opencode",
			invocationDescriptor: OPENCODE_DESCRIPTOR,
			descriptorIdentity: OPENCODE_DESCRIPTOR.descriptor_identity,
			executionBackend,
			cleanupContext,
			spawnFn: () => {
				const child = new EventEmitter();
				child.stdout = new EventEmitter();
				child.stderr = new EventEmitter();
				child.stdin = { end() {} };
				child.kill = () => true;
				queueMicrotask(() => child.emit("close", 255, null));
				return child;
			},
		});

		strictEqual(result.success, true);
		strictEqual(result.terminalEvidenceStatus, "confirmed");
		strictEqual(result.terminalEvidenceCleanupStatus, "removed");
		deepStrictEqual(readContext, cleanupContext);
		deepStrictEqual(clearContext, cleanupContext);
	});

	it("merges bridge cleanup context with the runner attempt on cancellation", async () => {
		const workspaceId = "55555555-5555-4555-8555-555555555555";
		const descriptor = validateInvocationDescriptor(
			{
				target_id: "opencode-go",
				model_ref: "opencode-go/mimo-v2.5",
				selector: "opencode-go/mimo-v2.5",
				effort: null,
				variant: null,
				invocation_args: [],
			},
			"opencode",
		);
		const cleanupContext = {
			taskId: "R6",
			attemptId: "opencode-attempt-2",
			descriptorIdentity: descriptor.descriptor_identity,
			workspaceId,
			operation: "provider",
		};
		let cleanupOptions = null;
		const executionBackend = {
			ephemeralOpenCodeKeyExecution() {
				return {
					command: "fixed-bridge",
					args: ["opencode-go", "--"],
					input: "non-secret test input",
					cleanupContext: { workspaceId },
				};
			},
			cleanupProviderProcess(_command, _args, options) {
				cleanupOptions = options;
				return { cleanupFailed: false, postcondition: true };
			},
		};
		const controller = new AbortController();
		controller.abort();
		const result = await executeOpencodeAsync("change one file", workspaceId, {
			model: descriptor.selector,
			resolvedTargetId: descriptor.target_id,
			descriptorHarness: "opencode",
			invocationDescriptor: descriptor,
			descriptorIdentity: descriptor.descriptor_identity,
			executionBackend,
			cleanupContext,
			signal: controller.signal,
			termGraceMs: 1,
			spawnFn: () => {
				const child = new EventEmitter();
				child.stdout = new EventEmitter();
				child.stderr = new EventEmitter();
				child.stdin = { end() {} };
				child.kill = (signal) => {
					queueMicrotask(() => child.emit("close", null, signal));
					return true;
				};
				return child;
			},
		});

		strictEqual(result.cancelled, true);
		deepStrictEqual(cleanupOptions, {
			onStatus: undefined,
			...cleanupContext,
		});
	});

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

		const stubPath = join(testRoot, "opencode-stub.sh");
		writeFileSync(stubPath, OPENCODE_STUB, { mode: 0o755 });
		execSync(`docker cp ${stubPath} ${containerName}:/usr/local/bin/opencode`, {
			stdio: "pipe",
		});
		execSync(`docker exec ${containerName} chmod +x /usr/local/bin/opencode`, {
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

	it("captures the applied diff", {
		skip: !dockerAvailable,
	}, () => {
		const taskBase = captureTaskStartTree(
			dockerExecutionBackend,
			containerName,
			{
				runId: "opencode-adapter",
				taskId: "1.1",
			},
		);
		const result = executeOpencode(PROMPT_MARKER, containerName, {
			model: "fake-model",
			resolvedTargetId: OPENCODE_DESCRIPTOR.target_id,
			descriptorHarness: "opencode",
			invocationDescriptor: OPENCODE_DESCRIPTOR,
			descriptorIdentity: OPENCODE_DESCRIPTOR.descriptor_identity,
			executionBackend: dockerExecutionBackend,
		});
		strictEqual(result.success, true);

		const diff = captureDiff(containerName, {
			executionBackend: dockerExecutionBackend,
			taskBase,
		});
		ok(typeof diff === "string" && diff.includes("updated"));
		ok(diff.includes("diff --git"));
	});
});
