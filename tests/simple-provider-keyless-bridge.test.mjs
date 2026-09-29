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
test("proxy admits concurrent calls beyond the former fixed request budget", async () => {
	const requestCount = 72;
	let upstreamCalls = 0;
	const events = [];
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
		onRequestEvent: (event) => events.push(event),
	});
	try {
		const responses = await Promise.all(
			Array.from({ length: requestCount }, () =>
				post(
					proxy.port,
					"/v1/chat/completions",
					proxy.nonce,
					"deepseek-v4.1-flash",
				),
			),
		);
		await Promise.all(responses.map((response) => response.arrayBuffer()));
		assert.equal(
			responses.filter((response) => response.status === 200).length,
			requestCount,
		);
		assert.equal(
			responses.filter((response) => response.status === 429).length,
			0,
		);
		assert.equal(upstreamCalls, requestCount);
		assert.equal(events.length, requestCount);
		assert.equal(
			new Set(events.map((event) => event.sequence)).size,
			requestCount,
		);
		assert.equal(
			events.every(
				(event) =>
					event.outcome === "upstream_http_success" &&
					event.httpStatus === 200 &&
					event.upstreamStatus === 200,
			),
			true,
		);
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
