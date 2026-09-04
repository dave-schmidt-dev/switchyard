import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	captureDiff,
	execute as executeOpencode,
	OPENCODE_SUPERVISOR,
} from "../src/switchyard/adapter/opencode.mjs";
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
		});
		ok(typeof diff === "string" && diff.includes("updated"));
		ok(diff.includes("diff --git"));
	});
});
