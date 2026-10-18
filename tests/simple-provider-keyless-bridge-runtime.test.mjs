// @test-phase: other
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	formatBridgeFailure,
	runBridge,
	verifyOpenCodeRuntime,
} from "../ops/simple-provider-keyless-bridge.mjs";
import { HANG_GUARD_MS } from "./helpers/hang-guard.mjs";
import {
	leftovers,
	runFake,
	SECRET,
	seatbeltBlocked,
	setup,
} from "./helpers/keyless-bridge-fixtures.mjs";

async function localServer(handler) {
	const server = http.createServer(handler);
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	return {
		url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
		close: () => new Promise((done) => server.close(done)),
	};
}
test("Vibe prompt EPIPE fails closed and removes its runtime", async (t) => {
	const check = spawnSync(
		"/usr/bin/sandbox-exec",
		[
			"-p",
			"(version 1) (deny default) (allow process*) (allow file-read*)",
			"/usr/bin/true",
		],
		{ encoding: "utf8" },
	);
	if (check.status !== 0 && /Operation not permitted/u.test(check.stderr)) {
		t.skip("host Seatbelt unavailable under outer sandbox");
		return;
	}
	const item = setup();
	const fake = join(item.worktree, "fake-vibe-exit");
	writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	try {
		await assert.rejects(
			runBridge({
				target: "vibe",
				model: "glm-5-3",
				worktree: item.worktree,
				prompt: "x".repeat(256 * 1024),
				secret: SECRET,
				cliPath: fake,
				timeoutMs: HANG_GUARD_MS,
				verifySession: false,
			}),
			/Vibe prompt pipe failed \(EPIPE\)/,
		);
		assert.equal(
			readdirSync(item.root).some((name) =>
				name.startsWith(".switchyard-keyless-"),
			),
			false,
		);
	} finally {
		item.cleanup();
	}
});
test("OpenCode duration limit terminates its process group without success", async (t) => {
	const check = spawnSync(
		"/usr/bin/sandbox-exec",
		[
			"-p",
			"(version 1) (deny default) (allow process*) (allow file-read*)",
			"/usr/bin/true",
		],
		{ encoding: "utf8" },
	);
	if (check.status !== 0 && /Operation not permitted/u.test(check.stderr)) {
		t.skip("host Seatbelt unavailable under outer sandbox");
		return;
	}
	const item = setup();
	const fake = join(item.worktree, "fake-opencode");
	writeFileSync(fake, "#!/bin/sh\nprintf 'started\\n'\nsleep 30\n", {
		mode: 0o755,
	});
	try {
		await assert.rejects(
			runBridge({
				target: "opencode-go",
				model: "opencode-go/deepseek-v4.1-flash",
				variant: "low",
				worktree: item.worktree,
				prompt: "synthetic task",
				secret: SECRET,
				cliPath: fake,
				timeoutMs: 200,
			}),
			/terminated before a verified completion/,
		);
		assert.equal(
			readdirSync(item.root).some((name) =>
				name.startsWith(".switchyard-keyless-"),
			),
			false,
		);
	} finally {
		item.cleanup();
	}
});
test("OpenCode receives the exact prompt on stdin without argv or environment leakage", async (t) => {
	const check = spawnSync(
		"/usr/bin/sandbox-exec",
		[
			"-p",
			"(version 1) (deny default) (allow process*) (allow file-read*)",
			"/usr/bin/true",
		],
		{ encoding: "utf8" },
	);
	if (check.status !== 0 && /Operation not permitted/u.test(check.stderr)) {
		t.skip("host Seatbelt unavailable under outer sandbox");
		return;
	}
	const item = setup();
	const fake = join(item.worktree, "fake-opencode-stdin");
	const sentinel = "switchyard-private-opencode-prompt-sentinel";
	const prompt = `Please preserve this exact stdin payload.\n${sentinel}\nNo tools.`;
	writeFileSync(
		fake,
		`#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const sentinel = ${JSON.stringify(sentinel)};
const expected = ${JSON.stringify(prompt)};
writeFileSync('probe.json', JSON.stringify({ exactStdin: prompt === expected, sentinelInArgv: process.argv.some(value => value.includes(sentinel)), sentinelInEnvironment: Object.values(process.env).some(value => value.includes(sentinel)), argv: process.argv.slice(2), realKeyInEnvironment: Object.values(process.env).includes('synthetic-real-api-key-bridge-123456') }));
`,
		{ mode: 0o755 },
	);
	try {
		const result = await runBridge({
			target: "opencode-go",
			model: "opencode-go/deepseek-v4.1-flash",
			variant: "max",
			worktree: item.worktree,
			prompt,
			secret: SECRET,
			cliPath: fake,
			timeoutMs: HANG_GUARD_MS,
		});
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(
			JSON.parse(readFileSync(join(item.worktree, "probe.json"), "utf8")),
			{
				exactStdin: true,
				sentinelInArgv: false,
				sentinelInEnvironment: false,
				argv: [
					"run",
					"--pure",
					"--agent",
					"build",
					"--auto",
					"--variant",
					"max",
					"--model",
					"opencode-go/deepseek-v4.1-flash",
				],
				realKeyInEnvironment: false,
			},
		);
	} finally {
		item.cleanup();
	}
});
for (const [target, model, variant, expectedEffort] of [
	["vibe", "glm-5-3-medium", undefined, "high"],
	["vibe", "glm-5-3", undefined, "max"],
	["opencode-go", "opencode-go/deepseek-v4.1-flash", "low", "low"],
	["opencode-go", "opencode-go/deepseek-v4.1-flash", "max", "max"],
])
	test(`installed ${target} CLI ${model} ${variant ?? "alias"} reaches the synthetic endpoint`, async (t) => {
		const check = spawnSync(
			"/usr/bin/sandbox-exec",
			[
				"-p",
				"(version 1) (deny default) (allow process*) (allow file-read*)",
				"/usr/bin/true",
			],
			{ encoding: "utf8" },
		);
		if (check.status !== 0 && /Operation not permitted/u.test(check.stderr)) {
			t.skip("host Seatbelt unavailable under outer sandbox");
			return;
		}
		const item = setup();
		let calls = 0;
		const prompt = "Please respond briefly. installed-opencode-stdin-sentinel";
		let observedPrompt = false;
		let observedBody = null;
		const upstream = await localServer((request, response) => {
			calls += 1;
			const chunks = [];
			request.on("data", (chunk) => chunks.push(chunk));
			request.on("end", () => {
				let body = {};
				try {
					body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				} catch {}
				observedBody = body;
				observedPrompt ||= JSON.stringify(body.messages ?? []).includes(prompt);
				response.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
				});
				const frame = (delta, finishReason = null) =>
					`data: ${JSON.stringify({
						id: "chatcmpl-synthetic",
						object: "chat.completion.chunk",
						created: 1,
						model: body.model,
						choices: [{ index: 0, delta, finish_reason: finishReason }],
					})}\n\n`;
				response.end(
					`${frame({ role: "assistant", content: "stdin-probe-ok" })}${frame({}, "stop")}data: [DONE]\n\n`,
				);
			});
		});
		try {
			const result = await runBridge({
				target,
				model,
				variant,
				worktree: item.worktree,
				prompt,
				secret: SECRET,
				upstream: upstream.url,
				timeoutMs: HANG_GUARD_MS,
			});
			assert.ok(calls > 0, "installed CLI did not reach synthetic upstream");
			if (target === "opencode-go") {
				assert.equal(result.code, 0, result.stderr);
				assert.equal(observedBody?.model, "deepseek-v4.1-flash");
				assert.equal(observedBody?.reasoning_effort, expectedEffort);
				assert.equal(
					observedPrompt,
					true,
					"installed CLI did not forward stdin prompt",
				);
			} else {
				assert.equal(result.code, 0, result.stderr);
				assert.equal(calls, 1, "Vibe should use only the completion endpoint");
				assert.equal(observedBody?.model, "zai-glm-5-3");
				assert.equal(observedBody?.reasoning_effort, expectedEffort);
			}
		} finally {
			await upstream.close();
			item.cleanup();
		}
	});

