// Behavior tests for the noninteractive OpenCode golden-VM updater.
//
// The fake prlctl records every host mutation and captures the guest stdin
// script. No Parallels VM, provider, registry, or credential is touched.

import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { tempDir } from "./helpers/tempdir.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "ops/macos-vm/update-opencode-cli.sh");
const BASH = "/bin/bash";
const VERSION = "1.18.30";
const SHA256 = "a".repeat(64);

const mockPrlctl = `#!/bin/bash
set -u
printf '%s\\n' "$*" >> "$PRL_LOG"
case "\${1:-}" in
  status)
    if [[ "\${PRL_STATUS_FORMAT:-state}" == exact ]]; then
      printf 'VM %s exist %s\\n' "$2" "$(<"$PRL_STATE")"
    elif [[ "\${PRL_STATUS_FORMAT:-state}" == ambiguous ]]; then
      printf 'VM other-vm exist stopped\\n'
    else
      printf 'State: %s\\n' "$(<"$PRL_STATE")"
    fi
    ;;
  start)
    printf 'running' > "$PRL_STATE"
    [[ "\${PRL_START_FAIL:-0}" == 1 ]] && exit 19
    exit 0
    ;;
  stop)
    if [[ "\${PRL_STOP_FAIL:-0}" == 1 ]]; then
      [[ "\${PRL_STOP_LEAVES_STOPPED:-0}" == 1 ]] && printf 'stopped' > "$PRL_STATE"
      exit 23
    fi
    printf 'stopped' > "$PRL_STATE"
    ;;
  exec)
    if [[ "\${5:-}" == ':' ]]; then
      exit "\${PRL_READY_RC:-0}"
    fi
    if [[ "\${4:-}" == -s ]]; then
      cat > "$PRL_GUEST_SCRIPT"
      if [[ "\${PRL_HANG_GUEST:-0}" == 1 ]]; then
        while :; do :; done
      fi
      exit "\${PRL_EXEC_RC:-0}"
    fi
    ;;
esac
`;

function fixture({
	state = "stopped",
	startFail = false,
	stopFail = false,
	stopLeavesStopped = true,
	execRc = 0,
	hangGuest = false,
	statusFormat = "state",
} = {}) {
	const dir = tempDir("switchyard-opencode-update-");
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const log = join(dir, "prlctl.log");
	const statePath = join(dir, "state");
	const guest = join(dir, "guest.sh");
	const manifest = join(dir, "manifest.txt");
	const sleep = join(bin, "sleep");
	writeFileSync(statePath, state);
	writeFileSync(log, "");
	writeFileSync(guest, "");
	writeFileSync(manifest, `opencode|npm|opencode-ai|${VERSION}|${SHA256}\n`);
	writeFileSync(join(dir, "prlctl"), mockPrlctl);
	writeFileSync(sleep, "#!/bin/bash\nexit 0\n");
	chmodSync(join(dir, "prlctl"), 0o755);
	chmodSync(sleep, 0o755);
	return {
		dir,
		manifest,
		guest,
		env: {
			...process.env,
			PATH: `${bin}:${dir}:${process.env.PATH}`,
			PRL_LOG: log,
			PRL_STATE: statePath,
			PRL_GUEST_SCRIPT: guest,
			PRL_STOP_FAIL: stopFail ? "1" : "0",
			PRL_STOP_LEAVES_STOPPED: stopLeavesStopped ? "1" : "0",
			PRL_START_FAIL: startFail ? "1" : "0",
			PRL_EXEC_RC: String(execRc),
			PRL_HANG_GUEST: hangGuest ? "1" : "0",
			PRL_STATUS_FORMAT: statusFormat,
		},
	};
}

function run(args, env = process.env) {
	return spawnSync(BASH, [SCRIPT, ...args], {
		env,
		encoding: "utf8",
	});
}

