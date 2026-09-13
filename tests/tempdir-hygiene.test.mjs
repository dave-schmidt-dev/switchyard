import { deepStrictEqual, ok } from "node:assert";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { withIsolatedAccountRoot } from "../scripts/run-test-phases.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const testsDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function switchyardEntries(root) {
	return readdirSync(root).filter((name) => name.startsWith("switchyard-"));
}

describe("temp directory hygiene", () => {
	// A grep for "every mkdtemp has an rmSync" would have passed while the suite
	// leaked ~6,000 directories into $TMPDIR: integration-gate.test.mjs had a
	// correct afterEach and still leaked, because a nested beforeEach replaced
	// the tracked path before either hook could see the first one. So this
	// proves the behaviour instead - a child suite whose every test fails, run
	// against a private TMPDIR, must leave nothing behind.
	it("leaves no temp directories behind when every test fails", () => {
		const scratch = tempDir("switchyard-tempdir-guard-");
		const childEnv = { ...process.env };
		delete childEnv.NODE_TEST_CONTEXT;
		const fixture = join(testsDir, "fixtures", "tempdir-leak.fixture.mjs");
		const child = spawnSync(process.execPath, ["--test", fixture], {
			cwd: repoRoot,
			// NODE_TEST_CONTEXT is set in this process by the runner above; passing
			// it down makes the grandchild report over IPC and exit 0 even when its
			// tests fail, which would silently defeat the assertion below.
			env: { ...childEnv, TMPDIR: scratch },
			encoding: "utf8",
		});
		ok(
			child.status !== 0,
			"the fixture must fail - a passing child would not prove cleanup on failure",
		);
		deepStrictEqual(
			switchyardEntries(scratch),
			[],
			"a failing suite must not leave switchyard-* entries in TMPDIR",
		);
	});

	// The behavioural check above only covers directories created through the
	// helper, so this is what keeps new call sites inside it.
	it("routes every test file's temp directory through the tracked helper", () => {
		const offenders = [];
		for (const name of readdirSync(testsDir)) {
			if (!name.endsWith(".test.mjs")) continue;
			const source = readFileSync(join(testsDir, name), "utf8");
			for (const match of source.matchAll(/\bmkdtemp(Sync)?\s*\(/g)) {
				const line = source.slice(0, match.index).split("\n").length;
				offenders.push(`${name}:${line}`);
			}
		}
		deepStrictEqual(
			offenders,
			[],
			`call tests/helpers/tempdir.mjs instead of mkdtemp directly: ${offenders.join(", ")}`,
		);
	});

	// $TMPDIR is not the only thing a suite can dirty. Shared account
	// coordination is on by default, so a phase that inherited the ambient
	// environment would mint a host key under the owner's real
	// ~/.switchyard/accounts and number their live subscriptions from a test
	// run — somewhere no temp sweep looks and no assertion above would see.
	it("redirects the shared account root away from the real one", () => {
		const withoutOverride = { PATH: process.env.PATH };
		const isolated = withIsolatedAccountRoot(withoutOverride);
		const redirected = isolated.SWITCHYARD_ACCOUNT_ROOT;
		try {
			ok(redirected, "a phase with no override must be given one");
			ok(
				!redirected.startsWith(join(homedir(), ".switchyard")),
				`the redirect must not resolve inside the real root: ${redirected}`,
			);
			// An explicit override is the caller's, and is left alone.
			deepStrictEqual(
				withIsolatedAccountRoot({ SWITCHYARD_ACCOUNT_ROOT: "/tmp/explicit" }),
				{ SWITCHYARD_ACCOUNT_ROOT: "/tmp/explicit" },
			);
		} finally {
			if (redirected) rmSync(redirected, { force: true, recursive: true });
		}
	});
});
