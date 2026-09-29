import { spawnSync } from "node:child_process";
import { PrlctlCallError } from "../adapter/exec-error.mjs";

export const PARALLELS_WORKING_PREFIX = "switchyard-work-";
export const MAX_AQUA_EXEC_ARGV_BYTES = 600000;
export const HOST_PROCESS_IDENTITY_VERSION = "switchyard-host-process-v1";
export const ALLOCATION_INTENT_PREFIX = "parallels-allocation-";
export const ALLOCATION_INTENT_SUFFIX = ".intent.json";
export const HOST_PROCESS_IDENTITY_TIMEOUT_MS = 2_000;
export const HOST_PROCESS_IDENTITY_MAX_BUFFER = 4_096;
export const CANONICAL_UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const HOST_PROCESS_IDENTITY = new RegExp(
	`^${HOST_PROCESS_IDENTITY_VERSION}:([0-9a-f-]{36}):([1-9]\\d*):([1-9]\\d*)$`,
	"iu",
);
export const HOST_PROCESS_PROBE_SOURCE = `
import ctypes, errno, json, sys, uuid
VERSION = "switchyard-host-process-v1"
LIBPROC = "/usr/lib/libproc.dylib"
LIBSYSTEM = "/usr/lib/libSystem.B.dylib"
class RusageInfoV0(ctypes.Structure):
    _fields_ = [("ri_uuid", ctypes.c_ubyte * 16)] + [("u%d" % i, ctypes.c_uint64) for i in range(10)]
if ctypes.sizeof(RusageInfoV0) != 96:
    raise SystemExit(70)
if len(sys.argv) != 2 or not sys.argv[1].isdigit() or int(sys.argv[1]) <= 0:
    raise SystemExit(64)
pid = int(sys.argv[1])
libsystem = ctypes.CDLL(LIBSYSTEM, use_errno=True)
sysctlbyname = libsystem.sysctlbyname
sysctlbyname.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
sysctlbyname.restype = ctypes.c_int
boot_buffer = ctypes.create_string_buffer(128)
boot_length = ctypes.c_size_t(len(boot_buffer))
ctypes.set_errno(0)
boot_rc = sysctlbyname(b"kern.bootsessionuuid", boot_buffer, ctypes.byref(boot_length), None, 0)
boot_errno = ctypes.get_errno()
if boot_rc != 0 or boot_errno != 0:
    raise SystemExit(71)
try:
    boot = str(uuid.UUID(boot_buffer.value.decode("ascii")))
except Exception:
    raise SystemExit(72)
libproc = ctypes.CDLL(LIBPROC, use_errno=True)
proc_pid_rusage = libproc.proc_pid_rusage
proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.POINTER(RusageInfoV0)]
proc_pid_rusage.restype = ctypes.c_int
info = RusageInfoV0()
ctypes.set_errno(0)
proc_rc = proc_pid_rusage(pid, 0, ctypes.byref(info))
proc_errno = ctypes.get_errno()
if proc_rc == 0 and proc_errno == 0:
    result = {"version": VERSION, "state": "present", "pid": str(pid), "bootSessionUuid": boot, "startTicks": str(info.u8)}
elif proc_rc == -1 and proc_errno == errno.ESRCH:
    result = {"version": VERSION, "state": "absent", "pid": str(pid), "bootSessionUuid": boot, "startTicks": None}
else:
    raise SystemExit(73)
sys.stdout.write(json.dumps(result, separators=(",", ":")))
`;

