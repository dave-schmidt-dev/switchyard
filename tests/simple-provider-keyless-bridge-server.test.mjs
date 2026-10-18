import { strict as assert } from "node:assert";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	formatBridgeFailure,
	runBridge,
} from "../ops/simple-provider-keyless-bridge.mjs";
import { HANG_GUARD_MS } from "./helpers/hang-guard.mjs";
import {
	captureStderr,
	leftovers,
	pidAlive,
	SECRET,
	seatbeltBlocked,
	setup,
	stubServerPids,
	withOpenCodeServer,
} from "./helpers/keyless-bridge-fixtures.mjs";

// OpenCode 2.x runs as a bridge-owned loopback server plus a `run --server`
// client. The client, which carries the per-run password, starts only after
// this server child reports the bridge's port, and both groups always stop.

const CLIENT =
	'#!/bin/bash\n: > client-ran\ncat >/dev/null\nprintf "done\\n"\n';

function launch(item, { serve, timeoutMs = HANG_GUARD_MS } = {}) {
	const fake = join(item.worktree, "fake-opencode");
	writeFileSync(fake, CLIENT, { mode: 0o755 });
	return captureStderr(() =>
		runBridge({
			target: "opencode-go",
			model: "opencode-go/deepseek-v4.1-flash",
			variant: "low",
			worktree: item.worktree,
			prompt: "synthetic task",
			secret: SECRET,
			cliPath: withOpenCodeServer(fake, { serve }),
			timeoutMs,
		}),
	);
}

const guarded = (name, body) =>
	test(name, async (t) => {
		if (seatbeltBlocked()) return t.skip("host Seatbelt unavailable");
		const item = setup();
		try {
			await body(item);
		} finally {
			item.cleanup();
		}
	});

guarded("the server and client stop after a completed run", async (item) => {
	const { value, error } = await launch(item);
	assert.ifError(error);
	assert.equal(value.code, 0, value.stderr);
	assert.equal(value.stdout, "done\n");
	const pids = stubServerPids(item.worktree);
	assert.equal(pids.length, 1);
	assert.equal(pidAlive(pids[0]), false, "OpenCode server outlived the run");
	assert.deepEqual(leftovers(item), []);
});

for (const [name, serve] of [
	["exits before listening", "#!/bin/bash\nexit 0\n"],
	[
		"reports another port",
		'#!/bin/bash\nprintf "server listening on http://127.0.0.1:1\\n"\n',
	],
	[
		"reports the port only mid-line",
		'#!/bin/bash\nprintf "log: server listening on http://127.0.0.1:%s\\n" "$5"\n',
	],
])
	guarded(`a server that ${name} never gets the client`, async (item) => {
		const { error } = await launch(item, { serve });
		assert.match(
			formatBridgeFailure(error),
			/^simple-provider-keyless-bridge: OpenCode server did not start\n$/u,
		);
		assert.equal(existsSync(join(item.worktree, "client-ran")), false);
		assert.deepEqual(leftovers(item), []);
	});

guarded("the run deadline stops a server that never listens", async (item) => {
	const silent =
		'#!/bin/bash\nprintf "%s\\n" "$$" >> server.pids\nexec sleep 30\n';
	const { error } = await launch(item, { serve: silent, timeoutMs: 1_500 });
	assert.match(
		formatBridgeFailure(error),
		/error none, interrupt duration-limit\)\n$/u,
	);
	assert.equal(existsSync(join(item.worktree, "client-ran")), false);
	const [pid] = stubServerPids(item.worktree);
	assert.ok(pid, "silent server did not start");
	assert.equal(pidAlive(pid), false, "silent server survived the deadline");
	assert.deepEqual(leftovers(item), []);
});
