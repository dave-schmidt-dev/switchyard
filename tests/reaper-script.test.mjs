// Standalone launchd reaper contract tests. The copied script must be able to
// inventory managed VM names without project access, while making no resource
// changes from hourly execution.

import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
	accessSync,
	chmodSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/tempdir.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const OPS = resolve(PKG_ROOT, "ops");
const BACKEND = resolve(
	PKG_ROOT,
	"src/switchyard/lifecycle/parallels-execution-backend.mjs",
);
const REAPER = resolve(OPS, "switchyard-reaper.sh");
const SCRIPTS = [REAPER].concat(
	["install-reaper.sh", "uninstall-reaper.sh"].map((f) => resolve(OPS, f)),
);
const TEMPLATE = resolve(OPS, "com.zerodelta.switchyard.reaper.plist.template");
const HAS_TRUSTED_GNU_TIMEOUT = [
	"/opt/homebrew/bin/gtimeout",
	"/opt/homebrew/bin/timeout",
	"/usr/local/bin/gtimeout",
	"/usr/local/bin/timeout",
].some((candidate) => {
	const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
	return (
		result.status === 0 && result.stdout.startsWith("timeout (GNU coreutils) ")
	);
});

describe("standalone reaper ops artifacts", () => {
	it("ships all reaper scripts, executable", () => {
		for (const script of SCRIPTS) {
			ok(existsSync(script), `missing: ${script}`);
			accessSync(script, constants.X_OK);
		}
	});

	it("every reaper script passes `sh -n` syntax validation", () => {
		for (const script of SCRIPTS) {
			const result = spawnSync("sh", ["-n", script], { encoding: "utf8" });
			strictEqual(
				result.status,
				0,
				`sh -n failed for ${script}: ${result.stderr}`,
			);
		}
	});

	it("is reporting-only and has no project or background metadata authority", () => {
		const body = readFileSync(REAPER, "utf8");
		ok(!/\bnode\b/.test(body), "reaper must not invoke node");
		ok(!/\bpython3?\b/.test(body), "reaper must not invoke python");
		ok(/"\$PRLCTL" list\s+-a/.test(body), "reaper must inventory managed VMs");
		ok(
			!/"\$PRLCTL"\s+(?:stop|delete)\b/.test(body),
			"hourly reaper must not stop or delete VMs",
		);
		ok(
			!/kill -0 "\$creator_pid"/.test(body),
			"hourly reaper must not treat creator PID liveness as ownership",
		);
		ok(
			!/inventory_pid|watchdog_pid/.test(body),
			"reaper must not supervise by PID",
		);
		ok(body.includes("/opt/homebrew/bin/gtimeout"));
		ok(body.includes('"$TIMEOUT_BIN" --signal=TERM --kill-after=1s 3s'));
		ok(
			!/"\$TIMEOUT_BIN"[^\n]*--foreground/.test(body),
			"supervisor invocation must use default process-group mode",
		);
		ok(
			!body.includes("linked-snapshots"),
			"hourly reaper must not read background snapshot metadata",
		);
	});

	it("keeps its managed VM-name prefix in sync with the lifecycle backend", () => {
		const reaper = readFileSync(REAPER, "utf8");
		const backend = readFileSync(BACKEND, "utf8");
		const sourcePrefix = /PARALLELS_WORKING_PREFIX\s*=\s*"([^"]+)"/.exec(
			backend,
		)?.[1];
		const reaperPrefix = /WORKING_PREFIX="([^"]+)"/.exec(reaper)?.[1];
		ok(sourcePrefix, "could not read PARALLELS_WORKING_PREFIX from backend");
		ok(reaperPrefix, "could not read WORKING_PREFIX from reaper");
		strictEqual(reaperPrefix, sourcePrefix);
	});

	it("plist template renders to a valid, placeholder-free plist", () => {
		const template = readFileSync(TEMPLATE, "utf8");
		for (const placeholder of [
			"__REAPER_SH__",
			"__REAPER_OUT__",
			"__REAPER_ERR__",
		]) {
			ok(
				template.includes(placeholder),
				`template must contain ${placeholder}`,
			);
		}
		const rendered = template
			.replaceAll("__REAPER_SH__", "/tmp/switchyard-reaper.sh")
			.replaceAll("__REAPER_OUT__", "/tmp/out.log")
			.replaceAll("__REAPER_ERR__", "/tmp/err.log");
		const lint = spawnSync("plutil", ["-lint", "-"], {
			input: rendered,
			encoding: "utf8",
		});
		if (lint.error) return;
		strictEqual(lint.status, 0, `plutil -lint failed: ${lint.stdout}`);
	});

	it("installer documents copied reporting-only operation", () => {
		const installer = readFileSync(resolve(OPS, "install-reaper.sh"), "utf8");
		ok(installer.includes("reports at load + every 3600s"));
		ok(installer.includes("never reclaims resources"));
		ok(installer.includes("GNU timeout required"));
	});
});

