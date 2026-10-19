// @test-phase: other
import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	checkBridgePins,
	checkLaunchAgents,
	checkProviderClis,
	checkQualificationExpiry,
	checkRepairHolds,
	checkSandboxToolchain,
	checkStrandedPending,
	parseBrokerConsumers,
	parseCliManifest,
	parseCliVersion,
} from "../src/switchyard/doctor/checks.mjs";
import {
	formatDoctorReport,
	handleDoctor,
	runDoctor,
} from "../src/switchyard/doctor/index.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SECRET_REF = "7c8a09ee-4765-4b73-bff0-b490001a142a";

describe("doctor version and manifest parsing", () => {
	it("reads the version token from every observed host CLI answer", () => {
		for (const [text, version] of [
			["2.1.302 (Claude Code)", "2.1.302"],
			["codex-cli 0.163.0", "0.163.0"],
			["1.4.2", "1.4.2"],
			["2026.10.01-e373342", "2026.10.01-e373342"],
			["GitHub Copilot CLI 1.0.96.\nRun 'copilot update' to check.", "1.0.96"],
			["opencode v2.0.32", "2.0.32"],
			["vibe 2.25.0", "2.25.0"],
			["no version here", null],
		])
			strictEqual(parseCliVersion(text), version, text);
	});

	it("parses the committed CLI manifest pins", () => {
		const pins = parseCliManifest(
			readFileSync("ops/macos-vm/cli-manifest.txt", "utf8"),
		);
		deepStrictEqual(
			pins.map((pin) => pin.provider),
			["claude", "codex", "agy", "cursor-agent", "copilot", "opencode", "vibe"],
		);
		ok(pins.every((pin) => parseCliVersion(pin.version) !== null));
	});
});

