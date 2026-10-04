#!/usr/bin/env node
// Native headless Vibe for the simple "vibe-code" lane.
// Vibe authenticates with its own keychain login, so Mistral bills the Vibe Code
// allowance. No BWS secret, broker consumer or proxy is involved: this process
// never reads, receives or prints that credential. Vibe runs under Seatbelt with
// a per-run VIBE_HOME and HOME, no MISTRAL_API_KEY in its environment (an
// inherited key would silently move billing to the API allowance), and only the
// file tools enabled, so the model has no shell or web tool to read the keychain
// item or send anything anywhere.

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	baseSeatbeltRules,
	createFail,
	detachSharedClone,
	MAX_PROMPT,
	MAX_WAIT_MS,
	readBoundedStdin,
	runSandboxedNative,
	SAFE_PATH,
	safeWorktree,
} from "./simple-native-launcher-core.mjs";

const SELF = fileURLToPath(import.meta.url);
const VIBE = "/Users/dave/.local/share/uv/tools/mistral-vibe/bin/vibe";
const VIBE_RUNTIME = "/Users/dave/.local/share/uv/tools/mistral-vibe";
const UV_PYTHON = "/Users/dave/.local/share/uv/python";
const ENABLED_TOOLS = Object.freeze([
	"edit",
	"write_file",
	"read_file",
	"grep",
]);
const THINKING = Object.freeze({ "glm-5-3-medium": "high", "glm-5-3": "max" });

const fail = createFail("simple-vibe-code-launcher");

export function parseLauncherArgs(argv) {
	if (argv.length !== 4) fail("invalid fixed argument set");
	const values = {};
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		if (!["--model", "--worktree"].includes(flag) || flag in values)
			fail("unknown or duplicate argument");
		values[flag] = argv[i + 1];
	}
	const model = values["--model"];
	if (!Object.hasOwn(THINKING, model)) fail("model is not approved");
	return { model, worktree: safeWorktree(values["--worktree"], fail) };
}

export function renderVibeCodeConfig(model, runtime) {
	const aliases = Object.entries(THINKING)
		.map(
			([alias, thinking]) =>
				`[[models]]\nname = "zai-glm-5-3"\nprovider = "mistral"\nalias = "${alias}"\nthinking = "${thinking}"\n`,
		)
		.join("\n");
	return `active_model = ${JSON.stringify(model)}\nenable_telemetry = false\nenable_otel = false\nenable_update_checks = false\nenable_auto_update = false\n\n[session_logging]\nsave_dir = ${JSON.stringify(join(runtime, "vibe", "logs", "session"))}\n\n[[providers]]\nname = "mistral"\napi_base = "https://api.mistral.ai/v1"\napi_key_env_var = "MISTRAL_API_KEY"\napi_style = "openai"\nbackend = "mistral"\n\n${aliases}`;
}

export function vibeCodeArgs(worktree) {
	return [
		"-p",
		"--agent",
		"accept-edits",
		"--auto-approve",
		"--trust",
		"--workdir",
		worktree,
		"--output",
		"json",
		...ENABLED_TOOLS.flatMap((tool) => ["--enabled-tools", tool]),
	];
}

export function vibeCodeEnvironment(runtime) {
	// Allowlist only: nothing from the launcher's own environment is inherited.
	return {
		PATH: SAFE_PATH,
		HOME: join(runtime, "home"),
		TMPDIR: runtime,
		TMP: runtime,
		TEMP: runtime,
		USER: "dave",
		LOGNAME: "dave",
		LC_ALL: "C",
		NO_COLOR: "1",
		CI: "1",
		VIBE_HOME: join(runtime, "vibe"),
		VIBE_DISABLE_TELEMETRY: "1",
	};
}

export function vibeCodeSeatbeltProfile({ worktree, runtime, keychains }) {
	const reads = [
		"/System",
		"/usr",
		"/bin",
		"/sbin",
		"/dev",
		"/private/etc",
		"/private/var/db",
		"/Library/Keychains",
		"/Library/Preferences",
		"/private/var/run",
		worktree,
		runtime,
		VIBE_RUNTIME,
		UV_PYTHON,
		keychains,
	];
	return baseSeatbeltRules({ reads, writes: [worktree, runtime] });
}

function verifyVibeSession(runtime, model) {
	const sessions = join(runtime, "vibe", "logs", "session");
	if (!existsSync(sessions)) return false;
	return readdirSync(sessions, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.some((dir) => {
			try {
				return (
					JSON.parse(
						readFileSync(join(sessions, dir.name, "meta.json"), "utf8"),
					)?.config?.active_model === model
				);
			} catch {
				return false;
			}
		});
}

export async function runVibeCode({
	model,
	worktree,
	prompt,
	cliPath = VIBE,
	timeoutMs = MAX_WAIT_MS,
	verifySession = true,
	keychains = join(homedir(), "Library", "Keychains"),
	sandboxExec,
}) {
	if (!Object.hasOwn(THINKING, model)) fail("model is not approved");
	if (
		typeof prompt !== "string" ||
		!prompt ||
		Buffer.byteLength(prompt) > MAX_PROMPT
	)
		fail("prompt is empty or too large");
	detachSharedClone(worktree, fail);
	const runtime = mkdtempSync(join(dirname(worktree), ".switchyard-vibecode-"));
	try {
		mkdirSync(join(runtime, "vibe"), { mode: 0o700 });
		mkdirSync(join(runtime, "home", "Library"), { recursive: true });
		// `security` resolves the login keychain from HOME; expose only that directory.
		symlinkSync(keychains, join(runtime, "home", "Library", "Keychains"));
		writeFileSync(
			join(runtime, "vibe", "config.toml"),
			renderVibeCodeConfig(model, runtime),
			{ mode: 0o600 },
		);
		const profile = vibeCodeSeatbeltProfile({ worktree, runtime, keychains });
		return await runSandboxedNative({
			fail,
			label: "native vibe",
			worktree,
			prompt,
			cliPath,
			args: vibeCodeArgs(worktree),
			env: vibeCodeEnvironment(runtime),
			profile,
			runtime,
			timeoutMs,
			...(sandboxExec ? { sandboxExec } : {}),
			verify: () => {
				if (verifySession && !verifyVibeSession(runtime, model))
					fail("Vibe session does not prove the requested model alias");
			},
		});
	} finally {
		rmSync(runtime, { recursive: true, force: true });
	}
}

async function main() {
	const options = parseLauncherArgs(process.argv.slice(2));
	const prompt = await readBoundedStdin(fail);
	const result = await runVibeCode({ ...options, prompt });
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	process.exitCode = result.code;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF)
	main().catch((error) => {
		process.stderr.write(
			`simple-vibe-code-launcher: failed closed (${String(error?.message ?? error).slice(0, 300)})\n`,
		);
		process.exitCode = 76;
	});
