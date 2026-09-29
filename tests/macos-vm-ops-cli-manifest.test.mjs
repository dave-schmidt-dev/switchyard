import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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
describe("the pinned CLI manifest", () => {
	it("passes build-golden-image.sh's own validator", notDarwin, () => {
		const body = readFileSync(BUILD, "utf8");
		const dir = scratch();
		const harness = join(dir, "validate.sh");
		// log() and fail() are what the validator reports through; take them
		// from the same file rather than restating them.
		writeFileSync(
			harness,
			[
				"#!/bin/bash",
				"set -Eeuo pipefail",
				'readonly SCRIPT_NAME="validator-harness"',
				extractShellFunction(body, "log"),
				extractShellFunction(body, "fail"),
				extractShellFunction(body, "validate_cli_manifest"),
				`CLI_MANIFEST=${JSON.stringify(MANIFEST)}`,
				"validate_cli_manifest",
				'printf "MANIFEST OK\\n"',
			].join("\n"),
		);
		const r = spawnSync("bash", [harness], { encoding: "utf8" });
		strictEqual(r.status, 0, `validator rejected the manifest: ${r.stderr}`);
		ok(r.stdout.includes("MANIFEST OK"));
	});

	it("covers exactly the providers the build asserts on PATH", () => {
		const rows = readManifestRows();
		strictEqual(rows.length, REQUIRED_PROVIDERS.length);
		const providers = rows.map((row) => row.provider).sort();
		strictEqual(providers.join(","), [...REQUIRED_PROVIDERS].sort().join(","));
	});

	it("pins each ref to the expected install source", () => {
		for (const row of readManifestRows()) {
			strictEqual(
				row.ref,
				EXPECTED_REFS[row.provider],
				`manifest ref drifted for ${row.provider}`,
			);
		}
	});

	it("carries a full sha256 and release version on every row", () => {
		for (const row of readManifestRows()) {
			strictEqual(row.rest.length, 0, `trailing field: ${row.line}`);
			ok(/^[0-9a-f]{64}$/.test(row.hash), `not a sha256: ${row.line}`);
			ok(
				/^[0-9][0-9A-Za-z.+_-]*$/.test(row.version),
				`bad version: ${row.line}`,
			);
			if (row.kind === "npm" || row.kind === "brew") {
				ok(
					/^[0-9][0-9A-Za-z.+_-]*$/.test(row.detail),
					`bad version detail: ${row.line}`,
				);
				strictEqual(
					row.version,
					row.detail,
					`version must equal detail: ${row.line}`,
				);
			} else {
				strictEqual(row.kind, "script");
				ok(
					row.detail === "bash" || row.detail === "sh",
					`bad shell: ${row.line}`,
				);
				ok(
					row.ref.startsWith("https://"),
					`installer must be HTTPS: ${row.line}`,
				);
			}
		}
	});

	it(
		"validator rejects a five-field row and an npm version mismatch",
		notDarwin,
		() => {
			const body = readFileSync(BUILD, "utf8");
			const validate = (manifestContent) => {
				const dir = scratch();
				const manifestPath = join(dir, "cli-manifest.txt");
				writeFileSync(manifestPath, manifestContent);
				const harness = join(dir, "validate.sh");
				writeFileSync(
					harness,
					[
						"#!/bin/bash",
						"set -Eeuo pipefail",
						'readonly SCRIPT_NAME="validator-harness"',
						extractShellFunction(body, "log"),
						extractShellFunction(body, "fail"),
						extractShellFunction(body, "validate_cli_manifest"),
						`CLI_MANIFEST=${JSON.stringify(manifestPath)}`,
						"validate_cli_manifest",
					].join("\n"),
				);
				return spawnSync("bash", [harness], { encoding: "utf8" });
			};

			const goodManifest = readFileSync(MANIFEST, "utf8");

			// Five-field row (missing sixth column)
			const fiveField = goodManifest.replace(
				/^(claude\|script\|[^|]+\|[^|]+\|[^|]+)\|.*$/m,
				"$1",
			);
			const rFive = validate(fiveField);
			strictEqual(
				rFive.status,
				1,
				`validator accepted 5-field row: ${rFive.stdout}`,
			);

			// npm row whose version differs from detail
			const npmMismatch = goodManifest.replace(
				/^(opencode\|npm\|opencode-ai\|[0-9.]+)\|([0-9a-f]{64})\|([0-9.]+)$/m,
				"$1|$2|999.999.999",
			);
			const rMismatch = validate(npmMismatch);
			strictEqual(
				rMismatch.status,
				1,
				`validator accepted npm version mismatch: ${rMismatch.stdout}`,
			);
		},
	);

	it("is generated, and says so, so no one hand-edits a hash", () => {
		const header = readFileSync(MANIFEST, "utf8");
		ok(/GENERATED BY generate-cli-manifest\.sh/.test(header));
		ok(/Do not hand-edit a hash/.test(header));
	});

	it("has a generator that refuses an npm row the registry does not confirm", () => {
		const body = readFileSync(GENERATOR, "utf8");
		// The npm rows are the only ones with an independent witness; losing
		// that check would silently downgrade them to "whatever this host had".
		ok(body.includes("dist.tarball"), "generator no longer reads dist.tarball");
		ok(
			/\[\[ "\$packed_hash" == "\$registry_hash" \]\] \|\|/.test(body),
			"generator no longer compares the packed and registry tarballs",
		);
	});

	it("generator requires --claude-version and --codex-version before network access", () => {
		const rNoClaude = spawnSync(
			"/bin/bash",
			[GENERATOR, "--codex-version", "0.155.1"],
			{
				encoding: "utf8",
				env: { ...process.env, PATH: "/nonexistent" },
			},
		);
		strictEqual(rNoClaude.status, 1);
		ok(rNoClaude.stderr.includes("--claude-version is required"));

		const rNoCodex = spawnSync(
			"/bin/bash",
			[GENERATOR, "--claude-version", "2.1.280"],
			{
				encoding: "utf8",
				env: { ...process.env, PATH: "/nonexistent" },
			},
		);
		strictEqual(rNoCodex.status, 1);
		ok(rNoCodex.stderr.includes("--codex-version is required"));

		const rBadPattern = spawnSync(
			"/bin/bash",
			[
				GENERATOR,
				"--claude-version",
				"bad/version",
				"--codex-version",
				"0.155.1",
			],
			{
				encoding: "utf8",
				env: { ...process.env, PATH: "/nonexistent" },
			},
		);
		strictEqual(rBadPattern.status, 1);
		ok(rBadPattern.stderr.includes("invalid claude version"));
	});

	it("cursor version extraction behavior: one version passes, zero or two fail", () => {
		const genBody = readFileSync(GENERATOR, "utf8");
		const dir = scratch();
		const extractCursorVersion = extractShellFunction(
			genBody,
			"extract_cursor_version",
		);
		const harness = join(dir, "cursor_extract.sh");
		writeFileSync(
			harness,
			[
				"#!/bin/bash",
				"set -Eeuo pipefail",
				'fail() { printf "FAIL: %s\\n" "$*" >&2; exit 1; }',
				extractCursorVersion,
				'extract_cursor_version "$1"',
			].join("\n"),
		);

		const oneFile = join(dir, "one.sh");
		writeFileSync(
			oneFile,
			"curl -s https://downloads.cursor.com/lab/2026.09.18-9a7762b/darwin-arm64\n" +
				"curl -s https://downloads.cursor.com/lab/2026.09.18-9a7762b/darwin-x64\n",
		);
		const rOne = spawnSync("/bin/bash", [harness, oneFile], {
			encoding: "utf8",
		});
		strictEqual(rOne.status, 0, `one version failed: ${rOne.stderr}`);
		strictEqual(rOne.stdout.trim(), "2026.09.18-9a7762b");

		const zeroFile = join(dir, "zero.sh");
		writeFileSync(zeroFile, "echo 'no version url here'\n");
		const rZero = spawnSync("/bin/bash", [harness, zeroFile], {
			encoding: "utf8",
		});
		strictEqual(
			rZero.status,
			1,
			`zero versions unexpectedly succeeded: ${rZero.stdout}`,
		);

		const twoFile = join(dir, "two.sh");
		writeFileSync(
			twoFile,
			"curl -s https://downloads.cursor.com/lab/1.0.0/darwin-arm64\n" +
				"curl -s https://downloads.cursor.com/lab/2.0.0/darwin-arm64\n",
		);
		const rTwo = spawnSync("/bin/bash", [harness, twoFile], {
			encoding: "utf8",
		});
		strictEqual(
			rTwo.status,
			1,
			`two versions unexpectedly succeeded: ${rTwo.stdout}`,
		);
	});
});
