import { ok, rejects, strictEqual } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { quickCheckSandboxProfile } from "../src/switchyard/runner/checks-sandbox.mjs";
import { EVIDENCE_TAIL_BYTES } from "../src/switchyard/simple/check-environment.mjs";
import {
	createSimpleCheckSessions,
	writeCheckEvidence,
} from "../src/switchyard/simple/check-session.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { nestedSandboxSkip } from "./helpers/nested-sandbox.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const suite = tempDir("switchyard-check-session-tests-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suite, "runs");
function git(path, args) {
	return execFileSync("git", args, {
		cwd: path,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		},
	}).trim();
}
function commit(path) {
	git(path, ["add", "."]);
	git(path, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"fixture",
	]);
}
function fixture() {
	const root = tempDir("switchyard-check-session-");
	const projectPath = join(root, "project");
	mkdirSync(projectPath);
	writeFileSync(join(projectPath, "a.txt"), "base\n");
	writeFileSync(
		join(projectPath, ".gitignore"),
		"node_modules/\nside-effect\nsentinel\n",
	);
	git(projectPath, ["init", "-q"]);
	commit(projectPath);
	const promptPath = join(root, "prompt");
	writeFileSync(promptPath, "Change a.txt");
	return { root, projectPath, promptPath };
}
async function run(repo, options = {}, provider = null, extra = {}) {
	let called = 0;
	let providerRoot;
	const result = await runSimpleTask(
		{
			...repo,
			capability: "standard",
			files: ["a.txt"],
			checks: ["test -f a.txt"],
			deadlineMs: Date.now() + 180_000,
			...options,
		},
		{
			tmpdir: repo.root,
			route: () => ({ provider: "Codex (Spark)", reason: "priority_fill" }),
			resolveTargetIdentity: () => ({
				targetId: "codex",
				harnessKey: "codex",
				ambiguous: false,
			}),
			getInvocationDescriptor: () => ({
				target_id: "codex",
				selector: "gpt-5.3-codex-spark",
				invocation_args: [],
			}),
			assertFundedRoute: () => {},
			executeProvider: async (context) => {
				called++;
				providerRoot = dirname(context.worktreePath);
				strictEqual(
					readdirSync(providerRoot).some((name) => name.startsWith("checker-")),
					false,
					"preflight checker removed before provider",
				);
				if (provider) return provider(context, called);
				writeFileSync(join(context.worktreePath, "a.txt"), "candidate\n");
				return { success: true, writerLifecycle: "stopped" };
			},
			...extra,
		},
	);
	if (providerRoot && existsSync(providerRoot))
		strictEqual(
			readdirSync(providerRoot).some((name) => name.startsWith("checker-")),
			false,
		);
	return { result, called, providerRoot };
}

test("full dispatch checks the actual safe candidate and exact dirty overlay", {
	skip: nestedSandboxSkip,
}, async () => {
	const repo = fixture();
	writeFileSync(join(repo.projectPath, "a.txt"), "overlay\n");
	const observed = await run(
		repo,
		{
			dirtyOverlay: true,
			baselineChecks: [
				`node -e 'if(require("fs").readFileSync("a.txt","utf8").trim()!=="overlay")process.exit(1)'`,
			],
			checks: [
				`node -e 'if(require("fs").readFileSync("a.txt","utf8").trim()!=="candidate")process.exit(1)'`,
			],
		},
		async ({ worktreePath }) => {
			strictEqual(
				readFileSync(join(worktreePath, "a.txt"), "utf8"),
				"overlay\n",
			);
			writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
			return { success: true, writerLifecycle: "stopped" };
		},
	);
	strictEqual(
		observed.result.status,
		"succeeded",
		JSON.stringify(observed.result),
	);
	strictEqual(
		readFileSync(join(repo.projectPath, "a.txt"), "utf8"),
		"candidate\n",
	);
	strictEqual(existsSync(observed.providerRoot), false);
});

