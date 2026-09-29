import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	formatOpenCodeGoBridgeDiagnostic,
	MAX_CHAT_REQUESTS,
	parseBridgeArgs,
	runBridge,
	seatbeltProfile,
	startProxy,
} from "../ops/simple-provider-keyless-bridge.mjs";
import { settleSimpleWriterProcesses } from "../src/switchyard/simple/process-teardown.mjs";

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
function post(port, path, nonce, model) {
	return fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${nonce}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ model }),
	});
}
test("proxy diagnostic counts chat requests, upstream statuses, and proxy rejections", async () => {
	const upstream = await localServer((_request, response) => {
		response.writeHead(429, { "content-type": "text/plain" });
		response.end("synthetic-upstream-body-sentinel");
	});
	const proxy = await startProxy({
		target: "opencode-go",
		model: "opencode-go/deepseek-v4.1-flash",
		secret: SECRET,
		upstream: upstream.url,
	});
	try {
		assert.equal(
			formatOpenCodeGoBridgeDiagnostic(proxy.getDiagnostic()),
			"SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=0 upstream_status=0 proxy_rejections=0\n",
		);
		assert.equal(
			(
				await post(
					proxy.port,
					"/v1/chat/completions",
					"invalid-nonce",
					"deepseek-v4.1-flash",
				)
			).status,
			403,
		);
		assert.equal(
			formatOpenCodeGoBridgeDiagnostic(proxy.getDiagnostic()),
			"SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=1 upstream_status=0 proxy_rejections=1\n",
		);
		assert.equal(
			(
				await post(
					proxy.port,
					"/v1/chat/completions",
					proxy.nonce,
					"deepseek-v4.1-flash",
				)
			).status,
			429,
		);
		assert.equal(
			formatOpenCodeGoBridgeDiagnostic(proxy.getDiagnostic()),
			"SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=2 upstream_status=429 proxy_rejections=1\n",
		);
	} finally {
		await proxy.close();
		await upstream.close();
	}
	assert.equal(
		formatOpenCodeGoBridgeDiagnostic({
			chatRequestCount: Number.MAX_SAFE_INTEGER,
			lastUpstreamStatus: 700,
			proxyRejectionCount: -1,
		}),
		"SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=999999 upstream_status=0 proxy_rejections=0\n",
	);
});
test("OpenCode Go failures expose numeric proxy diagnostics without CLI output", async (t) => {
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

	for (const scenario of [
		{
			name: "upstream error",
			request: true,
			rejectRequest: false,
			expected:
				"SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=1 upstream_status=429 proxy_rejections=0\n",
		},
		{
			name: "no proxy request",
			request: false,
			rejectRequest: false,
			expected:
				"SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=0 upstream_status=0 proxy_rejections=0\n",
		},
		{
			name: "proxy rejection",
			request: true,
			rejectRequest: true,
			expected:
				"SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=1 upstream_status=0 proxy_rejections=1\n",
		},
	]) {
		const item = setup();
		let upstreamCalls = 0;
		const upstream = await localServer((_request, response) => {
			upstreamCalls += 1;
			response.writeHead(429, { "content-type": "text/plain" });
			response.end("synthetic-upstream-body-sentinel");
		});
		const fake = join(item.worktree, "fake-opencode-failure.mjs");
		writeFileSync(
			fake,
			`#!/usr/bin/env node
const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const url = cfg.provider['opencode-go'].options.baseURL + '/chat/completions';
const request = ${JSON.stringify(scenario.request)};
const rejectRequest = ${JSON.stringify(scenario.rejectRequest)};
let responseText = '';
if (request) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: rejectRequest ? 'Bearer invalid' : 'Bearer ' + process.env.OPENCODE_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash' }),
  });
  responseText = await response.text();
}
process.stdout.write('raw-cli-stdout-sentinel ' + responseText);
process.stderr.write('raw-cli-stderr-sentinel');
process.exit(1);
`,
			{ mode: 0o755 },
		);
		try {
			const result = await runBridge({
				target: "opencode-go",
				model: "opencode-go/deepseek-v4.1-flash",
				variant: "low",
				worktree: item.worktree,
				prompt: "synthetic diagnostic prompt",
				secret: SECRET,
				cliPath: fake,
				upstream: upstream.url,
				timeoutMs: 5_000,
			});
			assert.equal(result.code, 1, scenario.name);
			assert.equal(result.stdout, scenario.expected, scenario.name);
			assert.equal(result.stderr, "", scenario.name);
			assert.equal(result.stdout.includes("sentinel"), false, scenario.name);
			assert.equal(result.stderr.includes("sentinel"), false, scenario.name);
			assert.equal(
				upstreamCalls,
				scenario.name === "upstream error" ? 1 : 0,
				scenario.name,
			);
		} finally {
			await upstream.close();
			item.cleanup();
		}
	}
});
test("Seatbelt child gets nonce and proxy only; host file and alternate network port are denied", async (t) => {
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
	assert.equal(check.status, 0, check.stderr);
	const item = setup();
	const forbidden = join(tmpdir(), `keyless-forbidden-${randomUUID()}`);
	writeFileSync(forbidden, "host-only");
	let upstreamCalls = 0;
	const upstream = await localServer((request, response) => {
		upstreamCalls += 1;
		request.resume();
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ ok: true, reflected: SECRET }));
	});
	const fake = join(item.worktree, "fake-cli.mjs");
	writeFileSync(
		fake,
		`#!/usr/bin/env node
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const url = cfg.provider['opencode-go'].options.baseURL + '/chat/completions';
let readDenied = false; let writeDenied = false; let outsideDenied = false; let homeListDenied = false; let tempListDenied = false;
try { readFileSync(${JSON.stringify(forbidden)}); } catch { readDenied = true; }
try { writeFileSync(${JSON.stringify(forbidden)}, 'escape'); } catch { writeDenied = true; }
try { readdirSync('/Users/dave'); } catch { homeListDenied = true; }
try { readdirSync(${JSON.stringify(realpathSync(tmpdir()))}); } catch { tempListDenied = true; }
try { await fetch(${JSON.stringify(upstream.url)}); } catch { outsideDenied = true; }
const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.OPENCODE_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4.1-flash' }) });
writeFileSync('probe.json', JSON.stringify({ readDenied, writeDenied, outsideDenied, homeListDenied, tempListDenied, status: response.status, realKeyInEnv: Object.values(process.env).some((x) => x.includes('synthetic-real-api-key')), realKeyInArgv: process.argv.some((x) => x.includes('synthetic-real-api-key')) }));
process.stdout.write(await response.text());
`,
		{ mode: 0o755 },
	);
	try {
		const result = await runBridge({
			target: "opencode-go",
			model: "opencode-go/deepseek-v4.1-flash",
			variant: "low",
			worktree: item.worktree,
			prompt: "synthetic task",
			secret: SECRET,
			cliPath: fake,
			upstream: upstream.url,
			timeoutMs: 20_000,
		});
		assert.equal(result.code, 0, result.stderr);
		const probe = JSON.parse(
			readFileSync(join(item.worktree, "probe.json"), "utf8"),
		);
		assert.deepEqual(probe, {
			readDenied: true,
			writeDenied: true,
			outsideDenied: true,
			homeListDenied: true,
			tempListDenied: true,
			status: 200,
			realKeyInEnv: false,
			realKeyInArgv: false,
		});
		assert.equal(upstreamCalls, 1);
		assert.equal(result.stdout.includes(SECRET), false);
		assert.equal(result.stderr.includes(SECRET), false);
		for (const name of readdirSync(item.worktree)) {
			if (name === ".git") continue;
			assert.equal(
				readFileSync(join(item.worktree, name), "utf8").includes(SECRET),
				false,
			);
		}
		assert.equal(readFileSync(forbidden, "utf8"), "host-only");
		assert.equal(
			readdirSync(item.root).some((name) =>
				name.startsWith(".switchyard-keyless-"),
			),
			false,
		);
	} finally {
		await upstream.close();
		item.cleanup();
		rmSync(forbidden, { force: true });
	}
});
test("Vibe completion fails closed when persisted served alias differs", async (t) => {
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
	const fake = join(item.worktree, "fake-vibe");
	writeFileSync(
		fake,
		'#!/bin/sh\ncat >/dev/null\nmkdir -p "$VIBE_HOME/logs/session/session_probe"\nprintf \'{"config":{"active_model":"mistral-medium-3.5"}}\' >"$VIBE_HOME/logs/session/session_probe/meta.json"\n',
		{ mode: 0o755 },
	);
	try {
		await assert.rejects(
			runBridge({
				target: "vibe",
				model: "glm-5-3",
				worktree: item.worktree,
				prompt: "synthetic task",
				secret: SECRET,
				cliPath: fake,
				timeoutMs: 5_000,
			}),
			/does not prove the requested model alias/,
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
test("Vibe auto-approves bash while OpenCode argv stays fixed", async (t) => {
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
	const fake = join(item.worktree, "fake-provider.sh");
	writeFileSync(
		fake,
		`#!/bin/sh
printf '%s\\n' "$@" > provider-argv.txt
cat >/dev/null
agent=""
auto_approve=false
previous=""
for arg in "$@"; do
	if [ "$previous" = "--agent" ]; then agent="$arg"; fi
	if [ "$arg" = "--auto-approve" ]; then auto_approve=true; fi
	previous="$arg"
done
if [ "$1" = "-p" ] && [ "$agent" = "accept-edits" ]; then
	if [ "$auto_approve" != true ]; then
		printf 'Allow bash? approval callback; bash effect cancelled\\n'
		exit 0
	fi
	/bin/bash -c "printf 'approved edit\\n' > approval-edit.txt"
	mkdir -p "$VIBE_HOME/logs/session/session_approval"
	printf '{"config":{"active_model":"glm-5-3"}}' > "$VIBE_HOME/logs/session/session_approval/meta.json"
fi
`,
		{ mode: 0o755 },
	);
	try {
		const vibe = await runBridge({
			target: "vibe",
			model: "glm-5-3",
			worktree: item.worktree,
			prompt: "Use bash to create approval-edit.txt.",
			secret: SECRET,
			cliPath: fake,
			timeoutMs: 5_000,
		});
		assert.equal(vibe.code, 0, vibe.stderr);
		assert.equal(
			readFileSync(join(item.worktree, "approval-edit.txt"), "utf8"),
			"approved edit\n",
		);
		assert.deepEqual(
			readFileSync(join(item.worktree, "provider-argv.txt"), "utf8")
				.trimEnd()
				.split("\n"),
			[
				"-p",
				"--agent",
				"accept-edits",
				"--auto-approve",
				"--trust",
				"--workdir",
				item.worktree,
				"--max-turns",
				"12",
				"--output",
				"json",
			],
		);

		const opencode = await runBridge({
			target: "opencode-go",
			model: "opencode-go/deepseek-v4.1-flash",
			variant: "low",
			worktree: item.worktree,
			prompt: "synthetic task",
			secret: SECRET,
			cliPath: fake,
			timeoutMs: 5_000,
		});
		assert.equal(opencode.code, 0, opencode.stderr);
		assert.deepEqual(
			readFileSync(join(item.worktree, "provider-argv.txt"), "utf8")
				.trimEnd()
				.split("\n"),
			[
				"run",
				"--pure",
				"--agent",
				"build",
				"--auto",
				"--variant",
				"low",
				"--model",
				"opencode-go/deepseek-v4.1-flash",
			],
		);
	} finally {
		item.cleanup();
	}
});
