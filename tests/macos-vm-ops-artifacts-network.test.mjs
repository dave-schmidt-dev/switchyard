import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
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
	it("ships the generator, the probe, and a generated manifest", () => {
		for (const script of [BUILD, GENERATOR, PROBE]) {
			ok(existsSync(script), `missing: ${script}`);
			accessSync(script, constants.X_OK);
		}
		ok(existsSync(MANIFEST), `missing: ${MANIFEST}`);
	});
	it("every ops script passes `bash -n`", () => {
		for (const script of [BUILD, GENERATOR, PROBE]) {
			const r = spawnSync("bash", ["-n", script], { encoding: "utf8" });
			strictEqual(r.status, 0, `bash -n failed for ${script}: ${r.stderr}`);
		}
	});
	it("passes DHCP in both directions above the C-3 blocks", () => {
		const body = readFileSync(BUILD, "utf8");
		const start = body.indexOf('anchor "switchyard-transfer/*"');
		ok(start !== -1, "C-3 anchor rules moved");
		const end = body.indexOf("\nPFEOF", start);
		ok(end !== -1, "unterminated C-3 anchor heredoc");
		const rules = body
			.slice(start, end)
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("#"));

		const dhcpOut = rules.findIndex((line) =>
			/^pass\s+out quick on en0 proto udp from any port 68 to any port 67$/.test(
				line.replace(/\s+/g, " ").trim(),
			),
		);
		const dhcpIn = rules.findIndex((line) =>
			/^pass\s+in quick on en0 proto udp from any port 67 to any port 68$/.test(
				line.replace(/\s+/g, " ").trim(),
			),
		);
		const firstBlock = rules.findIndex((line) =>
			line.startsWith("block drop quick on en0"),
		);

		ok(dhcpOut !== -1, "no outbound DHCP pass in the C-3 anchor");
		ok(dhcpIn !== -1, "no inbound DHCP pass in the C-3 anchor");
		ok(firstBlock !== -1, "C-3 anchor lost its RFC1918 blocks");
		ok(
			dhcpOut < firstBlock && dhcpIn < firstBlock,
			"a DHCP pass below the blocks never matches: a fresh-MAC clone gets no lease",
		);
	});
	it("puts the provider's ~/.local/bin on the login PATH", () => {
		const body = readFileSync(BUILD, "utf8");
		ok(
			/\/etc\/paths\.d\/switchyard/.test(body),
			"the build no longer registers a path_helper entry for the provider CLIs",
		);
		ok(
			/printf '%s\\\\n' "\/Users\/\\\$provider_user\/\.local\/bin" > \/etc\/paths\.d\/switchyard/.test(
				body,
			),
			"the path_helper entry does not name the provider's ~/.local/bin",
		);
	});
	it("resolves every pinned CLI through a fresh provider login", () => {
		const body = readFileSync(BUILD, "utf8");
		const installStart = body.indexOf("INSTALL_SCRIPT");
		const installEnd = body.indexOf("\nINSTALL_SCRIPT", installStart);
		ok(installEnd !== -1, "installer heredoc moved");

		const loginCheck =
			/\/bin\/launchctl asuser "\\\$uid" \/usr\/bin\/sudo -u "\\\$provider_user" \/bin\/bash -lc/;
		const match = body.search(loginCheck);
		ok(match !== -1, "no login-PATH resolution check in the build");
		ok(
			match > installEnd,
			"the login-PATH check sits inside the installer heredoc, which exports the directory and can never fail",
		);
		ok(
			/pinned CLI is not on the provider login PATH/.test(body),
			"the login-PATH check does not fail closed with a distinct message",
		);
	});
	it("waits for guest DNS before installing the CLIs, over stdin", () => {
		const body = readFileSync(BUILD, "utf8");
		ok(
			/wait_for_guest_dns\(\)/.test(body),
			"the build no longer gates CLI installation on DNS readiness",
		);
		const installIndex = body.indexOf("install_guest_tools() {");
		ok(installIndex !== -1, "install_guest_tools moved");
		const installBody = body.slice(installIndex, installIndex + 200);
		ok(
			/wait_for_guest_dns/.test(installBody),
			"install_guest_tools does not wait for DNS before fetching installers",
		);

		// The probe is piped, and prlctl reparses an argv-supplied script, so
		// routing it through guest_exec would drop the pipe and the gate would
		// fail for its whole timeout against a guest that resolves fine.
		const gateStart = body.indexOf("wait_for_guest_dns() {");
		const gateBody = body.slice(gateStart, body.indexOf("\n}", gateStart));
		ok(
			/\| guest_exec_script/.test(gateBody),
			"the DNS probe does not use the stdin channel",
		);
		ok(
			!/guest_exec "/.test(gateBody),
			"the DNS probe uses guest_exec, whose argv reparse drops the pipe",
		);
	});
	it("renders guest scripts that parse under the guest's own bash", () => {
		const dir = scratch();
		for (const { line, body } of renderBuildGuestScripts(dir)) {
			const guest = join(dir, `guest-${line}.sh`);
			writeFileSync(guest, body);
			const r = spawnSync("/bin/bash", ["-n", guest], { encoding: "utf8" });
			strictEqual(
				r.status,
				0,
				`the guest block at line ${line} does not parse: ${r.stderr}`,
			);
		}
	});
});