test("actual checker denies host paths and inherited environment", {
	skip: nestedSandboxSkip,
}, async () => {
	const repo = fixture();
	const outside = join(repo.root, "host-marker");
	writeFileSync(outside, "owner");
	process.env.SWITCHYARD_CHECK_SECRET_CANARY = "should-not-inherit";
	try {
		const command = `node -e 'const f=require("fs"); if(process.env.SWITCHYARD_CHECK_SECRET_CANARY)process.exit(1);try{f.readFileSync(${JSON.stringify(outside)});process.exit(1)}catch(e){if(!["EPERM","EACCES"].includes(e.code))process.exit(1)}try{f.writeFileSync(${JSON.stringify(outside)},"changed");process.exit(1)}catch(e){if(!["EPERM","EACCES"].includes(e.code))process.exit(1)}'`;
		const observed = await run(repo, { checks: [command] });
		strictEqual(
			observed.result.status,
			"succeeded",
			JSON.stringify(observed.result),
		);
		strictEqual(readFileSync(outside, "utf8"), "owner");
	} finally {
		delete process.env.SWITCHYARD_CHECK_SECRET_CANARY;
	}
});

test("full dispatch rebuilds repair candidate and discards checker side effects", {
	skip: nestedSandboxSkip,
}, async () => {
	const repo = fixture();
	const observed = await run(
		repo,
		{
			checks: [
				`node -e 'const f=require("fs");if(f.existsSync("side-effect"))process.exit(1);f.writeFileSync("side-effect", "x");if(f.readFileSync("a.txt","utf8").trim()!=="repaired")process.exit(1)'`,
			],
			repairChecks: true,
		},
		async ({ worktreePath }, called) => {
			writeFileSync(
				join(worktreePath, "a.txt"),
				called === 1 ? "wrong\n" : "repaired\n",
			);
			return { success: true, writerLifecycle: "stopped" };
		},
	);
	strictEqual(
		observed.result.status,
		"succeeded",
		JSON.stringify(observed.result),
	);
	strictEqual(observed.called, 2);
	strictEqual(existsSync(join(repo.projectPath, "side-effect")), false);
});

test("unavailable provider writer refuses checker rebuild", {
	skip: nestedSandboxSkip,
}, async () => {
	const repo = fixture();
	const observed = await run(repo, {}, async ({ worktreePath }) => {
		writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
		return { success: true, writerLifecycle: "unavailable" };
	});
	strictEqual(observed.result.failureReason, "provider_group_unconfirmed");
	strictEqual(readFileSync(join(repo.projectPath, "a.txt"), "utf8"), "base\n");
});

test("unavailable bounded tool refuses before provider", async () => {
	const observed = await run(fixture(), {
		checks: ["switchyard_missing_check_tool --version"],
	});
	strictEqual(observed.called, 0);
	strictEqual(observed.result.failureReason, "check_environment_unavailable");
});

test("cancelled preparation never launches provider and cleans owned root", async () => {
	const controller = new AbortController();
	const repo = fixture();
	const observed = await run(repo, {}, null, {
		signal: controller.signal,
		onStatus: (event) => {
			if (event.processPhase === "check_preparing") controller.abort();
		},
	});
	strictEqual(observed.called, 0);
	strictEqual(observed.result.status, "failed");
	strictEqual(observed.result.failureReason, "provider_cancelled");
	strictEqual(
		readdirSync(repo.root).some((name) =>
			name.startsWith("switchyard-simple-"),
		),
		false,
	);
});

test("baseline-only dispatch checks its base once without preparing a candidate checker", {
	skip: nestedSandboxSkip,
}, async () => {
	const repo = fixture();
	writeFileSync(join(repo.projectPath, "package.json"), '{"name":"base"}\n');
	commit(repo.projectPath);
	const fs = createRequire(import.meta.url)("node:fs");
	const original = fs.mkdtempSync;
	let checkerAllocations = 0;
	fs.mkdtempSync = (prefix, ...args) => {
		if (basename(prefix).startsWith("checker-")) checkerAllocations += 1;
		return original(prefix, ...args);
	};
	syncBuiltinESMExports();
	try {
		const observed = await run(
			repo,
			{
				files: ["package.json"],
				allowManifests: ["package.json"],
				checks: [],
				baselineChecks: [
					`node -e 'if(require("./package.json").name!=="base")process.exit(1)'`,
				],
			},
			async ({ worktreePath }) => {
				writeFileSync(
					join(worktreePath, "package.json"),
					'{"name":"changed"}\n',
				);
				return { success: true, writerLifecycle: "stopped" };
			},
		);
		strictEqual(
			observed.result.status,
			"succeeded",
			JSON.stringify(observed.result),
		);
		strictEqual(checkerAllocations, 1);
		strictEqual(
			readFileSync(join(repo.projectPath, "package.json"), "utf8"),
			'{"name":"changed"}\n',
		);
	} finally {
		fs.mkdtempSync = original;
		syncBuiltinESMExports();
	}
});

