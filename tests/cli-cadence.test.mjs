import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatCadenceReport,
	mergeManifest,
	parseManifest,
	runCadence,
	selectCandidates,
} from "../ops/cli-cadence/cadence-core.mjs";
import {
	agyBaseUrlFromInstaller,
	CHANNELS,
	compareVersions,
	cursorVersionFromInstaller,
	isStableVersion,
	resolveLatestStable,
} from "../ops/cli-cadence/channels.mjs";
import { parseCadenceArgs } from "../ops/cli-cadence/cli-cadence.mjs";

const MANIFEST = `# header
#
claude|script|https://claude.ai/install.sh|bash|${"a".repeat(64)}|2.1.285
codex|script|https://chatgpt.com/codex/install.sh|bash|${"b".repeat(64)}|0.159.2
agy|script|https://antigravity.google/cli/install.sh|bash|${"c".repeat(64)}|1.2.14
cursor-agent|script|https://cursor.com/install|bash|${"d".repeat(64)}|2026.09.28-64d2043
copilot|npm|@github/copilot|1.0.89|${"e".repeat(64)}|1.0.89
opencode|npm|opencode-ai|1.18.30|${"f".repeat(64)}|1.18.30
vibe|brew|mistral-vibe|2.25.0|${"0".repeat(64)}|2.25.0
`;
const CANDIDATE = MANIFEST.replace(
	`codex|script|https://chatgpt.com/codex/install.sh|bash|${"b".repeat(64)}|0.159.2`,
	`codex|script|https://chatgpt.com/codex/install.sh|bash|${"9".repeat(64)}|0.160.0`,
)
	.replace("opencode-ai|1.18.30|", "opencode-ai|1.18.34|")
	.replace(/\|1\.18\.30$/mu, "|1.18.34")
	.replace(
		`agy|script|https://antigravity.google/cli/install.sh|bash|${"c".repeat(64)}`,
		`agy|script|https://antigravity.google/cli/install.sh|bash|${"7".repeat(64)}`,
	);

describe("channels", () => {
	it("follows claude's stable dist-tag and never Homebrew for opencode", () => {
		assert.equal(CHANNELS.claude.source.tag, "stable");
		assert.equal(CHANNELS.opencode.source.kind, "npm");
		assert.equal(CHANNELS.opencode.informational.kind, "brew");
		assert.equal(CHANNELS.pi.manifest, false);
		assert.equal(CHANNELS.pi.source.pkg, "@earendil-works/pi-coding-agent");
		// The guest installs vibe's Homebrew formula; the host stages it from PyPI.
		assert.deepEqual(CHANNELS.vibe.source, {
			kind: "brew",
			formula: "mistral-vibe",
		});
		assert.equal(CHANNELS.vibe.stage, "pypi");
	});

	it("treats prereleases as unstable and cursor's dated build as stable", () => {
		for (const version of [
			"2.1.285",
			"0.160.0",
			"2026.09.28-64d2043",
			"2.25.8",
		])
			assert.equal(isStableVersion(version), true, version);
		for (const version of [
			"1.0.92-5",
			"0.159.0-alpha.12.1",
			"0.0.0-dev-202610030456",
			"2.0.0-rc.1",
			"",
			null,
		])
			assert.equal(isStableVersion(version), false, String(version));
	});

	it("orders versions numerically, ignoring build hashes", () => {
		assert.equal(compareVersions("0.160.0", "0.159.2"), 1);
		assert.equal(compareVersions("1.18.34", "1.18.4"), 1);
		assert.equal(
			compareVersions("2026.09.28-64d2043", "2026.10.02-aaaaaaa"),
			-1,
		);
		assert.equal(compareVersions("2.0.20", "2.0.20"), 0);
	});

	it("reads versions out of the vendor installers", () => {
		assert.equal(
			cursorVersionFromInstaller(
				'U="https://downloads.cursor.com/lab/2026.10.02-abc1234/darwin"\nV=downloads.cursor.com/lab/2026.10.02-abc1234/linux',
			),
			"2026.10.02-abc1234",
		);
		assert.equal(
			cursorVersionFromInstaller(
				"downloads.cursor.com/lab/a/x downloads.cursor.com/lab/b/y",
			),
			null,
		);
		assert.equal(
			agyBaseUrlFromInstaller('DOWNLOAD_BASE_URL="https://dl.example/agy/"'),
			"https://dl.example/agy",
		);
		assert.equal(
			agyBaseUrlFromInstaller('DOWNLOAD_BASE_URL="http://dl.example"'),
			null,
		);
	});

	it("resolves each channel kind and rejects an unstable answer", async () => {
		const io = {
			brewStable: async (formula) =>
				formula === "mistral-vibe" ? "2.25.8" : null,
			npmView: async (pkg, field) =>
				pkg === "@anthropic-ai/claude-code" && field === "dist-tags.stable"
					? "2.1.285\n"
					: "1.0.92-5\n",
			fetchJson: async (url) =>
				url.includes("pypi")
					? { info: { version: "2.25.8" } }
					: { version: "1.3.0" },
			fetchText: async (url) =>
				url.includes("cursor")
					? "downloads.cursor.com/lab/2026.10.02-abc/"
					: 'DOWNLOAD_BASE_URL="https://dl.example"',
		};
		assert.equal(await resolveLatestStable("claude", io), "2.1.285");
		assert.equal(await resolveLatestStable("vibe", io), "2.25.8");
		assert.equal(
			await resolveLatestStable("cursor-agent", io),
			"2026.10.02-abc",
		);
		assert.equal(await resolveLatestStable("agy", io), "1.3.0");
		await assert.rejects(
			resolveLatestStable("copilot", io),
			/copilot: channel returned no stable version \(1\.0\.92-5\)/u,
		);
	});
});