export function parseHostProcessProbe(value, expectedPid) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const fields = ["version", "state", "pid", "bootSessionUuid", "startTicks"];
	if (
		Object.keys(value).length !== fields.length ||
		fields.some((field) => !Object.hasOwn(value, field)) ||
		value.version !== HOST_PROCESS_IDENTITY_VERSION ||
		!["present", "absent"].includes(value.state) ||
		typeof value.pid !== "string" ||
		!/^[1-9]\d*$/.test(value.pid) ||
		Number(value.pid) !== expectedPid ||
		!Number.isSafeInteger(Number(value.pid)) ||
		typeof value.bootSessionUuid !== "string" ||
		!CANONICAL_UUID.test(value.bootSessionUuid)
	)
		return null;
	const bootSessionUuid = value.bootSessionUuid.toLowerCase();
	if (value.state === "absent") {
		return value.startTicks === null
			? { state: "absent", pid: expectedPid, bootSessionUuid, identity: null }
			: null;
	}
	if (
		typeof value.startTicks !== "string" ||
		!/^[1-9]\d*$/.test(value.startTicks) ||
		BigInt(value.startTicks) > 18_446_744_073_709_551_615n
	)
		return null;
	return {
		state: "present",
		pid: expectedPid,
		bootSessionUuid,
		startTicks: value.startTicks,
		identity: `${HOST_PROCESS_IDENTITY_VERSION}:${bootSessionUuid}:${value.pid}:${value.startTicks}`,
	};
}

export function parseHostProcessIdentity(value) {
	if (typeof value !== "string") return null;
	const match = value.match(HOST_PROCESS_IDENTITY);
	if (!match || !CANONICAL_UUID.test(match[1])) return null;
	const pid = Number(match[2]);
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	try {
		if (BigInt(match[3]) > 18_446_744_073_709_551_615n) return null;
	} catch {
		return null;
	}
	return {
		bootSessionUuid: match[1].toLowerCase(),
		pid,
		startTicks: match[3],
		identity: `${HOST_PROCESS_IDENTITY_VERSION}:${match[1].toLowerCase()}:${match[2]}:${match[3]}`,
	};
}

/** Probe one host PID's kernel birth identity through a fixed macOS ABI. */
export function probeHostProcessIdentity(
	pid,
	{ spawnFn = spawnSync, onStatus } = {},
) {
	const validatedPid = validatePid(pid);
	onStatus?.({ type: "host-process-identity", event: "start" });
	let child;
	try {
		child = spawnFn(
			"/usr/bin/python3",
			["-I", "-S", "-c", HOST_PROCESS_PROBE_SOURCE, String(validatedPid)],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: HOST_PROCESS_IDENTITY_TIMEOUT_MS,
				killSignal: "SIGKILL",
				maxBuffer: HOST_PROCESS_IDENTITY_MAX_BUFFER,
				env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
			},
		);
	} catch {
		onStatus?.({ type: "host-process-identity", event: "unavailable" });
		return { state: "unknown" };
	}
	if (
		child?.error ||
		child?.signal ||
		child?.status !== 0 ||
		typeof child?.stdout !== "string" ||
		Buffer.byteLength(child.stdout, "utf8") > HOST_PROCESS_IDENTITY_MAX_BUFFER
	) {
		onStatus?.({ type: "host-process-identity", event: "unavailable" });
		return { state: "unknown" };
	}
	let parsed;
	try {
		parsed = parseHostProcessProbe(JSON.parse(child.stdout), validatedPid);
	} catch {
		parsed = null;
	}
	if (!parsed) {
		onStatus?.({ type: "host-process-identity", event: "unavailable" });
		return { state: "unknown" };
	}
	onStatus?.({
		type: "host-process-identity",
		event: "complete",
		state: parsed.state,
	});
	return parsed;
}
// A cold macOS guest has to reach a logged-in Aqua session before
// `launchctl print gui/<uid>` answers, and 30s was inside the noise band of
// how long that actually takes: the INV-3 gate's whole create-boot-destroy
// leg measured 51s on an idle 18-core host, and the 30s budget produced two
// observed `not ready within 30000ms` failures that each passed on rerun --
// one of them at a load average of 4.3 with 81% CPU idle, so this was never
// host contention. waitForAqua returns the instant the probe succeeds, so a
// larger budget costs nothing on the happy path; it only slows how fast a
// genuinely unbootable guest is reported.
export const DEFAULT_AQUA_TIMEOUT_MS = 120_000;
export const DEFAULT_AQUA_POLL_MS = 250;