describe("doctor host checks", () => {
	it("passes a resolved sandbox toolchain and names the formula for a missing tool", () => {
		const tools = { node: "/n", npm: "/m", uv: "/u" };
		strictEqual(checkSandboxToolchain({ tools }).status, "ok");
		const missing = checkSandboxToolchain({ tools: { ...tools, uv: null } });
		strictEqual(missing.status, "fail");
		deepStrictEqual(missing.fixes, ["brew install uv"]);
		strictEqual(checkSandboxToolchain({ error: "ENOENT" }).status, "fail");
	});

	it("warns on CLI drift and fails a missing or broken CLI", () => {
		const pins = [
			{ provider: "codex", version: "0.159.2" },
			{ provider: "vibe", version: "2.25.0" },
		];
		const vibe = { path: "/v", output: "vibe 2.25.0" };
		strictEqual(
			checkProviderClis(pins, {
				codex: { path: "/c", output: "codex-cli 0.159.2" },
				vibe,
			}).status,
			"ok",
		);
		const drift = checkProviderClis(pins, {
			codex: { path: "/c", output: "codex-cli 0.163.0" },
			vibe,
		});
		strictEqual(drift.status, "warn");
		match(drift.summary, /codex 0\.163\.0 \(pin 0\.159\.2\)/u);
		match(drift.fixes[0], /sync-host-clis\.sh .*--check$/u);
		strictEqual(checkProviderClis(pins, { vibe }).status, "fail");
		strictEqual(
			checkProviderClis(pins, {
				codex: { path: "/c", output: "", error: "timeout" },
				vibe,
			}).status,
			"fail",
		);
		strictEqual(checkProviderClis([], {}).status, "fail");
	});

	it("reads only Switchyard consumer pins from the broker registry source", () => {
		const registry = `CONSUMERS = {
    "other-tool": Consumer(
        executable=Path("/x/other.sh"),
        executable_sha256="${SHA_A}",
        mode="single",
    ),
    "switchyard-simple-opencode-go-dispatch": Consumer(
        executable=Path("/r/ops/simple-provider-keyless-bridge.mjs"),
        executable_sha256="${SHA_A}",
        mode="single-fd",
        secret_id="${SECRET_REF}",
    ),
    "switchyard-dev-bridge": Consumer(
        executable=Path("/r/ops/dev.mjs"),
        executable_sha256=None,
        mode="single",
        secret_name="MISTRAL_API_KEY",
    ),
}`;
		const consumers = parseBrokerConsumers(registry);
		deepStrictEqual(consumers, [
			{
				consumer: "switchyard-simple-opencode-go-dispatch",
				executable: "/r/ops/simple-provider-keyless-bridge.mjs",
				sha256: SHA_A,
			},
			{
				consumer: "switchyard-dev-bridge",
				executable: "/r/ops/dev.mjs",
				sha256: null,
			},
		]);
		const text = JSON.stringify(consumers);
		ok(!text.includes(SECRET_REF) && !text.includes("MISTRAL_API_KEY"));
	});

	it("fails a changed bridge or runtime and warns on a disabled pin", () => {
		const base = {
			brokerPresent: true,
			registryPath: "/b/registry.py",
			consumers: [
				{ consumer: "switchyard-x", executable: "/r/x.mjs", sha256: SHA_A },
			],
			hashes: { "/r/x.mjs": SHA_A },
			runtime: { path: "/r/.tools/opencode", ok: true },
		};
		strictEqual(checkBridgePins(base).status, "ok");
		const changed = checkBridgePins({ ...base, hashes: { "/r/x.mjs": SHA_B } });
		strictEqual(changed.status, "fail");
		match(
			changed.summary,
			/switchyard-x: live bbbbbbbbbbbb != pin aaaaaaaaaaaa/u,
		);
		match(changed.fixes[0], /^owner: re-pin .* \/b\/registry\.py/u);
		const runtime = checkBridgePins({
			...base,
			runtime: { path: "/r/.tools/opencode", ok: false },
		});
		strictEqual(runtime.status, "fail");
		match(runtime.fixes[0], /\/r\/\.tools\/opencode$/u);
		strictEqual(
			checkBridgePins({
				...base,
				consumers: [{ ...base.consumers[0], sha256: null }],
			}).status,
			"warn",
		);
		strictEqual(checkBridgePins({ brokerPresent: false }).status, "fail");
		strictEqual(checkBridgePins({ ...base, hashes: {} }).status, "fail");
	});

	it("reports canary and reaper install state", () => {
		const good = {
			canary: {
				plist: true,
				loaded: true,
				state: {
					lastRunAt: new Date(NOW - DAY / 2).toISOString(),
					lastStatus: "passed",
				},
			},
			reaper: { plist: true, loaded: true, scriptCurrent: true },
		};
		strictEqual(checkLaunchAgents(good, NOW).status, "ok");
		const stale = checkLaunchAgents(
			{
				...good,
				canary: {
					...good.canary,
					state: {
						...good.canary.state,
						lastRunAt: new Date(NOW - 3 * DAY).toISOString(),
					},
				},
			},
			NOW,
		);
		strictEqual(stale.status, "warn");
		match(stale.summary, /canary has not run in 2 days/u);
		const drift = checkLaunchAgents(
			{ ...good, reaper: { ...good.reaper, scriptCurrent: false } },
			NOW,
		);
		match(drift.summary, /installed reaper script differs/u);
		deepStrictEqual(drift.fixes, ["ops/install-reaper.sh"]);
		const absent = checkLaunchAgents(
			{ canary: { plist: false }, reaper: { plist: false } },
			NOW,
		);
		match(absent.summary, /canary not installed; reaper not installed/u);
		match(absent.fixes[0], /npm run canary:install$/u);
	});
});

