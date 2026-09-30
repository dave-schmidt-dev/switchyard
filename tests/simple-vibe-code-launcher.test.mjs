import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	parseLauncherArgs,
	renderVibeCodeConfig,
	runVibeCode,
	vibeCodeArgs,
	vibeCodeEnvironment,
	vibeCodeSeatbeltProfile,
} from "../ops/simple-vibe-code-launcher.mjs";

function setup() {
	const root = join(
		realpathSync(tmpdir()),
		`switchyard-simple-${randomUUID()}`,
	);
	const worktree = join(root, "worktree");
	mkdirSync(join(worktree, ".git"), { recursive: true });
	writeFileSync(join(root, ".switchyard-cleanup-owner.json"), "{}\n");
	const keychains = join(root, "keychains");
	mkdirSync(keychains);
	return {
		root,
		worktree,
		keychains,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}
function seatbeltAvailable() {
	const check = spawnSync(
		"/usr/bin/sandbox-exec",
		[
			"-p",
			"(version 1) (deny default) (allow process*) (allow file-read*)",
			"/usr/bin/true",
		],
		{ encoding: "utf8" },
	);
	return !(check.status !== 0 && /Operation not permitted/u.test(check.stderr));
}

test("launcher accepts only the two approved aliases and a simple worktree", () => {
	const item = setup();
	try {
		for (const model of ["glm-5-3", "glm-5-3-medium"])
			assert.equal(
				parseLauncherArgs(["--model", model, "--worktree", item.worktree])
					.model,
				model,
			);
		assert.throws(
			() =>
				parseLauncherArgs(["--model", "other", "--worktree", item.worktree]),
			/not approved/,
		);
		assert.throws(
			() => parseLauncherArgs(["--model", "glm-5-3", "--worktree", tmpdir()]),
			/canonical|disposable/,
		);
		assert.throws(() => parseLauncherArgs(["--model", "glm-5-3"]), /fixed/);
	} finally {
		item.cleanup();
	}
});

test("launcher argv has only file tools and the environment carries no API key", () => {
	const args = vibeCodeArgs("/w");
	assert.deepEqual(args.slice(0, 9), [
		"-p",
		"--agent",
		"accept-edits",
		"--auto-approve",
		"--trust",
		"--workdir",
		"/w",
		"--output",
		"json",
	]);
	const tools = args.flatMap((v, i) =>
		args[i - 1] === "--enabled-tools" ? [v] : [],
	);
	assert.deepEqual(tools, ["edit", "write_file", "read_file", "grep"]);
	assert.equal(args.includes("--max-turns"), false);
	const previous = process.env.MISTRAL_API_KEY;
	process.env.MISTRAL_API_KEY = "must-not-leak-1234567890";
	try {
		const env = vibeCodeEnvironment("/r");
		assert.equal("MISTRAL_API_KEY" in env, false);
		assert.equal(JSON.stringify(env).includes("must-not-leak"), false);
		assert.equal(env.HOME, "/r/home");
		assert.equal(env.VIBE_HOME, "/r/vibe");
	} finally {
		if (previous === undefined) delete process.env.MISTRAL_API_KEY;
		else process.env.MISTRAL_API_KEY = previous;
	}
});

test("config targets Mistral directly with the native backend and both aliases", () => {
	const config = renderVibeCodeConfig("glm-5-3-medium", "/r");
	assert.match(config, /^active_model = "glm-5-3-medium"$/mu);
	assert.match(config, /api_base = "https:\/\/api\.mistral\.ai\/v1"/u);
	assert.match(config, /backend = "mistral"/u);
	assert.match(config, /alias = "glm-5-3"\nthinking = "max"/u);
	assert.match(config, /alias = "glm-5-3-medium"\nthinking = "high"/u);
	assert.equal(config.includes("127.0.0.1"), false);
	assert.match(config, /enable_telemetry = false/u);
});

test("seatbelt profile confines writes and limits outbound network to TLS and DNS", () => {
	const profile = vibeCodeSeatbeltProfile({
		worktree: "/w/worktree",
		runtime: "/w/.rt",
		keychains: "/k",
	});
	assert.match(profile, /\(deny default\)/u);
	assert.match(
		profile,
		/file-write\* \(subpath "\/w\/worktree"\) \(subpath "\/w\/\.rt"\)/u,
	);
	assert.equal(/network-outbound\)/u.test(profile), false);
	assert.match(profile, /remote tcp "\*:443"/u);
	assert.equal(profile.includes("/Users/dave/.ssh"), false);
});

