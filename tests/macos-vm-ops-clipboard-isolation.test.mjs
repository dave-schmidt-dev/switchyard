import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/tempdir.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const VM_OPS = resolve(PKG_ROOT, "ops/macos-vm");
const BUILD = resolve(VM_OPS, "build-golden-image.sh");
const GENERATOR = resolve(VM_OPS, "generate-cli-manifest.sh");
const PROBE = resolve(VM_OPS, "probe-guest-credentials.sh");
const MANIFEST = resolve(VM_OPS, "cli-manifest.txt");
const IS_DARWIN = process.platform === "darwin";
const notDarwin = { skip: IS_DARWIN ? false : "macOS-only ops lane" };
const REQUIRED_PROVIDERS = [
	"claude",
	"codex",
	"agy",
	"cursor-agent",
	"copilot",
	"opencode",
	"vibe",
];
const EXPECTED_REFS = {
	claude: "https://claude.ai/install.sh",
	codex: "https://chatgpt.com/codex/install.sh",
	agy: "https://antigravity.google/cli/install.sh",
	"cursor-agent": "https://cursor.com/install",
	copilot: "@github/copilot",
	opencode: "opencode-ai",
	vibe: "mistral-vibe",
};
const readManifestRows = () =>
	readFileSync(MANIFEST, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"))
		.map((line) => {
			const [provider, kind, ref, detail, hash, version, ...rest] =
				line.split("|");
			return { provider, kind, ref, detail, hash, version, rest, line };
		});
const extractShellFunction = (body, name) => {
	const start = body.indexOf(`${name}() {`);
	ok(start !== -1, `no ${name}() in script`);
	const end = body.indexOf("\n}\n", start);
	ok(end !== -1, `unterminated ${name}()`);
	return body.slice(start, end + 3);
};
const scratch = () => tempDir("switchyard-vm-ops-");
const renderBuildGuestScripts = (dir) => {
	const lines = readFileSync(BUILD, "utf8").split("\n");
	const preamble = [];
	for (const line of lines) {
		if (/^[a-z_]+\(\) \{/.test(line)) break;
		if (/^(readonly )?[A-Z][A-Z0-9_]*=/.test(line)) preamble.push(line);
	}
	ok(preamble.length > 0, "build script lost its top-level assignments");

	const rendered = [];
	for (let i = 0; i < lines.length; i += 1) {
		if (!/guest_exec_script <<EOF$/.test(lines[i])) continue;
		const end = lines.indexOf("EOF", i + 1);
		ok(end !== -1, `unterminated guest heredoc opened at line ${i + 1}`);
		const harness = join(dir, `render-guest-${rendered.length}.sh`);
		writeFileSync(
			harness,
			[...preamble, "cat <<EOF", ...lines.slice(i + 1, end), "EOF", ""].join(
				"\n",
			),
		);
		const run = spawnSync("/bin/bash", [harness], { encoding: "utf8" });
		strictEqual(
			run.status,
			0,
			`rendering the guest block at line ${i + 1} failed: ${run.stderr}`,
		);
		rendered.push({ line: i + 1, body: run.stdout });
		i = end;
	}
	ok(
		rendered.length >= 3,
		`expected several guest blocks, got ${rendered.length}`,
	);
	return rendered;
};
const extractProbeScript = (rendered) => {
	const block = rendered.find((entry) =>
		entry.body.includes("<<'PROBE_SCRIPT'"),
	);
	ok(block, "no guest block carries the XcodeGen probe heredoc");
	const start = block.body.indexOf("<<'PROBE_SCRIPT'");
	const bodyStart = block.body.indexOf("\n", start) + 1;
	const end = block.body.indexOf("\nPROBE_SCRIPT\n", bodyStart);
	ok(end !== -1, "unterminated XcodeGen probe heredoc");
	return { block, script: block.body.slice(bodyStart, end + 1) };
};
const renderGuestScript = (dir) => {
	const rendered = readFileSync(PROBE, "utf8")
		.replace('  prlctl exec "$VM_NAME" /bin/bash -s <<EOF', "  cat <<EOF")
		.replace(/^ {2}require_host_tools$/m, "  true");
	ok(rendered.includes("cat <<EOF"), "probe's prlctl exec call moved");
	// Prose mentions prlctl exec repeatedly; only a command position matters.
	ok(
		!/^\s*prlctl exec\b/m.test(rendered),
		"probe has a second prlctl exec call",
	);
	const harness = join(dir, "render.sh");
	writeFileSync(harness, rendered);
	const run = spawnSync(
		"/bin/bash",
		[harness, "--vm", "probe-vm", "--phase", "baseline"],
		{
			encoding: "utf8",
		},
	);
	strictEqual(run.status, 0, `render failed: ${run.stderr}`);
	return run.stdout;
};
describe("clipboard isolation posture", () => {
	const buildBody = () => readFileSync(BUILD, "utf8");

	const stubIn = (dir, name, body) => {
		const path = join(dir, name);
		writeFileSync(path, `#!/bin/bash\n${body}\n`);
		chmodSync(path, 0o755);
		return path;
	};

	// The guest posture check uses absolute paths, which no PATH stub can
	// intercept. Pull the two clipboard lines out of the rendered guest block
	// and point /bin/launchctl at a stub, so the committed assertion text is
	// what runs.
	const clipboardPostureHarness = (dir, launchctlStub) => {
		const rendered = renderBuildGuestScripts(dir);
		// Two blocks mention the label: the one that disables it and the one
		// that asserts the posture. Select on the assertion, not the label.
		const block = rendered.find((entry) =>
			entry.body.includes("launchctl print-disabled"),
		);
		ok(block, "no rendered guest block asserts on the clipboard label");
		const lines = block.body.split("\n");
		const first = lines.findIndex((line) =>
			line.includes("launchctl print-disabled"),
		);
		ok(first !== -1, "the guest block no longer checks the override database");
		const last = lines.findIndex(
			(line, i) => i > first && line.includes("clipboard service is loaded"),
		);
		ok(
			last !== -1,
			"the guest block no longer checks that the service resolves",
		);
		const assertion = lines
			.slice(first, last + 1)
			.join("\n")
			.replaceAll("/bin/launchctl", launchctlStub);
		const harness = join(dir, "posture.sh");
		writeFileSync(
			harness,
			[
				"#!/bin/bash",
				'fail_guest() { printf "GUEST-FAIL: %s\\n" "$*"; exit 9; }',
				'uid="501"',
				assertion,
				'printf "POSTURE-OK\\n"',
				"",
			].join("\n"),
		);
		return harness;
	};

	const runPosture = (printDisabled, printResolves) => {
		const dir = scratch();
		const stub = stubIn(
			dir,
			"launchctl",
			[
				'if [[ "$1" == "print-disabled" ]]; then',
				`  printf '%s\\n' ${JSON.stringify(printDisabled)}`,
				"  exit 0",
				"fi",
				'if [[ "$1" == "print" ]]; then',
				`  exit ${printResolves ? 0 : 1}`,
				"fi",
				"exit 0",
			].join("\n"),
		);
		return spawnSync("/bin/bash", [clipboardPostureHarness(dir, stub)], {
			encoding: "utf8",
		});
	};

	const DISABLED = '\t\t"com.parallels.copypaste" => disabled';

	it("passes only when the label is disabled and the service does not resolve", () => {
		const run = runPosture(DISABLED, false);
		strictEqual(run.status, 0, `hardened posture rejected: ${run.stdout}`);
		ok(run.stdout.includes("POSTURE-OK"));
	});

	it("accepts the older `=> true` rendering, which launchd owns, not us", () => {
		const run = runPosture('\t\t"com.parallels.copypaste" => true', false);
		strictEqual(run.status, 0, `posture rejected => true: ${run.stdout}`);
	});

	it("fails the build when the override database does not report the label disabled", () => {
		const run = runPosture('\t\t"com.parallels.copypaste" => enabled', false);
		strictEqual(run.status, 9, `an enabled label was accepted: ${run.stdout}`);
		ok(run.stdout.includes("not disabled in the launchd override database"));
	});

	it("fails the build when the label is absent from the override database entirely", () => {
		const run = runPosture('\t\t"com.apple.something.else" => disabled', false);
		strictEqual(
			run.status,
			9,
			`a missing override was accepted: ${run.stdout}`,
		);
	});

	it("fails the build when the service still resolves under launchctl print", () => {
		const run = runPosture(DISABLED, true);
		strictEqual(
			run.status,
			9,
			`a resolving service was accepted: ${run.stdout}`,
		);
		ok(run.stdout.includes("clipboard service is loaded"));
	});

	it("enforces the posture through `launchctl disable`, not by moving the plist", () => {
		const body = buildBody();
		ok(
			/launchctl disable "gui\/\\\$console_uid\/com\.parallels\.copypaste"/.test(
				body,
			),
			"the build no longer disables the label through the override database",
		);
		ok(
			!body.includes("com.parallels.copypaste.plist.switchyard-disabled"),
			"the build still renames the plist, which a Guest Tools update undoes",
		);
		ok(
			!/test ! -e \/Library\/LaunchAgents\/com\.parallels\.copypaste\.plist/.test(
				body,
			),
			"the build still asserts the plist is absent, which a disabled label is not",
		);
	});

	// The sentinel and the two-direction assertion, executed against stubs.
	const clipboardHarness = (dir, { guestScript, pbpaste = "" }) => {
		const body = buildBody();
		const harness = join(dir, "clipboard.sh");
		writeFileSync(
			harness,
			[
				"#!/bin/bash",
				'PROVIDER_USER="switchyard"',
				'log() { printf "LOG: %s\\n" "$*" >&2; }',
				'fail() { printf "FAIL: %s\\n" "$*"; exit 7; }',
				`pbcopy() { cat > "${join(dir, "host-pasteboard")}"; }`,
				`pbpaste() { printf '%s' ${JSON.stringify(pbpaste)}; }`,
				`guest_exec_script() { cat >/dev/null; ${guestScript} }`,
				extractShellFunction(body, "clipboard_sentinel"),
				extractShellFunction(body, "assert_clipboard_isolation"),
				'if [[ "$1" == "sentinel" ]]; then clipboard_sentinel; printf "\\n"; clipboard_sentinel; printf "\\n"; exit 0; fi',
				"assert_clipboard_isolation",
				'printf "CLIPBOARD-OK\\n"',
				"",
			].join("\n"),
		);
		return harness;
	};

	// A guest stub that answers each direction in turn, since
	// assert_clipboard_isolation calls guest_exec_script twice.
	const twoAnswers = (first, second) =>
		[
			`if [[ ! -f "$0.turn" ]]; then`,
			`  printf 'x' > "$0.turn"`,
			`  printf '%s\\n' ${JSON.stringify(first)}`,
			"else",
			`  printf '%s\\n' ${JSON.stringify(second)}`,
			"fi",
		].join("\n");

	const ISOLATED =
		"clipboard-probe: direction=host-to-guest origin=guest verdict=sentinel-absent bytes=0";
	const COPIED =
		"clipboard-probe: direction=guest-to-host origin=guest verdict=copied bytes=44";

	const runClipboard = (opts) => {
		const dir = scratch();
		return spawnSync("/bin/bash", [clipboardHarness(dir, opts)], {
			encoding: "utf8",
		});
	};

	it("mints a different sentinel on every invocation", () => {
		const dir = scratch();
		const run = spawnSync(
			"/bin/bash",
			[clipboardHarness(dir, { guestScript: "true;" }), "sentinel"],
			{ encoding: "utf8" },
		);
		strictEqual(run.status, 0, run.stderr);
		const [first, second] = run.stdout.trim().split("\n");
		ok(first?.startsWith("switchyard-clipboard-"), `unexpected: ${first}`);
		ok(
			first !== second,
			`two consecutive sentinels collided: ${first} === ${second}`,
		);
	});

	it("passes when both directions report isolation", () => {
		const run = runClipboard({ guestScript: twoAnswers(ISOLATED, COPIED) });
		strictEqual(run.status, 0, `isolated image rejected: ${run.stdout}`);
		ok(run.stdout.includes("CLIPBOARD-OK"));
	});

	it("fails when the host sentinel is visible in the guest", () => {
		const run = runClipboard({
			guestScript: twoAnswers(
				"clipboard-probe: direction=host-to-guest origin=guest verdict=sentinel-visible bytes=44",
				COPIED,
			),
		});
		strictEqual(run.status, 7, `a live leak passed: ${run.stdout}`);
		ok(run.stdout.includes("reached the guest"));
	});

	// The defect this replaces: an exit code made these two identical.
	it("fails, rather than passes, when the host-to-guest probe could not run", () => {
		const run = runClipboard({ guestScript: twoAnswers("", COPIED) });
		strictEqual(run.status, 7, `a probe that never ran passed: ${run.stdout}`);
		ok(run.stdout.includes("host-to-guest clipboard probe did not run"));
	});

	it("fails when the guest's pbpaste is unavailable, instead of reading absence as isolation", () => {
		const run = runClipboard({
			guestScript: twoAnswers(
				"clipboard-probe: direction=host-to-guest verdict=probe-failed reason=pbpaste-status-127",
				COPIED,
			),
		});
		strictEqual(run.status, 7, `an unavailable pbpaste passed: ${run.stdout}`);
		ok(run.stdout.includes("did not run"));
	});

	it("asserts the guest-to-host direction, and fails when the guest sentinel reaches the host", () => {
		// The host pasteboard hands back whatever the guest copied. The stub
		// echoes the guest's own sentinel, which is the breach.
		const dir = scratch();
		const harness = join(dir, "leak.sh");
		const body = buildBody();
		writeFileSync(
			harness,
			[
				"#!/bin/bash",
				'PROVIDER_USER="switchyard"',
				'log() { printf "LOG: %s\\n" "$*" >&2; }',
				'fail() { printf "FAIL: %s\\n" "$*"; exit 7; }',
				"pbcopy() { cat >/dev/null; }",
				// After the guest copies, the host sees the guest's sentinel.
				'pbpaste() { if [[ -f "$0.leaked" ]]; then printf "%s" "$guest_sentinel"; fi; }',
				`guest_exec_script() { cat >/dev/null; ${twoAnswers(ISOLATED, COPIED)}; printf 'x' > "$0.leaked"; }`,
				extractShellFunction(body, "clipboard_sentinel"),
				extractShellFunction(body, "assert_clipboard_isolation"),
				"assert_clipboard_isolation",
				'printf "CLIPBOARD-OK\\n"',
				"",
			].join("\n"),
		);
		const run = spawnSync("/bin/bash", [harness], { encoding: "utf8" });
		strictEqual(run.status, 7, `a guest-to-host leak passed: ${run.stdout}`);
		ok(
			run.stdout.includes("reached the host pasteboard"),
			`wrong failure: ${run.stdout}`,
		);
	});

	it("fails when the guest never confirmed its own copy, so host absence proves nothing", () => {
		const run = runClipboard({
			guestScript: twoAnswers(
				ISOLATED,
				"clipboard-probe: direction=guest-to-host verdict=probe-failed reason=guest-copy-not-readable",
			),
		});
		strictEqual(
			run.status,
			7,
			`an unconfirmed guest copy passed: ${run.stdout}`,
		);
		ok(run.stdout.includes("guest-to-host clipboard probe did not run"));
	});
});