test("baseline-only dispatch still requires stopped-writer proof", {
	skip: nestedSandboxSkip,
}, async () => {
	const observed = await run(
		fixture(),
		{ checks: [], baselineChecks: ["test -f a.txt"] },
		async ({ worktreePath }) => {
			writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
			return { success: true, writerLifecycle: "never_started" };
		},
	);
	strictEqual(observed.result.failureReason, "provider_group_unconfirmed");
});

test("trusted dirty-overlay stage failure survives concurrent cancellation", async () => {
	const repo = fixture();
	writeFileSync(join(repo.projectPath, "a.txt"), "overlay\n");
	const controller = new AbortController();
	const cp = createRequire(import.meta.url)("node:child_process");
	const original = cp.spawnSync;
	let injected = false;
	cp.spawnSync = (command, args, options) => {
		if (
			!injected &&
			command === "git" &&
			args.includes("add") &&
			options?.cwd?.endsWith("/worktree")
		) {
			injected = true;
			controller.abort();
			return { status: 1, stdout: "", stderr: "fixture stage failure" };
		}
		return original(command, args, options);
	};
	syncBuiltinESMExports();
	try {
		const observed = await run(repo, { dirtyOverlay: true }, null, {
			signal: controller.signal,
		});
		strictEqual(injected, true);
		strictEqual(observed.called, 0);
		strictEqual(observed.result.failureReason, "dirty_overlay_stage_failed");
		strictEqual(observed.result.failurePhase, "prepare");
	} finally {
		cp.spawnSync = original;
		syncBuiltinESMExports();
	}
});

for (const code of [
	"check_group_unconfirmed",
	"check_session_cleanup_failed",
]) {
	test(`trusted checker ${code} survives concurrent cancellation`, {
		skip: nestedSandboxSkip,
	}, async () => {
		const repo = fixture();
		const controller = new AbortController();
		const fs = createRequire(import.meta.url)("node:fs");
		const original = fs.rmSync;
		let injected = false;
		fs.rmSync = (path, ...args) => {
			if (
				!injected &&
				typeof path === "string" &&
				basename(path).startsWith("checker-")
			) {
				injected = true;
				controller.abort();
				throw Object.assign(new Error("fixture trusted checker fault"), {
					code,
				});
			}
			return original(path, ...args);
		};
		syncBuiltinESMExports();
		try {
			const observed = await run(repo, {}, null, { signal: controller.signal });
			strictEqual(injected, true);
			strictEqual(observed.called, 0);
			strictEqual(observed.result.failureReason, code);
			strictEqual(observed.result.failurePhase, "baseline");
		} finally {
			fs.rmSync = original;
			syncBuiltinESMExports();
		}
	});
}

test("a provider callback cannot override cancellation with a trusted checker error code", {
	skip: nestedSandboxSkip,
}, async () => {
	const controller = new AbortController();
	const observed = await run(
		fixture(),
		{},
		async () => {
			controller.abort();
			throw Object.assign(new Error("provider callback error"), {
				code: "check_session_cleanup_failed",
			});
		},
		{ signal: controller.signal },
	);
	strictEqual(observed.called, 1);
	strictEqual(observed.result.failureReason, "provider_cancelled");
});