describe("update-opencode-cli.sh", () => {
	it("exists, is executable, and passes bash syntax", () => {
		ok(existsSync(SCRIPT));
		accessSync(SCRIPT, constants.X_OK);
		const result = spawnSync(BASH, ["-n", SCRIPT], { encoding: "utf8" });
		strictEqual(result.status, 0, result.stderr);
		const source = readFileSync(SCRIPT, "utf8");
		const guestStart = source.indexOf(
			'prlctl exec "$VM_NAME" /bin/bash -s <<EOF',
		);
		ok(guestStart !== -1);
		ok(!/\brm\b/.test(source.slice(0, guestStart)));
	});

	it("fails closed when prlctl is unavailable", () => {
		const f = fixture();
		const result = run(["--vm", "golden", "--cli-manifest", f.manifest], {
			...f.env,
			PATH: "/usr/bin:/bin",
		});
		ok(result.status !== 0);
		ok(result.stderr.includes("missing host tool: prlctl"));
		strictEqual(readFileSync(join(f.dir, "prlctl.log"), "utf8"), "");
	});

	it("rejects missing and bad arguments without invoking prlctl", () => {
		const cases = [
			[],
			["--vm", "bad name", "--cli-manifest", "/tmp/nope"],
			["--vm", "golden", "--cli-manifest", "relative.txt"],
			["--vm", "golden", "--cli-manifest"],
		];
		for (const args of cases) {
			const result = run(args);
			ok(result.status !== 0, `accepted bad args: ${args.join(" ")}`);
		}
	});

	it("rejects manifests without exactly one valid OpenCode npm row", () => {
		for (const contents of [
			`copilot|npm|@github/copilot|1.0.80|${"b".repeat(64)}\n`,
			`opencode|npm|other-package|1.18.30|${SHA256}\n`,
			`opencode|npm|opencode-ai|1.18.30|${SHA256}\n` +
				`opencode|npm|opencode-ai|1.18.30|${SHA256}\n`,
		]) {
			const f = fixture();
			writeFileSync(f.manifest, contents);
			const result = run(
				["--vm", "golden", "--cli-manifest", f.manifest],
				f.env,
			);
			ok(result.status !== 0, result.stderr);
			strictEqual(readFileSync(join(f.dir, "prlctl.log"), "utf8"), "");
		}
	});

	it("refuses a running VM before any mutation", () => {
		const f = fixture({ state: "running" });
		const result = run(["--vm", "golden", "--cli-manifest", f.manifest], f.env);
		ok(result.status !== 0);
		strictEqual(
			readFileSync(join(f.dir, "prlctl.log"), "utf8"),
			"status golden\n",
		);
		strictEqual(readFileSync(join(f.dir, "state"), "utf8"), "running");
	});

	it("rejects a stopped status for a different or ambiguous VM", () => {
		const f = fixture({ statusFormat: "ambiguous" });
		const result = run(["--vm", "golden", "--cli-manifest", f.manifest], f.env);
		ok(result.status !== 0);
		strictEqual(
			readFileSync(join(f.dir, "prlctl.log"), "utf8"),
			"status golden\n",
		);
	});

	it("starts, captures the exact pinned guest script, and stops in order", () => {
		const f = fixture();
		const result = run(["--vm", "golden", "--cli-manifest", f.manifest], f.env);
		strictEqual(result.status, 0, result.stderr);
		const calls = readFileSync(join(f.dir, "prlctl.log"), "utf8")
			.trim()
			.split("\n");
		strictEqual(
			calls.join(" | "),
			"status golden | start golden | exec golden /bin/bash -lc : | exec golden /bin/bash -s | stop golden | status golden",
		);
		strictEqual(readFileSync(join(f.dir, "state"), "utf8"), "stopped");
		const guest = readFileSync(f.guest, "utf8");
		ok(guest.includes("readonly package='opencode-ai'"));
		ok(guest.includes(`readonly version='${VERSION}'`));
		ok(guest.includes(`readonly expected_sha256='${SHA256}'`));
		ok(guest.includes("launchctl asuser"));
		ok(
			guest.includes(
				`npm pack --silent "$SWITCHYARD_OPENCODE_PACKAGE@$SWITCHYARD_OPENCODE_VERSION"`,
			),
		);
		ok(guest.includes("npm install --global --allow-scripts=opencode-ai"));
		// The guest body is interpolated by an outer host heredoc.  Do not put
		// awk's positional `$1` in it: that would expand to the host script's
		// first argument (`--vm`) before the guest runs.
		ok(guest.includes('/usr/bin/cut -d " " -f 1'));
		ok(!guest.includes('awk "{print'));
		ok(guest.includes('rm -rf -- "$workdir"'));
		ok(!calls.some((call) => call.includes(SHA256) || call.includes(VERSION)));
		const syntax = spawnSync(BASH, ["-n", f.guest], { encoding: "utf8" });
		strictEqual(syntax.status, 0, syntax.stderr);
	});

	it("accepts the exact Parallels VM stopped status shape", () => {
		const f = fixture({ statusFormat: "exact" });
		const result = run(["--vm", "golden", "--cli-manifest", f.manifest], f.env);
		strictEqual(result.status, 0, result.stderr);
		const calls = readFileSync(join(f.dir, "prlctl.log"), "utf8");
		ok(calls.includes("start golden\n"));
		ok(calls.includes("stop golden\n"));
	});

	it("stops a VM that became running despite a failed start result", () => {
		const f = fixture({ startFail: true });
		const result = run(["--vm", "golden", "--cli-manifest", f.manifest], f.env);
		strictEqual(result.status, 19, result.stderr);
		const calls = readFileSync(join(f.dir, "prlctl.log"), "utf8")
			.trim()
			.split("\n");
		strictEqual(
			calls.join(" | "),
			"status golden | start golden | stop golden | status golden",
		);
		strictEqual(readFileSync(join(f.dir, "state"), "utf8"), "stopped");
	});

	it("stops the VM when guest installation fails", () => {
		const f = fixture({ execRc: 17 });
		const result = run(["--vm", "golden", "--cli-manifest", f.manifest], f.env);
		strictEqual(result.status, 17, result.stderr);
		const calls = readFileSync(join(f.dir, "prlctl.log"), "utf8");
		ok(calls.includes("start golden\n"));
		ok(calls.includes("stop golden\n"));
		strictEqual(readFileSync(join(f.dir, "state"), "utf8"), "stopped");
	});

	it("times out a hung guest update, emits a heartbeat, and stops the VM", () => {
		const f = fixture({ hangGuest: true });
		const result = run(["--vm", "golden", "--cli-manifest", f.manifest], f.env);
		strictEqual(result.status, 124, result.stderr);
		ok(result.stderr.includes("command still running"));
		ok(result.stderr.includes("command timed out after 900s"));
		const calls = readFileSync(join(f.dir, "prlctl.log"), "utf8");
		ok(calls.includes("stop golden\n"));
		ok(calls.includes("status golden\n"));
		strictEqual(readFileSync(join(f.dir, "state"), "utf8"), "stopped");
	});

	it("returns nonzero when the authoritative stop fails", () => {
		const f = fixture({ stopFail: true, stopLeavesStopped: true });
		const result = run(["--vm", "golden", "--cli-manifest", f.manifest], f.env);
		ok(result.status !== 0);
		const calls = readFileSync(join(f.dir, "prlctl.log"), "utf8");
		ok(calls.includes("stop golden\n"));
		strictEqual(readFileSync(join(f.dir, "state"), "utf8"), "stopped");
	});
});
