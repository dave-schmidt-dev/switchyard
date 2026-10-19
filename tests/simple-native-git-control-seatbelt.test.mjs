// @test-phase: other
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeCodeSeatbeltProfile } from "../ops/simple-claude-code-launcher.mjs";
import {
	baseSeatbeltRules,
	gitControlWriteRules,
	runSandboxedNative,
} from "../ops/simple-native-launcher-core.mjs";
import { vibeCodeSeatbeltProfile } from "../ops/simple-vibe-code-launcher.mjs";
import {
	snapshotGitControl,
	verifyGitControl,
} from "../src/switchyard/simple/git-control.mjs";

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

const IDENTITY = [
	"-c",
	"user.name=fixture",
	"-c",
	"user.email=fixture@example.invalid",
	"-c",
	"commit.gpgsign=false",
];
const hostEnv = (runtime) => ({
	PATH: process.env.PATH,
	HOME: runtime,
	TMPDIR: runtime,
	LC_ALL: "C",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
});

function setup(name = "switchyard-simple") {
	const root = join(realpathSync(tmpdir()), `${name}-${randomUUID()}`);
	const worktree = join(root, "worktree");
	const runtime = join(root, ".runtime");
	mkdirSync(worktree, { recursive: true });
	mkdirSync(runtime);
	const git = (...args) => {
		const result = spawnSync("git", ["-C", worktree, ...IDENTITY, ...args], {
			encoding: "utf8",
			env: hostEnv(runtime),
		});
		assert.equal(result.status, 0, result.stderr);
		return result.stdout;
	};
	git("init", "-q");
	writeFileSync(join(worktree, "a.txt"), "a\n");
	git("add", "a.txt");
	git("commit", "-qm", "base");
	return {
		root,
		worktree,
		runtime,
		git,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

// The fixture provider prints "ok <step>" or "denied <step>" per step, so a
// failed allowed step and a successful denied step both show by name.
const FIXTURE_PROVIDER = `#!/bin/sh
g() { git -c user.name=fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false "$@"; }
step() { name=$1; shift; if "$@" >/dev/null 2>&1; then echo "ok $name"; else echo "denied $name"; fi; }
work() { echo b >> a.txt && g add a.txt && g commit -qm work; }
step commit work
step branch g checkout -qb side
shelve() { echo c >> a.txt && g stash -q && g stash pop -q; }
step stash shelve
step reset g reset -q --hard HEAD
step repack g repack -a -d -q
step status g status --short
step git-config g config user.name stray
step append-config sh -c 'echo "[core]" >> .git/config'
step upper-config sh -c 'echo "[core]" >> .git/CONFIG'
step config-lock sh -c ': > .git/config.lock'
step hook sh -c 'mkdir -p .git/hooks && echo exit > .git/hooks/pre-commit'
step info-exclude sh -c 'mkdir -p .git/info && echo x >> .git/info/exclude'
step commit-graph g commit-graph write --reachable
step alternates sh -c 'echo /tmp > .git/objects/info/alternates'
step replace-ref g replace HEAD HEAD~1
step hardlink-config ln .git/config linked-config
step rename-git mv .git .git-moved
`;

const ALLOWED = ["commit", "branch", "stash", "reset", "repack", "status"];
const DENIED = [
	"git-config",
	"append-config",
	"upper-config",
	"config-lock",
	"hook",
	"info-exclude",
	"commit-graph",
	"alternates",
	"replace-ref",
	"hardlink-config",
	"rename-git",
];

async function runFixture(item, gitWorktree, extraWrites = []) {
	const cliPath = join(item.runtime, "fixture-provider.sh");
	writeFileSync(cliPath, FIXTURE_PROVIDER, { mode: 0o755 });
	const result = await runSandboxedNative({
		worktree: item.worktree,
		prompt: "fixture",
		cliPath,
		env: hostEnv(item.runtime),
		profile: baseSeatbeltRules({
			reads: ["/"],
			writes: [item.worktree, item.runtime, ...extraWrites],
			gitWorktree,
		}),
	});
	assert.equal(result.code, 0, result.stderr);
	return result.stdout.trim().split("\n");
}

test("a fixture provider under the git-control rules keeps working git but cannot touch control files", async (t) => {
	if (!seatbeltAvailable())
		return t.skip("host Seatbelt unavailable under outer sandbox");
	const item = setup();
	try {
		// git init's default template already wrote config and info/exclude.
		const controlFiles = ["config", "info/exclude"];
		const read = (path) => readFileSync(join(item.worktree, ".git", path));
		const before = controlFiles.map(read);
		const serverInfo = ["info/refs", "objects/info/packs"];
		for (const path of serverInfo)
			assert.equal(existsSync(join(item.worktree, ".git", path)), false);
		const snapshot = snapshotGitControl(item.worktree);
		assert.deepEqual(await runFixture(item, item.worktree), [
			...ALLOWED.map((step) => `ok ${step}`),
			...DENIED.map((step) => `denied ${step}`),
		]);
		assert.deepEqual(controlFiles.map(read), before);
		for (const path of [
			"config.lock",
			"hooks/pre-commit",
			"objects/info/commit-graph",
			"objects/info/alternates",
			"refs/replace",
		])
			assert.equal(existsSync(join(item.worktree, ".git", path)), false, path);
		assert.equal(existsSync(join(item.worktree, "linked-config")), false);
		// repack's update-server-info rewrote both re-allowed files.
		for (const path of serverInfo)
			assert.match(read(path).toString(), /\S/u, path);
		// Everything the allowed steps wrote is provider-writable, so the
		// checkout survives the post-provider verification.
		verifyGitControl(item.worktree, snapshot);
		assert.match(item.git("log", "--format=%s", "-1", "side"), /^work$/mu);
	} finally {
		item.cleanup();
	}
});

test("without the git-control rules every fixture step succeeds, so each denial above is the rules'", async (t) => {
	if (!seatbeltAvailable())
		return t.skip("host Seatbelt unavailable under outer sandbox");
	const item = setup();
	try {
		assert.deepEqual(
			await runFixture(item, undefined),
			[...ALLOWED, ...DENIED].map((step) => `ok ${step}`),
		);
	} finally {
		item.cleanup();
	}
});

test("without the git-control rules the same .git/config write reaches the verifier as a config change", async (t) => {
	if (!seatbeltAvailable())
		return t.skip("host Seatbelt unavailable under outer sandbox");
	const item = setup();
	try {
		const snapshot = snapshotGitControl(item.worktree);
		const cliPath = join(item.runtime, "stray-config.sh");
		writeFileSync(
			cliPath,
			'#!/bin/sh\ngit config user.name stray && echo "ok git-config"\n',
			{ mode: 0o755 },
		);
		const result = await runSandboxedNative({
			worktree: item.worktree,
			prompt: "fixture",
			cliPath,
			env: hostEnv(item.runtime),
			profile: baseSeatbeltRules({
				reads: ["/"],
				writes: [item.worktree, item.runtime],
			}),
		});
		assert.equal(result.stdout.trim(), "ok git-config");
		assert.throws(
			() => verifyGitControl(item.worktree, snapshot),
			(error) =>
				error.code === "git_control_tampered" &&
				error.tamperKind === "changed" &&
				error.tamperArea === "config",
		);
	} finally {
		item.cleanup();
	}
});

test("both native launcher profiles end their write grants with the git-control rules", () => {
	const worktree = "/private/var/folders/x/switchyard-simple-1/worktree";
	const rules = gitControlWriteRules(worktree).join("\n");
	for (const profile of [
		claudeCodeSeatbeltProfile({
			worktree,
			runtime: "/r",
			keychains: "/k",
			cliRoot: "/cli",
		}),
		vibeCodeSeatbeltProfile({ worktree, runtime: "/r", keychains: "/k" }),
	]) {
		const allow = profile.indexOf(
			`(allow file-write* (subpath ${JSON.stringify(worktree)})`,
		);
		assert.ok(allow >= 0);
		assert.ok(profile.indexOf(rules) > allow);
	}
});

test("git-control rules bracket-escape the path and bound every regex with the clone's .git", () => {
	const [deny, allow] = gitControlWriteRules("/tmp/a.b-c_d/worktree");
	const within = '(subpath "/tmp/a.b-c_d/worktree/.git")';
	assert.ok(
		deny.startsWith(
			`(deny file-write* (literal "/tmp/a.b-c_d/worktree/.git") (require-all ${within} (regex #"^/tmp/a[.]b[-]c[_]d/worktree/[.]git/[cC][oO][nN][fF][iI][gG]"))`,
		),
	);
	assert.match(
		allow,
		/\[pP\]\[aA\]\[cC\]\[kK\]\[sS\]\(_\[\^\/\]\*\)\?\$"\)\)\)$/u,
	);
	for (const line of [deny, allow])
		for (const rule of line.matchAll(/\(regex /gu))
			assert.equal(
				line.slice(rule.index - within.length - 1, rule.index - 1),
				within,
			);
	// Bytes no bracket can hold become ".", non-ASCII stays raw, and nothing
	// throws: a custom TMPDIR may hold any of these.
	const [odd] = gitControlWriteRules('/w/q"u]o^t\\e\u0001é[$/worktree');
	assert.ok(
		odd.includes('(regex #"^/w/q.u.o.t.e.é[[][$]/worktree/[.]git/'),
		odd,
	);
	for (const worktree of ["/w/é]^", '/w/q"\\'])
		assert.ok(
			claudeCodeSeatbeltProfile({
				worktree,
				runtime: "/r",
				keychains: "/k",
				cliRoot: "/cli",
			}).includes(gitControlWriteRules(worktree)[0]),
		);
});

test("the rules deny control writes under a worktree path no regex can spell exactly, and stop at that clone", async (t) => {
	if (!seatbeltAvailable())
		return t.skip("host Seatbelt unavailable under outer sandbox");
	const item = setup('switchyard-odd é]^"\\[$');
	// "]" and "^" both escape to ".", so this sibling's .git matches the
	// clone's loosened regex; only the subpath bound keeps it writable.
	const sibling = item.root.replace("é]", () => "é^");
	const siblingConfig = join(sibling, "worktree", ".git", "config");
	try {
		mkdirSync(join(sibling, "worktree", ".git"), { recursive: true });
		writeFileSync(siblingConfig, "[core]\n");
		const config = join(item.worktree, ".git", "config");
		const before = readFileSync(config);
		const snapshot = snapshotGitControl(item.worktree);
		assert.deepEqual(await runFixture(item, item.worktree, [sibling]), [
			...ALLOWED.map((step) => `ok ${step}`),
			...DENIED.map((step) => `denied ${step}`),
		]);
		assert.deepEqual(readFileSync(config), before);
		verifyGitControl(item.worktree, snapshot);
		const cliPath = join(item.runtime, "sibling-config.sh");
		writeFileSync(
			cliPath,
			'#!/bin/sh\necho "[user]" >> "$SIBLING_CONFIG" && echo "ok sibling"\n',
			{ mode: 0o755 },
		);
		const result = await runSandboxedNative({
			worktree: item.worktree,
			prompt: "fixture",
			cliPath,
			env: { ...hostEnv(item.runtime), SIBLING_CONFIG: siblingConfig },
			profile: baseSeatbeltRules({
				reads: ["/"],
				writes: [item.worktree, item.runtime, sibling],
				gitWorktree: item.worktree,
			}),
		});
		assert.equal(result.stdout.trim(), "ok sibling", result.stderr);
		assert.equal(readFileSync(siblingConfig, "utf8"), "[core]\n[user]\n");
	} finally {
		item.cleanup();
		rmSync(sibling, { recursive: true, force: true });
	}
});