test("fixed OpenCode runtime rejects replacement bytes, missing bytes, and symlinks", () => {
	const item = setup();
	try {
		const fake = join(item.worktree, "replaced-opencode");
		writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		assert.throws(
			() => verifyOpenCodeRuntime(fake),
			/runtime identity mismatch/,
		);
		const link = join(item.worktree, "linked-opencode");
		symlinkSync(fake, link);
		assert.throws(
			() => verifyOpenCodeRuntime(link),
			/runtime identity mismatch/,
		);
		assert.throws(
			() => verifyOpenCodeRuntime(join(item.worktree, "missing")),
			/runtime identity mismatch/,
		);
	} finally {
		item.cleanup();
	}
});

const BRIDGE = fileURLToPath(
	new URL("../ops/simple-provider-keyless-bridge.mjs", import.meta.url),
);
const REASON =
	/^simple-provider-keyless-bridge: provider terminated before a verified completion \(code none, signal SIGKILL, error none, interrupt none\)\n$/u;
const leaksKey = (text) =>
	text.includes("raw-cli-stderr-sentinel") ||
	Array.from({ length: SECRET.length - 7 }, (_, i) =>
		SECRET.slice(i, i + 8),
	).some((window) => text.includes(window));
for (const target of ["vibe", "opencode-go"])
	test(`${target} provider killed by a signal reports the reason, none of its stderr`, async (t) => {
		if (seatbeltBlocked()) return t.skip("host Seatbelt unavailable");
		const item = setup();
		// Key plain, split by newline, ESC (eats a key char), CSI or NUL; partials.
		const [head, tail] = [SECRET.slice(0, 9), SECRET.slice(9)];
		writeFileSync(
			join(item.worktree, "child-stderr"),
			[
				"raw-cli-stderr-sentinel",
				SECRET,
				`${head}\n${tail}`,
				`${head}\x1b${tail}`,
				`${head}\x1b[m${tail}`,
				`${head}\0${tail}`,
				SECRET.slice(0, 20),
				SECRET.slice(-20),
			].join("\n"),
		);
		try {
			const { error, stderr } = await runFake(
				item,
				"cat ./child-stderr >&2\nkill -KILL $$",
				{ target },
			);
			const line = formatBridgeFailure(error);
			assert.match(line, REASON);
			for (const text of [line, stderr, error.message])
				assert.equal(leaksKey(text), false);
			assert.deepEqual(leftovers(item), []);
		} finally {
			item.cleanup();
		}
	});
