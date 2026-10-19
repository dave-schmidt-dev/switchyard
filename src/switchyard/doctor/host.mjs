/**
 * Host probes for the full `switchyard doctor`: the quick-check sandbox
 * toolchain, provider CLI versions, bridge content pins and LaunchAgents.
 *
 * Every spawn is an absolute executable with a fixed argv, no shell and a
 * bounded timeout. Nothing here runs a provider beyond `--version`, runs the
 * bws broker, or reads a secret: the broker registry is read as source text
 * and only Switchyard consumer names, paths and content pins are matched.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	constants,
	createReadStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	quickCheckSandboxProfile,
	safeEnv,
} from "../runner/checks-sandbox.mjs";
import {
	parseBrokerConsumers,
	parseCliManifest,
	SANDBOX_TOOLS,
} from "./checks.mjs";

const PROBE_TIMEOUT_MS = 15_000;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** The broker the simple lane launches (provider-invocation.mjs). */
const BWS_BROKER = "/Users/dave/.agent/bin/bws-secret-exec";
const CANARY_LABEL = "com.zerodelta.switchyard.sandbox-canary";
const REAPER_LABEL = "com.zerodelta.switchyard.reaper";

function run(file, args, options = {}) {
	return new Promise((done) => {
		execFile(
			file,
			args,
			{
				timeout: PROBE_TIMEOUT_MS,
				maxBuffer: 256 * 1024,
				encoding: "utf8",
				...options,
			},
			(error, stdout, stderr) =>
				done({ error, output: `${stdout ?? ""}${stderr ?? ""}` }),
		);
	});
}
const spawnError = (error) =>
	error?.killed ? "timeout" : String(error?.code ?? error?.signal ?? error);

async function sha256File(path) {
	try {
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(path)) hash.update(chunk);
		return hash.digest("hex");
	} catch {
		return null;
	}
}

/** `command -v` for node, npm and uv inside a throwaway check sandbox. */
export async function probeSandboxToolchain() {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "sy-doctor-"));
	try {
		const clone = join(root, "clone");
		const runtime = join(root, "runtime");
		mkdirSync(clone, { mode: 0o700 });
		mkdirSync(runtime, { mode: 0o700 });
		const env = safeEnv(runtime);
		const profile = quickCheckSandboxProfile(clone, runtime, [], {});
		const answers = await Promise.all(
			SANDBOX_TOOLS.map((tool) =>
				run(
					"/usr/bin/sandbox-exec",
					[
						"-p",
						profile,
						"/bin/sh",
						"-c",
						'command -v -- "$1"',
						"doctor",
						tool,
					],
					{ cwd: clone, env },
				),
			),
		);
		const tools = {};
		SANDBOX_TOOLS.forEach((tool, index) => {
			const path = answers[index].output.trim();
			tools[tool] = !answers[index].error && isAbsolute(path) ? path : null;
		});
		return { tools };
	} catch (error) {
		return { error: String(error?.code ?? error?.message ?? error) };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function onPath(name, path = process.env.PATH ?? "") {
	for (const dir of path.split(delimiter)) {
		if (!isAbsolute(dir)) continue;
		try {
			accessSync(join(dir, name), constants.X_OK);
			return join(dir, name);
		} catch {}
	}
	return null;
}

/** Manifest pins and each pinned CLI's `--version`, resolved on PATH. */
export async function probeProviderClis({
	manifestPath = join(REPO_ROOT, "ops/macos-vm/cli-manifest.txt"),
} = {}) {
	let pins;
	try {
		pins = parseCliManifest(readFileSync(manifestPath, "utf8"));
	} catch {
		return { pins: [], probes: {} };
	}
	const entries = await Promise.all(
		pins.map(async ({ provider }) => {
			const path = onPath(provider);
			if (!path) return [provider, { path: null }];
			const answer = await run(path, ["--version"], {
				env: { ...process.env, NO_COLOR: "1" },
			});
			return [
				provider,
				{
					path,
					output: answer.output,
					...(answer.error ? { error: spawnError(answer.error) } : {}),
				},
			];
		}),
	);
	return { pins, probes: Object.fromEntries(entries) };
}

/**
 * Hash each Switchyard broker consumer's executable against its registry
 * pin.
 */
export async function probeBridgePins({ broker = BWS_BROKER } = {}) {
	if (!existsSync(broker)) return { brokerPresent: false };
	let registryPath = null;
	let consumers = [];
	try {
		registryPath =
			readFileSync(broker, "utf8").match(/\s(\/\S+\.py)(?=\s|$)/u)?.[1] ?? null;
		if (registryPath)
			consumers = parseBrokerConsumers(readFileSync(registryPath, "utf8"));
	} catch {
		consumers = [];
	}
	const executables = [...new Set(consumers.map((entry) => entry.executable))];
	const hashes = Object.fromEntries(
		await Promise.all(
			executables.map(async (path) => [path, await sha256File(path)]),
		),
	);
	return { brokerPresent: true, registryPath, consumers, hashes };
}

async function loaded(label) {
	const answer = await run("/bin/launchctl", [
		"print",
		`gui/${userInfo().uid}/${label}`,
	]);
	return !answer.error;
}

/** Plist presence, launchctl load state and canary state; reaper presence only. */
export async function probeLaunchAgents({
	home = homedir(),
	env = process.env,
} = {}) {
	const agents = join(home, "Library/LaunchAgents");
	const support = join(home, "Library/Application Support/switchyard");
	const stateDir =
		env.SWITCHYARD_CANARY_STATE_DIR || join(support, "sandbox-canary-state");
	let state = null;
	try {
		state = JSON.parse(
			readFileSync(join(stateDir, "canary-state.json"), "utf8"),
		);
	} catch {}
	const [canaryLoaded, reaperLoaded] = await Promise.all([
		loaded(CANARY_LABEL),
		loaded(REAPER_LABEL),
	]);
	return {
		canary: {
			plist: existsSync(join(agents, `${CANARY_LABEL}.plist`)),
			loaded: canaryLoaded,
			state,
		},
		reaper: {
			plist: existsSync(join(agents, `${REAPER_LABEL}.plist`)),
			loaded: reaperLoaded,
		},
	};
}
