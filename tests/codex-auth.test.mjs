import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	captureDiff,
	executeCodex,
	isCodexAuthenticated,
} from "../src/switchyard/adapter/codex.mjs";
import { validateInvocationDescriptor } from "../src/switchyard/roster/index.mjs";
import { createFakeExecutionBackend } from "./helpers/fake-execution-backend.mjs";

function hasDocker() {
	try {
		execSync("docker --version", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const dockerAvailable = hasDocker();

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
const CODEX_SHAPE_DESCRIPTOR = validateInvocationDescriptor(
	{
		target_id: "codex-shape-target",
		model_ref: "gpt-4o",
		selector: "gpt-4o",
		effort: null,
		variant: null,
		invocation_args: [],
	},
	"codex",
);

describe("codex adapter shell injection guard", () => {
	it("rejects workingContainerName with shell metacharacters", () => {
		const result = executeCodex("do something", "bad container; rm -rf /", {});
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("rejects model name with shell metacharacters", () => {
		const result = executeCodex("do something", "valid-container", {
			model: "gpt-4; echo INJECTED",
			resolvedTargetId: "codex-target",
			descriptorHarness: "codex",
			invocationDescriptor: {
				target_id: "codex-target",
				model_ref: "gpt-4; echo INJECTED",
				selector: "gpt-4; echo INJECTED",
				effort: null,
				variant: null,
				invocation_args: [],
			},
			descriptorIdentity: `sha256:${"0".repeat(64)}`,
		});
		strictEqual(result.success, false);
		ok(
			result.error?.includes("unsafe characters"),
			`expected unsafe-characters error, got: ${result.error}`,
		);
	});

	it("accepts a valid container name", () => {
		// Should not throw on validation — will fail at Docker exec (not available),
		// but the failure comes from Docker, not from input validation.
		const result = executeCodex("do something", "switchyard-work-1", {
			model: "gpt-4o",
		});
		// Either Docker is unavailable (success:false with docker error) or succeeds.
		// Key: no "unsafe characters" error.
		ok(
			!result.error?.includes("unsafe characters"),
			"valid identifier should not be rejected by validation",
		);
	});

	it("captureDiff rejects unsafe container names", () => {
		const diff = captureDiff("bad container; rm -rf /");
		strictEqual(diff, null, "captureDiff should return null for unsafe names");
	});

	it("does not execute shell metacharacters embedded in the prompt on the host", () => {
		// Regression test: an earlier version shell-interpolated the prompt into
		// a single-quoted `sh -c '...'` block without escaping single quotes.
		// A prompt containing an unescaped `'` would close that quoted region
		// early and let the remainder of the prompt run as literal shell syntax
		// in the *host* shell that invoked the whole docker command — a host
		// RCE via task text, not merely a captured-diff bug. The current
		// implementation delivers the prompt over stdin (never shell-parsed),
		// so this must be a no-op regardless of the container's existence.
		const markerDir = mkdtempSync(
			join(tmpdir(), "switchyard-prompt-injection-"),
		);
		const markerPath = join(markerDir, "marker");
		const evilPrompt = `wrap up'; touch ${markerPath}; echo '`;

		try {
			const result = executeCodex(
				evilPrompt,
				"switchyard-nonexistent-container",
				{},
			);
			strictEqual(result.success, false, "nonexistent container should fail");
			strictEqual(
				existsSync(markerPath),
				false,
				"prompt content must never be interpreted as host shell syntax",
			);
		} finally {
			rmSync(markerDir, { recursive: true, force: true });
		}
	});
});

describe("codex adapter invocation shape (real container)", () => {
	it("invokes the `codex exec` subcommand, not the bare interactive binary", {
		skip: !dockerAvailable,
	}, () => {
		// Regression: an earlier version called bare `codex` (no `exec`
		// subcommand). Per the CLI's own --help: "If no subcommand is
		// specified, options will be forwarded to the interactive CLI" —
		// so a real dispatch would launch the interactive TUI instead of
		// running non-interactively. The fake stub below fails loudly if
		// `exec` isn't argv[1], which a stub that merely ignores its argv
		// (as the adapter test's stub does) would never have caught.
		const containerName = `switchyard-codex-shape-${Date.now()}`;
		execSync(
			`docker run -d --name ${containerName} --entrypoint sh alpine -c "sleep 60"`,
			{ stdio: "pipe" },
		);
		try {
			execSync(`docker exec ${containerName} mkdir -p /project`, {
				stdio: "pipe",
			});
			execSync(
				`docker exec ${containerName} sh -c 'printf "#!/bin/sh\nif [ \\"\\$1\\" != exec ]; then echo MISSING_EXEC_SUBCOMMAND >&2; exit 1; fi\ncat >/dev/null\necho ok\n" > /usr/local/bin/codex && chmod +x /usr/local/bin/codex'`,
				{ stdio: "pipe" },
			);

			const result = executeCodex("do something", containerName, {
				model: "gpt-4o",
				resolvedTargetId: CODEX_SHAPE_DESCRIPTOR.target_id,
				descriptorHarness: "codex",
				invocationDescriptor: CODEX_SHAPE_DESCRIPTOR,
				descriptorIdentity: CODEX_SHAPE_DESCRIPTOR.descriptor_identity,
				executionBackend: dockerExecutionBackend,
			});
			strictEqual(result.success, true, result.error);
			ok(
				!result.output.includes("MISSING_EXEC_SUBCOMMAND"),
				`codex was invoked without its exec subcommand: ${result.output}`,
			);
		} finally {
			execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
		}
	});
});

describe("isCodexAuthenticated credential-validity check (fake guest)", () => {
	it("returns false when the credential is withheld/corrupt even though the binary responds", () => {
		// TASKS.md Task 15 "done when": with the CLI installed and answering
		// `--version` (liveness passes), a withheld or trivial auth.json must
		// make isCodexAuthenticated() return false — the false-positive the old
		// liveness-only check produced. `codex login` persists
		// ~/.codex/auth.json directly (TASKS.md Task 24), so that is the
		// checked path.
		const credPath = ".codex/auth.json";
		const files = {};
		const backend = createFakeExecutionBackend({
			version: "codex-cli 1.0.0",
			files,
		});

		// Credential withheld entirely.
		strictEqual(
			isCodexAuthenticated("fake-workspace", backend),
			false,
			"withheld credential must not read as authenticated",
		);

		// Credential present but empty (the empty-file bug shape).
		files[credPath] = "";
		strictEqual(
			isCodexAuthenticated("fake-workspace", backend),
			false,
			"empty credential file must not read as authenticated",
		);

		// Credential present but a trivial JSON stub.
		files[credPath] = "{}";
		strictEqual(
			isCodexAuthenticated("fake-workspace", backend),
			false,
			"trivial {} stub must not read as authenticated",
		);

		// Positive control: a non-trivial credential reads as authenticated
		// (pre-fix liveness-only logic returned true for all four states).
		files[credPath] = '{"OPENAI_API_KEY":"fake-codex-token-1234567890"}';
		strictEqual(
			isCodexAuthenticated("fake-workspace", backend),
			true,
			"a non-trivial persisted credential must read as authenticated",
		);
	});

	it("returns false when the binary doesn't respond to --version at all", () => {
		const backend = createFakeExecutionBackend({
			version: null,
			files: {
				".codex/auth.json": '{"OPENAI_API_KEY":"fake-codex-token-1234567890"}',
			},
		});
		strictEqual(
			isCodexAuthenticated("fake-workspace", backend),
			false,
			"missing binary must not read as authenticated even with credentials present",
		);
	});
});
