import { ok, strictEqual } from "node:assert";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	execute as executeOpencode,
	executeAsync as executeOpencodeAsync,
	OPENCODE_SUPERVISOR,
} from "../src/switchyard/adapter/opencode.mjs";
import { validateInvocationDescriptor } from "../src/switchyard/roster/index.mjs";
import { dockerAvailable } from "./helpers/docker.mjs";

// Regression coverage for the container-side idle bound. `opencode run` starts
// an in-process local server and never exits (anomalyco/opencode#17516), and
// because the lingering process holds `docker exec`'s stdout pipe the host
// cannot shorten the wait from outside. These tests stand in a stub that
// reproduces exactly that shape: emit output, then never exit.

const testRoot = mkdtempSync(join(tmpdir(), "switchyard-opencode-idle-"));
const realPsPath = execSync("command -v ps", { encoding: "utf8" }).trim();
const containerName = `switchyard-opencode-idle-${Date.now()}`;
const IDLE_SECONDS = 5;
const STUB_OUTPUT = "stub-did-the-work";
const STUB_STDERR_MARKER = "stub-diagnostic-on-stderr";
// Long enough that a surviving stub is unambiguous, and distinctive enough to
// tell apart from the container's own `sleep infinity` init.
const STUB_HANG_MARKER = "sleep 604";