describe("doctor state checks", () => {
	it("warns on expired and soon-expiring qualifications with the plan command", () => {
		const slot = (targetId, capability, inDays) => ({
			targetId,
			capability,
			expiresAt: inDays === null ? null : NOW + inDays * DAY,
		});
		strictEqual(
			checkQualificationExpiry({ slots: [slot("codex", "low", 20)] }, NOW)
				.status,
			"ok",
		);
		const report = checkQualificationExpiry(
			{
				slots: [
					slot("codex", "low", 20),
					slot("vibe", "standard", 3),
					slot("agy", "high", -1),
					slot("cursor", "low", null),
				],
			},
			NOW,
		);
		strictEqual(report.status, "warn");
		strictEqual(
			report.summary,
			"1 expired, 1 expire within 9 d, 1 never qualified of 4 slots; soonest agy/high expired 1.0 d ago",
		);
		deepStrictEqual(
			report.fixes.map((fix) => fix.split("  ")[0]),
			[
				"node scripts/provider-qualification.mjs --target agy --capability high",
				"node scripts/provider-qualification.mjs --target vibe --capability standard",
				"node scripts/provider-qualification.mjs --target cursor --capability low",
			],
		);
		ok(report.fixes.every((fix) => fix.includes("--execute runs a paid")));
		strictEqual(
			checkQualificationExpiry({ error: "ENOENT" }, NOW).status,
			"fail",
		);
	});

	it("names each unattested repair hold's attestation command and root", () => {
		const hold = (code, at) => ({
			code,
			publicConfigurationEpoch: "sha256:e1",
			repairEpoch: 0,
			at,
		});
		const report = checkRepairHolds({
			root: "/h/route-health",
			controls: [
				{
					targetId: "free",
					descriptorIdentity: "sha256:00",
					repairEpoch: 0,
					holds: [],
					attestations: [],
				},
				{
					targetId: "codex",
					descriptorIdentity: "sha256:95b1e5f2aa",
					repairEpoch: 0,
					holds: [hold("auth_expired", 1), hold("auth_expired", 5)],
					attestations: [],
				},
				{
					targetId: "vibe",
					descriptorIdentity: "sha256:c0ffee00aa",
					repairEpoch: 2,
					holds: [hold("image_stale", 3)],
					attestations: [
						{ publicConfigurationEpoch: "sha256:e1", repairEpoch: 2, at: 4 },
					],
				},
				{
					targetId: "agy",
					descriptorIdentity: "sha256:abcdef00aa",
					repairEpoch: 0,
					holds: [hold("configuration_invalid", 3)],
					attestations: [],
				},
			],
		});
		strictEqual(report.status, "warn");
		strictEqual(
			report.summary,
			"3 held: codex 95b1e5f2 auth_expired, vibe c0ffee00 image_stale (attested, awaiting trial), agy abcdef00 configuration_invalid",
		);
		deepStrictEqual(report.fixes, [
			"after repairing auth_expired: switchyard-dispatch health attest-repair --target codex --descriptor sha256:95b1e5f2aa --public-configuration-epoch sha256:e1 --repair-kind auth_repaired --health-state-root /h/route-health",
			"after repairing configuration_invalid: switchyard-dispatch health attest-repair --target agy --descriptor sha256:abcdef00aa --public-configuration-epoch sha256:e1 --repair-kind configuration_repaired --health-state-root /h/route-health",
		]);
		strictEqual(checkRepairHolds({ root: "/h", controls: [] }).status, "ok");
		strictEqual(
			checkRepairHolds({ root: "/h", error: "EACCES" }).status,
			"fail",
		);
	});

	it("separates closable, unconfirmed, live and inert pending attempts", () => {
		const entry = (routingRunId, extra) => ({
			project: "/p",
			routingRunId,
			taskId: `t-${routingRunId}`,
			runState: "failed",
			live: false,
			closable: false,
			projectExists: true,
			...extra,
		});
		const report = checkStrandedPending({
			pending: [
				entry("a", { closable: true }),
				entry("b", { runState: null }),
				entry("c", { live: true, runState: "running" }),
				entry("d", { projectExists: false }),
			],
		});
		strictEqual(report.status, "warn");
		strictEqual(
			report.summary,
			"2 stranded (1 closable, 1 need inspection); 1 inert (project deleted)",
		);
		deepStrictEqual(report.fixes, [
			"switchyard-dispatch routing-run close-pending --project /p --routing-run-id a --task-id t-a",
			"switchyard-dispatch routing-run inspect --project /p --routing-run-id b",
		]);
		strictEqual(
			checkStrandedPending({ pending: [entry("d", { projectExists: false })] })
				.status,
			"ok",
		);
	});
});

