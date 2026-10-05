// Every provider argv Switchyard builds, captured from the real builders.
//
// Nothing here restates a flag. Each site calls the production code that spawns
// a provider CLI (VM adapters, auth probes, liveness probes, the simple lane,
// both BWS bridges) with a capturing execution backend, then records the argv
// it would have run. A flag added or removed in any builder therefore changes
// the contract automatically; the check only compares it to the CLI's --help.

import { guestProviderArgv } from "../../../ops/opencode-api-key-bridge.mjs";
import {
	KEYLESS_OPENCODE_PATH,
	KEYLESS_OPENCODE_VERSION,
	keylessCliArgs,
} from "../../../ops/simple-provider-keyless-bridge.mjs";
import { vibeCodeArgs } from "../../../ops/simple-vibe-code-launcher.mjs";
import * as agy from "../adapter/agy.mjs";
import * as claude from "../adapter/claude.mjs";
import * as codex from "../adapter/codex.mjs";
import * as copilot from "../adapter/copilot.mjs";
import * as cursor from "../adapter/cursor.mjs";
import * as opencode from "../adapter/opencode.mjs";
import { isVibeAuthenticated } from "../adapter/vibe-config.mjs";
import { buildExecution as buildVibeExecution } from "../adapter/vibe-execution.mjs";
import { LIVENESS_PROBES } from "../auth/liveness.mjs";
import {
	mapInvocationArgs,
	PROVIDER_INVOCATION_VOCABULARY,
	validateInvocationDescriptor,
} from "../roster/index.mjs";
import { buildSimpleProviderInvocation } from "../simple/provider-invocation.mjs";

/** Provider CLI binaries, keyed by the harness name the roster uses. */
export const HARNESS_BINARIES = Object.freeze({
	claude: "claude",
	codex: "codex",
	agy: "agy",
	cursor: "cursor-agent",
	copilot: "copilot",
	opencode: "opencode",
	vibe: "vibe",
});

/**
 * The subcommands Switchyard (and agent-headless) invoke, per CLI. A flag after
 * one of these is checked against `<cli> <subcommand> --help`.
 */
export const CLI_SUBCOMMANDS = Object.freeze({
	claude: Object.freeze({ auth: Object.freeze({ status: Object.freeze({}) }) }),
	codex: Object.freeze({
		exec: Object.freeze({}),
		review: Object.freeze({}),
	}),
	"cursor-agent": Object.freeze({ status: Object.freeze({}) }),
	opencode: Object.freeze({ run: Object.freeze({}) }),
});

const PROMPT = "SWITCHYARD FLAG CONTRACT PROMPT";
const WORKSPACE = "switchyard-flag-contract";
const WORKTREE =
	"/tmp/switchyard-simple-00000000-0000-0000-0000-000000000000/worktree";
const KNOWN_BINARIES = new Set(Object.values(HARNESS_BINARIES));

class CapturedArgv extends Error {}

function basename(path) {
	return String(path).split("/").at(-1);
}

/** Drop transport wrappers (sh -c supervisor, nohup, sandbox-exec) before the CLI. */
export function providerArgvFrom(argv) {
	const start = argv.findIndex(
		(token) => typeof token === "string" && KNOWN_BINARIES.has(basename(token)),
	);
	if (start < 0) return null;
	return [basename(argv[start]), ...argv.slice(start + 1)];
}

function capturingBackend(sink) {
	return {
		execArgv(_workspaceId, { argv }) {
			sink.push(argv);
			throw new CapturedArgv("captured");
		},
		execGuest(_workspaceId, command, args) {
			sink.push([command, ...args]);
			// Plausible enough that a probe proceeds to its next command.
			return "0.0.0 (Claude Code)\n";
		},
		guestHomePath: () => "/Users/switchyard",
	};
}

function adapterOptions(harness, descriptor, backend) {
	const validated = validateInvocationDescriptor(descriptor, harness);
	return {
		model: validated.selector,
		resolvedTargetId: validated.target_id,
		invocationDescriptor: validated,
		descriptorHarness: harness,
		descriptorIdentity: validated.descriptor_identity,
		executionBackend: backend,
		cwd: "/project",
	};
}

/**
 * One representative descriptor per harness, using the roster's own argv
 * mapping, so every invocation_args template is part of the contract.
 */
function representativeDescriptors() {
	const out = [];
	for (const [harness, vocabulary] of Object.entries(
		PROVIDER_INVOCATION_VOCABULARY,
	)) {
		const intents = [{}];
		if (vocabulary.effort.length > 0)
			intents.push({ effort: vocabulary.effort.at(-1) });
		for (const variant of vocabulary.variant)
			if (variant !== "default") intents.push({ variant });
		for (const intent of intents) {
			const selector =
				harness === "vibe" ? "mistral-medium-3.5" : `${harness}-contract-model`;
			out.push({
				harness,
				intent,
				descriptor: {
					target_id: `${harness}-contract`,
					model_ref: selector,
					selector,
					effort: intent.effort ?? null,
					variant: intent.variant ?? null,
					invocation_args: [...mapInvocationArgs(harness, intent)],
				},
			});
		}
	}
	return out;
}

const ADAPTER_EXECUTORS = Object.freeze({
	claude: claude.executeClaude,
	codex: codex.executeCodex,
	agy: agy.executeAgy,
	cursor: cursor.executeCursor,
	copilot: copilot.execute,
	opencode: opencode.execute,
});

const AUTH_PROBES = Object.freeze({
	claude: claude.isClaudeAuthenticated,
	codex: codex.isCodexAuthenticated,
	agy: agy.isAgyAuthenticated,
	cursor: cursor.isCursorAuthenticated,
	copilot: copilot.isCopilotAuthenticated,
	opencode: opencode.isOpencodeAuthenticated,
	vibe: isVibeAuthenticated,
});

