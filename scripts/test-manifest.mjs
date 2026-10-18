#!/usr/bin/env node

/**
 * The test-phase manifest, generated from a pragma on each test file.
 *
 * Every `tests/*.test.mjs` names its phase on its first line:
 *
 *   // @test-phase: serial      test:serial, one file at a time
 *   // @test-phase: other       test:other, two files at a time
 *   // @test-phase: properties  test:properties (run-test-phases.mjs)
 *
 * The phase lists used to be hand-kept in package.json: an 82-path serial
 * list, the same paths again as a case exclusion in test:other, and two hash
 * pins over that text. A file now carries its own phase, so a rename or split
 * moves the metadata with it. An untagged or mistagged file fails both lanes
 * by name instead of silently joining one.
 *
 * `--run <lane>` executes a lane under a hermetic environment; `--list
 * <phase>` prints one phase's files, one per line.
 */

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withHermeticTestEnv } from "./hermetic-test-env.mjs";

export const TEST_PHASES = Object.freeze(["serial", "other", "properties"]);
const PRAGMA = /^\/\/ @test-phase: ([a-z]+)$/u;
const PRAGMA_HINT = `first line must be "// @test-phase: <${TEST_PHASES.join("|")}>"`;

/** Node test-runner flags per runnable lane; properties run elsewhere. */
export const LANE_ARGS = Object.freeze({
	serial: Object.freeze(["--test-concurrency=1", "--test-reporter=tap"]),
	other: Object.freeze(["--test-concurrency=2", "--test-reporter=tap"]),
});

function firstLine(path) {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(256);
		const bytes = readSync(fd, buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytes).toString("utf8").split(/\r?\n/u, 1)[0];
	} finally {
		closeSync(fd);
	}
}

/**
 * Scan `tests/*.test.mjs` and group the files by their phase pragma.
 * @param {string} [root] Repository root.
 * @returns {{files: string[], phases: Record<string, string[]>, errors: string[]}}
 *   Sorted repo-relative paths; `errors` names each untagged or mistagged file.
 */
export function readTestManifest(root = process.cwd()) {
	const files = readdirSync(resolve(root, "tests"), { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
		.map((entry) => `tests/${entry.name}`)
		.sort();
	const phases = Object.fromEntries(TEST_PHASES.map((phase) => [phase, []]));
	const errors = [];
	for (const path of files) {
		const phase = firstLine(resolve(root, path)).match(PRAGMA)?.[1];
		if (phase && Object.hasOwn(phases, phase)) phases[phase].push(path);
		else errors.push(`${path}: ${PRAGMA_HINT}`);
	}
	return { files, phases, errors };
}

/**
 * Run one lane's files in a single `node --test` child with a hermetic
 * HOME, TMPDIR and state roots. Refuses before spawning when any test file
 * lacks a valid pragma, so a forgotten tag cannot drop a suite unseen.
 */
export function runLane(
	lane,
	{
		root = process.cwd(),
		extraArgs = [],
		env = process.env,
		spawn = spawnSync,
		log = console.error,
	} = {},
) {
	if (!Object.hasOwn(LANE_ARGS, lane)) {
		log(`test manifest: unknown lane ${JSON.stringify(lane)}`);
		return 2;
	}
	const manifest = readTestManifest(root);
	if (manifest.errors.length > 0) {
		for (const error of manifest.errors) log(`test manifest: ${error}`);
		return 1;
	}
	return withHermeticTestEnv(env, (hermetic) => {
		const result = spawn(
			process.execPath,
			["--test", ...LANE_ARGS[lane], ...extraArgs, ...manifest.phases[lane]],
			{ cwd: root, stdio: "inherit", env: hermetic },
		);
		return result.error ? 1 : (result.status ?? 1);
	});
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
	const [mode, name, ...rest] = process.argv.slice(2);
	if (mode === "--run") process.exit(runLane(name, { extraArgs: rest }));
	if (mode === "--list" && TEST_PHASES.includes(name)) {
		const manifest = readTestManifest();
		for (const error of manifest.errors)
			console.error(`test manifest: ${error}`);
		for (const path of manifest.phases[name]) console.log(path);
		process.exit(manifest.errors.length > 0 ? 1 : 0);
	}
	console.error(
		`usage: test-manifest.mjs --run <${Object.keys(LANE_ARGS).join("|")}> | --list <${TEST_PHASES.join("|")}>`,
	);
	process.exit(2);
}