describe("manifest handling", () => {
	it("parses rows and skips comments", () => {
		const rows = parseManifest(MANIFEST);
		assert.equal(rows.size, 7);
		assert.equal(rows.get("opencode").version, "1.18.30");
	});

	it("merges only promoted rows and keeps held rows byte-identical", () => {
		const merged = mergeManifest(
			MANIFEST,
			parseManifest(CANDIDATE),
			new Set(["codex"]),
		);
		const rows = parseManifest(merged);
		assert.equal(rows.get("codex").version, "0.160.0");
		assert.equal(rows.get("opencode").version, "1.18.30");
		assert.equal(
			rows.get("agy").hash,
			"c".repeat(64),
			"an unpromoted installer hash change is not taken",
		);
		assert.ok(merged.startsWith("# header\n#\n"));
		assert.throws(
			() => mergeManifest(MANIFEST, new Map(), new Set(["codex"])),
			/no candidate manifest row for codex/u,
		);
	});

	it("selects only newer stable releases, by pin or (pi) by host", () => {
		const candidates = selectCandidates({
			codex: { pin: "0.159.2", host: "0.159.2", latest: "0.160.0" },
			claude: { pin: "2.1.285", host: "2.1.289", latest: "2.1.285" },
			opencode: { pin: "1.18.30", host: "2.0.20", latest: "1.18.34" },
			pi: { pin: null, host: "1.0.2", latest: "1.0.3" },
			agy: { pin: "1.2.14", host: null, latest: null },
		});
		assert.deepEqual(candidates, [
			{ name: "codex", from: "0.159.2", to: "0.160.0" },
			{ name: "opencode", from: "1.18.30", to: "1.18.34" },
			{ name: "pi", from: "1.0.2", to: "1.0.3" },
		]);
	});
});

