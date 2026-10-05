import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	baseSeatbeltRules,
	boundedText,
	createFail,
	detachSharedClone,
	groupPresent,
	killGroup,
	runSandboxedNative,
	safeWorktree,
	schemePath,
	settleGroup,
} from "../ops/simple-native-launcher-core.mjs";

function setup() {
	const root = join(
		realpathSync(tmpdir()),
		`switchyard-simple-${randomUUID()}`,
	);
	const worktree = join(root, "worktree");
	mkdirSync(join(worktree, ".git"), { recursive: true });
	writeFileSync(join(root, ".switchyard-cleanup-owner.json"), "{}\n");

	const shimPath = join(root, "sandbox-shim.sh");
	writeFileSync(
		shimPath,
		`#!/bin/sh
shift 2
exec "$@"
`,
		{ mode: 0o755 },
	);

	return {
		root,
		worktree,
		shimPath,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("createFail formats error message with the provided label", () => {
	const fail = createFail("custom-launcher");
	assert.throws(() => fail("invalid operation"), {
		name: "Error",
		message: "custom-launcher: invalid operation",
	});
});

test("safeWorktree accepts canonical switchyard worktree and rejects invalid paths", () => {
	const item = setup();
	const nonSimpleRoot = join(realpathSync(tmpdir()), `other-${randomUUID()}`);
	const otherWorktree = join(nonSimpleRoot, "worktree");
	const wrongBasename = join(item.root, "not-worktree");
	const noOwnerRoot = join(
		realpathSync(tmpdir()),
		`switchyard-simple-${randomUUID()}`,
	);
	const noOwnerWorktree = join(noOwnerRoot, "worktree");
	const noGitRoot = join(
		realpathSync(tmpdir()),
		`switchyard-simple-${randomUUID()}`,
	);
	const noGitWorktree = join(noGitRoot, "worktree");

	try {
		assert.equal(safeWorktree(item.worktree), item.worktree);
		assert.throws(
			() => safeWorktree("relative/worktree"),
			/worktree must be absolute/,
		);
		assert.throws(
			() => safeWorktree("/bad\0/worktree"),
			/worktree must be absolute/,
		);
		assert.throws(() => safeWorktree(12345), /worktree must be absolute/);

		const symlinkWorktree = join(item.root, "symlink-worktree");
		symlinkSync(item.worktree, symlinkWorktree);
		assert.throws(
			() => safeWorktree(symlinkWorktree),
			/worktree must be a canonical directory/,
		);
		assert.throws(
			() => safeWorktree(`${item.worktree}/../worktree`),
			/worktree must be a canonical directory/,
		);
		assert.throws(
			() => safeWorktree(join(item.root, "nonexistent")),
			/worktree must be a canonical directory/,
		);

		mkdirSync(join(otherWorktree, ".git"), { recursive: true });
		writeFileSync(
			join(nonSimpleRoot, ".switchyard-cleanup-owner.json"),
			"{}\n",
		);
		assert.throws(
			() => safeWorktree(otherWorktree),
			/worktree is not a simple disposable clone/,
		);

		mkdirSync(join(wrongBasename, ".git"), { recursive: true });
		assert.throws(
			() => safeWorktree(wrongBasename),
			/worktree is not a simple disposable clone/,
		);

		mkdirSync(join(noOwnerWorktree, ".git"), { recursive: true });
		assert.throws(
			() => safeWorktree(noOwnerWorktree),
			/worktree ownership marker is absent/,
		);

		mkdirSync(noGitWorktree, { recursive: true });
		writeFileSync(join(noGitRoot, ".switchyard-cleanup-owner.json"), "{}\n");
		assert.throws(
			() => safeWorktree(noGitWorktree),
			/worktree ownership marker is absent/,
		);
	} finally {
		rmSync(nonSimpleRoot, { recursive: true, force: true });
		rmSync(noOwnerRoot, { recursive: true, force: true });
		rmSync(noGitRoot, { recursive: true, force: true });
		item.cleanup();
	}
});

test("boundedText strips escapes and control bytes while preserving whitespace", () => {
	const raw = Buffer.from(
		"\x1b[31;1mError:\x1b[0m\x00\x08 hello\x7f world\t!\r\nnext line\x1b]0;Title\x07",
	);
	assert.equal(boundedText(raw), "Error: hello world\t!\r\nnext line");
	assert.equal(
		boundedText("color \x1b[32mgreen\x1b[0m \x01control\x1f end"),
		"color green control end",
	);
});

test("baseSeatbeltRules output contains (deny default) and only the given write subpaths", () => {
	const profile = baseSeatbeltRules({
		reads: ["/read/alpha", "/read/beta"],
		writes: ["/write/one", "/write/two"],
	});
	assert.match(profile, /^\(version 1\)$/mu);
	assert.match(profile, /^\(deny default\)$/mu);
	assert.match(profile, /\(allow process-exec\)/u);
	assert.match(profile, /\(allow process-fork\)/u);
	assert.match(profile, /\(allow sysctl-read\)/u);
	assert.match(profile, /\(allow file-read\* \(literal "\/"\)\)/u);
	assert.match(
		profile,
		/\(allow file-read\* \(subpath "\/read\/alpha"\) \(subpath "\/read\/beta"\)\)/u,
	);
	assert.match(profile, /\(allow file-read-metadata\)/u);
	assert.match(
		profile,
		/^\(allow file-write\* \(subpath "\/write\/one"\) \(subpath "\/write\/two"\) \(literal "\/dev\/null"\)\)$/mu,
	);
	assert.match(profile, /\(allow mach-lookup\)/u);
	assert.match(profile, /\(allow ipc-posix-shm\)/u);
	assert.match(
		profile,
		/\(allow network-outbound \(remote tcp "\*:443"\) \(literal "\/private\/var\/run\/mDNSResponder"\) \(remote udp "\*:53"\)\)/u,
	);

	const writeLines = profile
		.split("\n")
		.filter((line) => line.includes("file-write*"));
	assert.equal(writeLines.length, 1);
	assert.equal(
		writeLines[0],
		'(allow file-write* (subpath "/write/one") (subpath "/write/two") (literal "/dev/null"))',
	);
});

test("runSandboxedNative fails closed when profile is missing or empty", async () => {
	const item = setup();
	const fakeCli = join(item.worktree, "fake-cli.sh");
	const sentinel = join(item.worktree, "sentinel.txt");
	writeFileSync(
		fakeCli,
		`#!/bin/sh
touch "${sentinel}"
exit 0
`,
		{ mode: 0o755 },
	);
	try {
		for (const emptyProfile of ["", "   ", null, undefined]) {
			await assert.rejects(
				runSandboxedNative({
					worktree: item.worktree,
					prompt: "test",
					cliPath: fakeCli,
					profile: emptyProfile,
					sandboxExec: item.shimPath,
				}),
				/seatbelt profile is required/,
			);
			assert.equal(existsSync(sentinel), false);
		}
	} finally {
		item.cleanup();
	}
});

test("runSandboxedNative succeeds on zero exit, passes stdin, and invokes verify", async () => {
	const item = setup();
	const fakeCli = join(item.worktree, "fake-cli.sh");
	writeFileSync(
		fakeCli,
		`#!/bin/sh
cat > stdin.txt
printf "success output\\n"
printf "debug log\\n" >&2
exit 0
`,
		{ mode: 0o755 },
	);
	try {
		let verifiedResult = null;
		const result = await runSandboxedNative({
			worktree: item.worktree,
			prompt: "hello from stdin",
			cliPath: fakeCli,
			profile: "(version 1)",
			sandboxExec: item.shimPath,
			verify: (res) => {
				verifiedResult = res;
			},
		});
		assert.equal(result.code, 0);
		assert.equal(result.stdout, "success output\n");
		assert.equal(result.stderr, "debug log\n");
		assert.equal(
			readFileSync(join(item.worktree, "stdin.txt"), "utf8"),
			"hello from stdin",
		);
		assert.deepEqual(verifiedResult, result);
	} finally {
		item.cleanup();
	}
});

test("runSandboxedNative passes non-zero exit and stderr through without verify", async () => {
	const item = setup();
	const fakeCli = join(item.worktree, "fake-cli.sh");
	writeFileSync(
		fakeCli,
		`#!/bin/sh
cat >/dev/null
printf "provider crashed\\n" >&2
exit 42
`,
		{ mode: 0o755 },
	);
	try {
		let verifyCalled = false;
		const result = await runSandboxedNative({
			worktree: item.worktree,
			prompt: "test",
			cliPath: fakeCli,
			profile: "(version 1)",
			sandboxExec: item.shimPath,
			verify: () => {
				verifyCalled = true;
			},
		});
		assert.equal(result.code, 42);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr, "provider crashed\n");
		assert.equal(verifyCalled, false);
	} finally {
		item.cleanup();
	}
});

test("runSandboxedNative enforces output cap and fails when exceeded", async () => {
	const item = setup();
	const fakeCli = join(item.worktree, "fake-cli.mjs");
	writeFileSync(
		fakeCli,
		`#!${process.execPath}
const chunk = Buffer.alloc(1024 * 1024, "a");
for (let i = 0; i < 9; i++) {
	process.stdout.write(chunk);
}
`,
		{ mode: 0o755 },
	);
	try {
		await assert.rejects(
			runSandboxedNative({
				worktree: item.worktree,
				prompt: "test",
				cliPath: fakeCli,
				profile: "(version 1)",
				sandboxExec: item.shimPath,
			}),
			/provider terminated before a verified completion/,
		);
	} finally {
		item.cleanup();
	}
});

test("runSandboxedNative terminates and fails on timeout", async () => {
	const item = setup();
	const fakeCli = join(item.worktree, "fake-cli.mjs");
	writeFileSync(
		fakeCli,
		`#!${process.execPath}
process.stderr.write("PROVIDER_TIMEOUT_STDERR_MARKER\\n");
setInterval(() => {}, 1000);
`,
		{ mode: 0o755 },
	);
	try {
		await assert.rejects(
			runSandboxedNative({
				worktree: item.worktree,
				prompt: "test",
				cliPath: fakeCli,
				profile: "(version 1)",
				sandboxExec: item.shimPath,
				timeoutMs: 150,
			}),
			(error) => {
				assert.match(
					error.message,
					/provider terminated before a verified completion/,
				);
				assert.doesNotMatch(error.message, /PROVIDER_TIMEOUT_STDERR_MARKER/u);
				return true;
			},
		);
	} finally {
		item.cleanup();
	}
});

test("helper functions handle trivial and boundary conditions", async () => {
	assert.equal(schemePath("/path/to/file"), '"/path/to/file"');
	assert.equal(schemePath("path with spaces"), '"path with spaces"');

	const item = setup();
	try {
		assert.doesNotThrow(() => detachSharedClone(item.worktree));
	} finally {
		item.cleanup();
	}

	assert.equal(groupPresent(null), false);
	assert.equal(groupPresent({}), false);
	assert.doesNotThrow(() => killGroup(null, "SIGTERM"));
	assert.doesNotThrow(() => killGroup({}, "SIGTERM"));
	assert.equal(await settleGroup(null), true);
	assert.equal(await settleGroup({}), true);
});