test("an interrupt names its cause: duration limit or received signal", async (t) => {
	if (seatbeltBlocked()) return t.skip("host Seatbelt unavailable");
	const item = setup();
	try {
		const limit = await runFake(item, "sleep 30", { timeoutMs: 300 });
		assert.match(
			formatBridgeFailure(limit.error),
			/error none, interrupt duration-limit\)/u,
		);
		const pending = runFake(item, ": > started\nsleep 30");
		for (let i = 0; i < 100 && !existsSync(join(item.worktree, "started")); i++)
			await new Promise((done) => setTimeout(done, 50));
		process.kill(process.pid, "SIGTERM");
		const { error } = await pending;
		assert.match(formatBridgeFailure(error), /interrupt SIGTERM\)/u);
	} finally {
		item.cleanup();
	}
});
test("cleanup trouble never replaces the first reason, and still fails closed", async (t) => {
	if (seatbeltBlocked()) return t.skip("host Seatbelt unavailable");
	const item = setup();
	const realKill = process.kill;
	// Stubborn group: the group probe always answers "still there".
	const stubborn = () => {
		process.kill = (pid, signal) =>
			pid < 0 ? true : realKill.call(process, pid, signal);
	};
	try {
		stubborn();
		const first = await runFake(item, "kill -KILL $$");
		const alone = await runFake(item, "exit 0");
		process.kill = realKill;
		assert.match(formatBridgeFailure(first.error), REASON);
		assert.doesNotMatch(first.error.message, /did not stop/u);
		assert.match(alone.error.message, /provider process group did not stop/u);
		// A runtime directory that cannot be removed behaves the same way.
		const lock =
			'mkdir "$HOME/locked" && : > "$HOME/locked/f" && chmod 500 "$HOME/locked"\n';
		const locked = await runFake(item, `${lock}kill -KILL $$`);
		const lockedAlone = await runFake(item, `${lock}exit 0`);
		assert.match(formatBridgeFailure(locked.error), REASON);
		assert.doesNotMatch(locked.error.message, /cleanup failed/u);
		assert.match(lockedAlone.error.message, /runtime cleanup failed/u);
	} finally {
		process.kill = realKill;
		spawnSync("/bin/chmod", ["-R", "u+rwx", item.root]);
		item.cleanup();
	}
});
for (const [name, argv, secret, expected] of [
	[
		"bad arguments",
		"--target vibe",
		"k".repeat(16),
		"invalid fixed argument set",
	],
	["short credential", null, "short", "credential missing or invalid"],
	["no credential pipe", null, undefined, "broker credential pipe missing"],
	["oversized credential", null, "k".repeat(5000), null],
])
	test(`bridge entry point on ${name} exits 76 with the right stderr line`, () => {
		const item = setup();
		const file = join(item.root, "credential");
		writeFileSync(file, secret ?? "");
		const fd = openSync(file, "r");
		try {
			const result = spawnSync(
				process.execPath,
				[
					BRIDGE,
					...(
						argv ?? `--target vibe --model glm-5-3 --worktree ${item.worktree}`
					).split(" "),
				],
				{
					input: "synthetic task",
					encoding: "utf8",
					stdio: ["pipe", "pipe", "pipe", fd],
					env: {
						...process.env,
						SWITCHYARD_BWS_SECRET_FD: secret === undefined ? "" : "3",
					},
				},
			);
			assert.equal(result.status, 76, result.stderr);
			// Unmarked errors stay generic: their messages may hold paths.
			assert.equal(
				result.stderr,
				`simple-provider-keyless-bridge: ${expected ?? "failed closed"}\n`,
			);
		} finally {
			closeSync(fd);
			item.cleanup();
		}
	});