const DESCRIPTOR = validateInvocationDescriptor(
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

// Emits output like a finished task, then parks forever holding its stdout —
// the observed upstream behaviour.
const STUB_WORKS_THEN_HANGS = `#!/bin/sh
echo ${STUB_OUTPUT}
exec ${STUB_HANG_MARKER}
`;

// Never emits anything. The idle bound must NOT fire here: silence from the
// first byte onward is indistinguishable from a provider that never started
// working, so the host deadline stays responsible for classifying it.
const STUB_SILENT_HANG = `#!/bin/sh
exec ${STUB_HANG_MARKER}
`;

// Writes only progress chatter on stderr and never produces a result on stdout,
// then hangs. Observed live against opencode 1.18.5 on a transient provider
// failure: the task was not performed, so this must not be booked as a success.
const STUB_STDERR_ONLY_HANG = `#!/bin/sh
echo "build · some-model" >&2
echo "thinking" >&2
exec ${STUB_HANG_MARKER}
`;

// Produces a result on stdout AND a diagnostic on stderr, then hangs. An
// idle-terminated run is booked as a success, so the provider's own words are
// the only explanation of what it did — they have to reach the record. fd 2 is
// shared with the supervisor's heartbeat, which must not.
const STUB_WORKS_WITH_STDERR_THEN_HANGS = `#!/bin/sh
echo ${STUB_OUTPUT}
echo ${STUB_STDERR_MARKER} >&2
exec ${STUB_HANG_MARKER}
`;

function installStub(body) {
	const stubPath = join(testRoot, "opencode-stub.sh");
	writeFileSync(stubPath, body, { mode: 0o755 });
	execSync(`docker cp ${stubPath} ${containerName}:/usr/local/bin/opencode`, {
		stdio: "pipe",
	});
	execSync(`docker exec ${containerName} chmod +x /usr/local/bin/opencode`, {
		stdio: "pipe",
	});
}

// Counts the stub's hang still resident in the container. Matched on the hang
// itself rather than on argv[0], because a shell stub reports argv[0] as the
// interpreter — this stays accurate regardless of how the stub is launched.
function survivingStubs() {
	const out = execSync(
		`docker exec ${containerName} sh -c 'for p in /proc/[0-9]*; do tr "\\0" " " <$p/cmdline 2>/dev/null; echo; done'`,
		{ encoding: "utf8", stdio: "pipe" },
	);
	return out.split("\n").filter((line) => line.includes(STUB_HANG_MARKER));
}

function writeExecutable(path, body) {
	writeFileSync(path, body, { mode: 0o755 });
}

function runSupervisor(commandDir, idleSeconds = 1) {
	return spawnSync(
		"sh",
		["-c", OPENCODE_SUPERVISOR, "sh", String(idleSeconds), "opencode"],
		{
			env: {
				...process.env,
				PATH: `${commandDir}:${process.env.PATH ?? ""}`,
			},
			encoding: "utf8",
			timeout: 15_000,
		},
	);
}

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

const invocationOptions = {
	model: "fake-model",
	resolvedTargetId: DESCRIPTOR.target_id,
	descriptorHarness: "opencode",
	invocationDescriptor: DESCRIPTOR,
	descriptorIdentity: DESCRIPTOR.descriptor_identity,
	executionBackend: dockerExecutionBackend,
};

describe("opencode container-side idle bound", () => {
	before(() => {
		if (!dockerAvailable) return;
		process.env.SWITCHYARD_OPENCODE_IDLE_SECONDS = String(IDLE_SECONDS);
		execSync(
			`docker run -d --name ${containerName} --entrypoint sh -v ${testRoot}:/project -w /project alpine/git -c "sleep infinity"`,
			{ stdio: "pipe" },
		);
	});

	after(() => {
		delete process.env.SWITCHYARD_OPENCODE_IDLE_SECONDS;
		if (dockerAvailable) {
			try {
				execSync(`docker rm -f -v ${containerName}`, { stdio: "pipe" });
			} catch {
				// ignore cleanup errors
			}
		}
		rmSync(testRoot, { recursive: true, force: true });
	});

	it("terminates a finished-but-not-exiting provider and reports success", {
		skip: !dockerAvailable,
		timeout: 120_000,
	}, () => {
		installStub(STUB_WORKS_THEN_HANGS);
		const startedAt = Date.now();
		const result = executeOpencode("marker", containerName, {
			...invocationOptions,
			// Far longer than the idle bound: if the wait is shortened, it is the
			// supervisor doing it and not this deadline.
			timeoutMs: 90_000,
		});
		const elapsedMs = Date.now() - startedAt;

		strictEqual(result.success, true);
		strictEqual(result.idleTerminated, true);
		ok(result.output.includes(STUB_OUTPUT));
		ok(result.output.includes("[switchyard]"));
		ok(
			elapsedMs < 45_000,
			`expected the idle bound to return early, took ${elapsedMs}ms`,
		);
		strictEqual(survivingStubs().length, 0);
	});

	it("terminates on the async path too", {
		skip: !dockerAvailable,
		timeout: 120_000,
	}, async () => {
		installStub(STUB_WORKS_THEN_HANGS);
		const startedAt = Date.now();
		const result = await executeOpencodeAsync("marker", containerName, {
			...invocationOptions,
			timeoutMs: 90_000,
		});
		const elapsedMs = Date.now() - startedAt;

		strictEqual(result.success, true);
		strictEqual(result.idleTerminated, true);
		ok(result.output.includes(STUB_OUTPUT));
		ok(result.output.includes("[switchyard]"));
		ok(
			elapsedMs < 45_000,
			`expected the idle bound to return early, took ${elapsedMs}ms`,
		);
		strictEqual(survivingStubs().length, 0);
	});

	// executeAsync destructures `stderr` off the lifecycle result to keep its
	// return shape identical to the sync path's, which makes `output` the only
	// place the diagnostic can live. Nothing else exercises that hand-off.
	it("carries provider stderr into an idle-terminated success, not supervisor noise", {
		skip: !dockerAvailable,
		timeout: 120_000,
	}, async () => {
		installStub(STUB_WORKS_WITH_STDERR_THEN_HANGS);
		// The supervisor heartbeats at 15s elapsed, so a shorter window leaves
		// nothing to strip and the negative assertion below would pass vacuously.
		process.env.SWITCHYARD_OPENCODE_IDLE_SECONDS = "16";
		let result;
		try {
			result = await executeOpencodeAsync("marker", containerName, {
				...invocationOptions,
				timeoutMs: 90_000,
			});
		} finally {
			process.env.SWITCHYARD_OPENCODE_IDLE_SECONDS = String(IDLE_SECONDS);
		}

		strictEqual(result.success, true);
		strictEqual(result.idleTerminated, true);
		ok(result.output.includes(STUB_OUTPUT));
		ok(result.output.includes("[switchyard] provider stderr at termination:"));
		ok(result.output.includes(STUB_STDERR_MARKER));
		ok(!result.output.includes("switchyard: opencode alive"));
		strictEqual(result.stderr, undefined);
		strictEqual(survivingStubs().length, 0);
	});

	it("does not idle-terminate a provider that never produced output", {
		skip: !dockerAvailable,
		timeout: 120_000,
	}, () => {
		installStub(STUB_SILENT_HANG);
		const result = executeOpencode("marker", containerName, {
			...invocationOptions,
			// Comfortably past the idle bound, so a missing zero-output guard
			// would surface here as a spurious success.
			timeoutMs: 20_000,
		});

		strictEqual(result.success, false);
		strictEqual(result.timedOut, true);
		ok(result.idleTerminated === undefined);
	});

	it("does not idle-terminate on stderr chatter with no result", {
		skip: !dockerAvailable,
		timeout: 120_000,
	}, () => {
		installStub(STUB_STDERR_ONLY_HANG);
		const result = executeOpencode("marker", containerName, {
			...invocationOptions,
			timeoutMs: 20_000,
		});

		strictEqual(result.success, false);
		strictEqual(result.timedOut, true);
		ok(result.idleTerminated === undefined);
	});

	for (const state of ["Ss", "S+", "Z+"]) {
		it(`matches macOS ps state prefix ${state}`, () => {
			const commandDir = mkdtempSync(join(testRoot, `state-${state}-`));
			const psCountPath = join(commandDir, "ps-count");
			writeFileSync(psCountPath, "0\n");
			writeExecutable(
				join(commandDir, "ps"),
				`#!/bin/sh
count=$(cat '${psCountPath}')
count=$((count + 1))
printf '%s\\n' "$count" >'${psCountPath}'
if [ "$count" -le 2 ]; then
  printf '${state}\\n'
else
  exec '${realPsPath}' "$@"
fi
`,
			);
			writeExecutable(
				join(commandDir, "opencode"),
				"#!/bin/sh\necho mac-state-output\nsleep 2\n",
			);

			const result = runSupervisor(commandDir);
			if (state.startsWith("Z")) {
				strictEqual(result.status, 0);
			} else {
				strictEqual(result.status, 75);
			}
			ok(result.stdout.includes("mac-state-output"));
			rmSync(commandDir, { recursive: true, force: true });
		});
	}

	it("treats an unprobeable PID as alive", () => {
		const commandDir = mkdtempSync(join(testRoot, "unprobeable-"));
		writeExecutable(join(commandDir, "ps"), "#!/bin/sh\nexit 1\n");
		writeExecutable(
			join(commandDir, "opencode"),
			"#!/bin/sh\necho unprobeable-output\nsleep 2\n",
		);

		const result = runSupervisor(commandDir);
		strictEqual(result.status, 75);
		ok(result.stdout.includes("unprobeable-output"));
		rmSync(commandDir, { recursive: true, force: true });
	});

	it("sweeps a surviving named process and reports a nonzero count", () => {
		const commandDir = mkdtempSync(join(testRoot, "sweep-"));
		const pidPath = join(commandDir, "survivor-pid");
		writeExecutable(
			join(commandDir, "pgrep"),
			`#!/bin/sh
case "$*" in
  *"-x opencode"*) cat '${pidPath}' ;;
  *) exit 1 ;;
esac
`,
		);
		writeExecutable(
			join(commandDir, "opencode"),
			`#!/bin/sh
sleep 60 &
echo $! >'${pidPath}'
echo sweep-output
exec sleep 60
`,
		);

		const result = runSupervisor(commandDir);
		strictEqual(result.status, 75);
		ok(
			/swept [1-9][0-9]* surviving opencode process\(es\)/u.test(result.stderr),
			result.stderr,
		);
		rmSync(commandDir, { recursive: true, force: true });
	});
});