async function lockedFixture() {
	const repo = fixture();
	const cache = join(repo.root, "cache");
	mkdirSync(cache);
	const packageRoot = join(repo.root, "package");
	mkdirSync(packageRoot);
	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify({
			name: "fixture-tool",
			version: "1.0.0",
			bin: { "fixture-check": "cli.js" },
			scripts: { install: "touch sentinel" },
		}),
	);
	writeFileSync(
		join(packageRoot, "cli.js"),
		'#!/usr/bin/env node\nconst fs = require("node:fs"); if (fs.existsSync("sentinel") || fs.existsSync("node_modules/fixture-tool/sentinel") || fs.readFileSync("a.txt", "utf8").trim() !== "candidate") process.exit(1);\n',
	);
	const archive = join(repo.root, "fixture.tgz");
	execFileSync("tar", ["-czf", archive, "-C", repo.root, "package"]);
	const bytes = readFileSync(archive);
	const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	const npm = createRequire("/opt/homebrew/lib/node_modules/npm/package.json");
	const cacache = npm("cacache");
	await cacache.put(join(cache, "_cacache"), "fixture", bytes, { integrity });
	writeFileSync(
		join(repo.projectPath, "package.json"),
		JSON.stringify({
			name: "fixture",
			version: "1.0.0",
			dependencies: { "fixture-tool": "1.0.0" },
			scripts: { install: "touch sentinel" },
		}),
	);
	writeFileSync(
		join(repo.projectPath, "package-lock.json"),
		JSON.stringify({
			name: "fixture",
			version: "1.0.0",
			lockfileVersion: 3,
			packages: {
				"": {
					name: "fixture",
					version: "1.0.0",
					dependencies: { "fixture-tool": "1.0.0" },
				},
				"node_modules/fixture-tool": {
					version: "1.0.0",
					resolved:
						"https://registry.npmjs.org/fixture-tool/-/fixture-tool-1.0.0.tgz",
					integrity,
					bin: { "fixture-check": "cli.js" },
					hasInstallScript: true,
				},
			},
		}),
	);
	commit(repo.projectPath);
	return { repo, cache };
}

test("actual seeded offline cache isolates binary tampering and disables lifecycle scripts", {
	skip: nestedSandboxSkip,
}, async () => {
	const { repo, cache } = await lockedFixture();
	const observed = await run(
		repo,
		{ checks: ["npx fixture-check"] },
		async ({ worktreePath }) => {
			mkdirSync(join(worktreePath, "node_modules", ".bin"), {
				recursive: true,
			});
			writeFileSync(
				join(worktreePath, "node_modules", ".bin", "fixture-check"),
				"exit 0\n",
			);
			writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
			return { success: true, writerLifecycle: "stopped" };
		},
		{ checkCachePath: cache },
	);
	strictEqual(
		observed.result.status,
		"succeeded",
		JSON.stringify(observed.result),
	);
	strictEqual(existsSync(join(repo.projectPath, "sentinel")), false);
});

test("plain Node imports receive the complete locked tree", {
	skip: nestedSandboxSkip,
}, async () => {
	const { repo, cache } = await lockedFixture();
	const observed = await run(
		repo,
		{ checks: [`node -e 'require("fixture-tool/cli.js")'`] },
		null,
		{ checkCachePath: cache },
	);
	strictEqual(
		observed.result.status,
		"succeeded",
		JSON.stringify(observed.result),
	);
});

test("generic non-Node checks with manifest dependencies need no cache installation", {
	skip: nestedSandboxSkip,
}, async () => {
	const { repo } = await lockedFixture();
	const cache = join(repo.root, "cold-generic");
	mkdirSync(cache);
	const observed = await run(
		repo,
		{
			checks: ["test -f a.txt"],
			baselineChecks: ["test -f a.txt"],
		},
		async ({ worktreePath }) => {
			strictEqual(existsSync(join(worktreePath, "node_modules")), false);
			writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
			return { success: true, writerLifecycle: "stopped" };
		},
		{ checkCachePath: cache },
	);
	strictEqual(observed.called, 1);
	strictEqual(
		observed.result.status,
		"succeeded",
		JSON.stringify(observed.result),
	);
	strictEqual(existsSync(join(cache, "_cacache")), false);
});

test("plain Node imported dependencies with cold cache refuse before provider", {
	skip: nestedSandboxSkip,
}, async () => {
	const { repo } = await lockedFixture();
	const cache = join(repo.root, "cold-node");
	mkdirSync(cache);
	const observed = await run(
		repo,
		{
			checks: [`node -e 'require("fixture-tool/cli.js")'`],
		},
		null,
		{ checkCachePath: cache },
	);
	strictEqual(observed.called, 0);
	strictEqual(observed.result.failureReason, "check_dependencies_unverified");
});

test("declared locked binary heads trigger trusted provisioning", {
	skip: nestedSandboxSkip,
}, async () => {
	const { repo, cache } = await lockedFixture();
	const observed = await run(repo, { checks: ["fixture-check"] }, null, {
		checkCachePath: cache,
	});
	strictEqual(
		observed.result.status,
		"succeeded",
		JSON.stringify(observed.result),
	);
});

