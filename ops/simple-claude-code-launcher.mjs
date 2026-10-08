#!/usr/bin/env node
// Native headless Claude Code for the simple "claude-code" lane.
// Claude authenticates with its own keychain login. No credential is read,
// received, or printed by this launcher.

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
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
const CLAUDE = "/opt/homebrew/bin/claude";
const CLAUDE_ROOT = "/opt/homebrew/Caskroom/claude-code@latest";
const MODELS = Object.freeze([
	"claude-haiku-5-5",
	"claude-sonnet-5-5",
	"claude-opus-5-5",
]);
const EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
const fail = createFail("simple-claude-code-launcher");

export function parseLauncherArgs(argv) {
	if (argv.length !== 6) fail("invalid fixed argument set");
	const values = {};
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		if (!["--model", "--effort", "--worktree"].includes(flag) || flag in values)
			fail("unknown or duplicate argument");
		values[flag] = argv[i + 1];
	}
	if (!MODELS.includes(values["--model"])) fail("model is not approved");
	if (!EFFORTS.includes(values["--effort"])) fail("effort is not approved");
	return {
		model: values["--model"],
		effort: values["--effort"],
		worktree: safeWorktree(values["--worktree"], fail),
	};
}

export function claudeCodeArgs({ model, effort }) {
	return [
		"-p",
		"--model",
		model,
		"--effort",
		effort,
		"--restricted",
		"--tools",
		"Read,Edit,Write,Glob,Grep",
		"--disallowedTools",
		"Bash,WebFetch,WebSearch,Agent,mcp__*",
		"--strict-mcp-config",
		"--permission-mode",
		"acceptEdits",
		"--permission-prompts",
		"none",
		"--no-session-persistence",
		"--disable-slash-commands",
		"--output-format",
		"json",
	];
}

export function claudeCodeEnvironment(runtime) {
	return {
		PATH: SAFE_PATH,
		HOME: join(runtime, "home"),
		TMPDIR: runtime,
		TMP: runtime,
		TEMP: runtime,
		// The CLI ignores TMPDIR for its own scratch and defaults to /tmp.
		CLAUDE_CODE_TMPDIR: runtime,
		USER: "dave",
		LOGNAME: "dave",
		LANG: "en_US.UTF-8",
		NO_COLOR: "1",
		CI: "1",
		DISABLE_AUTOUPDATER: "1",
		DISABLE_TELEMETRY: "1",
		DISABLE_ERROR_REPORTING: "1",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	};
}

export function claudeCodeSeatbeltProfile({
	worktree,
	runtime,
	keychains,
	cliRoot,
}) {
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
		keychains,
		cliRoot,
	];
	return baseSeatbeltRules({ reads, writes: [worktree, runtime] });
}

export function claudeCodeDiagnostic(parsed) {
	const subtype =
		typeof parsed?.subtype === "string" &&
		/^[a-z_]{1,40}$/u.test(parsed.subtype)
			? parsed.subtype
			: "unknown";
	const apiStatus =
		Number.isInteger(parsed?.api_error_status) &&
		parsed.api_error_status >= 100 &&
		parsed.api_error_status <= 599
			? parsed.api_error_status
			: null;
	return {
		subtype,
		apiStatus,
		limit:
			typeof parsed?.result === "string" &&
			/usage limit|hit your limit|limit reached/iu.test(parsed.result),
	};
}

function resolveClaudeBinary(cliPath) {
	const path = realpathSync(cliPath);
	if (!path.startsWith(`${CLAUDE_ROOT}/`) || !statSync(path).isFile())
		fail("Claude Code binary is outside the approved Caskroom");
	return path;
}

export async function runClaudeCode({
	model,
	effort,
	worktree,
	prompt,
	cliPath = CLAUDE,
	cliRoot = CLAUDE_ROOT,
	timeoutMs = MAX_WAIT_MS,
	keychains = join(homedir(), "Library", "Keychains"),
	verifyModel = true,
	sandboxExec,
}) {
	if (!MODELS.includes(model)) fail("model is not approved");
	if (!EFFORTS.includes(effort)) fail("effort is not approved");
	if (
		typeof prompt !== "string" ||
		!prompt ||
		Buffer.byteLength(prompt) > MAX_PROMPT
	)
		fail("prompt is empty or too large");
	const resolvedCli =
		cliPath === CLAUDE ? resolveClaudeBinary(cliPath) : cliPath;
	detachSharedClone(worktree, fail);
	const runtime = mkdtempSync(
		join(dirname(worktree), ".switchyard-claudecode-"),
	);
	try {
		mkdirSync(join(runtime, "home", "Library"), { recursive: true });
		symlinkSync(keychains, join(runtime, "home", "Library", "Keychains"));
		const result = await runSandboxedNative({
			fail,
			label: "native claude-code",
			worktree,
			prompt,
			cliPath: resolvedCli,
			args: claudeCodeArgs({ model, effort }),
			env: claudeCodeEnvironment(runtime),
			profile: claudeCodeSeatbeltProfile({
				worktree,
				runtime,
				keychains,
				cliRoot,
			}),
			runtime,
			timeoutMs,
			...(sandboxExec ? { sandboxExec } : {}),
		});
		let parsed;
		try {
			parsed = JSON.parse(result.stdout);
		} catch {
			if (result.code === 0) fail("Claude Code output is not valid JSON");
			return result;
		}
		if (parsed?.is_error === true) {
			const diagnostic = claudeCodeDiagnostic(parsed);
			const line = [
				"SWITCHYARD_CLAUDE_CODE_DIAG_V1",
				`subtype=${diagnostic.subtype}`,
				`api_status=${diagnostic.apiStatus ?? "none"}`,
				`limit=${diagnostic.limit ? 1 : 0}`,
			].join(" ");
			return { ...result, code: 76, stderr: `${line}\n` };
		}
		if (result.code !== 0) return result;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			parsed.is_error !== false ||
			(verifyModel &&
				(!parsed.modelUsage || !Object.hasOwn(parsed.modelUsage, model)))
		)
			fail("Claude Code result did not verify the requested model");
		return result;
	} finally {
		rmSync(runtime, { recursive: true, force: true });
	}
}

async function main() {
	const options = parseLauncherArgs(process.argv.slice(2));
	const prompt = await readBoundedStdin(fail);
	const result = await runClaudeCode({ ...options, prompt });
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	process.exitCode = result.code;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF)
	main().catch((error) => {
		process.stderr.write(
			`simple-claude-code-launcher: failed closed (${String(error?.message ?? error).slice(0, 300)})\n`,
		);
		process.exitCode = 76;
	});
