import { strictEqual } from "node:assert";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { defaultRunCheck } from "../src/switchyard/simple/provider-invocation.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

function fixture({
	installed = true,
	version = "1.2.3",
	lockedVersion = "1.2.3",
	lockedDeclaration = "^1.2.3",
	declaration = "^1.2.3",
} = {}) {
	const root = tempDir("switchyard-check-resolution-");
	const packagePath = join(root, "node_modules", "fixture-tool");
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ devDependencies: { "fixture-tool": declaration } }),
	);
	writeFileSync(
		join(root, "package-lock.json"),
		JSON.stringify({
			lockfileVersion: 3,
			packages: {
				"": { devDependencies: { "fixture-tool": lockedDeclaration } },
				"node_modules/fixture-tool": {
					version: lockedVersion,
					bin: { "fixture-check": "cli.js" },
				},
			},
		}),
	);
	if (installed) {
		mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
		mkdirSync(packagePath, { recursive: true });
		writeFileSync(
			join(packagePath, "package.json"),
			JSON.stringify({
				name: "fixture-tool",
				version,
				bin: { "fixture-check": "cli.js" },
			}),
		);
		writeFileSync(
			join(packagePath, "cli.js"),
			'#!/usr/bin/env node\nrequire("node:fs").writeFileSync("local-ran", process.argv.slice(2).join(" "));\n',
		);
		chmodSync(join(packagePath, "cli.js"), 0o755);
		symlinkSync(
			"../fixture-tool/cli.js",
			join(root, "node_modules", ".bin", "fixture-check"),
		);
	}
	return root;
}

function check(root, command, extra = {}) {
	return defaultRunCheck({
		command,
		worktreePath: root,
		timeoutMs: 10_000,
		...extra,
	});
}