function site(name, argv, extra = {}) {
	const providerArgv = providerArgvFrom(argv);
	if (!providerArgv) return null;
	return Object.freeze({
		site: name,
		cli: providerArgv[0],
		argv: Object.freeze(providerArgv),
		...extra,
	});
}

function adapterSites() {
	const sites = [];
	for (const { harness, intent, descriptor } of representativeDescriptors()) {
		const sink = [];
		const backend = capturingBackend(sink);
		const options = adapterOptions(harness, descriptor, backend);
		const label = intent.effort ?? intent.variant ?? "base";
		let result;
		try {
			result =
				harness === "vibe"
					? buildVibeExecution(WORKSPACE, PROMPT, options)
					: ADAPTER_EXECUTORS[harness](PROMPT, WORKSPACE, options);
		} catch (error) {
			if (!(error instanceof CapturedArgv)) throw error;
		}
		if (sink.length === 0)
			throw new Error(
				`flag contract could not capture the ${harness} adapter argv: ${result?.error ?? "no argv"}`,
			);
		for (const argv of sink)
			sites.push(site(`adapter:${harness}:${label}`, argv));
	}
	return sites;
}

function authProbeSites() {
	const sites = [];
	for (const [harness, probe] of Object.entries(AUTH_PROBES)) {
		const sink = [];
		try {
			probe(WORKSPACE, capturingBackend(sink));
		} catch {
			// A probe that stops early still recorded what it ran.
		}
		for (const argv of sink) sites.push(site(`auth-probe:${harness}`, argv));
	}
	return sites;
}

function livenessSites() {
	return Object.entries(LIVENESS_PROBES).map(([name, probe]) =>
		site(`liveness:${name}`, probe(PROMPT).args),
	);
}

function simpleLaneSites() {
	const sites = [];
	const descriptors = [
		{
			harness: "codex",
			target_id: "codex",
			selector: "gpt-contract",
			invocation_args: ["-c", "model_reasoning_effort=high"],
		},
		{
			harness: "agy",
			target_id: "antigravity",
			selector: "gemini-3.8-flash-medium",
			invocation_args: [],
		},
		{
			harness: "copilot",
			target_id: "copilot-student",
			selector: "auto",
			invocation_args: [],
		},
	];
	for (const { harness, ...descriptor } of descriptors) {
		const invocation = buildSimpleProviderInvocation(
			harness,
			descriptor,
			PROMPT,
			WORKTREE,
			descriptor.target_id,
		);
		sites.push(
			site(`simple:${descriptor.target_id}`, [
				invocation.command,
				...invocation.args,
			]),
		);
	}
	sites.push(site("simple:vibe-code", ["vibe", ...vibeCodeArgs(WORKTREE)]));
	sites.push(
		site("simple-keyless-bridge:vibe", [
			"vibe",
			...keylessCliArgs("vibe", { worktree: WORKTREE }),
		]),
	);
	for (const variant of ["low", "max"])
		sites.push(
			site(
				`simple-keyless-bridge:opencode-go:${variant}`,
				[
					"opencode",
					...keylessCliArgs("opencode-go", {
						worktree: WORKTREE,
						variant,
						model: "opencode-go/deepseek-v4.1-flash",
					}),
				],
				// The simple lane runs its own vendored runtime, not PATH opencode.
				{
					binary: KEYLESS_OPENCODE_PATH,
					pinnedVersion: KEYLESS_OPENCODE_VERSION,
				},
			),
		);
	return sites;
}

function apiKeyBridgeSites() {
	return [
		site(
			"opencode-api-key-bridge:mistral",
			guestProviderArgv({
				workspaceId: WORKSPACE,
				model: "mistral/contract-model",
				invocationArgs: ["--variant", "high"],
				prompt: PROMPT,
				idleSeconds: 60,
			}),
		),
	];
}

/** Every Switchyard call site, as { site, cli, argv[, binary, pinnedVersion] }. */
export function collectSwitchyardCallSites() {
	return [
		...adapterSites(),
		...authProbeSites(),
		...livenessSites(),
		...simpleLaneSites(),
		...apiKeyBridgeSites(),
	].filter(Boolean);
}

/**
 * Read call sites another tool declares, e.g. ~/.agent's agent-headless arms:
 * { "sites": [{ "site": "agent-headless:opencode", "argv": ["opencode", "run", ...] }] }
 * argv[0] names the CLI; a site may add "subcommands" (same shape as
 * CLI_SUBCOMMANDS) or "binary" (an absolute path to check instead of PATH).
 */
export function parseContractSites(text, source = "contract") {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${source}: not valid JSON (${error.message})`);
	}
	if (!parsed || !Array.isArray(parsed.sites) || parsed.sites.length === 0)
		throw new Error(`${source}: expected a non-empty "sites" array`);
	return parsed.sites.map((entry, index) => {
		const where = `${source}: sites[${index}]`;
		if (!entry || typeof entry.site !== "string" || entry.site === "")
			throw new Error(`${where}.site must be a non-empty string`);
		if (
			!Array.isArray(entry.argv) ||
			entry.argv.length === 0 ||
			entry.argv.some((token) => typeof token !== "string")
		)
			throw new Error(`${where}.argv must be a non-empty string array`);
		if (entry.binary !== undefined && !String(entry.binary).startsWith("/"))
			throw new Error(`${where}.binary must be an absolute path`);
		const cli = basename(entry.argv[0]);
		return Object.freeze({
			site: entry.site,
			cli,
			argv: Object.freeze([cli, ...entry.argv.slice(1)]),
			...(entry.binary ? { binary: entry.binary } : {}),
			...(entry.subcommands ? { subcommands: entry.subcommands } : {}),
		});
	});
}
