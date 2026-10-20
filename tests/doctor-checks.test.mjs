// @test-phase: other
import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	CLI_CONTRACTS,
	cliContractPreflightDetail,
} from "../src/switchyard/cli-contract/canary.mjs";
import {
	checkBridgePins,
	checkLaunchAgents,
	checkProviderClis,
	checkQualificationExpiry,
	checkRepairHolds,
	checkSandboxToolchain,
	checkStrandedPending,
	parseBrokerConsumers,
} from "../src/switchyard/doctor/checks.mjs";
import { probeCliContracts } from "../src/switchyard/doctor/host.mjs";
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

/** One CLI canary result row, as `runCliCanary` returns it. */
const canaryRow = (cli, fields = {}) => ({
	cli,
	binary: cli,
	resolvedPath: `/bin/${cli}`,
	version: "1.0.0",
	status: "ok",
	missingFlags: [],
	detail: null,
	targets: [cli],
	...fields,
});
const DRIFTED_OPENCODE = canaryRow("opencode", {
	version: "2.0.1",
	status: "flags_missing",
	missingFlags: ["run --variant"],
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

	it("reports each adapter's canary result and names a drifted one", () => {
		const passing = checkProviderClis([
			canaryRow("codex", { version: "0.163.0" }),
			canaryRow("vibe", { version: "2.25.0" }),
		]);
		strictEqual(passing.status, "ok");
		strictEqual(passing.summary, "2 CLIs pass the launch contract");
		deepStrictEqual(passing.details, [
			"ok    codex 0.163.0",
			"ok    vibe 2.25.0",
		]);
		deepStrictEqual(passing.fixes, []);
		const drift = checkProviderClis([
			canaryRow("codex", { version: "0.163.0" }),
			DRIFTED_OPENCODE,
		]);
		strictEqual(drift.status, "warn");
		strictEqual(drift.summary, "1/2 CLIs fail the launch contract");
		deepStrictEqual(drift.details, [
			"ok    codex 0.163.0",
			"warn  opencode 2.0.1 no longer accepts run --variant",
		]);
		deepStrictEqual(drift.fixes, [
			cliContractPreflightDetail(DRIFTED_OPENCODE).remedy,
		]);
		match(drift.fixes[0], /npm run cli:canary/u);
	});

	it("fails a missing or unreadable CLI and warns on an inconclusive one", () => {
		for (const status of [
			"not_installed",
			"version_unreadable",
			"help_unreadable",
		])
			strictEqual(
				checkProviderClis([canaryRow("agy", { status, version: null })]).status,
				"fail",
				status,
			);
		const missing = checkProviderClis([
			canaryRow("agy", { status: "not_installed", version: null }),
		]);
		deepStrictEqual(missing.details, ["fail  agy is not installed at agy"]);
		const inconclusive = checkProviderClis([
			canaryRow("codex"),
			canaryRow("copilot", {
				status: "unavailable",
				version: null,
				detail: "timeout",
			}),
		]);
		strictEqual(inconclusive.status, "warn");
		strictEqual(inconclusive.summary, "1/2 inconclusive");
		strictEqual(
			inconclusive.details.at(-1),
			"warn  copilot check inconclusive (timeout)",
		);
		deepStrictEqual(inconclusive.fixes, [
			"npm run cli:canary -- --only copilot",
		]);
		const threw = checkProviderClis({ error: "canary exploded" });
		strictEqual(threw.status, "fail");
		match(threw.summary, /canary exploded/u);
		strictEqual(checkProviderClis([]).status, "fail");
	});

	it("probes every CLI contract row through the canary within its budget", async () => {
		const seen = [];
		const rows = await probeCliContracts({
			resolve: () => null,
			onRow: (row) => seen.push(row.cli),
		});
		deepStrictEqual(
			seen,
			CLI_CONTRACTS.map((row) => row.cli),
		);
		ok(rows.every((row) => row.status === "not_installed"));
		// The budget bounds every canary step: 1 s left of the 120 s budget.
		const clock = [0, 119_000];
		const timeouts = [];
		await probeCliContracts({
			only: ["codex"],
			now: () => clock.shift() ?? 119_000,
			resolve: () => "/bin/codex",
			run: async (_binary, _args, { timeoutMs }) => {
				timeouts.push(timeoutMs);
				return { text: "", status: 1, error: null };
			},
		});
		deepStrictEqual(timeouts, [1_000]);
	});

	it("leaves no reference to the retired manifest version probe", async () => {
		const host = await import("../src/switchyard/doctor/host.mjs");
		strictEqual("probeProviderClis" in host, false);
		const src = new URL("../src/", import.meta.url);
		for (const name of readdirSync(src, { recursive: true }))
			if (String(name).endsWith(".mjs"))
				strictEqual(
					readFileSync(new URL(String(name), src), "utf8").includes(
						"probeProviderClis",
					),
					false,
					String(name),
				);
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

	it("fails a changed bridge and warns on a disabled pin", () => {
		const base = {
			brokerPresent: true,
			registryPath: "/b/registry.py",
			consumers: [
				{ consumer: "switchyard-x", executable: "/r/x.mjs", sha256: SHA_A },
			],
			hashes: { "/r/x.mjs": SHA_A },
		};
		strictEqual(checkBridgePins(base).status, "ok");
		const changed = checkBridgePins({ ...base, hashes: { "/r/x.mjs": SHA_B } });
		strictEqual(changed.status, "fail");
		match(
			changed.summary,
			/switchyard-x: live bbbbbbbbbbbb != pin aaaaaaaaaaaa/u,
		);
		match(changed.fixes[0], /^owner: re-pin .* \/b\/registry\.py/u);
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

	it("reports canary install state and a leftover retired reaper", () => {
		const good = {
			canary: {
				plist: true,
				loaded: true,
				state: {
					lastRunAt: new Date(NOW - DAY / 2).toISOString(),
					lastStatus: "passed",
				},
			},
			reaper: { plist: false, loaded: false },
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
		const leftover = checkLaunchAgents(
			{ ...good, reaper: { plist: true, loaded: false } },
			NOW,
		);
		strictEqual(leftover.status, "warn");
		match(leftover.summary, /retired VM reaper LaunchAgent still installed/u);
		match(
			leftover.fixes[0],
			/^launchctl bootout gui\/\$\(id -u\)\/com\.zerodelta\.switchyard\.reaper;/u,
		);
		const absent = checkLaunchAgents(
			{ canary: { plist: false }, reaper: { plist: false } },
			NOW,
		);
		strictEqual(absent.summary, "canary not installed");
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
		clis: () => [canaryRow("vibe", { version: "2.25.0" })],
		bridges: () => ({
			brokerPresent: true,
			registryPath: "/b.py",
			consumers: [
				{ consumer: "switchyard-x", executable: "/x", sha256: SHA_A },
			],
			hashes: { "/x": SHA_A },
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
			reaper: { plist: false, loaded: false },
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
		strictEqual(lines[3], "      ok    vibe 2.25.0");
		deepStrictEqual(
			lines
				.slice(1)
				.filter((line) => !line.startsWith("      "))
				.map((line) => line.split(/\s+/u).slice(0, 2).join(" ")),
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
					clis: () => [canaryRow("vibe"), DRIFTED_OPENCODE],
				},
				now: () => NOW,
				...warned,
			}),
			0,
		);
		match(
			warned.out.join(""),
			/^warn {2}provider-clis +1\/2 CLIs fail the launch contract\n {6}ok {4}vibe 1\.0\.0\n {6}warn {2}opencode 2\.0\.1 no longer accepts run --variant\n {6}fix: port the adapter /mu,
		);
		const missing = capture();
		strictEqual(
			await handleDoctor([], {
				probes: {
					...healthy,
					clis: () => [canaryRow("vibe", { status: "not_installed" })],
				},
				now: () => NOW,
				...missing,
			}),
			1,
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
