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
import { dirname, join } from "node:path";
import { runBridge } from "../../ops/simple-provider-keyless-bridge.mjs";
import { HANG_GUARD_MS } from "./hang-guard.mjs";

export const SECRET = "synthetic-real-api-key-bridge-123456";
export function setup() {
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
		cleanup: () => {
			stopStubServers(worktree);
			rmSync(root, { recursive: true, force: true });
		},
	};
}

// Stands in for `opencode serve`: listens where the bridge asked, prints the
// line the bridge waits for, and exits on its own if nothing stops it.
const SERVE_STUB = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import net from "node:net";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
appendFileSync("server.pids", \`\${process.pid}\\n\`);
setTimeout(() => process.exit(0), 120_000);
net.createServer((socket) => socket.destroy()).listen(port, "127.0.0.1", () =>
	process.stdout.write(\`server listening on http://127.0.0.1:\${port}\\n\`),
);
`;

/** Pids of every serve stub started in `worktree`, oldest first. */
export function stubServerPids(worktree) {
	const file = join(worktree, "server.pids");
	return existsSync(file)
		? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number)
		: [];
}
function stopStubServers(worktree) {
	for (const pid of stubServerPids(worktree)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}
export function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code !== "ESRCH";
	}
}

/**
 * Wrap an OpenCode fake for the bridge's two launches: `serve` runs `serve`
 * (default: the listening stub) and records its argv in serve-argv.txt; every
 * other call execs the fake itself. Bash, not sh: under the Seatbelt profile
 * /bin/sh prints its own error line.
 */
export function withOpenCodeServer(fake, { serve } = {}) {
	const dir = dirname(fake);
	const stub = join(dir, "serve-stub");
	writeFileSync(stub, serve ?? SERVE_STUB, { mode: 0o755 });
	const dispatcher = join(dir, "opencode-dispatch");
	writeFileSync(
		dispatcher,
		`#!/bin/bash\nif [ "$1" = serve ]; then\n\tprintf '%s\\n' "$@" > serve-argv.txt\n\texec ${JSON.stringify(stub)} "$@"\nfi\nexec ${JSON.stringify(fake)} "$@"\n`,
		{ mode: 0o755 },
	);
	return dispatcher;
}
export const seatbeltBlocked = () => {
	const check = spawnSync(
		"/usr/bin/sandbox-exec",
		[
			"-p",
			"(version 1) (deny default) (allow process*) (allow file-read*)",
			"/usr/bin/true",
		],
		{ encoding: "utf8" },
	);
	return check.status !== 0 && /Operation not permitted/u.test(check.stderr);
};
export async function captureStderr(run) {
	const write = process.stderr.write;
	const chunks = [];
	process.stderr.write = (chunk, ...rest) => {
		chunks.push(String(chunk));
		rest.find((item) => typeof item === "function")?.();
		return true;
	};
	try {
		return { value: await run(), stderr: chunks.join("") };
	} catch (error) {
		return { error, stderr: chunks.join("") };
	} finally {
		process.stderr.write = write;
	}
}
export function runFake(
	item,
	script,
	{ target = "opencode-go", shebang = "#!/bin/sh", ...extra } = {},
) {
	const fake = join(item.worktree, "fake-provider");
	writeFileSync(fake, `${shebang}\n${script}\n`, { mode: 0o755 });
	const cliPath = target === "opencode-go" ? withOpenCodeServer(fake) : fake;
	return captureStderr(() =>
		runBridge({
			target,
			model: target === "vibe" ? "glm-5-3" : "opencode-go/deepseek-v4.1-flash",
			variant: target === "vibe" ? undefined : "low",
			worktree: item.worktree,
			prompt: "synthetic task",
			secret: SECRET,
			cliPath,
			timeoutMs: HANG_GUARD_MS,
			verifySession: false,
			...extra,
		}),
	);
}
export const leftovers = (item) =>
	readdirSync(item.root).filter((name) =>
		name.startsWith(".switchyard-keyless-"),
	);
