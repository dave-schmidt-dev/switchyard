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

test("Seatbelt grants no broad host preferences or etc read", () => {
	const profile = seatbeltProfile({
		worktree: "/private/tmp/switchyard-simple-test/worktree",
		runtime: "/private/tmp/switchyard-simple-test/runtime",
		proxyPort: 12345,
	});
	assert.equal(profile.includes('(subpath "/private/etc")'), false);
	assert.equal(profile.includes('(subpath "/Library/Preferences")'), false);
});

test("proxy admits at most the fixed request budget across concurrent calls", async () => {
	let upstreamCalls = 0;
	const upstream = await localServer((request, response) => {
		upstreamCalls += 1;
		request.resume();
		response.writeHead(200, { "content-type": "application/json" });
		response.end("{}");
	});
	const proxy = await startProxy({
		target: "opencode-go",
		model: "opencode-go/deepseek-v4.1-flash",
		secret: SECRET,
		upstream: upstream.url,
	});
	try {
		const responses = await Promise.all(
			Array.from({ length: MAX_CHAT_REQUESTS + 8 }, () =>
				post(
					proxy.port,
					"/v1/chat/completions",
					proxy.nonce,
					"deepseek-v4.1-flash",
				),
			),
		);
		assert.equal(
			responses.filter((response) => response.status === 200).length,
			MAX_CHAT_REQUESTS,
		);
		assert.equal(
			responses.filter((response) => response.status === 429).length,
			8,
		);
		assert.equal(upstreamCalls, MAX_CHAT_REQUESTS);
	} finally {
		await proxy.close();
		await upstream.close();
	}
});

test("Switchyard teardown stops a detached CLI after bridge SIGKILL", async (t) => {
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
	const fake = join(item.worktree, "fake-cli");
	writeFileSync(
		fake,
		"#!/bin/sh\nprintf '%s' \"$$\" > cli.pid\nexec sleep 30\n",
		{ mode: 0o755 },
	);
	const launchedAt = Date.now();
	const script = `import { runBridge } from ${JSON.stringify(new URL("../ops/simple-provider-keyless-bridge.mjs", import.meta.url).href)}; await runBridge({ target: "opencode-go", model: "opencode-go/deepseek-v4.1-flash", variant: "low", worktree: ${JSON.stringify(item.worktree)}, prompt: "synthetic", secret: ${JSON.stringify(SECRET)}, cliPath: ${JSON.stringify(fake)}, timeoutMs: 30000 });`;
	const bridge = spawn(
		process.execPath,
		["--input-type=module", "-e", script],
		{
			cwd: item.worktree,
			detached: true,
			stdio: "ignore",
		},
	);
	let cliPid = null;
	try {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			try {
				cliPid = Number(readFileSync(join(item.worktree, "cli.pid"), "utf8"));
				if (Number.isSafeInteger(cliPid) && cliPid > 1) break;
			} catch {}
			await new Promise((done) => setTimeout(done, 50));
		}
		assert.ok(cliPid, "detached CLI did not start");
		process.kill(bridge.pid, "SIGKILL");
		assert.equal(
			await settleSimpleWriterProcesses({
				processGroupId: bridge.pid,
				processScopePath: item.worktree,
				launchedAt,
			}),
			"stopped",
		);
		const probe = spawnSync("ps", ["-o", "stat=", "-p", String(cliPid)], {
			encoding: "utf8",
		});
		assert.ok(
			probe.status !== 0 || /^Z/u.test(probe.stdout.trim()),
			"detached CLI survived teardown",
		);
	} finally {
		if (bridge.pid) {
			try {
				process.kill(-bridge.pid, "SIGKILL");
			} catch {}
		}
		if (cliPid) {
			try {
				process.kill(cliPid, "SIGKILL");
			} catch {}
		}
		item.cleanup();
	}
});

test("fixed invocation rejects unapproved target, model, variant, and clone", () => {
	const item = setup();
	try {
		const good = [
			"--target",
			"opencode-go",
			"--model",
			"opencode-go/deepseek-v4.1-flash",
			"--worktree",
			item.worktree,
			"--variant",
			"low",
		];
		assert.equal(
			parseBridgeArgs(good).model,
			"opencode-go/deepseek-v4.1-flash",
		);
		assert.throws(
			() =>
				parseBridgeArgs([...good.slice(0, 3), "other/model", ...good.slice(4)]),
			/not approved/,
		);
		assert.throws(
			() => parseBridgeArgs([...good.slice(0, 7), "high"]),
			/variant/,
		);
		assert.throws(
			() => parseBridgeArgs([...good, "--extra", "x"]),
			/invalid fixed argument set/,
		);
		assert.throws(
			() =>
				parseBridgeArgs(
					good.map((v) => (v === item.worktree ? realpathSync(tmpdir()) : v)),
				),
			/disposable clone/,
		);
	} finally {
		item.cleanup();
	}
});