test("runVibeCode runs the CLI sandboxed with no API key, then cleans up", async (t) => {
	if (!seatbeltAvailable())
		return t.skip("host Seatbelt unavailable under outer sandbox");
	const item = setup();
	const fake = join(item.worktree, "fake-vibe");
	writeFileSync(
		fake,
		`#!/bin/sh
cat >/dev/null
printf '%s\\n' "$@" > argv.txt
env | sort | sed 's/=.*//' > env-names.txt
cp "$VIBE_HOME/config.toml" config-copy.toml
ls "$HOME/Library" > home-library.txt
mkdir -p "$VIBE_HOME/logs/session/s"
printf '{"config":{"active_model":"glm-5-3"}}' > "$VIBE_HOME/logs/session/s/meta.json"
printf 'done'
`,
		{ mode: 0o755 },
	);
	const previous = process.env.MISTRAL_API_KEY;
	process.env.MISTRAL_API_KEY = "must-not-leak-1234567890";
	try {
		const result = await runVibeCode({
			model: "glm-5-3",
			worktree: item.worktree,
			prompt: "synthetic task",
			cliPath: fake,
			keychains: item.keychains,
			timeoutMs: 10_000,
		});
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout, "done");
		const names = readFileSync(join(item.worktree, "env-names.txt"), "utf8");
		assert.equal(/MISTRAL/u.test(names), false);
		assert.match(
			readFileSync(join(item.worktree, "argv.txt"), "utf8"),
			/--enabled-tools\nedit\n/u,
		);
		assert.match(
			readFileSync(join(item.worktree, "home-library.txt"), "utf8"),
			/Keychains/u,
		);
		assert.equal(
			readdirSync(item.root).some((name) =>
				name.startsWith(".switchyard-vibecode-"),
			),
			false,
		);
	} finally {
		if (previous === undefined) delete process.env.MISTRAL_API_KEY;
		else process.env.MISTRAL_API_KEY = previous;
		item.cleanup();
	}
});

test("runVibeCode fails closed when the served alias is not proven", async (t) => {
	if (!seatbeltAvailable())
		return t.skip("host Seatbelt unavailable under outer sandbox");
	const item = setup();
	const fake = join(item.worktree, "fake-vibe");
	writeFileSync(
		fake,
		`#!/bin/sh
cat >/dev/null
mkdir -p "$VIBE_HOME/logs/session/s"
printf '{"config":{"active_model":"other"}}' > "$VIBE_HOME/logs/session/s/meta.json"
`,
		{ mode: 0o755 },
	);
	try {
		await assert.rejects(
			runVibeCode({
				model: "glm-5-3",
				worktree: item.worktree,
				prompt: "synthetic task",
				cliPath: fake,
				keychains: item.keychains,
				timeoutMs: 10_000,
			}),
			/does not prove the requested model alias/,
		);
		assert.equal(existsSync(join(item.root, ".switchyard-vibecode-x")), false);
	} finally {
		item.cleanup();
	}
});

test("runVibeCode passes a nonzero exit and stderr through for classification", async (t) => {
	if (!seatbeltAvailable())
		return t.skip("host Seatbelt unavailable under outer sandbox");
	const item = setup();
	const fake = join(item.worktree, "fake-vibe");
	writeFileSync(
		fake,
		"#!/bin/sh\ncat >/dev/null\necho 'Error: API error from mistral' >&2\nexit 1\n",
		{
			mode: 0o755,
		},
	);
	try {
		const result = await runVibeCode({
			model: "glm-5-3",
			worktree: item.worktree,
			prompt: "synthetic task",
			cliPath: fake,
			keychains: item.keychains,
			timeoutMs: 10_000,
		});
		assert.equal(result.code, 1);
		assert.match(result.stderr, /API error from mistral/u);
	} finally {
		item.cleanup();
	}
});