describe("copied launchd reaper", () => {
	function runInstalledReaper({
		behavior = "success",
		installCli = true,
		supervisorMode,
	} = {}) {
		const root = tempDir("switchyard-reaper-");
		const home = join(root, "home");
		const installDir = join(
			home,
			"Library",
			"Application Support",
			"switchyard",
		);
		const deniedProject = join(root, "project-denied");
		const binDir = join(root, "bin");
		const installed = join(installDir, "switchyard-reaper.sh");
		const callsPath = join(root, "prlctl-calls.log");
		mkdirSync(installDir, { recursive: true });
		mkdirSync(join(home, "Library", "Logs"), { recursive: true });
		mkdirSync(binDir, { recursive: true });
		mkdirSync(deniedProject);
		copyFileSync(REAPER, installed);
		chmodSync(installed, 0o755);
		const prlctl = join(binDir, "prlctl");
		if (installCli) {
			const body =
				behavior === "hung"
					? `#!/bin/sh
printf '%s\\n' "$*" >>'${callsPath}'
trap '' TERM
while :; do :; done
`
					: behavior === "slow"
						? `#!/bin/sh
printf '%s\\n' "$*" >>'${callsPath}'
while :; do :; done
`
						: behavior === "failed"
							? `#!/bin/sh
printf '%s\\n' "$*" >>'${callsPath}'
exit 7
`
							: behavior === "many"
								? `#!/bin/sh
printf '%s\\n' "$*" >>'${callsPath}'
printf '%s\\n' 'UUID STATUS NAME'
i=0
while [ "$i" -lt 300 ]; do
	printf 'id-%s running switchyard-work-run-%s-999999\\n' "$i" "$i"
	i=$((i + 1))
done
`
								: behavior === "large"
									? `#!/bin/sh
printf '%s\\n' "$*" >>'${callsPath}'
exec /bin/dd if=/dev/zero bs=262144 count=5 2>/dev/null
`
									: behavior === "medium"
										? `#!/bin/sh
printf '%s\\n' "$*" >>'${callsPath}'
printf '%s\\n' 'UUID STATUS NAME'
printf '%s' 'padding running '
/bin/dd if=/dev/zero bs=1024 count=600 2>/dev/null | /usr/bin/tr '\\000' x
printf '\\n%s\\n' 'kept running switchyard-work-medium-999999'
`
										: `#!/bin/sh
printf '%s\\n' "$*" >>'${callsPath}'
case "$1" in
	list)
		printf '%s\\n' 'UUID STATUS NAME'
		printf '%s\\n' 'dead-owner running switchyard-work-run-dead-999999'
		printf '%s\\n' 'missing-metadata stopped switchyard-work-run-missing-999998'
		printf '%s\\n' 'foreign running unrelated-vm'
		;;
esac
`;
			writeFileSync(prlctl, body, { mode: 0o755 });
		}
		chmodSync(deniedProject, 0o000);
		const startedAt = Date.now();
		const env = {
			HOME: home,
			PATH: "/launchd-minimal",
			PWD: deniedProject,
			TMPDIR: root,
			SWITCHYARD_REAPER_PRLCTL: prlctl,
			SWITCHYARD_RUN_STORE_ROOT: deniedProject,
		};
		if (supervisorMode) {
			env.SWITCHYARD_REAPER_TESTING = "1";
			env.SWITCHYARD_REAPER_TEST_SUPERVISOR = supervisorMode;
		}
		const result = spawnSync("/bin/sh", [installed], {
			encoding: "utf8",
			timeout: 8_000,
			env,
		});
		chmodSync(deniedProject, 0o755);
		const log = readFileSync(
			join(home, "Library", "Logs", "switchyard-reaper.log"),
			"utf8",
		);
		const calls = existsSync(callsPath) ? readFileSync(callsPath, "utf8") : "";
		return { calls, elapsedMs: Date.now() - startedAt, log, result, root };
	}

	function assertOnlyInventoryCalls(calls, expectedCount = 1) {
		const lines = calls.trim() === "" ? [] : calls.trimEnd().split("\n");
		strictEqual(lines.length, expectedCount, calls);
		for (const line of lines) strictEqual(line, "list -a -o uuid,status,name");
	}

	it("reports candidates but never changes resources under a minimal launchd PATH", {
		skip: !HAS_TRUSTED_GNU_TIMEOUT && "trusted GNU timeout unavailable",
	}, () => {
		const { calls, log, result, root } = runInstalledReaper();
		try {
			strictEqual(result.status, 0, result.stderr);
			assertOnlyInventoryCalls(calls);
			strictEqual(
				(log.match(/ownership unverified; no resource changed/g) ?? []).length,
				2,
				`expected two candidate diagnostics, log was:\n${log}`,
			);
			ok(log.includes("managed VM inventory started"));
			ok(log.includes("managed VM inventory complete (candidates=2"));
			ok(
				!log.includes("dead-owner"),
				"diagnostics must not retain VM contents",
			);
			ok(!log.includes("switchyard-work-run-dead"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts inventory above 512 KiB and below the one-MiB output cap", {
		skip: !HAS_TRUSTED_GNU_TIMEOUT && "trusted GNU timeout unavailable",
	}, () => {
		const { calls, log, result, root } = runInstalledReaper({
			behavior: "medium",
		});
		try {
			strictEqual(result.status, 0, result.stderr);
			assertOnlyInventoryCalls(calls);
			ok(log.includes("managed VM inventory complete (candidates=1"), log);
			ok(!log.includes("inventory truncated"), log);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	for (const fixture of [
		{
			name: "reports status 124 when inventory ends on the deadline TERM",
			options: { behavior: "slow" },
			expected: "managed VM inventory timed out",
			maxElapsedMs: 6_000,
			noCandidates: true,
			expectedCalls: 1,
		},
		{
			name: "kills and reaps a TERM-ignoring inventory within its absolute budget",
			options: { behavior: "hung" },
			expected: "inventory supervision terminated",
			maxElapsedMs: 7_000,
			noCandidates: true,
			expectedCalls: 1,
		},
		{
			name: "reports failed inventory without claiming completion",
			options: { behavior: "failed" },
			expected: "managed VM inventory unavailable",
			maxElapsedMs: 3_000,
			noCandidates: true,
			expectedCalls: 1,
		},
		{
			name: "reports a missing CLI without claiming completion",
			options: { installCli: false },
			expected: "prlctl not found on PATH",
			maxElapsedMs: 3_000,
			noCandidates: true,
			expectedCalls: 0,
		},
		{
			name: "reports bounded row truncation without claiming completion",
			options: { behavior: "many" },
			expected: "managed VM inventory truncated (row limit=256",
			maxElapsedMs: 5_000,
			noCandidates: false,
			expectedCalls: 1,
		},
		{
			name: "rejects a 1.25-MiB inventory at the one-MiB output limit",
			options: { behavior: "large" },
			expected: "managed VM inventory truncated (output limit reached",
			maxElapsedMs: 3_000,
			noCandidates: true,
			expectedCalls: 1,
		},
		{
			name: "fails closed before inventory when the GNU supervisor is missing",
			options: { supervisorMode: "missing" },
			expected: "GNU timeout supervisor unavailable",
			maxElapsedMs: 3_000,
			noCandidates: true,
			expectedCalls: 0,
			requiresGnu: false,
		},
		{
			name: "fails closed before inventory when the supervisor is not GNU timeout",
			options: { supervisorMode: "wrong" },
			expected: "GNU timeout supervisor unavailable",
			maxElapsedMs: 3_000,
			noCandidates: true,
			expectedCalls: 0,
			requiresGnu: false,
		},
	]) {
		it(fixture.name, {
			skip:
				fixture.requiresGnu !== false &&
				!HAS_TRUSTED_GNU_TIMEOUT &&
				"trusted GNU timeout unavailable",
		}, () => {
			const { calls, elapsedMs, log, result, root } = runInstalledReaper(
				fixture.options,
			);
			try {
				strictEqual(result.status, 0, result.stderr);
				ok(
					elapsedMs < fixture.maxElapsedMs,
					`reaper exceeded its test budget: ${elapsedMs}ms`,
				);
				ok(log.includes(fixture.expected), log);
				ok(!log.includes("inventory complete"), log);
				if (fixture.noCandidates)
					ok(!log.includes("ownership unverified"), log);
				assertOnlyInventoryCalls(calls, fixture.expectedCalls);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
});