// INV-1 clone hardening. `com.parallels.copypaste` is the only Parallels GUI
// LaunchAgent in the guest, and `prlcopypaste` is the process it starts; the
// prltoolsd LaunchDaemon is deliberately not touched, because `prlctl exec` --
// including every call in this file -- rides on it.
export const CLIPBOARD_AGENT_LABEL = "com.parallels.copypaste";
export const CLIPBOARD_AGENT_PROCESS = "prlcopypaste";
// Measured on this host: prltoolsd starts at boot and the clipboard agent
// appears about five seconds later, so the settle window has to outlast a
// respawn rather than sampling once into the gap.
export const DEFAULT_CLIPBOARD_SETTLE_MS = 8_000;
export const DEFAULT_CLIPBOARD_POLL_MS = 1_000;

// Workspace preparation reconciliation. The three commands that build the
// workspace are silent, so prlctl's exit status is the only signal they give
// back -- and prlctl loses that signal outright when its host-side job handle
// misfires. Measured 2026-08-31: `/bin/chmod 700 <parent> <root>` returned
// host status 255 with empty stderr/stdout beyond `PrlJob_GetRetCode: Invalid
// argument`, microseconds after `mkdir -p` and `chown` succeeded on those same
// two paths. PrlJob_GetRetCode is a host-side SDK call, so that is prlctl
// failing to read the guest's result, not the guest refusing the command.
// Every one of these commands is idempotent, so a mismatch is safe to repair
// by simply running the layout again.
export const DEFAULT_WORKSPACE_VERIFY_TIMEOUT_MS = 15_000;
export const DEFAULT_WORKSPACE_VERIFY_POLL_MS = 500;
export const WORKSPACE_PREPARE_ATTEMPTS = 2;
export const WORKSPACE_MODE = "700";

// Shutdown settle window. `prlctl stop` returns before Parallels has finished
// tearing the VM down, and a delete issued into that gap is refused with a
// truthful "the virtual machine is busy. The virtual machine is currently
// running." Measured 2026-08-31 on the INV-1 gate: the delete failed, the
// reprobe read `running` once and gave up, and the same VM reported `stopped`
// moments later -- so the stop had in fact succeeded and the teardown leaked a
// VM over a race with itself. A settling state has to be polled to a deadline;
// one instantaneous read of it decides nothing.
export const DEFAULT_STOP_SETTLE_TIMEOUT_MS = 30_000;
// The golden gets its own, longer settle budget. 30s was calibrated for
// disposable clones, where overrunning it costs a `--kill` on a VM that was
// going to be discarded anyway. The golden is not disposable and is never
// killed, so overrunning it instead reports a healthy macOS guest -- which can
// take well past 30s to reach `stopped` after ACPI shutdown -- as stuck.
export const DEFAULT_GOLDEN_STOP_SETTLE_TIMEOUT_MS = 120_000;
export const DEFAULT_STOP_SETTLE_POLL_MS = 1_000;
export const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const UUID =
	/^\{?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}?$/i;
export const SAFE_GUEST_PATH = /^\/[A-Za-z0-9._+@%+=:,\-/]*$/;
export const SAFE_USER = /^[A-Za-z_][A-Za-z0-9._-]*$/;

/**
 * The Task 1.3 credential layout, relative to the provider account's home.
 *
 * Every path here was measured inside the guest on 2026-08-14, not inferred
 * from the CLI's shape: each file was moved aside and the provider's own auth
 * check re-run through the Aqua session, so a `yes` means that provider
 * actually authenticated from a copied file. Two results are worth keeping in
 * view because they invert the obvious guess. **copilot is file-backed** —
 * `login --help` advertises the system credential store, which on macOS is the
 * login Keychain, but the token lands in `~/.copilot/config.json` and a copy of
 * it works. **agy writes a `gemini` Keychain entry after authenticating** and
 * still fails without its token file, so Keychain presence is not evidence of
 * Keychain backing.
 *
 * `cursor-agent` is deliberately absent. It is the PM3-5 case: file-backed in
 * shape, machine-bound in behavior. With `.config/cursor/auth.json`,
 * `.cursor/cli-config.json`, and `.cursor/agent-cli-state.json` all provisioned
 * it still reported `Not logged in`. A routed VM task must fail here rather
 * than at exec inside a guest that holds a store the CLI refuses.
 */
