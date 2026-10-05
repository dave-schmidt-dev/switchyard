// The cadence's side effects on the owner's Mac: reading channels, staging a
// candidate CLI in scratch, running the repo's own sync scripts, committing
// pins on a local branch, and notifying. cadence-core.mjs decides; this acts.
//
// Staging never touches the live install: npm and PyPI candidates install
// under the run's scratch directory, and installer-script CLIs run with HOME
// pointed there. The host is updated only through sync-host-clis.sh, only in
// promote mode, and only for candidates that passed.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	collectSwitchyardCallSites,
	parseContractSites,
} from "../../src/switchyard/cli-contract/call-sites.mjs";
import {
	checkFlagContract,
	FAILING_CANARY_STATUSES,
	formatFlagContractReport,
	runCanaries,
} from "../../src/switchyard/cli-contract/check.mjs";
import { extractCliVersion } from "../../src/switchyard/cli-contract/help-flags.mjs";
import { CHANNELS, resolveLatestStable } from "./channels.mjs";

const STEP_TIMEOUT_MS = 15 * 60 * 1000;
const HEARTBEAT_MS = 30_000;
const FETCH_TIMEOUT_MS = 30_000;

/** Run a command with a deadline and a heartbeat; never throws. */
export function runStep(
	command,
	args,
	{ log, cwd, env, timeoutMs = STEP_TIMEOUT_MS } = {},
) {
	return new Promise((done) => {
		const label = [command, ...args].join(" ").slice(0, 160);
		let stdout = "";
		let stderr = "";
		let child;
		try {
			child = spawn(command, args, {
				cwd,
				env: env ?? process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			done({ status: null, stdout, stderr: error.message });
			return;
		}
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const started = Date.now();
		const heartbeat = setInterval(
			() =>
				log?.(
					`still running (${Math.round((Date.now() - started) / 1000)}s): ${label}`,
				),
			HEARTBEAT_MS,
		);
		const timer = setTimeout(() => {
			log?.(`timed out after ${timeoutMs / 1000}s: ${label}`);
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
		}, timeoutMs);
		const finish = (status, error) => {
			clearInterval(heartbeat);
			clearTimeout(timer);
			done({
				status,
				stdout,
				stderr: error ? `${stderr}${error.message}` : stderr,
			});
		};
		child.once("error", (error) => finish(null, error));
		child.once("close", (status) => finish(status, null));
	});
}

function lines(text) {
	return String(text)
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean);
}

async function fetchChecked(url) {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	return response;
}

/**
 * Real I/O for runCadence. `repo` is the Switchyard checkout; `scratch` a
 * private mktemp directory the caller removes.
 */
export function createHostIo({ repo, scratch, log, agentContractPath }) {
	const manifestPath = join(repo, "ops/macos-vm/cli-manifest.txt");
	const run = (command, args, options = {}) =>
		runStep(command, args, { log, ...options });

	function contractSites() {
		const sites = collectSwitchyardCallSites();
		if (agentContractPath && existsSync(agentContractPath))
			sites.push(
				...parseContractSites(
					readFileSync(agentContractPath, "utf8"),
					agentContractPath,
				),
			);
		return sites;
	}

	async function stageNpm(name, version) {
		const { pkg } = CHANNELS[name].source;
		const prefix = join(scratch, `stage-${name}`);
		const result = await run("npm", [
			"install",
			"--prefix",
			prefix,
			"--no-audit",
			"--no-fund",
			`${pkg}@${version}`,
		]);
		const binary = join(prefix, "node_modules/.bin", CHANNELS[name].bin);
		return result.status === 0 && existsSync(binary)
			? { ok: true, binary }
			: {
					ok: false,
					reason: `npm install ${pkg}@${version} failed: ${lines(result.stderr).at(-1) ?? "no output"}`,
				};
	}

	async function stagePypi(name, version) {
		const venv = join(scratch, `stage-${name}`);
		const create = await run("uv", ["venv", "--python", "3.12", venv]);
		const install =
			create.status === 0
				? await run("uv", [
						"pip",
						"install",
						"--python",
						join(venv, "bin/python"),
						`${CHANNELS[name].pypi}==${version}`,
					])
				: create;
		const binary = join(venv, "bin", CHANNELS[name].bin);
		return install.status === 0 && existsSync(binary)
			? { ok: true, binary }
			: {
					ok: false,
					reason: `uv install ${version} failed: ${lines(install.stderr).at(-1) ?? "no output"}`,
				};
	}

	async function stageInstaller(name, version, row) {
		if (!row) return { ok: false, reason: "no candidate manifest row" };
		const response = await fetchChecked(CHANNELS[name].source.url);
		const bytes = Buffer.from(await response.arrayBuffer());
		const hash = createHash("sha256").update(bytes).digest("hex");
		if (hash !== row.hash)
			return {
				ok: false,
				reason: `installer changed since the candidate manifest was generated (${hash})`,
			};
		const home = join(scratch, `stage-${name}-home`);
		mkdirSync(home, { recursive: true });
		const installer = join(scratch, `${name}.installer`);
		writeFileSync(installer, bytes, { mode: 0o700 });
		const result = await run("/bin/bash", [installer], {
			env: {
				PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
				HOME: home,
				TMPDIR: scratch,
			},
		});
		const binary = join(home, ".local/bin", CHANNELS[name].bin);
		return result.status === 0 && existsSync(binary)
			? { ok: true, binary, note: `installed ${version} under a scratch HOME` }
			: {
					ok: false,
					reason: `installer failed or placed no ${CHANNELS[name].bin} in ~/.local/bin`,
				};
	}

	async function brewStable(formula) {
		const result = await run("brew", ["info", "--json=v2", formula], {
			timeoutMs: 120_000,
		});
		try {
			return JSON.parse(result.stdout).formulae?.[0]?.versions?.stable ?? null;
		} catch {
			return null;
		}
	}

	return {
		log,
		failingCanaryStatuses: FAILING_CANARY_STATUSES,
		readManifest: async () => readFileSync(manifestPath, "utf8"),
		resolveLatest: (name) =>
			resolveLatestStable(name, {
				npmView: async (pkg, field) => {
					const result = await run("npm", ["view", pkg, field]);
					if (result.status !== 0)
						throw new Error(`npm view ${pkg} ${field} failed`);
					return result.stdout;
				},
				brewStable,
				fetchText: async (url) => (await fetchChecked(url)).text(),
				fetchJson: async (url) => (await fetchChecked(url)).json(),
			}),
		hostVersion: async (bin) => {
			const result = await run(bin, ["--version"], { timeoutMs: 30_000 });
			return result.status === 0
				? extractCliVersion(`${result.stdout}\n${result.stderr}`)
				: null;
		},
		otherChannelVersion: async ({ kind, formula }) =>
			kind === "brew" ? brewStable(formula) : null,
		syncHostCheck: async () => {
			const result = await run(join(repo, "ops/macos-vm/sync-host-clis.sh"), [
				"--cli-manifest",
				manifestPath,
				"--check",
			]);
			return {
				ok: result.status === 0,
				lines: lines(result.stderr).filter((line) => /DRIFT|ERROR/u.test(line)),
			};
		},
		contract: async ({ strict, only = [], binOverrides = {} }) => {
			const report = checkFlagContract(contractSites(), {
				strict,
				only,
				binOverrides,
			});
			return { ok: report.ok, lines: lines(formatFlagContractReport(report)) };
		},
		canary: ({ names, binOverrides }) =>
			runCanaries({ names, binOverrides, log }),
		generateCandidateManifest: async (versions) => {
			const out = join(scratch, "cli-manifest.candidate.txt");
			const result = await run(
				join(repo, "ops/macos-vm/generate-cli-manifest.sh"),
				[
					"--out",
					out,
					"--claude-version",
					versions.claude,
					"--codex-version",
					versions.codex,
					"--copilot-version",
					versions.copilot,
					"--opencode-version",
					versions.opencode,
					"--vibe-version",
					versions.vibe,
				],
			);
			if (result.status !== 0)
				throw new Error(
					`generate-cli-manifest.sh failed: ${lines(result.stderr).at(-1) ?? "no output"}`,
				);
			return readFileSync(out, "utf8");
		},
		stage: async (name, version, row) => {
			try {
				const { stage } = CHANNELS[name];
				if (stage === "npm") return await stageNpm(name, version);
				if (stage === "pypi") return await stagePypi(name, version);
				return await stageInstaller(name, version, row);
			} catch (error) {
				return { ok: false, reason: error.message };
			}
		},
		promoteHost: async ({ manifestText, providers, hostOnly }) => {
			const out = [];
			let ok = true;
			if (providers.length > 0) {
				const finalPath = join(scratch, "cli-manifest.promoted.txt");
				writeFileSync(finalPath, manifestText);
				const result = await run(join(repo, "ops/macos-vm/sync-host-clis.sh"), [
					"--cli-manifest",
					finalPath,
					...providers.flatMap((provider) => ["--only", provider]),
				]);
				ok &&= result.status === 0;
				out.push(...lines(result.stderr));
			}
			for (const { name, version } of hostOnly) {
				const result = await run("npm", [
					"install",
					"--global",
					`${CHANNELS[name].source.pkg}@${version}`,
				]);
				ok &&= result.status === 0;
				out.push(`${name}: npm install --global exited ${result.status}`);
			}
			return { ok, lines: out };
		},
		commitPins: async ({ manifestText, bumps }) => {
			const branch =
				`cli-cadence/${new Date().toISOString().slice(0, 10)}-${bumps.map((b) => `${b.name}-${b.to}`).join("-")}`.replace(
					/[^A-Za-z0-9._/-]/gu,
					"-",
				);
			const worktree = join(scratch, "pin-worktree");
			const git = (...args) => run("git", ["-C", repo, ...args]);
			const add = await git("worktree", "add", "-b", branch, worktree, "HEAD");
			if (add.status !== 0)
				throw new Error(`git worktree add failed: ${lines(add.stderr).at(-1)}`);
			try {
				writeFileSync(
					join(worktree, "ops/macos-vm/cli-manifest.txt"),
					manifestText,
				);
				const subject = `Bump provider CLI pins: ${bumps.map((b) => `${b.name} ${b.from} -> ${b.to}`).join(", ")}`;
				const body =
					"Staged by ops/cli-cadence: every bumped CLI passed the flag contract against its staged binary and its live canary, and the host was updated and re-checked.";
				const commit = await run("git", [
					"-C",
					worktree,
					"commit",
					"--quiet",
					"-m",
					subject,
					"-m",
					body,
					"--",
					"ops/macos-vm/cli-manifest.txt",
				]);
				if (commit.status !== 0)
					throw new Error(`git commit failed: ${lines(commit.stderr).at(-1)}`);
				const sha = (
					await run("git", ["-C", worktree, "rev-parse", "HEAD"])
				).stdout.trim();
				return { branch, sha };
			} finally {
				await git("worktree", "remove", "--force", worktree);
			}
		},
	};
}

/** Tell the owner: their notifier if configured, else a macOS notification. */
export async function notifyOwner({ title, body }, { notifier, log }) {
	if (notifier) {
		const child = spawn(notifier, [title], {
			stdio: ["pipe", "ignore", "inherit"],
		});
		child.stdin.end(body);
		await new Promise((done) => child.once("close", done));
		return;
	}
	if (process.platform === "darwin") {
		const first = body
			.split("\n")
			.slice(1, 3)
			.join(" | ")
			.replace(/["\\]/gu, "");
		await runStep(
			"/usr/bin/osascript",
			["-e", `display notification "${first}" with title "${title}"`],
			{ log },
		);
	}
}
