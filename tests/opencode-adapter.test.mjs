import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	captureDiff,
	execute as executeOpencode,
} from "../src/switchyard/adapter/opencode.mjs";
import { validateInvocationDescriptor } from "../src/switchyard/roster/index.mjs";

function hasDocker() {
	try {
		execSync("docker --version", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const dockerAvailable = hasDocker();
const testRoot = mkdtempSync(join(tmpdir(), "switchyard-opencode-adapter-"));
const containerName = `switchyard-opencode-adapter-${Date.now()}`;
const PROMPT_MARKER = "switchyard-prompt-marker";
const OPENCODE_DESCRIPTOR = validateInvocationDescriptor(
	{
		target_id: "opencode-target",
		model_ref: "fake-model",
		selector: "fake-model",
		effort: null,
		variant: "high",
		invocation_args: ["--variant", "high"],
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
  *" --variant high "*) ;;
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
		});
		strictEqual(result.success, true);

		const diff = captureDiff(containerName);
		ok(typeof diff === "string" && diff.includes("updated"));
		ok(diff.includes("diff --git"));
	});
});
