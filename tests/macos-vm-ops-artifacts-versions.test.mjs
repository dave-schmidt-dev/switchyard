import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
describe("macOS golden-image ops artifacts", () => {
	it(
		"in-guest version check accepts exact shapes, rejects mismatch and substring trap",
		notDarwin,
		() => {
			const rendered = renderBuildGuestScripts(scratch());
			const block = rendered.find(
				(entry) =>
					entry.body.includes("extract_cli_version") &&
					entry.body.includes("verify_cli_versions"),
			);
			ok(
				block,
				"no guest block carries extract_cli_version and verify_cli_versions",
			);
			const dir = scratch();
			const binDir = join(dir, "bin");
			mkdirSync(binDir);

			const extractCliVersion = extractShellFunction(
				block.body,
				"extract_cli_version",
			);
			const verifyCliVersions = extractShellFunction(
				block.body,
				"verify_cli_versions",
			);

			const makeCli = (name, stdout, dir = binDir) => {
				const path = join(dir, name);
				writeFileSync(
					path,
					`#!/bin/bash\nprintf '%s\\n' ${JSON.stringify(stdout)}\n`,
				);
				chmodSync(path, 0o755);
			};

			// 1. Verify copilot extracts 1.0.87 specifically
			makeCli(
				"copilot",
				"GitHub Copilot CLI 1.0.87. Run 'copilot update' to check for updates.",
			);
			const harnessCopilot = join(dir, "copilot_extract.sh");
			writeFileSync(
				harnessCopilot,
				[
					"#!/bin/bash",
					"set -Eeuo pipefail",
					extractCliVersion,
					'extract_cli_version "$(copilot --version 2>&1 || true)"',
				].join("\n"),
			);
			const runCopilot = spawnSync("/bin/bash", [harnessCopilot], {
				encoding: "utf8",
				env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
			});
			strictEqual(
				runCopilot.status,
				0,
				`copilot extraction failed: ${runCopilot.stderr}`,
			);
			strictEqual(
				runCopilot.stdout.trim(),
				"1.0.87",
				"copilot version token must be 1.0.87",
			);

			// 2. Set up fake CLIs for each of the 7 providers covering all output shapes.
			// The versions below mirror cli-manifest.txt on purpose: the exact-match
			// run checks them against the committed manifest, so a manifest refresh
			// must update this table in the same change.
			const shapes = {
				claude: "2.1.280 (Claude Code)",
				codex: "codex-cli 0.155.1",
				agy: "1.2.8",
				"cursor-agent": "2026.09.18-9a7762b",
				copilot:
					"GitHub Copilot CLI 1.0.87. Run 'copilot update' to check for updates.",
				opencode: "1.18.30",
				vibe: "vibe 2.24.5",
			};
			for (const [provider, output] of Object.entries(shapes)) {
				makeCli(provider, output);
			}

			// Exact match pass: using committed MANIFEST
			const harness = join(dir, "verify_harness.sh");
			writeFileSync(
				harness,
				[
					"#!/bin/bash",
					"set -Eeuo pipefail",
					extractCliVersion,
					verifyCliVersions,
					'verify_cli_versions "$1"',
				].join("\n"),
			);

			const runGood = spawnSync("/bin/bash", [harness, MANIFEST], {
				encoding: "utf8",
				env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
			});
			strictEqual(
				runGood.status,
				0,
				`exact match check failed: ${runGood.stderr}`,
			);
			for (const provider of REQUIRED_PROVIDERS) {
				ok(
					runGood.stderr.includes(`[guest] verifying ${provider} --version`),
					`no progress line before checking ${provider}: ${runGood.stderr}`,
				);
			}

			// Mismatched release failure
			const badManifest = join(dir, "bad-manifest.txt");
			writeFileSync(
				badManifest,
				readFileSync(MANIFEST, "utf8").replaceAll("2.24.5", "2.24.4"),
			);
			const runMismatch = spawnSync("/bin/bash", [harness, badManifest], {
				encoding: "utf8",
				env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
			});
			strictEqual(
				runMismatch.status,
				1,
				`mismatch unexpectedly passed: ${runMismatch.stdout}`,
			);
			ok(
				runMismatch.stderr.includes(
					"[guest] ERROR: vibe reports version 2.24.5, manifest pins 2.24.4 (raw: vibe 2.24.5)",
				),
				`unexpected stderr on mismatch: ${runMismatch.stderr}`,
			);

			// 2.1.28 vs 2.1.280 substring trap
			const substringManifest = join(dir, "substring-manifest.txt");
			writeFileSync(
				substringManifest,
				readFileSync(MANIFEST, "utf8").replace("2.1.280", "2.1.28"),
			);
			const runSubstring = spawnSync(
				"/bin/bash",
				[harness, substringManifest],
				{
					encoding: "utf8",
					env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
				},
			);
			strictEqual(
				runSubstring.status,
				1,
				`substring trap passed: ${runSubstring.stdout}`,
			);
			ok(
				runSubstring.stderr.includes(
					"[guest] ERROR: claude reports version 2.1.280, manifest pins 2.1.28",
				),
				`unexpected stderr on substring trap: ${runSubstring.stderr}`,
			);

			// The cases below run on a PATH that cannot reach CLIs installed on
			// the host, so a missing fake cannot be masked by a real binary.
			const isolatedEnv = (label, { omit = [], scripts = {} } = {}) => {
				const isolatedBin = join(dir, label);
				mkdirSync(isolatedBin);
				for (const [provider, output] of Object.entries(shapes)) {
					if (!omit.includes(provider)) makeCli(provider, output, isolatedBin);
				}
				for (const [provider, body] of Object.entries(scripts)) {
					const path = join(isolatedBin, provider);
					writeFileSync(path, `#!/bin/bash\n${body}\n`);
					chmodSync(path, 0o755);
				}
				return { ...process.env, PATH: `${isolatedBin}:/usr/bin:/bin` };
			};

			// A pinned provider missing from PATH fails, after its progress line.
			const runAbsent = spawnSync("/bin/bash", [harness, MANIFEST], {
				encoding: "utf8",
				env: isolatedEnv("absent-bin", { omit: ["cursor-agent"] }),
			});
			strictEqual(
				runAbsent.status,
				1,
				`absent CLI unexpectedly passed: ${runAbsent.stderr}`,
			);
			ok(
				runAbsent.stderr.includes(
					"[guest] ERROR: pinned CLI is absent after installation: cursor-agent",
				),
				`unexpected stderr on absent CLI: ${runAbsent.stderr}`,
			);
			ok(
				runAbsent.stderr.includes("[guest] verifying cursor-agent --version"),
				`no progress line before the absent CLI: ${runAbsent.stderr}`,
			);

			// Output with no version token fails with the first raw line only.
			// Written to stderr with a non-zero exit, so it also proves the check
			// captures 2>&1 and survives a failing --version.
			const runUnparseable = spawnSync("/bin/bash", [harness, MANIFEST], {
				encoding: "utf8",
				env: isolatedEnv("unparseable-bin", {
					scripts: {
						agy: "printf '%s\\n' 'error: unknown flag --version' 'usage: agy [flags]' >&2\nexit 2",
					},
				}),
			});
			strictEqual(
				runUnparseable.status,
				1,
				`unparseable version unexpectedly passed: ${runUnparseable.stderr}`,
			);
			ok(
				runUnparseable.stderr.includes(
					"[guest] ERROR: agy reports no parseable version, manifest pins 1.2.8 (raw: error: unknown flag --version)",
				),
				`unexpected stderr on unparseable version: ${runUnparseable.stderr}`,
			);
			ok(
				!runUnparseable.stderr.includes("usage: agy"),
				`raw excerpt went past the first line: ${runUnparseable.stderr}`,
			);

			// The loop reads the manifest on stdin. A CLI that drains stdin must
			// not swallow the remaining rows and turn a mismatch into a pass.
			const runDrain = spawnSync("/bin/bash", [harness, badManifest], {
				encoding: "utf8",
				env: isolatedEnv("drain-bin", {
					scripts: {
						claude:
							"/bin/cat >/dev/null\nprintf '%s\\n' '2.1.280 (Claude Code)'",
					},
				}),
			});
			strictEqual(
				runDrain.status,
				1,
				`a stdin-reading CLI hid the vibe mismatch: ${runDrain.stderr}`,
			);
			ok(
				runDrain.stderr.includes(
					"[guest] ERROR: vibe reports version 2.24.5, manifest pins 2.24.4",
				),
				`unexpected stderr with a stdin-reading CLI: ${runDrain.stderr}`,
			);
		},
	);
});