export const VM_CREDENTIAL_LAYOUTS = Object.freeze({
	claude: Object.freeze([".claude/.credentials.json", ".claude.json"]),
	codex: Object.freeze([".codex/auth.json"]),
	agy: Object.freeze([".gemini/antigravity-cli/antigravity-oauth-token"]),
	copilot: Object.freeze([".copilot/config.json"]),
	opencode: Object.freeze([".local/share/opencode/auth.json"]),
});
export const DEFAULT_TRANSFER_HOST = "10.211.55.2";
// Bind on the Parallels host-only interface. Binding all interfaces leaves
// the listener reachable from unrelated host networks and was not reachable
// from the guest on this substrate's shared bridge.
export const MAX_TRANSFER_BYTES = 512 * 1024 * 1024;
// Parallels 27.0.0 intermittently loses the result of a host-side SDK job and
// reports it as one of these on exit 255 with no other output. Measured
// 2026-09-01 against the golden image on an idle host, in a plain shell loop
// with switchyard entirely absent: 5 of 150 serial `prlctl exec` calls
// misfired, 14 of 100 under four concurrent callers, and every serial misfire
// succeeded on the very next call. It is transient and per-call, so a bounded
// retry is the correct response; without one, a run making ~20 exec calls has
// roughly even odds of dying on a fault that costs milliseconds to absorb.
export const PRLCTL_JOB_MISFIRE =
	/PrlJob_(?:GetRetCode|GetResult):\s*Invalid argument/i;
// Deliberately NOT retried here. A guest still booting refuses the session with
// this message (48 of the first 100 calls after `prlctl start`), and the
// readiness pollers already own that wait on a timescale of minutes. Retrying
// it inside `_call` would both distort those polls and mask an unbootable
// guest as a slow one. It is classified only so the run record can tell the two
// conditions apart.
export const PRLCTL_SESSION_NOT_READY =
	/Unable to open new session in this virtual machine/i;
// Four attempts absorbs the measured misfire rate with margin: at the observed
// ~3.3% serial rate a single retry already clears it, and even at the 14%
// concurrent rate four attempts leaves a ~4-in-10,000 residual per call.
export const DEFAULT_PRLCTL_RETRY_ATTEMPTS = 4;
export const DEFAULT_PRLCTL_RETRY_BACKOFF_MS = 250;
// Queue admission needs proof that the host service can return a complete VM
// inventory, not merely that the prlctl binary is installed. This is a small,
// dedicated budget for that read-only check; it must not inherit _call's
// retry policy, because clone/start/delete are not made retryable by probing.
// Every prlctl call gets a deadline. Observed 2026-09-08: a `prlctl stop --kill`
// issued while a guest was still booting hung for 3h32m and had to be killed by
// hand, taking a VM and a test harness with it. No _call site is long-running --
// the bulk transfer runs in its own helper process and never reaches here -- so
// this is generous for clone/delete/start/stop rather than a tuned bound, and
// every site that needs a tighter one already passes its own. The kill signal is
// SIGKILL because the failure being bounded is a wedged client that a SIGTERM
// may not reach; a killed mutation of unknown outcome is what the state probes
// exist to resolve, and it is strictly better than blocking forever.
export const DEFAULT_PRLCTL_CALL_TIMEOUT_MS = 300_000;
export const DEFAULT_HOST_READINESS_ATTEMPTS = 2;
export const DEFAULT_HOST_READINESS_BACKOFF_MS = 100;
export const DEFAULT_HOST_READINESS_TIMEOUT_MS = 2_000;
export const HOST_READINESS_MAX_BUFFER = 1024 * 1024;
export const HOST_PERMISSION_DENIED_SIGNATURE =
	/(?:^|\n)(?:\/usr\/local\/bin\/prlctl: line \d+: )?\/bin\/ps:\s*Operation not permitted(?:\n|$)/u;