test("cold offline cache refuses before provider", {
	skip: nestedSandboxSkip,
}, async () => {
	const { repo } = await lockedFixture();
	const cache = join(repo.root, "cold");
	mkdirSync(cache);
	const observed = await run(repo, { checks: ["npx fixture-check"] }, null, {
		checkCachePath: cache,
	});
	strictEqual(observed.called, 0);
	strictEqual(observed.result.failureReason, "check_dependencies_unverified");
});

test("scoped generic manifest edits need no unchanged dependency tree", {
	skip: nestedSandboxSkip,
}, async () => {
	const { repo } = await lockedFixture();
	const cache = join(repo.root, "cold-manifest");
	mkdirSync(cache);
	const candidate = '{"name":"changed","dependencies":{"different":"1.0.0"}}\n';
	const observed = await run(
		repo,
		{
			files: ["package.json"],
			allowManifests: ["package.json"],
			checks: ["test -f package.json"],
			baselineChecks: ["test -f package.json"],
		},
		async ({ worktreePath }) => {
			strictEqual(existsSync(join(worktreePath, "node_modules")), false);
			writeFileSync(join(worktreePath, "package.json"), candidate);
			return { success: true, writerLifecycle: "stopped" };
		},
		{ checkCachePath: cache },
	);
	strictEqual(
		observed.result.status,
		"succeeded",
		JSON.stringify(observed.result),
	);
	strictEqual(
		readFileSync(join(repo.projectPath, "package.json"), "utf8"),
		candidate,
	);
	strictEqual(existsSync(join(cache, "_cacache")), false);
});

test("plain Node checks reject changed dependencies before any candidate installation", {
	skip: nestedSandboxSkip,
}, async () => {
	const { repo, cache } = await lockedFixture();
	const observed = await run(
		repo,
		{
			files: ["a.txt", "package.json"],
			allowManifests: ["package.json"],
			checks: [`node -e 'require("fixture-tool/cli.js")'`],
		},
		async ({ worktreePath }) => {
			writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
			writeFileSync(
				join(worktreePath, "package.json"),
				'{"dependencies":{"different":"1.0.0"}}',
			);
			return { success: true, writerLifecycle: "stopped" };
		},
		{ checkCachePath: cache },
	);
	strictEqual(observed.called, 1);
	strictEqual(observed.result.failureReason, "check_dependencies_unverified");
});

for (const failure of ["deadline", "profile"]) {
	test(`pre-spawn ${failure} failure preserves never-started checker cleanup proof`, async () => {
		const repo = fixture();
		let nowCalls = 0;
		let runtimeReads = 0;
		const fs = createRequire(import.meta.url)("node:fs");
		const originalRealpath = fs.realpathSync;
		const session = createSimpleCheckSessions({
			taskRoot: repo.root,
			projectPath: repo.projectPath,
			baseRevision: git(repo.projectPath, ["rev-parse", "HEAD"]),
			baseTree: git(repo.projectPath, ["rev-parse", "HEAD^{tree}"]),
			files: ["a.txt"],
			commands: ["test -f a.txt"],
			taskId: "pre-spawn-check",
			deadlineMs: 100000,
			now: () => {
				nowCalls++;
				return failure === "deadline" && nowCalls === 7 ? 100000 : 1000;
			},
		});
		if (failure === "profile") {
			fs.realpathSync = (path, ...args) => {
				if (
					typeof path === "string" &&
					path.startsWith(`${repo.root}/checker-`) &&
					path.endsWith("/runtime") &&
					++runtimeReads === 2
				)
					throw Object.assign(new Error("fixture profile unavailable"), {
						code: "EIO",
					});
				return originalRealpath(path, ...args);
			};
			syncBuiltinESMExports();
		}
		try {
			await rejects(session.prepare(), {
				code: failure === "deadline" ? "deadline_expired" : "EIO",
			});
			strictEqual(session.writerLifecycle, "never_started");
			session.remove();
			strictEqual(
				readdirSync(repo.root).some((name) => name.startsWith("checker-")),
				false,
			);
		} finally {
			fs.realpathSync = originalRealpath;
			syncBuiltinESMExports();
			session.remove();
		}
	});
}