describe("doctor report and exit status", () => {
	const healthy = {
		sandbox: () => ({ tools: { node: "/n", npm: "/m", uv: "/u" } }),
		clis: () => ({
			pins: [{ provider: "vibe", version: "2.25.0" }],
			probes: { vibe: { path: "/v", output: "vibe 2.25.0" } },
		}),
		bridges: () => ({
			brokerPresent: true,
			registryPath: "/b.py",
			consumers: [
				{ consumer: "switchyard-x", executable: "/x", sha256: SHA_A },
			],
			hashes: { "/x": SHA_A },
			runtime: null,
		}),
		qualification: () => ({
			slots: [
				{ targetId: "vibe", capability: "low", expiresAt: NOW + 20 * DAY },
			],
		}),
		holds: () => ({ root: "/h", controls: [] }),
		pending: async () => ({ pending: [] }),
		agents: () => ({
			canary: {
				plist: true,
				loaded: true,
				state: { lastRunAt: new Date(NOW).toISOString(), lastStatus: "passed" },
			},
			reaper: { plist: true, loaded: true, scriptCurrent: true },
		}),
	};
	const capture = () => {
		const out = [];
		const err = [];
		return { out, err, stdout: (s) => out.push(s), stderr: (s) => err.push(s) };
	};

	it("prints one line per check and exits 0 on warnings, 1 on a failure", async () => {
		const io = capture();
		strictEqual(
			await handleDoctor([], { probes: healthy, now: () => NOW, ...io }),
			0,
		);
		const lines = io.out.join("").trimEnd().split("\n");
		strictEqual(lines[0], "switchyard doctor: ok (7 checks: 0 fail, 0 warn)");
		deepStrictEqual(
			lines.slice(1).map((line) => line.split(/\s+/u).slice(0, 2).join(" ")),
			[
				"ok sandbox-toolchain",
				"ok provider-clis",
				"ok bridge-pins",
				"ok qualification-expiry",
				"ok repair-holds",
				"ok stranded-pending",
				"ok launch-agents",
			],
		);
		match(io.err.join(""), /^switchyard doctor: probing /u);
		const warned = capture();
		strictEqual(
			await handleDoctor([], {
				probes: {
					...healthy,
					clis: () => ({
						pins: [{ provider: "vibe", version: "2.24.0" }],
						probes: { vibe: { path: "/v", output: "vibe 2.25.0" } },
					}),
				},
				now: () => NOW,
				...warned,
			}),
			0,
		);
		match(
			warned.out.join(""),
			/^warn {2}provider-clis .*\n {6}fix: ops\/macos-vm/mu,
		);
		const failed = capture();
		strictEqual(
			await handleDoctor(["--json"], {
				probes: {
					...healthy,
					sandbox: () => {
						throw new Error("profile exploded");
					},
				},
				now: () => NOW,
				...failed,
			}),
			1,
		);
		const report = JSON.parse(failed.out.join(""));
		strictEqual(report.schemaVersion, 1);
		strictEqual(report.status, "fail");
		strictEqual(report.checks[0].id, "sandbox-toolchain");
		match(report.checks[0].summary, /profile exploded/u);
	});

	it("runs only the state checks with --quick and refuses unknown flags", async () => {
		const report = await runDoctor({
			quick: true,
			probes: healthy,
			now: () => NOW,
		});
		deepStrictEqual(
			report.checks.map((check) => check.id),
			["qualification-expiry", "repair-holds", "stranded-pending"],
		);
		strictEqual(
			formatDoctorReport(report).split("\n")[0],
			"switchyard doctor: ok (3 checks: 0 fail, 0 warn)",
		);
		const io = capture();
		strictEqual(await handleDoctor(["--bogus"], io), 2);
		match(io.err.join(""), /^doctor: .*bogus/u);
		const help = capture();
		strictEqual(await handleDoctor(["--help"], help), 0);
		match(help.out.join(""), /^Usage: switchyard-dispatch doctor/u);
	});
});