describe("real default package check execution", () => {
	it("rejects missing dependencies without executing a PATH/cache substitute", async () => {
		const root = fixture({ installed: false });
		const fake = join(root, "fake");
		mkdirSync(fake);
		for (const name of ["npx", "npm", "fixture-check"]) {
			writeFileSync(
				join(fake, name),
				`#!/bin/sh\n touch '${join(root, "fake-ran")}'\n echo pass\n`,
			);
			chmodSync(join(fake, name), 0o755);
		}
		const previousPath = process.env.PATH;
		const previousCache = process.env.npm_config_cache;
		process.env.PATH = `${fake}:${previousPath}`;
		process.env.npm_config_cache = fake;
		try {
			for (const command of [
				"npx fixture-check",
				"npm exec -- fixture-check",
				"fixture-check",
				"./node_modules/.bin/fixture-check",
			]) {
				const result = await check(root, command);
				strictEqual(result.success, false);
				strictEqual(result.diagnosticCode, "check_dependencies_unverified");
				strictEqual(result.writerLifecycle, "never_started");
			}
			strictEqual(existsSync(join(root, "fake-ran")), false);
		} finally {
			process.env.PATH = previousPath;
			if (previousCache === undefined) delete process.env.npm_config_cache;
			else process.env.npm_config_cache = previousCache;
		}
	});

	it("executes the exact installed lock binary through each supported launch", async () => {
		const root = fixture();
		for (const command of [
			"npx fixture-check --check",
			"npm exec -- fixture-check --check",
			"./node_modules/.bin/fixture-check --check",
			"fixture-check --check",
		]) {
			const result = await check(root, command);
			strictEqual(result.success, true);
			strictEqual(result.writerLifecycle, "stopped");
		}
		strictEqual(existsSync(join(root, "local-ran")), true);
	});

	it("rejects installed version and root declaration mismatches", async () => {
		for (const options of [{ version: "9.9.9" }, { declaration: "^9.9.9" }]) {
			const root = fixture(options);
			strictEqual((await check(root, "npx fixture-check")).success, false);
			strictEqual(existsSync(join(root, "local-ran")), false);
		}
		const root = fixture({ declaration: "^9.9.9" });
		const lockPath = join(root, "package-lock.json");
		const lock = JSON.parse(readFileSync(lockPath, "utf8"));
		lock.packages[""].devDependencies["fixture-tool"] = "^9.9.9";
		writeFileSync(lockPath, JSON.stringify(lock));
		strictEqual((await check(root, "npx fixture-check")).success, false);
		strictEqual(existsSync(join(root, "local-ran")), false);
	});

	it("retains progress, timeout teardown and cancellation for local binaries", async () => {
		const root = fixture();
		const controller = new AbortController();
		controller.abort();
		strictEqual(
			(await check(root, "npx fixture-check", { signal: controller.signal }))
				.cancelled,
			true,
		);
		strictEqual(existsSync(join(root, "local-ran")), false);
		writeFileSync(
			join(root, "node_modules", "fixture-tool", "cli.js"),
			"#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n",
		);
		let progress = 0;
		const result = await check(root, "npx fixture-check", {
			timeoutMs: 100,
			onProgress: () => {
				progress += 1;
			},
		});
		strictEqual(result.timedOut, true);
		strictEqual(result.writerLifecycle, "stopped");
		strictEqual(progress > 0, true);
	});

	it("fails closed for manager scripts and nested shell package launches", async () => {
		const root = fixture();
		for (const command of [
			"npm run test",
			"bunx fixture-check",
			"pnpx fixture-check",
			"n$(printf p)x fixture-check",
			"launcher=npx; $launcher fixture-check",
			"if true; then npx fixture-check; fi",
			"npx --yes fixture-check",
			"sh -c 'npx fixture-check'",
			"npx fixture-check && true",
			"env npx fixture-check",
			"test -f package.json && fixture-check",
			"n\\px fixture-check",
			"./node_modules/.bin/nested/fixture-check",
		]) {
			strictEqual((await check(root, command)).success, false);
		}
		strictEqual(existsSync(join(root, "local-ran")), false);
	});

	it("checks range boundaries and rejects an escaping bin link", async () => {
		for (const [declaration, version, expected] of [
			["^0.2.3", "0.2.4", true],
			["^0.2.3", "0.3.0", false],
			["~1.2.3", "1.2.4", true],
			["~1.2.3", "1.3.0", false],
			["^1.2.3", "1.2.2", false],
		]) {
			const root = fixture({
				declaration,
				lockedDeclaration: declaration,
				version,
				lockedVersion: version,
			});
			strictEqual((await check(root, "npx fixture-check")).success, expected);
		}
		const root = fixture();
		const outside = tempDir("switchyard-check-outside-");
		writeFileSync(join(outside, "cli.js"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(outside, "cli.js"), 0o755);
		rmSync(join(root, "node_modules", "fixture-tool", "cli.js"));
		symlinkSync(
			join(outside, "cli.js"),
			join(root, "node_modules", "fixture-tool", "cli.js"),
		);
		strictEqual((await check(root, "npx fixture-check")).success, false);
	});

	it("keeps package names in ordinary arguments out of launch detection", async () => {
		const root = fixture();
		writeFileSync(join(root, "x"), "semver fixture-check npm\n");
		for (const command of [
			"grep semver x",
			"grep fixture-check x",
			"grep 'npm' x",
			"which node",
			'test -n "$PWD"',
			"sh -c true",
			"grep semver x >/dev/null",
		]) {
			strictEqual((await check(root, command)).success, true);
		}
	});

	it("preserves generic shell and Node checks and cancellation", async () => {
		const root = fixture({ installed: false });
		strictEqual(
			(await check(root, "test -f package.json && test -f package-lock.json"))
				.success,
			true,
		);
		writeFileSync(join(root, "check.js"), "process.exit(0);\n");
		strictEqual(
			(await check(root, `${process.execPath} check.js`)).success,
			true,
		);
		const controller = new AbortController();
		controller.abort();
		const cancelled = await check(root, `${process.execPath} check.js`, {
			signal: controller.signal,
		});
		strictEqual(cancelled.cancelled, true);
		strictEqual(cancelled.writerLifecycle, "never_started");
	});
});