// A fake host: codex 0.160.0 passes everything; opencode 1.18.34 fails its
// flag contract; everything else is current.
function fakeIo(overrides = {}) {
	const calls = { promoteHost: [], commitPins: [], stage: [], contract: [] };
	const latest = {
		claude: "2.1.285",
		codex: "0.160.0",
		copilot: "1.0.89",
		opencode: "1.18.34",
		vibe: "2.25.0",
		"cursor-agent": "2026.09.28-64d2043",
		agy: "1.2.14",
		pi: "1.0.3",
	};
	const io = {
		log: () => {},
		failingCanaryStatuses: ["flag_rejected", "not_live"],
		readManifest: async () => MANIFEST,
		resolveLatest: async (name) => latest[name],
		hostVersion: async (bin) =>
			({
				opencode: "1.18.30",
				pi: "1.0.3",
				"cursor-agent": "2026.09.28-64d2043",
			})[bin] ??
			parseManifest(MANIFEST).get(bin)?.version ??
			null,
		otherChannelVersion: async () => "2.0.20",
		syncHostCheck: async () => ({ ok: true, lines: [] }),
		contract: async (args) => {
			calls.contract.push(args);
			const failing =
				(args.only ?? []).includes("opencode") && args.binOverrides?.opencode;
			return failing
				? {
						ok: false,
						lines: [
							'FLAG-CONTRACT FAIL opencode 1.18.34: "opencode run --help" does not list --variant (used by adapter:opencode:max)',
						],
					}
				: { ok: true, lines: ["FLAG-CONTRACT ok"] };
		},
		canary: async ({ names }) =>
			names.map((name) => ({ name, cli: name, status: "live" })),
		generateCandidateManifest: async () => CANDIDATE,
		stage: async (name, version) => {
			calls.stage.push([name, version]);
			return { ok: true, binary: `/scratch/${name}` };
		},
		promoteHost: async (args) => {
			calls.promoteHost.push(args);
			return { ok: true, lines: [] };
		},
		commitPins: async (args) => {
			calls.commitPins.push(args);
			return { branch: "cli-cadence/test", sha: "0123456789abcdef" };
		},
		...overrides,
	};
	return { io, calls };
}

