import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	captureDiff,
	execute as executeCopilot,
} from "../src/switchyard/adapter/copilot.mjs";
import { validateInvocationDescriptor } from "../src/switchyard/roster/index.mjs";
import { dockerAvailable } from "./helpers/docker.mjs";

const testRoot = mkdtempSync(join(tmpdir(), "switchyard-copilot-adapter-"));
const containerName = `switchyard-copilot-adapter-${Date.now()}`;

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
const COPILOT_DESCRIPTOR = validateInvocationDescriptor(
	{
		target_id: "copilot-target",
		model_ref: "fake-model",
		selector: "fake-model",
		effort: null,
		variant: null,
		invocation_args: [],
	},
	"copilot",
);

const COPILOT_STUB = `#!/bin/sh
# The prompt belongs in argv only; stdin must be closed and empty.
if [ -n "$(cat)" ]; then
  echo "stub: received unexpected stdin payload" >&2
  exit 4
fi
case " $* " in
  *" -p "*) ;;
  *) echo "stub: executeCopilot did not pass -p; args: $*" >&2; exit 3 ;;
esac
case " $* " in
  *" --allow-all-tools "*) ;;
  *) echo "stub: executeCopilot did not pass --allow-all-tools; args: $*" >&2; exit 3 ;;
esac
case " $* " in
  *" --no-ask-user "*) ;;
  *) echo "stub: executeCopilot did not pass --no-ask-user; args: $*" >&2; exit 3 ;;
esac
# The prompt is delivered through exactly one -p option.
count_p=$(echo " $* " | grep -o " -p " | wc -l)
if [ "$count_p" -ne 1 ]; then
  echo "stub: expected exactly one -p flag, found $count_p; args: $*" >&2
  exit 5
fi
echo updated >> test.txt
echo copilot
`;

describe("copilot adapter container execution", () => {
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

		const stubPath = join(testRoot, "copilot-stub.sh");
		writeFileSync(stubPath, COPILOT_STUB, { mode: 0o755 });
		execSync(`docker cp ${stubPath} ${containerName}:/usr/local/bin/copilot`, {
			stdio: "pipe",
		});
		execSync(`docker exec ${containerName} chmod +x /usr/local/bin/copilot`, {
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

	it("passes noninteractive prompt and tool permissions, then captures the diff", {
		skip: !dockerAvailable,
	}, () => {
		const result = executeCopilot("apply a small change", containerName, {
			model: "fake-model",
			resolvedTargetId: COPILOT_DESCRIPTOR.target_id,
			descriptorHarness: "copilot",
			invocationDescriptor: COPILOT_DESCRIPTOR,
			descriptorIdentity: COPILOT_DESCRIPTOR.descriptor_identity,
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

it("rejects unsupported invocation argv before Docker", () => {
	const malformed = {
		...COPILOT_DESCRIPTOR,
		invocation_args: ["--effort", "high"],
	};
	const result = executeCopilot("apply a small change", "unused-container", {
		model: "fake-model",
		resolvedTargetId: COPILOT_DESCRIPTOR.target_id,
		descriptorHarness: "copilot",
		invocationDescriptor: malformed,
		descriptorIdentity: COPILOT_DESCRIPTOR.descriptor_identity,
	});
	strictEqual(result.success, false);
});
