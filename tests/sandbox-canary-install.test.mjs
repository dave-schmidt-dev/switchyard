// @test-phase: serial
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { notifyLocal, runCanaryCli } from "../scripts/sandbox-canary-daily.mjs";
import { HANG_GUARD_MS } from "./helpers/hang-guard.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const OPS = resolve(import.meta.dirname, "../ops");
const INSTALLER = join(OPS, "install-sandbox-canary.sh");
const UNINSTALLER = join(OPS, "uninstall-sandbox-canary.sh");
const LABEL = "com.zerodelta.switchyard.sandbox-canary";
const SHA = "a".repeat(40);
// Healthy commands get the installer's largest accepted per-command bound;
// cases that expect a timeout pass "1" explicitly. The outer guard stays above
// it so the installer, not the test, reports a hung command.
const COMMAND_BOUND_SECONDS = String(HANG_GUARD_MS / 1000);
const OUTER_GUARD_MS = 2 * HANG_GUARD_MS;
function setup() {
	const root = tempDir("sy-canary-install-");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const source = join(root, "accepted");
	for (const directory of [
		home,
		bin,
		join(source, "src/switchyard/runner"),
		join(source, "scripts"),
		join(source, "tests"),
	])
		mkdirSync(directory, { recursive: true });
	writeFileSync(join(source, "package.json"), "{}");
	for (const script of [
		"sandbox-canary.mjs",
		"sandbox-canary-daily.mjs",
		"hermetic-test-env.mjs",
	]) {
		writeFileSync(
			join(source, "scripts", script),
			readFileSync(resolve(OPS, "../scripts", script)),
		);
	}

	writeFileSync(
		join(source, "src/switchyard/runner/checks-sandbox.mjs"),
		"// fixture\n",
	);
	writeFileSync(
		join(source, "tests/runner-quick-checks-toolchain-sandbox.test.mjs"),
		"// fixture\n",
	);
	const calls = join(root, "calls.log");
	const script = (name, body) =>
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	script(
		"git",
		`printf '%s\\n' "$*" >> "$CALLS"
shift 2
case "$1" in
 rev-parse) case "$*" in *--show-prefix*) printf 'switchyard/\\n';; *) printf '%s\\n' "$ACCEPTED_SHA";; esac;;
 archive) shift; shift; [ "$1" = "-o" ] || exit 9; output="$2"; shift 2; [ "$1" = "$ACCEPTED_SHA" ] || exit 8; shift; [ "$1" = "--" ] || exit 6; shift; exec /usr/bin/tar -cf "$output" -C "$ACCEPTED_SOURCE" "$@";;
 *) exit 7;; esac`,
	);
	script("plutil", `[ "\${FAIL_PLUTIL:-0}" != 1 ] || exit 1\nexit 0`);
	script(
		"launchctl",
		`printf '%s\\n' "$*" >> "$CALLS"
if [ "$1" = "\${HANG_COMMAND:-never}" ]; then printf ready > "$READY"; exec /bin/sleep 300; fi
if [ "$1" = "\${FAIL_COMMAND:-never}" ]; then exit 1; fi
if [ "$1" = print ]; then
 case "\${PRINT_STATE:-loaded}" in
  absent) echo 'Bad request.' >&2; domain_user="\${2#gui/}"; domain_user="\${domain_user%%/*}"; printf 'Could not find service "%s" in domain for user gui: %s\\n' 'com.zerodelta.switchyard.sandbox-canary' "$domain_user" >&2; exit 113;;
  malformed) echo 'unrecognized response' >&2; exit 113;;
  transport) echo 'Input/output error' >&2; exit 5;;
  wrong-domain) echo 'Could not find service "com.zerodelta.switchyard.sandbox-canary" in domain for user gui: 99999999' >&2; exit 113;;
  wrong-label) echo 'Could not find service "com.zerodelta.other" in domain for user gui: 501' >&2; exit 113;;
 esac
fi
if [ "$1" = bootout ] && [ "\${PRINT_STATE:-loaded}" = absent ]; then exit 113; fi
exit 0`,
	);
	const base = join(home, "Library/Application Support/switchyard");
	const install = join(base, "sandbox-canary");
	const target = join(home, "Library/LaunchAgents", `${LABEL}.plist`);
	const env = {
		...process.env,
		HOME: home,
		PATH: `${bin}:/usr/bin:/bin`,
		NODE_BIN: process.execPath,
		SWITCHYARD_CANARY_REV: SHA,
		SWITCHYARD_CANARY_INSTALL_TIMEOUT_SECONDS: COMMAND_BOUND_SECONDS,
		CALLS: calls,
		ACCEPTED_SHA: SHA,
		ACCEPTED_SOURCE: source,
		READY: join(root, "ready"),
	};
	const run = (script = INSTALLER, extra = {}) =>
		spawnSync("/bin/sh", [script], {
			env: { ...env, ...extra },
			encoding: "utf8",
			timeout: OUTER_GUARD_MS,
		});
	const clean = () => rmSync(root, { recursive: true, force: true });
	const leftovers = () =>
		readdirSync(base).filter((name) => name.startsWith(".sandbox-canary"));
	return {
		root,
		home,
		base,
		install,
		target,
		source,
		calls,
		env,
		run,
		clean,
		leftovers,
	};
}
function success(result) {
	strictEqual(result.status, 0, result.stderr);
}
describe("sandbox canary synthetic installation", () => {
	it("pins the accepted project tree, installs daily, repeats and uninstalls", () => {
		const f = setup();
		try {
			success(f.run());
			const template = readFileSync(f.target, "utf8");
			strictEqual(
				readFileSync(
					join(f.install, "scripts/sandbox-canary-daily.mjs"),
					"utf8",
				),
				readFileSync(
					resolve(OPS, "../scripts/sandbox-canary-daily.mjs"),
					"utf8",
				),
			);
			ok(template.includes("<integer>86400</integer>"));
			ok(template.includes("<key>RunAtLoad</key>"));
			ok(template.includes(f.install));
			strictEqual(
				JSON.parse(readFileSync(join(f.install, "snapshot.json"))).revision,
				SHA,
			);
			writeFileSync(join(f.install, "old-marker"), "old");
			success(f.run());
			strictEqual(existsSync(join(f.install, "old-marker")), false);
			deepStrictEqual(f.leftovers(), []);
			success(f.run(UNINSTALLER));
			success(f.run(UNINSTALLER));
			strictEqual(existsSync(f.target), false);
			strictEqual(existsSync(f.install), false);
		} finally {
			f.clean();
		}
	});
	it("rejects implicit HEAD acceptance and preserves foreign stale paths", () => {
		const f = setup();
		try {
			strictEqual(f.run(INSTALLER, { SWITCHYARD_CANARY_REV: "" }).status, 1);
			mkdirSync(join(f.base, ".sandbox-canary-stage.foreign"));
			writeFileSync(
				join(f.base, ".sandbox-canary-stage"),
				join(f.base, ".sandbox-canary-stage.foreign"),
			);
			success(f.run());
			ok(existsSync(join(f.base, ".sandbox-canary-stage.foreign")));
		} finally {
			f.clean();
		}
	});
	for (const failure of ["lint", "bootstrap", "enable"]) {
		it(`rolls back a failed ${failure} update and removes owned scratch`, () => {
			const f = setup();
			try {
				success(f.run());
				const before = readFileSync(f.target, "utf8");
				writeFileSync(join(f.install, "previous-marker"), "keep");
				const result = f.run(
					INSTALLER,
					failure === "lint" ? { FAIL_PLUTIL: "1" } : { FAIL_COMMAND: failure },
				);
				strictEqual(result.status, 1, result.stderr);
				strictEqual(readFileSync(f.target, "utf8"), before);
				strictEqual(
					readFileSync(join(f.install, "previous-marker"), "utf8"),
					"keep",
				);
				deepStrictEqual(f.leftovers(), []);
			} finally {
				f.clean();
			}
		});
	}
	it("bounds a hung launchctl and preserves the previous snapshot", () => {
		const f = setup();
		try {
			success(f.run());
			writeFileSync(join(f.install, "previous-marker"), "keep");
			const start = Date.now();
			const result = f.run(INSTALLER, {
				HANG_COMMAND: "enable",
				SWITCHYARD_CANARY_INSTALL_TIMEOUT_SECONDS: "1",
			});
			strictEqual(result.status, 1, result.stderr);
			ok(Date.now() - start < HANG_GUARD_MS);
			ok(existsSync(join(f.install, "previous-marker")));
			deepStrictEqual(f.leftovers(), []);
		} finally {
			f.clean();
		}
	});
	it("cleans interrupted installation and restores the previous snapshot", async () => {
		const f = setup();
		try {
			success(f.run());
			writeFileSync(join(f.install, "previous-marker"), "keep");
			const child = spawn("/bin/sh", [INSTALLER], {
				env: { ...f.env, HANG_COMMAND: "enable" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			child.stdout.resume();
			child.stderr.resume();
			const ended = new Promise((resolve) =>
				child.on("exit", (code, signal) => resolve({ code, signal })),
			);
			const deadline = Date.now() + HANG_GUARD_MS;
			while (!existsSync(f.env.READY) && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 20));
			ok(existsSync(f.env.READY));
			child.kill("SIGTERM");
			const result = await ended;
			strictEqual(result.code, 143);
			ok(existsSync(join(f.install, "previous-marker")));
			deepStrictEqual(f.leftovers(), []);
		} finally {
			f.clean();
		}
	});
	it("failed or timed out uninstall preserves runnable files", () => {
		const f = setup();
		try {
			success(f.run());
			strictEqual(f.run(UNINSTALLER, { FAIL_COMMAND: "bootout" }).status, 1);
			strictEqual(
				f.run(UNINSTALLER, {
					HANG_COMMAND: "bootout",
					SWITCHYARD_CANARY_INSTALL_TIMEOUT_SECONDS: "1",
				}).status,
				1,
			);
			ok(existsSync(f.target));
			ok(existsSync(f.install));
			deepStrictEqual(f.leftovers(), []);
			success(f.run(UNINSTALLER));
		} finally {
			f.clean();
		}
	});
	it("refuses concurrent or stale ownership without deleting it", () => {
		const f = setup();
		try {
			mkdirSync(join(f.base, ".sandbox-canary-install.lock"), {
				recursive: true,
			});
			writeFileSync(
				join(f.base, ".sandbox-canary-install.lock/pid"),
				"99999999",
			);
			strictEqual(f.run().status, 1);
			strictEqual(f.run(UNINSTALLER).status, 1);
			ok(existsSync(join(f.base, ".sandbox-canary-install.lock/pid")));
		} finally {
			f.clean();
		}
	});
});
describe("daily canary runtime state", () => {
	it("deduplicates failures and recovery locally and bounds logs", () => {
		const f = setup();
		try {
			const stateDir = join(f.root, "state");
			let day = 1;
			let status = "failed";
			let runs = 0;
			const notifications = [];
			const logDir = join(f.home, "Library/Logs");
			mkdirSync(logDir, { recursive: true });
			const out = join(logDir, "switchyard-sandbox-canary.launchd.out.log");
			writeFileSync(out, "x".repeat(100000));
			const run = () =>
				runCanaryCli({
					env: { ...f.env, SWITCHYARD_CANARY_DAILY: "1" },
					stateDir,
					now: () =>
						new Date(`2026-10-${String(day).padStart(2, "0")}T12:00:00Z`),
					log: () => {},
					error: () => {},
					runCanary: () => {
						runs++;
						return {
							status,
							exitCode: status === "failed" ? 1 : 0,
							results: [],
							reason: null,
						};
					},
					notify: (notice) => {
						notifications.push(notice);
						return { sent: true };
					},
				});
			strictEqual(run().exitCode, 1);
			strictEqual(run().skipped, true);
			strictEqual(runs, 1);
			day++;
			run();
			strictEqual(notifications.length, 1);
			day++;
			status = "passed";
			run();
			strictEqual(notifications.length, 2);
			day++;
			run();
			strictEqual(notifications.length, 2);
			day++;
			status = "failed";
			run();
			strictEqual(notifications.length, 3);
			ok(readFileSync(out).length <= 65536);
			ok(readFileSync(join(stateDir, "outcomes.log")).length <= 65536);
			strictEqual(
				readdirSync(stateDir).filter((name) => name.includes(".tmp-")).length,
				0,
			);
		} finally {
			f.clean();
		}
	});
	it("contains a crashed probe and retries an unavailable notification next day", () => {
		const f = setup();
		try {
			let day = 1;
			let notices = 0;
			const run = () =>
				runCanaryCli({
					env: { SWITCHYARD_CANARY_DAILY: "1", HOME: f.home },
					stateDir: join(f.root, "state"),
					now: () => new Date(`2026-10-0${day}T12:00:00Z`),
					log: () => {},
					error: () => {},
					runCanary: () => {
						throw Error("fixture crash");
					},
					notify: () => {
						notices++;
						return { sent: false, error: "missing" };
					},
				});
			strictEqual(run().exitCode, 1);
			day++;
			strictEqual(run().exitCode, 1);
			strictEqual(notices, 2);
		} finally {
			f.clean();
		}
	});
	it("bounds the notification subprocess and reports timeout failure", () => {
		let timeout;
		const result = notifyLocal({
			platform: "darwin",
			env: { PATH: "/synthetic" },
			exists: () => true,
			spawn: (_command, _args, options) => {
				timeout = options.timeout;
				return { error: { code: "ETIMEDOUT" }, status: null };
			},
		});
		strictEqual(timeout, 5000);
		strictEqual(result.sent, false);
		strictEqual(result.error, "ETIMEDOUT");
	});
});

it("kills a real hung notification subprocess under its runtime deadline", () => {
	const f = setup();
	try {
		writeFileSync(
			join(f.root, "bin/terminal-notifier"),
			"#!/bin/sh\nexec /bin/sleep 30\n",
			{ mode: 0o755 },
		);
		const start = Date.now();
		const result = notifyLocal({
			platform: "darwin",
			env: f.env,
			timeoutMs: 100,
		});
		strictEqual(result.sent, false);
		strictEqual(result.error, "ETIMEDOUT");
		ok(Date.now() - start < 3000);
	} finally {
		f.clean();
	}
});

it("reinstalls and uninstalls an existing plist when its job is already unloaded", () => {
	const f = setup();
	try {
		success(f.run());
		writeFileSync(f.calls, "");
		success(f.run(INSTALLER, { PRINT_STATE: "absent" }));
		ok(existsSync(f.target));
		success(f.run(UNINSTALLER, { PRINT_STATE: "absent" }));
		strictEqual(existsSync(f.target), false);
		strictEqual(existsSync(f.install), false);
		const calls = readFileSync(f.calls, "utf8");
		ok(calls.includes("print gui/"));
		ok(!calls.includes("bootout "));
		deepStrictEqual(f.leftovers(), []);
	} finally {
		f.clean();
	}
});
for (const probe of [
	"malformed",
	"transport",
	"wrong-domain",
	"wrong-label",
	"timeout",
]) {
	it(`preserves prior installation when launchctl print reports ${probe}`, () => {
		const f = setup();
		try {
			success(f.run());
			writeFileSync(join(f.install, "previous-marker"), "keep");
			const before = readFileSync(f.target, "utf8");
			const extra =
				probe === "timeout"
					? {
							HANG_COMMAND: "print",
							SWITCHYARD_CANARY_INSTALL_TIMEOUT_SECONDS: "1",
						}
					: { PRINT_STATE: probe };
			strictEqual(f.run(INSTALLER, extra).status, 1);
			strictEqual(f.run(UNINSTALLER, extra).status, 1);
			strictEqual(readFileSync(f.target, "utf8"), before);
			strictEqual(
				readFileSync(join(f.install, "previous-marker"), "utf8"),
				"keep",
			);
			deepStrictEqual(f.leftovers(), []);
		} finally {
			f.clean();
		}
	});
}
it("retries pending recovery on a later passing day until the notice is delivered", () => {
	const f = setup();
	try {
		const notices = [];
		let day = 1;
		const run = () =>
			runCanaryCli({
				env: { HOME: f.home, SWITCHYARD_CANARY_DAILY: "1" },
				stateDir: join(f.root, "state"),
				now: () => new Date(`2026-10-0${day}T12:00:00Z`),
				log: () => {},
				error: () => {},
				runCanary: () => ({
					status: day === 1 ? "failed" : "passed",
					exitCode: day === 1 ? 1 : 0,
					results: [],
				}),
				notify: (notice) => {
					notices.push(notice.title);
					return { sent: day !== 2 };
				},
			});
		strictEqual(run().state.lastNotifiedStatus, "failed");
		day = 2;
		strictEqual(run().state.lastNotifiedStatus, "failed");
		strictEqual(run().skipped, true);
		day = 3;
		strictEqual(run().state.lastNotifiedStatus, "passed");
		day = 4;
		run();
		deepStrictEqual(notices, [
			"Switchyard sandbox canary failed",
			"Switchyard sandbox canary recovered",
			"Switchyard sandbox canary recovered",
		]);
	} finally {
		f.clean();
	}
});

it("keeps default supervisor output captured without forwarding", () => {
	const moduleUrl = new URL(
		"../scripts/sandbox-canary-daily.mjs",
		import.meta.url,
	).href;
	const childCode =
		"process.stdout.write('captured-out');process.stderr.write('captured-err')";
	const driver = `import {supervisedSpawn} from ${JSON.stringify(moduleUrl)};process.stdout.write(JSON.stringify(supervisedSpawn(process.execPath,["-e",${JSON.stringify(childCode)}],{timeout:${HANG_GUARD_MS}})))`;
	const result = spawnSync(
		process.execPath,
		["--input-type=module", "-e", driver],
		{ encoding: "utf8", timeout: OUTER_GUARD_MS },
	);
	strictEqual(result.status, 0, result.stderr);
	strictEqual(result.stderr, "");
	const report = JSON.parse(result.stdout);
	strictEqual(report.status, 0);
	strictEqual(report.stdout, "captured-out");
	strictEqual(report.stderr, "captured-err");
	strictEqual(report.error, null);
});
it("forwards supervisor output live and emits fixed progress while retaining captures", async () => {
	const moduleUrl = new URL(
		"../scripts/sandbox-canary-daily.mjs",
		import.meta.url,
	).href;
	const childCode =
		"process.stdout.write('live-out');process.stderr.write('live-err');setTimeout(()=>{},5200)";
	const driver = `import {supervisedSpawn} from ${JSON.stringify(moduleUrl)};process.stdout.write(JSON.stringify(supervisedSpawn(process.execPath,["-e",${JSON.stringify(childCode)}],{timeout:${HANG_GUARD_MS},forwardOutput:true,progressLabel:"strict gate running"})))`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", driver], {
		timeout: OUTER_GUARD_MS,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "",
		stderr = "",
		live = false;
	child.stdout.on("data", (data) => {
		stdout += data;
	});
	child.stderr.on("data", (data) => {
		stderr += data;
		if (String(data).includes("live-out") && child.exitCode === null)
			live = true;
	});
	const code = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	strictEqual(code, 0, stderr);
	strictEqual(live, true);
	ok(stderr.includes("live-out"));
	ok(stderr.includes("live-err"));
	ok(stderr.includes("strict gate running\n"));
	const report = JSON.parse(stdout);
	strictEqual(report.status, 0);
	strictEqual(report.stdout, "live-out");
	strictEqual(report.stderr, "live-err");
	strictEqual(report.error, null);
});

for (const owner of ["dead", "live", "invalid", "zero", "missing"]) {
	it(`preserves ${owner} lock ownership with an explicit inspection diagnostic`, () => {
		const f = setup();
		try {
			const lock = join(f.base, ".sandbox-canary-install.lock");
			mkdirSync(lock, { recursive: true });
			const dead = spawnSync(process.execPath, ["-e", ""], {
				timeout: 2000,
			}).pid;
			const content =
				owner === "dead"
					? `${dead}\n`
					: owner === "live"
						? `${process.pid}\n`
						: owner === "zero"
							? "0\n"
							: "invalid\n";
			if (owner !== "missing") writeFileSync(join(lock, "pid"), content);
			writeFileSync(join(lock, "owner-marker"), "preserve");
			for (const script of [INSTALLER, UNINSTALLER]) {
				const result = f.run(script);
				strictEqual(result.status, 1);
				ok(result.stderr.includes(lock));
				ok(result.stderr.includes("owner inspection"));
				if (owner === "dead")
					ok(result.stderr.includes("may be stale or uninspectable"));
				if (owner === "live") ok(result.stderr.includes("owner is live"));
				if (["invalid", "zero", "missing"].includes(owner))
					ok(result.stderr.includes("invalid or uninspectable"));
				strictEqual(
					readFileSync(join(lock, "owner-marker"), "utf8"),
					"preserve",
				);
				if (owner !== "missing")
					strictEqual(readFileSync(join(lock, "pid"), "utf8"), content);
				else strictEqual(existsSync(join(lock, "pid")), false);
			}
		} finally {
			f.clean();
		}
	});
}
it("reports a missing uninstall Node prerequisite before touching installation", () => {
	const f = setup();
	try {
		mkdirSync(f.install, { recursive: true });
		writeFileSync(join(f.install, "marker"), "keep");
		writeFileSync(join(f.root, "bin/id"), "#!/bin/sh\nprintf '501\\n'\n", {
			mode: 0o755,
		});
		const result = f.run(UNINSTALLER, {
			NODE_BIN: "",
			PATH: join(f.root, "bin"),
		});
		strictEqual(result.status, 1);
		ok(result.stderr.includes("node binary is required for bounded uninstall"));
		strictEqual(readFileSync(join(f.install, "marker"), "utf8"), "keep");
		strictEqual(existsSync(f.calls), false);
	} finally {
		f.clean();
	}
});
for (const boundary of ["middle", "newline", "record-start", "no-newline"]) {
	it(`trims logs at complete record boundaries when cutoff is ${boundary}`, () => {
		const f = setup();
		try {
			const stateDir = join(f.root, "state");
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(
				join(stateDir, "canary-state.json"),
				JSON.stringify({ lastRunDay: "2026-10-14" }),
			);
			const first = `${JSON.stringify({ record: 1, padding: "a".repeat(33000) })}\n`;
			const second = `${JSON.stringify({ record: 2, padding: "b".repeat(33000) })}\n`;
			let content = first + second;
			if (boundary === "no-newline") content = "z".repeat(70000);
			if (boundary === "newline" || boundary === "record-start") {
				const window = 65536 - (boundary === "newline" ? 1 : 0);
				const overhead = JSON.stringify({ record: 3, padding: "" }).length + 1;
				const record = JSON.stringify({
					record: 3,
					padding: "c".repeat(window - overhead),
				});
				content = `discard\n${record}\n`;
			}

			const logDir = join(f.home, "Library/Logs");
			mkdirSync(logDir, { recursive: true });
			const paths = [
				join(stateDir, "outcomes.log"),
				join(logDir, "switchyard-sandbox-canary.launchd.out.log"),
			];
			for (const path of paths) writeFileSync(path, content);
			const result = runCanaryCli({
				env: { HOME: f.home, SWITCHYARD_CANARY_DAILY: "1" },
				stateDir,
				now: () => new Date("2026-10-14T12:00:00Z"),
				log: () => {},
				error: () => {},
				runCanary: () => {
					throw Error("must skip");
				},
			});
			strictEqual(result.skipped, true);
			for (const path of paths) {
				const retained = readFileSync(path, "utf8");
				ok(Buffer.byteLength(retained) <= 65536);
				if (boundary === "no-newline") strictEqual(retained, "");
				else {
					const records = retained
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line));
					ok(records.length > 0);
					if (boundary === "middle") strictEqual(records[0].record, 2);
					else strictEqual(records[0].record, 3);
				}
			}
		} finally {
			f.clean();
		}
	});
}
