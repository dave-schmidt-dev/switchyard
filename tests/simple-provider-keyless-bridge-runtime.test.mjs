import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	runBridge,
	verifyOpenCodeRuntime,
} from "../ops/simple-provider-keyless-bridge.mjs";

const SECRET = "synthetic-real-api-key-bridge-123456";
function setup() {
	const root = join(
		realpathSync(tmpdir()),
		`switchyard-simple-${randomUUID()}`,
	);
	const worktree = join(root, "worktree");
	mkdirSync(join(worktree, ".git"), { recursive: true });
	writeFileSync(join(root, ".switchyard-cleanup-owner.json"), "{}\n");
	return {
		root,
		worktree,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}
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
				timeoutMs: 5_000,
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
			timeoutMs: 5_000,
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
				timeoutMs: 15_000,
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