// This remains deliberately disabled until an attended, disposable-VM run has
// observed both an already-satisfied postcondition and a lost SDK result for
// each newly covered mutation.  The budget belongs to the read-only proof, not
// to a second mutation attempt.
export const DEFAULT_LOST_MUTATION_RECONCILIATION_TIMEOUT_MS = 5_000;
export const DEFAULT_LOST_MUTATION_RECONCILIATION_POLL_MS = 250;
// Only these may be persisted as the failing subcommand. Every value is a
// literal this file passes to `_call`; allowlisting rather than echoing argv
// keeps a guest-influenced string from reaching a run record.
export const PRLCTL_SUBCOMMANDS = Object.freeze(
	new Set([
		"--version",
		"clone",
		"delete",
		"exec",
		"list",
		"set",
		"snapshot-delete",
		"snapshot-list",
		"start",
		"stop",
	]),
);
export const PERSISTABLE_PRLCTL_SIGNALS = Object.freeze(
	new Set(["SIGABRT", "SIGHUP", "SIGINT", "SIGKILL", "SIGQUIT", "SIGTERM"]),
);

export function prlctlHostPermissionDenied(error) {
	if (!(error instanceof PrlctlCallError)) return false;
	const text = Buffer.isBuffer(error.stderr)
		? error.stderr.toString("utf8")
		: typeof error.stderr === "string"
			? error.stderr
			: "";
	return HOST_PERMISSION_DENIED_SIGNATURE.test(text);
}
export const PROVIDER_PID_MARKER_PREFIX = "/tmp/switchyard-provider-";
export const VM_OWNERSHIP_SCHEMA_VERSION = 1;
export const PROCESS_MARKER_SCHEMA_VERSION = 1;
export const PROVIDER_TERMINAL_EVIDENCE_SCHEMA_VERSION = 1;
export const PROVIDER_TERMINAL_EVIDENCE_MAX_BYTES = 1024;
export const PROVIDER_TERMINAL_EVIDENCE_KIND = "switchyard_provider_terminal";
// The bulk-transfer URL is only known once the helper has bound its ephemeral
// port, so it reaches the guest as a plaintext argv assignment that the helper
// substitutes. The variable name deliberately does not contain the placeholder
// token, or the substitution would rewrite the name along with the value.
export const XFER_URL_ASSIGNMENT = "SWITCHYARD_XFER_URL=TRANSFER_URL";
export const INDEX_LOCK_PATH = "/project/.git/index.lock";
export const CLEANUP_STARTED = "cleanup_started";
export const PID_OBSERVED = "pid_observed";
export const TREE_TERMINATED = "tree_terminated";
export const PID_MARKER_REMOVED = "pid_marker_removed";
export const INDEX_LOCK_REMOVED = "index_lock_removed";
export const KILL_GUEST_PROCESS_TREE = String.raw`
set -eu
root="$1"

children() {
  /bin/ps -axo pid=,ppid= | /usr/bin/awk -v parent="$1" '$2 == parent { print $1 }'
}

collect_descendants() {
  for child in $(children "$1"); do
    printf '%s\n' "$child"
    collect_descendants "$child"
  done
}

alive() {
  /bin/ps -axo pid=,state= | /usr/bin/awk -v target="$1" '$1 == target && $2 !~ /^Z/ { found = 1 } END { exit(found ? 0 : 1) }'
}

signal_tree() {
  signal="$1"
  pid="$2"
  for child in $(collect_descendants "$pid"); do
    /bin/kill "-$signal" "$child" 2>/dev/null || true
  done
  /bin/kill "-$signal" "$pid" 2>/dev/null || true
}

signal_tree TERM "$root"
for _ in $(/usr/bin/seq 1 20); do
  survivors=""
  alive "$root" && survivors="$root"
  descendants="$(collect_descendants "$root")"
  if [ -n "$descendants" ]; then
    if [ -n "$survivors" ]; then
      survivors="$survivors $descendants"
    else
      survivors="$descendants"
    fi
  fi
  [ -z "$survivors" ] && exit 0
  /bin/sleep 0.05
done

signal_tree KILL "$root"
/bin/sleep 0.05
survivors=""
alive "$root" && survivors="$root"
descendants="$(collect_descendants "$root")"
if [ -n "$descendants" ]; then
  if [ -n "$survivors" ]; then
    survivors="$survivors $descendants"
  else
    survivors="$descendants"
  fi
fi
[ -z "$survivors" ]
`;

export function validatePid(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		throw new Error("creatorPid must be a positive integer");
	}
	return pid;
}