describe("runCadence", () => {
	it("check mode reports newer releases without staging anything", async () => {
		const { io, calls } = fakeIo();
		const report = await runCadence({ mode: "check", startedAt: "t" }, io);
		assert.equal(calls.stage.length, 0);
		assert.ok(
			report.notes.some((note) => note.includes("codex 0.159.2 -> 0.160.0")),
		);
		assert.equal(
			report.status.opencode.otherChannel,
			"brew opencode 2.0.20 (not followed)",
		);
	});

	it("promotes a passing candidate and holds a failing one without writing its pin", async () => {
		const { io, calls } = fakeIo();
		const report = await runCadence({ mode: "promote", startedAt: "t" }, io);
		const byName = Object.fromEntries(
			report.candidates.map((c) => [c.name, c]),
		);
		assert.equal(byName.codex.verdict.pass, true);
		assert.equal(byName.codex.promoted, true);
		assert.equal(byName.opencode.verdict.pass, false);
		assert.equal(byName.opencode.verdict.reason, "flag contract failed");
		assert.deepEqual(
			byName.opencode.canaries,
			[],
			"no canary spend on a failed contract",
		);
		assert.equal(calls.promoteHost.length, 1);
		assert.deepEqual(calls.promoteHost[0].providers, ["codex"]);
		const committed = parseManifest(calls.commitPins[0].manifestText);
		assert.equal(committed.get("codex").version, "0.160.0");
		assert.equal(
			committed.get("opencode").version,
			"1.18.30",
			"held pin is never committed",
		);
		assert.equal(report.ok, false, "a held bump needs the owner");
		const { body } = formatCadenceReport(report);
		assert.match(body, /update codex 0\.159\.2 -> 0\.160\.0: PROMOTED/u);
		assert.match(
			body,
			/update opencode 1\.18\.30 -> 1\.18\.34: HELD \(flag contract failed\)/u,
		);
		assert.match(body, /does not list --variant/u);
		assert.match(body, /local branch cli-cadence\/test/u);
	});

	it("stage mode never touches the host or git", async () => {
		const { io, calls } = fakeIo();
		await runCadence({ mode: "stage", startedAt: "t" }, io);
		assert.equal(calls.promoteHost.length, 0);
		assert.equal(calls.commitPins.length, 0);
		assert.ok(calls.stage.some(([name]) => name === "codex"));
	});

	it("holds a candidate whose canary shows a rejected flag", async () => {
		const { io, calls } = fakeIo({
			canary: async ({ names }) =>
				names.map((name) => ({ name, cli: name, status: "flag_rejected" })),
		});
		const report = await runCadence({ mode: "promote", startedAt: "t" }, io);
		assert.ok(report.candidates.every((c) => !c.verdict.pass));
		assert.equal(calls.promoteHost.length, 0);
		assert.equal(calls.commitPins.length, 0);
	});

	it("does not commit when the host's post-update contract fails", async () => {
		const { io, calls } = fakeIo({
			contract: async (args) =>
				args.strict && !args.binOverrides
					? {
							ok: false,
							lines: ["FLAG-CONTRACT FAIL codex 0.161.0: overshoot"],
						}
					: (args.only ?? []).includes("opencode")
						? { ok: false, lines: [] }
						: { ok: true, lines: [] },
		});
		const report = await runCadence({ mode: "promote", startedAt: "t" }, io);
		assert.equal(calls.commitPins.length, 0);
		assert.equal(report.promotion.postContract.ok, false);
		assert.equal(report.ok, false);
	});

	it("still checks candidates but holds them when the manifest cannot be regenerated", async () => {
		const { io, calls } = fakeIo({
			generateCandidateManifest: async () => {
				throw new Error(
					"installer download failed: https://claude.ai/install.sh",
				);
			},
		});
		const report = await runCadence({ mode: "promote", startedAt: "t" }, io);
		const codex = report.candidates.find((c) => c.name === "codex");
		assert.equal(codex.contract.ok, true);
		assert.equal(codex.verdict.pass, false);
		assert.match(codex.verdict.reason, /no candidate manifest row/u);
		assert.ok(
			report.notes.some((note) => note.includes("claude.ai/install.sh")),
		);
		assert.equal(calls.promoteHost.length, 0);
		assert.equal(calls.commitPins.length, 0);
	});

	it("does not commit pins the host could not reach", async () => {
		const { io, calls } = fakeIo({
			promoteHost: async () => ({
				ok: false,
				lines: ["DRIFT codex: host 0.159.2 after update, pinned 0.160.0"],
			}),
		});
		const report = await runCadence({ mode: "promote", startedAt: "t" }, io);
		assert.equal(calls.commitPins.length, 0);
		assert.equal(report.ok, false);
		assert.match(formatCadenceReport(report).body, /promotion: host FAILED/u);
	});

	it("reports host drift and an unreadable channel as failures", async () => {
		const { io } = fakeIo({
			syncHostCheck: async () => ({
				ok: false,
				lines: ["DRIFT opencode: host 2.0.20, pinned 1.18.30"],
			}),
			resolveLatest: async (name) => {
				if (name === "agy")
					throw new Error("agy: installer has no DOWNLOAD_BASE_URL");
				return {
					codex: "0.159.2",
					opencode: "1.18.30",
					claude: "2.1.285",
					copilot: "1.0.89",
					vibe: "2.25.0",
					"cursor-agent": "2026.09.28-64d2043",
					pi: "1.0.3",
				}[name];
			},
		});
		const report = await runCadence({ mode: "stage", startedAt: "t" }, io);
		assert.equal(report.ok, false);
		const { title, body } = formatCadenceReport(report);
		assert.equal(title, "Switchyard CLI cadence FAIL");
		assert.match(body, /DRIFT opencode: host 2\.0\.20, pinned 1\.18\.30/u);
		assert.match(body, /could not read agy's stable channel/u);
		assert.match(body, /no newer stable releases/u);
	});
});

describe("parseCadenceArgs", () => {
	it("defaults to stage and validates the mode", () => {
		assert.equal(parseCadenceArgs([]).mode, "stage");
		assert.equal(
			parseCadenceArgs(["--mode", "promote", "--no-notify"]).notify,
			false,
		);
		assert.throws(
			() => parseCadenceArgs(["--mode", "yolo"]),
			/--mode must be/u,
		);
		assert.throws(() => parseCadenceArgs(["--bogus"]), /unknown argument/u);
	});
});