test("proxy gates nonce, exact path and model, strips credentials, redacts response, and refuses redirects", async () => {
	await assert.rejects(
		startProxy({
			target: "vibe",
			model: "glm-5-3",
			secret: SECRET,
			upstream: "http://example.com/v1/chat/completions",
		}),
		/test HTTP upstream must be loopback/,
	);
	let observed = null;
	const upstream = await localServer((request, response) => {
		observed = {
			path: request.url,
			auth: request.headers.authorization,
			host: request.headers.host,
			userAgent: request.headers["user-agent"],
			session: request.headers["x-opencode-session"],
			project: request.headers["x-opencode-project"],
		};
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({ model: "deepseek-v4.1-flash", reflected: SECRET }),
		);
	});
	const proxy = await startProxy({
		target: "opencode-go",
		model: "opencode-go/deepseek-v4.1-flash",
		secret: SECRET,
		upstream: upstream.url,
	});
	try {
		assert.equal(
			(
				await post(
					proxy.port,
					"/v1/chat/completions",
					"wrong",
					"deepseek-v4.1-flash",
				)
			).status,
			403,
		);
		assert.equal(
			(await post(proxy.port, "/v1/models", proxy.nonce, "deepseek-v4.1-flash"))
				.status,
			403,
		);
		assert.equal(
			(
				await post(
					proxy.port,
					"/v1/chat/completions",
					proxy.nonce,
					"other-model",
				)
			).status,
			403,
		);
		const accepted = await fetch(
			`http://127.0.0.1:${proxy.port}/v1/chat/completions`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${proxy.nonce}`,
					"content-type": "application/json",
					"user-agent": "opencode/1.18.30",
					"x-opencode-session": "session-123",
					"x-opencode-project": "private-project",
				},
				body: JSON.stringify({ model: "deepseek-v4.1-flash" }),
			},
		);
		assert.equal(accepted.status, 200);
		const response = await accepted.text();
		assert.equal(response.includes(SECRET), false);
		assert.equal(response.includes("[redacted]"), true);
		assert.equal(observed.path, "/v1/chat/completions");
		assert.equal(observed.auth, `Bearer ${SECRET}`);
		assert.equal(observed.host, `127.0.0.1:${new URL(upstream.url).port}`);
		assert.equal(observed.userAgent, "opencode/1.18.30");
		assert.equal(observed.session, "session-123");
		assert.equal(observed.project, undefined);
	} finally {
		await proxy.close();
		await upstream.close();
	}
	const redirect = await localServer((_request, response) => {
		response.writeHead(302, { location: "http://127.0.0.1:9/leak" });
		response.end();
	});
	const second = await startProxy({
		target: "vibe",
		model: "glm-5-3",
		secret: SECRET,
		upstream: redirect.url,
	});
	try {
		assert.equal(
			(
				await post(
					second.port,
					"/v1/chat/completions",
					second.nonce,
					"zai-glm-5-3",
				)
			).status,
			502,
		);
	} finally {
		await second.close();
		await redirect.close();
	}
});

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
writeFileSync('probe.json', JSON.stringify({ exactStdin: prompt === expected, sentinelInArgv: process.argv.some(value => value.includes(sentinel)), sentinelInEnvironment: Object.values(process.env).some(value => value.includes(sentinel)) }));
`,
		{ mode: 0o755 },
	);
	try {
		const result = await runBridge({
			target: "opencode-go",
			model: "opencode-go/deepseek-v4.1-flash",
			variant: "low",
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
			},
		);
	} finally {
		item.cleanup();
	}
});

for (const [target, model, variant, expectedEffort] of [
	["vibe", "glm-5-3-medium", undefined, "high"],
	["vibe", "glm-5-3", undefined, "max"],
	["opencode-go", "opencode-go/deepseek-v4.1-flash", "low", undefined],
])
	test(`installed ${target} CLI ${model} reaches the synthetic endpoint`, async (t) => {
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