test("failed-check evidence redacts credential shapes before truncation", () => {
	const directory = join(tempDir("switchyard-check-evidence-"), "evidence");
	const sk = "sk-live-ABCDEFGHIJKLMNOPQRSTUVWX";
	const ghp = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
	const bws = "bws_0123456789abcdefghijklmnopqrstuv";
	// The trailing padding places the token across the stdout tail boundary, so
	// truncating before redacting would retain an unmatched token suffix.
	const output = `${"x".repeat(EVIDENCE_TAIL_BYTES - 15)}\n${sk}${"y".repeat(16370)}`;
	const stderr = `ordinary diagnostic: build failed\n${ghp}\n${bws}\n`;
	const path = writeCheckEvidence(directory, 2, 3, { output, stderr });
	const bytes = readFileSync(path);
	const text = bytes.toString("utf8");
	strictEqual(basename(path), "2-3.log");
	strictEqual(statSync(directory).mode & 0o777, 0o700);
	strictEqual(statSync(path).mode & 0o777, 0o600);
	ok(bytes.length <= 2 * EVIDENCE_TAIL_BYTES, "per-stream tail cap retained");
	ok(!text.includes(sk), "sk-shaped token never persisted");
	ok(!text.includes(sk.slice(18)), "truncation never exposes a token suffix");
	ok(!text.includes(ghp), "ghp-shaped token never persisted");
	ok(!text.includes(bws), "bws-shaped token never persisted");
	ok(
		text.includes("ordinary diagnostic: build failed"),
		"useful diagnostics are retained",
	);
	ok(text.includes("[REDACTED]"), "credential shapes are replaced");
});

test("changed manifests refuse acceptance without installing them", {
	skip: nestedSandboxSkip,
}, async () => {
	const { repo, cache } = await lockedFixture();
	const observed = await run(
		repo,
		{
			files: ["a.txt", "package.json"],
			allowManifests: ["package.json"],
			checks: ["npx fixture-check"],
		},
		async ({ worktreePath }) => {
			writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
			writeFileSync(
				join(worktreePath, "package.json"),
				'{"dependencies":{"evil":"1.0.0"}}',
			);
			return { success: true, writerLifecycle: "stopped" };
		},
		{ checkCachePath: cache },
	);
	strictEqual(observed.called, 1);
	strictEqual(observed.result.failureReason, "check_dependencies_unverified");
});

test("host probe succeeds while nested sandbox refuses full dispatch before provider", {
	skip: nestedSandboxSkip,
}, () => {
	const repo = fixture();
	const profile = quickCheckSandboxProfile(repo.root, repo.root);
	const host = spawnSync("/usr/bin/sandbox-exec", [
		"-p",
		profile,
		"/usr/bin/true",
	]);
	strictEqual(host.status, 0);
	const modulePath = new URL(
		"../src/switchyard/simple/index.mjs",
		import.meta.url,
	).href;
	const script = `import { runSimpleTask } from ${JSON.stringify(modulePath)};
	let called = false;
	const r = await runSimpleTask({ ...${JSON.stringify(repo)}, capability: "standard", files: ["a.txt"], checks: ["test -f a.txt"], deadlineMs: Date.now() + 180000 }, {
	 tmpdir: ${JSON.stringify(repo.root)}, route: () => ({provider:"Codex (Spark)",reason:"priority_fill"}),
	 resolveTargetIdentity: () => ({targetId:"codex",harnessKey:"codex",ambiguous:false}),
	 getInvocationDescriptor: () => ({target_id:"codex",selector:"gpt-5.3-codex-spark",invocation_args:[]}), assertFundedRoute: () => {},
	 executeProvider: async () => { called = true; return {success:true,writerLifecycle:"stopped"}; }
	}); process.stdout.write(JSON.stringify({called,status:r.status,reason:r.failureReason,cleanup:r.recovery.cleanup}));`;
	const nested = spawnSync(
		"/usr/bin/sandbox-exec",
		[
			"-p",
			'(version 1)(allow default)(deny process-exec (literal "/usr/bin/sandbox-exec"))',
			process.execPath,
			"--input-type=module",
			"-e",
			script,
		],
		{ encoding: "utf8", timeout: 30000 },
	);
	strictEqual(nested.status, 0, nested.stderr);
	const result = JSON.parse(nested.stdout);
	strictEqual(result.called, false);
	strictEqual(result.reason, "check_environment_unavailable");
	strictEqual(result.cleanup.worktree.state, "removed");
	ok(profile.includes("deny default"));
});
