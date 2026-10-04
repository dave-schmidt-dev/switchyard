import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/tempdir.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const VM_OPS = resolve(PKG_ROOT, "ops/macos-vm");
const BUILD = resolve(VM_OPS, "build-golden-image.sh");
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
describe("macOS golden-image ops artifacts", () => {
	it("checks XcodeGen by generating a project, not by its version string", () => {
		const rendered = renderBuildGuestScripts(scratch());
		const { block, script } = extractProbeScript(rendered);

		ok(
			block.body.includes("share/xcodegen/SettingPresets"),
			"the build no longer asserts the XcodeGen preset tree is on disk",
		);
		// brew decides "installed" from the prefix, and the broken Cellar carries
		// no receipt, so `brew reinstall` alone can no-op against this exact state.
		// `uninstall --force` is brew bookkeeping too and can decline a formula it
		// does not consider installed, so the removal the install depends on is the
		// rm -- which needs no bookkeeping to be correct.
		ok(
			/uninstall --force xcodegen/.test(block.body),
			"the XcodeGen repair does not remove the broken install before reinstalling",
		);
		ok(
			/rm -rf "\$brew_path\/Cellar\/xcodegen"/.test(block.body),
			"the XcodeGen repair leaves the broken Cellar directory to brew's bookkeeping, which does not model it",
		);
		// The guest script is root. A root-owned mktemp -d at mode 700 would make
		// the generate fail on permissions and report a cause that is not the
		// cause, so the probe's directory has to be created in the same hop that
		// runs xcodegen.
		ok(
			script.includes('mktemp -d "$HOME/'),
			"the XcodeGen probe does not create its working directory as the build user",
		);
		ok(
			/XcodeGen did not generate a project carrying a product name: \$xcodegen_probe_out/.test(
				block.body,
			),
			"the XcodeGen failure does not carry the probe's own output, so it cannot say why it stopped",
		);
	});
	it("restores Homebrew ownership before using the administrator install session", () => {
		const { block } = extractProbeScript(renderBuildGuestScripts(scratch()));
		const ownershipRepair = block.body.indexOf(
			"restoring Homebrew ownership to the existing administrator build session",
		);
		const nodeInstall = block.body.indexOf(
			"installing Node through the existing administrator build session",
		);
		ok(
			ownershipRepair !== -1,
			"the build does not repair a root-owned Homebrew prefix",
		);
		ok(
			ownershipRepair < nodeInstall,
			"Homebrew ownership is repaired only after an administrator-scoped brew install",
		);
		ok(
			/\/usr\/sbin\/chown -R "\$console_user:admin" "\$brew_path"/.test(
				block.body,
			),
			"the Homebrew repair does not restore the console administrator as owner",
		);
	});
	it("fails a preset-less XcodeGen and passes a healthy one", () => {
		const { script } = extractProbeScript(renderBuildGuestScripts(scratch()));
		const dir = scratch();
		const probe = join(dir, "probe.sh");
		writeFileSync(probe, script);

		const stub = (name, body) => {
			const path = join(dir, name);
			writeFileSync(path, `#!/bin/bash\n${body}\n`);
			chmodSync(path, 0o755);
			return path;
		};
		// What the broken image does: exits 0, warns, writes a project whose
		// product name is empty.
		const presetless = stub(
			"xcodegen-preset-less",
			[
				`printf 'No "base" settings found\\n'`,
				"mkdir -p SwitchyardPresetProbe.xcodeproj",
				"printf 'PRODUCT_NAME = \"\";\\n' > SwitchyardPresetProbe.xcodeproj/project.pbxproj",
			].join("\n"),
		);
		const healthy = stub(
			"xcodegen-healthy",
			[
				"mkdir -p SwitchyardPresetProbe.xcodeproj",
				"printf 'path = SwitchyardPresetProbe.app;\\n' > SwitchyardPresetProbe.xcodeproj/project.pbxproj",
			].join("\n"),
		);

		const run = (bin) =>
			spawnSync("/bin/bash", [probe, bin], {
				encoding: "utf8",
				env: { ...process.env, HOME: dir },
			});

		const broken = run(presetless);
		ok(
			broken.stdout.includes('No "base" settings found'),
			"the probe swallowed the preset warning the build greps for",
		);
		ok(
			!broken.stdout.includes("SWITCHYARD_XCODEGEN_PRODUCT_NAME_OK"),
			"the probe passed a preset-less XcodeGen",
		);

		const good = run(healthy);
		strictEqual(
			good.status,
			0,
			`probe failed a healthy install: ${good.stderr}`,
		);
		ok(
			good.stdout.includes("SWITCHYARD_XCODEGEN_PRODUCT_NAME_OK"),
			"the probe does not signal success on a healthy install",
		);
		ok(
			!readdirSync(dir).some((entry) =>
				entry.startsWith(".switchyard-xcodegen-probe."),
			),
			"the probe left its working directory in the image",
		);
	});
	it("does not let xcodegen eat the rest of the probe", () => {
		const { script } = extractProbeScript(renderBuildGuestScripts(scratch()));
		const dir = scratch();
		const greedy = join(dir, "xcodegen-greedy");
		writeFileSync(
			greedy,
			[
				"#!/bin/bash",
				// Exactly what a CLI that prompts does to a piped script.
				"cat >/dev/null",
				"mkdir -p SwitchyardPresetProbe.xcodeproj",
				"printf 'path = SwitchyardPresetProbe.app;\\n' > SwitchyardPresetProbe.xcodeproj/project.pbxproj",
				"",
			].join("\n"),
		);
		chmodSync(greedy, 0o755);

		const run = spawnSync("/bin/bash", ["-s", "--", greedy], {
			encoding: "utf8",
			input: script,
			env: { ...process.env, HOME: dir },
		});
		ok(
			run.stdout.includes("SWITCHYARD_XCODEGEN_PRODUCT_NAME_OK"),
			"a stdin-reading xcodegen ate the probe's remaining lines, so the check silently never ran",
		);
	});
	it("renders guest install script passing pinned version to claude and codex installers", () => {
		const rendered = renderBuildGuestScripts(scratch());
		const block = rendered.find((entry) =>
			entry.body.includes("install_script_cli"),
		);
		ok(block, "no guest block contains install_script_cli");
		ok(
			/\/bin\/bash\s+"\$installer"\s+"\$version"/.test(block.body),
			"claude installer does not receive version as its first positional argument",
		);
		// sudo -iu resets the environment, so the non-interactive flag has to
		// ride on the installer's own command line.
		ok(
			block.body.includes(
				'CODEX_NON_INTERACTIVE=1 /bin/bash "$installer" --release "$version"',
			),
			"codex installer does not run non-interactively with version via --release",
		);
	});
});
