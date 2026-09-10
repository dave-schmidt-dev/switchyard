#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = "tests/fixtures/incident-mutations.json";
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?\/?)[A-Za-z0-9._/-]+$/u;
const COPY_ALLOWLIST = Object.freeze([
	".node-version",
	".husky/pre-push",
	"INVARIANTS.md",
	"biome.json",
	"knip.json",
	"ledger.yaml",
	"package-lock.json",
	"package.json",
	"scripts",
	"src",
	"tests",
]);

function fail(message) {
	const error = new Error(message);
	error.code = message;
	throw error;
}

export function loadIncidentMutations(root = process.cwd()) {
	const fixture = JSON.parse(readFileSync(resolve(root, FIXTURE), "utf8"));
	if (
		fixture?.schemaVersion !== 1 ||
		!Array.isArray(fixture.mutations) ||
		fixture.mutations.length !== 7
	)
		fail("incident_mutation_fixture_invalid");
	const ids = new Set();
	for (const mutation of fixture.mutations) {
		if (!mutation || typeof mutation !== "object" || ids.has(mutation.id))
			fail("incident_mutation_identity_invalid");
		ids.add(mutation.id);
		if (
			!SAFE_PATH.test(mutation.source) ||
			!Array.isArray(mutation.tests) ||
			mutation.tests.length === 0
		)
			fail(`incident_mutation_paths_invalid:${mutation.id}`);
		if (
			typeof mutation.needle !== "string" ||
			!mutation.needle ||
			typeof mutation.replacement !== "string" ||
			mutation.needle === mutation.replacement
		)
			fail(`incident_mutation_transform_invalid:${mutation.id}`);
		for (const suite of mutation.tests)
			if (!SAFE_PATH.test(suite) || !suite.endsWith(".test.mjs"))
				fail(`incident_mutation_suite_invalid:${mutation.id}`);
	}
	const classes = new Set(
		fixture.mutations.map((mutation) => mutation.defectClass),
	);
	for (const expected of [
		"field-drop",
		"vacuous-consumer-guard",
		"failure-overwrite",
		"duplicate-terminal-count",
		"omitted-boundary-suite",
		"false-command-success",
		"unsafe-retry",
	])
		if (!classes.has(expected))
			fail(`incident_mutation_class_missing:${expected}`);
	return fixture.mutations;
}

function isSensitive(relative) {
	return relative
		.split("/")
		.some(
			(part) =>
				part === ".logs" ||
				part === ".local" ||
				part === ".env" ||
				part.startsWith(".env."),
		);
}

function copyAllowed(source, destination, relative) {
	const stat = lstatSync(source);
	if (stat.isSymbolicLink()) fail(`incident_copy_symlink:${relative}`);
	if (isSensitive(relative)) return;
	if (stat.isDirectory()) {
		mkdirSync(destination, { recursive: true });
		for (const entry of readdirSync(source))
			copyAllowed(
				join(source, entry),
				join(destination, entry),
				`${relative}/${entry}`,
			);
		return;
	}
	if (!stat.isFile()) fail(`incident_copy_entry_invalid:${relative}`);
	mkdirSync(dirname(destination), { recursive: true });
	cpSync(source, destination, { dereference: false });
}

function initializeDisposableGit(destination) {
	execFileSync("git", ["init", "-q"], { cwd: destination });
	execFileSync("git", ["config", "user.email", "mutation@example.invalid"], {
		cwd: destination,
	});
	execFileSync("git", ["config", "user.name", "Mutation Fixture"], {
		cwd: destination,
	});
	execFileSync("git", ["add", "-A"], { cwd: destination });
	execFileSync("git", ["commit", "-qm", "clean mutation baseline"], {
		cwd: destination,
	});
}

function materialize(root) {
	const destination = join(
		tmpdir(),
		`switchyard-incident-mutation-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
	try {
		mkdirSync(destination, { recursive: true, mode: 0o700 });
		for (const relative of COPY_ALLOWLIST) {
			const source = join(root, relative);
			copyAllowed(source, join(destination, relative), relative);
		}
		initializeDisposableGit(destination);
		return destination;
	} catch (error) {
		rmSync(destination, { recursive: true, force: true });
		throw error;
	}
}

export function applyMutation(root, mutation) {
	const path = resolve(root, mutation.source);
	const source = readFileSync(path, "utf8");
	const first = source.indexOf(mutation.needle);
	if (first < 0 || first !== source.lastIndexOf(mutation.needle))
		fail(`incident_mutation_needle_invalid:${mutation.id}`);
	writeFileSync(path, source.replace(mutation.needle, mutation.replacement));
}

function tapSummary(output, exitCode) {
	const tests = Number(output.match(/^# tests (\d+)$/mu)?.[1] ?? 0);
	const passed = Number(output.match(/^# pass (\d+)$/mu)?.[1] ?? 0);
	const skipped = Number(output.match(/^# skipped (\d+)$/mu)?.[1] ?? 0);
	return {
		tests,
		passed,
		skipped,
		status:
			exitCode !== 0
				? "failed"
				: tests === 0 || (skipped > 0 && passed === 0)
					? "skipped"
					: "executed",
	};
}

function runMutationSuite(root, mutation, run) {
	const child = run(
		process.execPath,
		["--test", "--test-reporter=tap", ...mutation.tests],
		{
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, SWITCHYARD_SKIP_LIVE_VM_TESTS: "1" },
		},
	);
	const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
	return { output, summary: tapSummary(output, child.status ?? 1) };
}

export function runIncidentMutations({
	root = process.cwd(),
	run = spawnSync,
} = {}) {
	const mutations = loadIncidentMutations(root);
	const results = [];
	for (const mutation of mutations) {
		const disposable = materialize(root);
		try {
			const baseline = runMutationSuite(disposable, mutation, run);
			if (
				baseline.summary.status !== "executed" ||
				baseline.summary.skipped > 0
			) {
				process.stderr.write(baseline.output);
				fail(`incident_mutation_baseline_invalid:${mutation.id}`);
			}
			applyMutation(disposable, mutation);
			const mutated = runMutationSuite(disposable, mutation, run);
			const { output, summary } = mutated;
			const killed =
				summary.status === "failed" &&
				summary.tests > 0 &&
				summary.skipped === 0;
			results.push({
				id: mutation.id,
				defectClass: mutation.defectClass,
				killed,
				summary,
			});
			console.log(
				`${killed ? "killed" : "SURVIVED"}: ${mutation.id} (${summary.tests} tests, ${summary.skipped} skipped)`,
			);
			if (!killed) process.stderr.write(output);
		} finally {
			rmSync(disposable, { recursive: true, force: true });
		}
	}
	const survivors = results.filter((result) => !result.killed);
	if (survivors.length)
		fail(
			`incident_mutations_survived:${survivors.map((result) => result.id).join(",")}`,
		);
	return { status: 0, results };
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
	try {
		runIncidentMutations();
	} catch (error) {
		console.error(`incident mutations: ${error.code ?? error.message}`);
		process.exitCode = 1;
	}
}
