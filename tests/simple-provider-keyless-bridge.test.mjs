import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
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
	parseBridgeArgs,
	runBridge,
	startProxy,
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
		const accepted = await post(
			proxy.port,
			"/v1/chat/completions",
			proxy.nonce,
			"deepseek-v4.1-flash",
		);
		assert.equal(accepted.status, 200);
		const response = await accepted.text();
		assert.equal(response.includes(SECRET), false);
		assert.equal(response.includes("[redacted]"), true);
		assert.equal(observed.path, "/v1/chat/completions");
		assert.equal(observed.auth, `Bearer ${SECRET}`);
		assert.equal(observed.host, `127.0.0.1:${new URL(upstream.url).port}`);
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

for (const [target, model, variant] of [
	["vibe", "glm-5-3-medium", undefined],
	["opencode-go", "opencode-go/deepseek-v4.1-flash", "low"],
])
	test(`installed ${target} CLI reaches the synthetic endpoint through its override`, async (t) => {
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
		const upstream = await localServer((request, response) => {
			calls += 1;
			request.resume();
			response.writeHead(400, { "content-type": "application/json" });
			response.end('{"message":"synthetic endpoint reached"}');
		});
		try {
			await runBridge({
				target,
				model,
				variant,
				worktree: item.worktree,
				prompt: "Say hello only.",
				secret: SECRET,
				upstream: upstream.url,
				timeoutMs: 15_000,
			});
			assert.ok(calls > 0, "installed CLI did not reach synthetic upstream");
		} finally {
			await upstream.close();
			item.cleanup();
		}
	});
